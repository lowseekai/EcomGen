# PostgreSQL 迁移方案

> 状态：**方案，未动代码**。
> 依据：当前 `packages/core` 与 `apps/api` 的真实规模。

## 0. 为什么现在不能顺手做

| 指标 | 当前值 |
| --- | --- |
| 仓储方法 | 250（23 个模块，经门面暴露 229） |
| SQL 语句（`prepare` 调用） | 295 |
| 路由处理器 | 167 |
| 测试文件 | 95 |

`better-sqlite3` 是**同步**驱动，250 个仓储方法全部同步返回，并被 167 个路由处理器内联调用（典型写法 `const p = repository.getProject(id)`，没有 `await`）。

换 PostgreSQL 意味着：

1. 250 个仓储方法改异步，23 个模块重写；
2. 167 个处理器逐个补 `await`，**且顺序依赖的地方要重新审并发语义**（现在同步执行是天然串行，改成异步后两个查询之间可能插入别的请求）；
3. 295 条 SQL 里有大量 SQLite 专有写法（`json_extract`、`json_each`、`INSERT OR IGNORE`、`rowid`、部分索引、`PRAGMA`），逐条改写并验证；
4. 95 个测试文件跟着改。

这是一次全仓手术，必须**独立成轮**，不能和功能开发混在一起。

## 1. 分阶段路线（每阶段都可独立上线）

### 阶段 A：可移植性改造（不动数据库）

目标：让代码在 SQLite 上继续跑，但**不再新增 SQLite 专有依赖**。

#### A1：INSERT 冲突语法（已完成）

`INSERT OR IGNORE` / `INSERT OR REPLACE` 换成标准 upsert，共 10 处：

| 原写法 | 换成 | 位置 |
| --- | --- | --- |
| `INSERT OR IGNORE` | `ON CONFLICT(...) DO NOTHING` | credit_accounts、outputs、payment_notifications、plans、plan_entitlements、app_settings |
| `INSERT OR REPLACE` | `ON CONFLICT(...) DO UPDATE SET ...` | copywriting_results、web_research_audits、pattern_listing_results、plan_entitlements |

顺带修掉一个潜在风险：`INSERT OR REPLACE` 的语义是 **DELETE + INSERT**，一旦将来给这些表加了 `ON DELETE CASCADE` 的子表，替换主行会连带删掉子行。显式 `DO UPDATE` 没有这个问题。

验收：`pnpm --filter @ecomgen/core test` 153 个用例全绿（行为未变）。

#### A2：JSON 函数（已完成）

原 20 处 `json_each` / `json_extract` 已清零（剩余出现全部在注释里）。

**1. `layer_exports.layer_files_json` / `print_packs.files_json` → 行表**

被查询的 JSON 数组本来就该是表。新增 `layer_export_files` 与 `print_pack_files`：

- 写入方（`exportRepository`、`patternRepository`）在**同一事务**里同步行表与 JSON 快照；
- 资产库的 UNION 分支从 `CROSS JOIN json_each(...)` 改成普通 `JOIN`，去重/排序/游标分页仍下推数据库；
- `findLibrarySourcePath` 从"扫全表 + 展开 JSON"变成**按 hash 命中索引**（这是顺带的性能收益）；
- 一次性回填由 `app_settings` 里的 `migration.json_arrays_expanded` 标记守住，不会每次启动重扫。

**2. `patternDraftRepository.isStoragePathReferenced` → 应用层扫描**

每个草稿的批次数是个位数，为它绑死 `json_extract` / `json_each` 不值得。

**3. 模特身份维度 → `models` 的真实列**

`gender` / `age` / `heritage` / `stature` / `build` 原先靠 `json_extract(spec_json,'$.gender')` 筛选。
这五个是稳定枚举，落成列后筛选就是普通等值比较，并加了联合索引 `idx_models_identity`。
写入时同步（`writeModel`），存量由 `backfillModelIdentity` 在应用层解析回填。

验收：`pnpm test` 全绿（api 173 / web 173 / worker 88 / core 158）。

#### A3：`rowid`（已完成）

8 处 `ORDER BY ..., rowid DESC` 用来做"同一毫秒内的插入次序"兜底。PostgreSQL 没有等价物
（`ctid` 会随 VACUUM 变化，不能用）。

解法是**让主键可排序**，而不是改 SQL：新增 `newId()` 生成 RFC 9562 的 **UUIDv7**
（`packages/core/src/ids.ts`）。它仍是合法 UUID 字符串，契约里的 `format: "uuid"` 不受影响；
同一毫秒内用 12 位计数器递增，单进程内严格单调。于是 `ORDER BY id` 就等于插入序，`rowid` 全部去掉。

> **切换时踩到的坑**：`apps/api/src/http-input.ts` 里的 uuid 校验正则把版本位限制在 `[1-5]`，
> 而 RFC 9562 已定义到 v8。v7 上线后所有带 `format: "uuid"` 的请求体校验全部失败（表现为 400）。
> 已放宽为 `[1-8]`。这类"校验器比标准旧"的问题，只会在真正换版本号时暴露。

> 存量数据的 id 是 v4，按 id 排序时它们的相对次序是随机的。
> 开发库数据量很小，生产尚未上线，因此不做 id 重写；若已有大量生产数据，迁移时需要按原 rowid 顺序重写 id。

#### A4：`PRAGMA`（属于驱动层，随阶段 C 一起消失）

16 处全是连接初始化（`journal_mode`、`foreign_keys`、`busy_timeout`）与
`PRAGMA table_info` 内省。它们本来就在 `database.ts` 里，阶段 C 整体替换该文件时一并处理。

### 阶段 B：仓储层异步化（仍用 SQLite）

目标：把同步调用改成异步，**但不换数据库**。这样异步化引入的并发问题能在 SQLite 上先暴露、先修。

- 250 个方法返回 `Promise`，门面同步改；
- 167 个处理器补 `await`（编译器会逐条报错，漏不掉）；
- **重点审这些地方**：同一处理器里"先读后写"的逻辑（如 `findJobByFingerprint` → `createJob`），同步时天然原子，异步后要显式加锁或依赖唯一约束；
- 事务边界：`better-sqlite3` 的 `db.transaction(fn)` 是同步回调，要改成 `async` 版本并确保回调内不并发。

**验收**：全量测试绿；用并发压测（同一项目并发建任务）确认没有重复创建。

### 阶段 C：驱动替换

- 引入 `pg`，实现同一套 `SqlDialect` 接口；
- SQL 语法逐条过：占位符 `?` → `$1`、`TEXT` 时间戳 → `timestamptz`、布尔 `0/1` → `boolean`、`AUTOINCREMENT` 无对应（本来就没用）；
- 迁移脚本重写：现在 `migrate()` 是"一串幂等 CREATE/ALTER"，PostgreSQL 上应换成带版本号的迁移（`node-pg-migrate` 或自建 `schema_migrations` 表）。

**验收**：同一套测试在 PostgreSQL 上跑绿。

### 阶段 D：双写与切流

- 一次性导入脚本：SQLite → PostgreSQL（保持 id 不变）；
- 灰度：先只把读切到 PostgreSQL，写仍走 SQLite，比对结果；
- 再切写，观察一周；
- 回滚预案：保留 SQLite 快照，切回只需改一个环境变量。

## 2. 迁移时必须一起处理的东西

| 项 | 现在 | 迁移后 |
| --- | --- | --- |
| 事务 | `db.transaction(fn)`（同步） | `BEGIN/COMMIT` + 显式 client，**同一事务必须用同一连接** |
| 并发写 | SQLite 单写者，天然串行 | PostgreSQL 真并发，`billing_orders` 的"先读后写"要改成 `SELECT ... FOR UPDATE` 或条件更新 |
| 计数 | `SELECT COUNT(*)` | 大表要索引；`adminOverview` 的 12 个聚合查询需要复核执行计划 |
| 时间 | `TEXT` ISO 字符串 | `timestamptz`，注意时区与 `new Date().toISOString()` 的取舍 |
| 布尔 | `INTEGER 0/1` | `boolean`，映射层要统一 |
| JSON | `TEXT` + 应用层解析 | 可先用 `jsonb`，但**不建议**：应用层已解析，迁 `jsonb` 是额外风险 |

## 3. 已知的高风险点

1. **`billingRepository.transition` 的守卫在 `WHERE status=?` 里**。同步时这条天然安全；异步 + 真并发下仍安全（条件更新是原子的），但**不能**在迁移时改成"先查后改"。
2. **`paymentRepository.creditOrderOnce`** 依赖 `credited_at IS NULL` 条件更新做幂等。同上，别改写法。
3. **`libraryRepository` 的 UNION**：`json_each` 展开文件列表。PostgreSQL 上要么用 `jsonb_array_elements`，要么按阶段 A 的建议改成应用层展开。
4. **`storageRepository.usedBytes`** 是 11 个子查询相加。PostgreSQL 上要么加索引，要么改成物化统计表（但那样会重新引入"计数器漂移"问题）。
5. **`jobs` 的 `recoverInterruptedJobs`** 在 Worker 启动时跑，改异步后要确保它在开始消费之前完成。

## 4. 建议的时机与顺序

**先做阶段 A 和 B，再决定要不要迁 PostgreSQL。**

理由：

- A/B 的价值独立存在：A 让代码不再被 SQLite 方言绑死，B 让并发语义显式化。两者都不改变部署形态，风险可控。
- 如果负载始终在单实例能力范围内，B 做完就可以停——**异步化的仓储层本身就是一份资产**（未来接任何数据库都更容易）。
- 真正必须迁的信号只有三个：**出现第二个 API 实例**、**写入排队开始影响体验**、**单库接近几十 GB**。

## 5. 粗略工作量

| 阶段 | 相对量 | 风险 |
| --- | --- | --- |
| A 可移植性 | 中 | 低（行为不变，测试覆盖足） |
| B 异步化 | **大** | **中高**：167 个处理器 + 并发语义复审 |
| C 驱动替换 | 大 | 中：SQL 逐条改写，测试兜底 |
| D 双写切流 | 中 | 中：数据一致性 + 回滚演练 |

最大的单点风险是 B。缓解办法：**按模块分批**，每批改完立刻跑全量测试，不要一次性改完再跑。
