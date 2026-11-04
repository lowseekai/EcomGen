# 阶段 1：SaaS 基础层设计与迁移方案

> 状态：实施中。§4 数据模型、§5 认证设计、§6 归属隔离已落地为代码，认证路由与后台尚未开始。
> 目标读者：项目负责人。

## 0. 实施进度

| 步骤 | 状态 | 落点 |
| --- | --- | --- |
| SaaS schema 与迁移 | 已完成 | `packages/core/src/database.ts` 的 `migrateSaasFoundation` |
| 身份/积分/套餐/计费/支付/存储仓储 | 已完成 | `packages/core/src/repositories/{user,credit,plan,billing,payment,storage}Repository.ts` |
| 密码哈希与会话令牌 | 已完成 | `packages/core/src/auth.ts` |
| 首次启动引导与存量归属回填 | 已完成 | `packages/core/src/bootstrap.ts` |
| 仓储归属作用域与查询级谓词 | 已完成 | `packages/core/src/scope.ts` + 13 个仓储模块 |
| 请求级作用域接线（`forOwner` / ALS） | 已完成 | `app.ts`、`auth-guard.ts`、`context.ts` |
| 跨租户探针测试（HTTP 层） | 已完成 | `apps/api/src/crossTenant.test.ts`：解析 `printRoutes` 自动枚举全部路由，新增接口自动纳入覆盖 |

## 多租户改造中修掉的三个真实缺陷

这三个都是改造引入的、且**单元测试全绿也发现不了**的问题，靠自动探针与 Mock E2E 才暴露。

| 缺陷 | 表现 | 修法 |
| --- | --- | --- |
| `DELETE /projects/:id` 越权删库 | 路由把"查不到"当成"已删除"，走了幂等清理分支，**删掉了别人项目的存储目录**并返回 204 | 用系统作用域复核：存在但不属于当前用户 → 404，绝不碰存储 |
| Worker 以系统作用域写库 | `PATTERN_FORGE` 等任务产出的花型 `owner_id` 为空，**用户在自己的列表里看不到刚生成的东西** | 任务执行前 `runWithScope(ownerScope(job.ownerId))`，整段执行以发起者身份进行 |
| 每次启动都认领孤儿行 | 任何 `owner_id` 为空的行都会被划给引导管理员——多租户下等于把别人的数据判给自己 | 用 `migration.orphans_claimed` 标记改成一次性 |

> 这三条的共同点：**"查不到"在有归属过滤之后是二义的**（不存在 / 不属于你）。
> 凡是"查不到就做副作用"的地方都要重新审一遍。

### 第二轮：错误边界与纵深防御

| 改动 | 原因 |
| --- | --- |
| 错误处理器区分框架 4xx 与真实 5xx | Fastify 自身抛的畸形 JSON 等 4xx 不是 `ApiError`，原先一律报 500——调用方以为服务故障，运维被无意义告警淹没 |
| 4xx 改用 warn 级日志 | 之前每个 400/401/404 都按 error 级记录，真正的故障被埋掉 |
| `getEditReferenceAsset` / `deleteEditReferenceAsset` 补归属校验 | 原先只按 id 读写；路由层虽有 `sessionId` 校验兜底，但仓储层不带作用域太脆弱 |
| 跨租户探针补齐 10 类子资源 | 草稿媒体/批次/候选、编辑参考素材、模板、套图、成包、编辑会话与轮次，全部纳入自动探针 |

新增 `apps/api/src/errorHandling.test.ts`（5 个用例）把"4xx 不得变 500、响应体不得含堆栈"固化下来。

### 第三轮：存储配额从"死功能"变成真的生效

用户明确要求"存储配额现在做"，但 `size_bytes` **只有 assets 一条写入路径会记**，
生成的输出、导出、花型、成包、模特照全部为空 → `usedBytes` 几乎恒为 0 → 配额拦不住任何人。

31 处落盘点逐条补记既易漏又易错，因此分两层修：

| 层 | 做法 | 覆盖 |
| --- | --- | --- |
| 即时记账 | 生成图落库时按内存字节数写入 `size_bytes`（`job-generation` / `job-edit`） | 占用最大的部分 |
| 定期对齐 | Worker 启动时 + 每 5 分钟跑一次 `recountStorage(dataDir)`，按磁盘实际大小回填 | 其余所有产物 |

`recountStorage` 本来就实现了（还有单元测试），缺的只是**没有任何地方调用它**。

Mock E2E 增加断言：整条链路跑完后 `/auth/me` 的 `usedStorageBytes` 必须为正——
否则配额永远拦不住人，而这类"字段恒为 0"的问题单元测试完全看不出来。

### 第四轮：套餐权益从"配了不生效"变成真的拦截

`Entitlements` 有 12 个字段，之前**只有 3 个被使用**（`maxProjects` / `maxConcurrentJobs` / `maxStorageBytes`）。
其余 9 个只在管理端可编辑、在任何执行点都不判定——管理员把"免费版不允许 PSD 导出"配好，实际什么都不会发生。

现在接上的判定点：

| 权益 | 拦截位置 | 行为 |
| --- | --- | --- |
| `allowSuiteForge` | `POST /suite-forge-jobs` | 403 `CAPABILITY_UNSUPPORTED` |
| `allowPsdExport` | `GET /files/layer-exports/:id`（PSD 下载） | 403；分层 PNG 不受影响 |
| `allowWebResearch` | 项目创建 / 更新时开启该开关 | 403 |
| `maxImageResolution` | 项目创建 / 更新时的分辨率 | 超过套餐上限 403（不静默降级） |
| `allowLayerExport` | `POST /outputs/:id/layer-exports` | 403 |
| `allowModelLibrary` | `POST /models` | 403 |
| `allowPatternStudio` | `POST /patterns/upload` | 403 |

`assertFeature` / `assertResolutionAllowed` 放在 `apps/api/src/helpers.ts`；owner/admin 走 `UNLIMITED_ENTITLEMENTS`，不受影响。

**仍有一项未实现**：`watermarkExports`。它需要真正的水印合成（图像处理），
不是加个判断就能生效——在没有实现之前，这个开关保持"配置了也不会加水印"的状态，
不要误以为打开它就有了水印。

`apps/api/src/entitlements.test.ts`（6 个用例）覆盖：免费套餐被拦、站长不被拦、
以及**管理员改套餐后立即生效**——最后这条是关键，只测默认值的话，
即使开关根本没被任何代码读取，测试也会绿。

### 第五轮：响应体契约一致性

之前只校验**请求**（`parseBody`），**响应从来没人校验**——后端多返回、少返回、
类型漂移都不会被任何测试发现，而前端拿到形状不对的数据只会在运行时炸。

新增 `apps/api/src/responseContract.test.ts`：拿契约里的 TypeBox schema 直接校验真实响应，
覆盖 10 个读接口（会话、项目、花型、渠道、模特、套餐、审计、用户、仪表盘、账单）。

**立刻抓到一个真实漂移**：`Plan.id` 声明为 `format: "uuid"`，但套餐 id 实际是稳定 slug
（`plan-free` / `plan-pro`）。契约在说谎——任何按 schema 做校验或代码生成的客户端都会出错。
已改成普通字符串并写明它是跨环境稳定的 slug（订阅与权益行都按它外键，不能随便换成 UUID）。

> 这类问题单元测试看不见：`PATCH /admin/plans/plan-free` 一直能正常工作，
> 因为字符串传给路由就是字符串。只有**用契约校验真实响应**才会暴露。

### 第六轮：积分被永久占住（僵尸预扣）

Worker 被强杀时，任务行停在 `RUNNING`。重启后 `recoverInterruptedJobs` 会把它们
重置为 `QUEUED` 或标成 `FAILED`——但**完全不动计费单**。

被标成 `FAILED` 的那些，对应的 `reserved` 预扣就永远挂着：**用户的积分被永久冻结**，
没有任何代码会再来释放它，只能靠管理员去后台逐个改。

修法：新增 `listStaleReservations()` + `markStaleReservationsUncertain()`，
在 Worker 启动时扫描"订单仍 `reserved` 但任务已终态或行已不存在"的记录，一律标成 `uncertain`。

**只标不退款**——任务可能真的跑完了只是没来得及结算，自动退款会让平台白送一次生成。
交给管理员按日志裁决，这与既定的计费策略一致。

`saas-billing.test.ts` 补了 2 个用例：终态任务的预扣会被收口、还在跑的任务不能被误伤。

### 第七轮：任务没有墙钟超时

`startJobCancellation` 只在**用户主动取消**时才 abort。Node 的 `fetch` 没有默认超时，
所以 Provider 挂起（TCP 连上但不返回）时 `await` 永不 settle：

- Worker 并发只有 2，两个挂起的任务就能把整个 Worker 堵死
- 积分一直停在 `reserved`
- 用户界面一直显示"生成中"

修法：在同一个 signal 上叠加 `setTimeout`，超时以 `JobTimeout` 中止——它走**失败**分支
（可重试、最终按策略退款），而不是取消分支。上限默认 15 分钟，`WORKER_JOB_TIMEOUT_MS` 可配。

> **这次改动我自己先制造了一个严重 bug**：用 PowerShell 写 compose 文件时，
> 双引号里的 `${WORKER_JOB_TIMEOUT_MS:-900000}` 被 PowerShell 当成变量展开，
> 结果 compose 里只剩下 `WORKER_JOB_TIMEOUT_MS:`（空值）。
> 而 `Number("") === 0`，`setTimeout(0)` 会让**每个任务刚启动就被中止**。
>
> 两处都修了：compose 用脚本文件写入（避开 shell 插值），代码里 `readJobTimeout`
> 对空串/非法值/非正数一律退回默认值。`job-timeout.test.ts` 把这条钉住。

### 第八轮：水印真正生效 + compose 变量转发

**`watermarkExports` 从"配了没作用"变成真的加水印**——它是最后一个悬空的权益项。
导出流程原先直接把原图塞进 ZIP，没有任何地方读过这个开关。

现在打包时按套餐决定是否叠加水印：

- 水印文案走设置项 `export_watermark_text`（默认「仅供预览」），运营可改而不用改代码
- 保留原图格式（`toBuffer()` 沿用输入格式）——转成 PNG 会让文件名里的扩展名与内容不符
- 文字进 SVG 前做 XML 转义，否则 `&` 或 `<` 会让整段标记失效
- **单张图加水印失败退回原图**，不让一张坏图拖垮整包导出
- 两个内置套餐的 `watermarkExports` 都是 `false`，所以默认行为不变

`export-watermark.test.ts`（4 个用例）覆盖：合成确实发生且格式没坏、特殊字符不炸、
非图片原样返回、损坏图片原样返回。

**顺带修掉 compose 里三个"改了不生效"的变量**：`WORKER_CONCURRENCY`、`ECOMGEN_QUEUE_NAME`、
`ECOMGEN_CORS_ORIGINS` 之前都没被转发。其中 CORS 有个连带风险——转发后未设置时是空串，
而原解析逻辑把空串当成"显式配置了空来源"会启动即崩，已改为按未配置处理（`a,,b` 这类
真正的配置错误仍然报错）。`corsOriginsFromEnv` 也从 `server.ts` 抽到 `cors.ts` 才测得了。

### 第九轮：把 `/admin/dashboard` 接进后台

这个接口统计了用户、项目、任务、计费、额度、存储六个维度，但**前端从未调用过**——
属于"实现了但没接线"的死代码。

现在管理后台第一个页签就是「概览」：

- 六个维度分块展示，待裁决计费单数量为 0 时不着色、大于 0 时标红
- 类型直接复用生成的 `AdminDashboard`（六个维度嵌套，手写一份必然漂移）
- 顺带补上 `admin.module.css` 里缺失的 `panelBody`（多个面板引用了它但类根本没定义）

同时给「待裁决计费单」页签加了数量提示：`待裁决计费单 (3)`，超过 100 条显示 `99+`
（列表默认最多取 100 条，不编造精确值）。这类订单是"钱被占着等人处理"的异常，
藏在一个没有数字提示的标签里等于没人会点开。

> 默认页签从「用户」改成「概览」，两个既有用例因此失效——它们假设默认视图是用户列表。
> 已改为先切页签再断言。**这是加功能导致的测试失效，不是回归**，但值得记一笔：
> 断言"默认视图"的测试天然脆弱。
| 平台渠道写权限边界（Provider / 搜索源） | 已完成 | `routes/providers.ts`、`routes/searchSources.ts` + 审计留痕 |
| 计费服务（报价/预扣/结算/退款/挂起） | 已完成 | `packages/core/src/billing.ts` |
| 配额判定（存储/项目数/并发） | 已完成 | `packages/core/src/quota.ts`；上传入口已接线 |
| 计费接入任务创建 | 已完成 | `apps/api/src/charged-jobs.ts` + 9 个创建入口 |
| Worker 侧结算/退款接线 | 已完成 | `apps/worker/src/job-billing.ts` + `worker.ts` 四个终态 |
| 结算精度（按实际产出重算） | 已完成 | `packages/core/src/billing.ts` 的 `settleAmountForJob` |
| 认证路由与鉴权钩子 | 已完成（另一路会话） | `apps/api/src/routes/auth.ts`、`apps/api/src/auth-guard.ts` |
| 管理后台接口（用户/积分/价目/计费裁决/审计） | 已完成 | `apps/api/src/routes/admin.ts` |
| 管理后台前端页面 | 已完成 | `apps/web/src/features/admin/`，路由 `/admin` |
| 开户与重置密码（接口 + UI） | 已完成 | `admin.ts` 的 `POST /admin/users`、`POST /admin/users/:id/password`；`AdminPage.tsx` 新建用户/重置密码入口 |
| 支付（易支付协议：下单/回调/入账） | 已完成 | `packages/core/src/payment.ts`、`apps/api/src/routes/billing.ts` |
| 充值前端页面 | 已完成 | `apps/web/src/features/billing/`，路由 `/billing` 与 `/billing/return` |
| 支付渠道配置界面 | 已完成 | `AdminPage.tsx` 的「支付配置」页签 |
| 管理/充值端点纳入 OpenAPI 契约 | 已完成 | `packages/contracts/src/admin-schemas.ts` + `openapi/paths.yaml`（24 个 operation：18 个 admin 路径 + 3 个 billing 路径） |
| 认证端点纳入 OpenAPI 契约 | 已完成 | `packages/contracts/src/auth-schemas.ts`（7 个 operation） |
| 契约漂移守卫 | 已完成 | `adminClient.ts`、`session.ts` 里的 `Equals<手写类型, 生成类型>` 断言 |
| 邮件通道（SMTP 客户端 + 密码重置接入） | 已完成 | `packages/core/src/mailer.ts`；`auth.ts` 的重置请求已发信 |
| 邮件配置接口 | 已完成 | `GET/PATCH /admin/settings/mail`、`POST /admin/settings/mail/test` |
| 邮件配置界面 | 已完成 | `AdminPage.tsx` 的「邮件」页签 |
| 仪表盘统计 / 套餐管理 / 支付对账接口 | 已完成 | `apps/api/src/routes/adminOps.ts`、`packages/core/src/repositories/adminRepository.ts` |

新增测试：`saas-schema.test.ts`（7）、`saas-repositories.test.ts`（17）、`auth.test.ts`（12）、`scope.test.ts`（13）、`saas-billing.test.ts`（14）、`providerAccess.test.ts`（6）、`crossTenant.test.ts`（5）、`billingFlow.test.ts`（5）、`job-billing.test.ts`（7）、`admin.test.ts`（18）、`adminOps.test.ts`（12）、`admin.test.tsx`（3）、`payment.test.ts`（12 + 6）。

## 1. 范围

阶段 1 的交付物是"可商业化的单实例版本"：一个新用户能自己注册 → 拿到赠送积分 → 建项目 → 生成一套图 → 按实际用量扣积分 → 失败自动退回 → 管理员能在后台看到他、调整他的积分、封禁他、查他的流水。

**做**：用户与会话、资源归属、管理员角色、积分账本、任务预扣/结算/退款、套餐权益、**存储配额**、充值订单、单渠道支付、最小管理后台。

**不做**（明确留到阶段 2/3）：组织与团队、成员邀请、细粒度 RBAC、Stripe 订阅、对象存储、CDN、兑换码、邀请返佣、公告、多区域部署。

## 2. 一处重要修正：阶段 1 不迁 PostgreSQL

我在上一轮建议"阶段 1 就把数据库切到 PostgreSQL"。读完代码后，这个建议要收回。

原因是代价被低估了。当前 `packages/core` 的仓储层是**全同步**的（`better-sqlite3` 的特性），163 个仓储方法全部同步返回，并被 131 个路由处理器**内联直接调用**（典型写法 `const project = repository.getProject(id)`，没有 await）。换 PostgreSQL 意味着：

- 163 个仓储方法改成异步，16 个仓储模块全部重写；
- 131 个路由处理器逐个补 `await`，且顺序依赖的地方要重新审并发语义；
- 526 个测试用例里凡是直接调仓储的都要改；
- Worker 侧同样受影响。

这是一次**全仓大手术**，和"加认证 + 加计费 + 接支付"三件事叠在一起做，回归风险不可控，而且它不产生任何用户可见的价值。

**修正后的做法**：

- 阶段 1 继续用 SQLite（WAL + `busy_timeout=5000`），保持单 API 进程 + 单 Worker 进程的现有部署形态。当前 Docker Compose 已经是"两个容器共用一个 SQLite 文件"，WAL 下 POSIX 锁在同一个 VM 内是可靠的。
- 新增的表全部用**可移植 SQL** 写（不用 SQLite 专有语法、不用 `AUTOINCREMENT`、时间统一 `TEXT` ISO-8601），为后续迁移留门。
- 阶段 2 拿到真实并发数据后，用**独立的一轮**专门做 PostgreSQL 迁移。那时认证和计费已经稳定，回归面只有数据库一层。

什么时候必须迁：出现第二个 API 实例、或管理后台的统计查询开始拖慢写事务、或单库写入排队明显。在那之前 SQLite 不是瓶颈。

## 3. 现状盘点

| 项目 | 现状 |
| --- | --- |
| 数据库 | 单文件 SQLite，`migrate()` 内一串幂等 `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE` |
| 业务表 | providers、search_sources、projects、assets、storyboards、storyboard_items、jobs、outputs、exports、edit_sessions、edit_turns、edit_reference_assets、layer_plans、layer_exports、patterns、print_packs、pattern_pipelines、pattern_pipeline_steps、pattern_drafts、draft_media、draft_batches、draft_slots、draft_candidates、models、model_portraits、user_templates、user_suites、suite_forge_results、copywriting_results、web_research_audits、web_research_attempts、planning_config_snapshots |
| 认证 | **完全没有**。`app.ts` 注释明确写着"项目没有认证层"，CORS 只靠白名单挡跨站 |
| 归属 | **完全没有**。所有资源全局唯一，`/api/v1/projects` 直接返回全部项目 |
| Provider | 全局表，任何访问者都能增删改，API Key 用 `ECOMGEN_MASTER_KEY` 加密 |
| 计费 | 无。`jobs.estimated_cost_json` / `actual_cost_json` 是自由 JSON，没有价格来源，也不参与任何扣费 |
| 文件 | `LocalAssetStore` 落本地目录，文件路由 `/api/v1/files/*` 无鉴权，靠 UUID 不可猜 |

**结论**：这不是"加个登录页"的工作量，是要在数据模型里补一层所有权，并在 131 个接口上落实它。

## 4. 数据模型设计

### 4.1 设计原则

1. **只加 `owner_id`，不加 `organization_id`**。阶段 3 再做组织时，是给这批表补一列，不是重构。
2. **只在不属于项目的实体上加 `owner_id`**。`assets`、`outputs` 等始终挂在 `project_id` 下（NOT NULL），归属通过项目推导，不冗余存储，避免两处真相漂移。
3. **余额不做成用户表的一个字段**。余额是可变的派生值，真相是不可变流水 `credit_ledger_entries`；`credit_accounts` 只是流水聚合的缓存，任何时刻都能用流水重算对账。
4. **金额一律整数微积分**（1 积分 = 1,000,000 微积分）。禁止浮点。
5. **价格快照必须落库**。后台改价不能改写历史订单。

### 4.2 身份与会话

```sql
CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,        -- 存前统一小写
  password_hash     TEXT NOT NULL,               -- scrypt(N=16384,r=8,p=1)，格式 scrypt$N$r$p$salt$hash
  display_name      TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'user',   -- owner | admin | support | user
  status            TEXT NOT NULL DEFAULT 'active', -- active | disabled
  email_verified_at TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,   -- sha256(不透明随机 token)；明文只出现在 Cookie 里
  user_agent    TEXT,
  ip            TEXT,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id, expires_at);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 登录审计：成功与失败都记。失败行 user_id 为空（此时还不知道是谁）。
CREATE TABLE IF NOT EXISTS login_events (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  email      TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  outcome    TEXT NOT NULL,  -- success | bad_credentials | disabled | rate_limited
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_events_created ON login_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_events_email ON login_events(email, created_at DESC);

-- 管理操作审计：改积分、封禁、改价、删用户等一切有后果的动作。
CREATE TABLE IF NOT EXISTS admin_audit_events (
  id            TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  action        TEXT NOT NULL,   -- user.disable | credit.adjust | plan.update | provider.create ...
  target_type   TEXT NOT NULL,
  target_id     TEXT,
  summary       TEXT NOT NULL,
  data_json     TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_events(created_at DESC);

-- 全局开关（注册是否开放、赠送额度、站点名等）。值一律 JSON。
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**为什么不加 MFA / OAuth**：阶段 1 目标客户是个体卖家，邮箱密码足够。OAuth 与 MFA 放阶段 3 和企业版一起做。

### 4.3 资源归属

给这些表补 `owner_id TEXT`（`NULL` 只允许出现在平台级配置表）：

| 表 | 归属列 | 约束 | 说明 |
| --- | --- | --- | --- |
| `projects` | `owner_id` | NOT NULL | 所有项目查询的第一过滤条件 |
| `models` | `owner_id` | NOT NULL | 模特库是用户的私人资产 |
| `patterns` | `owner_id` | NOT NULL | 花型 |
| `pattern_drafts` | `owner_id` | NOT NULL | 起稿草稿 |
| `user_templates` | `owner_id` | NOT NULL | 自定义模板 |
| `user_suites` | `owner_id` | NOT NULL | 自定义套图 |
| `jobs` | `owner_id` | NOT NULL | `project_id` 可空（套图反推），必须有 owner 才能计费与配额 |

**`providers` 与 `search_sources` 不加 `owner_id`。** 已确认走平台代付：渠道由管理员统一配置、API Key 由平台持有，用户只读、不可增删改。这比"用户自带 Key"少一整条分支——不需要按 owner 过滤、不需要区分渠道归属、也不需要 `allow_custom_provider` 权益。

`assets` / `outputs` / `exports` / `storyboard_items` / `layer_*` / `draft_*` **不加** `owner_id`，它们始终经由 `project_id` 或父表可达。

索引：

```sql
CREATE INDEX IF NOT EXISTS idx_projects_owner_updated ON projects(owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_owner_status ON jobs(owner_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_models_owner ON models(owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_patterns_owner ON patterns(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pattern_drafts_owner ON pattern_drafts(owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_providers_owner ON providers(owner_id);
```

> `providers.owner_id` 为 `NULL` 时表示平台渠道。SQLite 的 `UNIQUE` 索引对 `NULL` 不去重，所以平台渠道的重名由应用层校验，不建唯一索引。

### 4.4 套餐与权益

```sql
CREATE TABLE IF NOT EXISTS plans (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,     -- free | starter | pro
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  price_cents   INTEGER NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'CNY',
  billing_period TEXT NOT NULL DEFAULT 'none',  -- none | month | year
  active        INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- 权益键值。value_json 存标量，避免为每个权益加一列。
CREATE TABLE IF NOT EXISTS plan_entitlements (
  plan_id    TEXT NOT NULL,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  PRIMARY KEY (plan_id, key),
  FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                      TEXT PRIMARY KEY,
  user_id                 TEXT NOT NULL,
  plan_id                 TEXT NOT NULL,
  status                  TEXT NOT NULL,   -- active | past_due | canceled | expired
  current_period_start    TEXT NOT NULL,
  current_period_end      TEXT NOT NULL,
  cancel_at_period_end    INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id) REFERENCES plans(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_active_user
  ON subscriptions(user_id) WHERE status = 'active';
```

权益键（全部对应 EcomGen 已有能力，不是凭空设计的）：

| key | 类型 | 作用点 |
| --- | --- | --- |
| `monthly_credits` | int（微积分） | 每期发放额度 |
| `max_projects` | int（-1 无限） | 建项目时校验 |
| `max_concurrent_jobs` | int | 入队时校验该用户 RUNNING+QUEUED 数 |
| `max_image_resolution` | `"1K"\|"2K"\|"4K"` | 生成前比对 `image_resolution` |
| `max_storage_bytes` | int（-1 无限） | 上传前校验（见 4.7） |
| `allow_psd_export` | bool | 分层导出 PSD |
| `allow_layer_export` | bool | 分层导出 ZIP/PNG |
| `allow_web_research` | bool | 项目级联网研究开关 |
| `allow_suite_forge` | bool | 套图工坊 |
| `allow_model_library` | bool | 模特库 |
| `allow_pattern_studio` | bool | 花型工坊 |
| `watermark_exports` | bool | 导出加固定水印 |

无订阅时回落到 `code='free'` 的计划。**免费计划必须存在**，否则新用户无法工作。

### 4.5 积分账本

```sql
-- 余额缓存。任何写入都必须和 credit_ledger_entries 在同一事务内。
CREATE TABLE IF NOT EXISTS credit_accounts (
  user_id              TEXT PRIMARY KEY,
  balance_microcredits INTEGER NOT NULL DEFAULT 0,
  updated_at           TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 不可变流水。只允许 INSERT，不允许 UPDATE/DELETE（改错用反向流水冲正）。
CREATE TABLE IF NOT EXISTS credit_ledger_entries (
  id                      TEXT PRIMARY KEY,
  user_id                 TEXT NOT NULL,
  type                    TEXT NOT NULL,
  amount_microcredits     INTEGER NOT NULL,   -- 带符号：发放为正，扣费为负
  balance_after_microcredits INTEGER NOT NULL,
  job_id                  TEXT,
  project_id              TEXT,
  billing_order_id        TEXT,
  payment_order_id        TEXT,
  note                    TEXT,
  created_at              TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ledger_user_created ON credit_ledger_entries(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_job ON credit_ledger_entries(job_id);
```

流水 `type` 取值：

| type | 触发 |
| --- | --- |
| `signup_bonus` | 注册赠送 |
| `plan_grant` | 套餐周期性发放 |
| `payment_topup` | 充值到账 |
| `job_reserve` | 任务预扣（负） |
| `job_settle` | 结算差额（正=退多扣，负=补扣） |
| `job_refund` | 任务失败全额退回（正） |
| `admin_grant` | 管理员手工发放 |
| `admin_adjust` | 管理员冲正 |

### 4.6 任务计费

```sql
-- 一次任务一条计费单。状态机：reserved -> settled | refunded | uncertain
CREATE TABLE IF NOT EXISTS billing_orders (
  id                        TEXT PRIMARY KEY,
  user_id                   TEXT NOT NULL,
  job_id                    TEXT NOT NULL UNIQUE,
  status                    TEXT NOT NULL,
  reserved_microcredits     INTEGER NOT NULL,
  settled_microcredits      INTEGER,
  cost_snapshot_json        TEXT NOT NULL,   -- 下单价目快照，改价不影响历史
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_billing_orders_user_created ON billing_orders(user_id, created_at DESC);
```

```sql
-- 平台渠道价目。成本与售价分开，才能算毛利。
CREATE TABLE IF NOT EXISTS provider_model_prices (
  id                 TEXT PRIMARY KEY,
  provider_id        TEXT NOT NULL,
  model_id           TEXT NOT NULL,
  kind               TEXT NOT NULL,   -- image | reasoning | segmentation
  pricing_mode       TEXT NOT NULL,   -- fixed_request | per_image | per_resolution | token
  price_microcredits INTEGER NOT NULL,          -- 对用户售价
  cost_microcredits  INTEGER NOT NULL DEFAULT 0, -- 平台成本，仅后台可见
  tiers_json         TEXT NOT NULL DEFAULT '{}', -- per_resolution: {"1K":800000,"2K":1600000}
  active             INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_model_prices_key
  ON provider_model_prices(provider_id, model_id, kind);
```

**计费时序**（这是最容易做错的地方，单独说明）：

```
建任务（API，同一事务）
  ├─ 校验套餐权益（并发数、分辨率、功能开关）
  ├─ 算价 -> 写 billing_orders(reserved) + cost_snapshot
  ├─ 扣 balance + 写 credit_ledger_entries(job_reserve, 负数)
  └─ 写 jobs(QUEUED) -> 入队

Worker 成功
  ├─ 按实际产物（张数/分辨率）算 settled
  ├─ billing_orders -> settled
  └─ 差额写 job_settle（通常为 0；多退少补）

Worker 明确失败（未发出外部请求）
  ├─ billing_orders -> refunded
  └─ 全额退回，写 job_refund

Worker 已发出外部请求但结果未知（进程崩溃 / 超时）
  ├─ billing_orders -> uncertain
  └─ 不自动退款，进后台待人工核对
```

最后一条对应代码里已有的 `EXTERNAL_REQUEST_STARTED` 标记语义——那种情况 Provider 可能已经计费，自动退款会让平台白贴成本。这是必须显式处理的分支，不能默认退款。

**预扣必须在 API 侧完成，不能放 Worker**。否则用户可以无限建任务排队，Worker 事后才发现余额不足。

### 4.7 存储配额

已确认阶段 1 就做。但这里有个前置缺口：**现有表没有任何一列记录文件字节数**，所以配额无法执行。要先补统计基础。

文件落在 10 个位置，全部需要计入：

| 表 | 列 | 形态 |
| --- | --- | --- |
| `assets` | `storage_path` | 单文件（上传素材） |
| `outputs` | `storage_path` | 单文件（生成结果） |
| `exports` | `storage_path` | 单文件（ZIP） |
| `edit_reference_assets` | `storage_path` | 单文件（编辑参考图） |
| `patterns` | `storage_path` | 单文件（花型图稿） |
| `draft_media` | `storage_path` | 单文件（起稿参考图/蒙版） |
| `draft_candidates` | `storage_path` | 单文件（起稿候选） |
| `model_portraits` | `storage_path` | 单文件（定妆照） |
| `models` | `reference_face_path` | 单文件（参考脸） |
| `layer_exports` | `psd_storage_path` + `layer_files_json` | 多文件 |
| `print_packs` | `files_json` | 多文件 |

统一补一列 `size_bytes INTEGER`（多文件的表存总和）：

```sql
ALTER TABLE assets                ADD COLUMN size_bytes INTEGER;
ALTER TABLE outputs               ADD COLUMN size_bytes INTEGER;
ALTER TABLE exports               ADD COLUMN size_bytes INTEGER;
ALTER TABLE edit_reference_assets ADD COLUMN size_bytes INTEGER;
ALTER TABLE patterns              ADD COLUMN size_bytes INTEGER;
ALTER TABLE draft_media           ADD COLUMN size_bytes INTEGER;
ALTER TABLE draft_candidates      ADD COLUMN size_bytes INTEGER;
ALTER TABLE model_portraits       ADD COLUMN size_bytes INTEGER;
ALTER TABLE models                ADD COLUMN size_bytes INTEGER;   -- reference_face 的大小
ALTER TABLE layer_exports         ADD COLUMN size_bytes INTEGER;
ALTER TABLE print_packs           ADD COLUMN size_bytes INTEGER;
```

**不做 `storage_usage` 计数器表。** 理由是计数器会漂移：删文件、级联删除项目、Worker 崩溃留下半成品，任何一处漏减就会永久错账，而且错账只能靠人工排查。改为**按需聚合查询**：

```sql
-- 用户已用字节数：按项目归属聚合
SELECT
  (SELECT COALESCE(SUM(a.size_bytes),0) FROM assets a JOIN projects p ON p.id=a.project_id WHERE p.owner_id=?)
+ (SELECT COALESCE(SUM(o.size_bytes),0) FROM outputs o JOIN projects p ON p.id=o.project_id WHERE p.owner_id=?)
+ (SELECT COALESCE(SUM(e.size_bytes),0) FROM exports e JOIN projects p ON p.id=e.project_id WHERE p.owner_id=?)
+ (SELECT COALESCE(SUM(r.size_bytes),0) FROM edit_reference_assets r JOIN projects p ON p.id=r.project_id WHERE p.owner_id=?)
+ (SELECT COALESCE(SUM(l.size_bytes),0) FROM layer_exports l JOIN projects p ON p.id=l.project_id WHERE p.owner_id=?)
+ (SELECT COALESCE(SUM(x.size_bytes),0) FROM patterns x WHERE x.owner_id=?)
+ (SELECT COALESCE(SUM(m.size_bytes),0) FROM draft_media m JOIN pattern_drafts d ON d.id=m.draft_id WHERE d.owner_id=?)
+ (SELECT COALESCE(SUM(c.size_bytes),0) FROM draft_candidates c JOIN pattern_drafts d ON d.id=c.draft_id WHERE d.owner_id=?)
+ (SELECT COALESCE(SUM(mo.size_bytes),0) FROM model_portraits mo JOIN models m ON m.id=mo.model_id WHERE m.owner_id=?)
+ (SELECT COALESCE(SUM(m.size_bytes),0) FROM models m WHERE m.owner_id=?)
+ (SELECT COALESCE(SUM(pp.size_bytes),0) FROM print_packs pp JOIN patterns x ON x.id=pp.pattern_id WHERE x.owner_id=?)
AS bytes_used;
```

上传频率是每分钟个位数，这个查询走索引完全够用，而它**永远是对的**——行删了额度自动释放，不存在漂移。

**回填**：迁移时对 `size_bytes IS NULL` 的行，按 `storage_path` 逐个 `stat` 文件大小写回。幂等，只处理 `NULL` 行，不覆盖已有值。

**校验点**（两处，缺一不可）：

1. **上传前**：`已用 + 本次文件大小 > max_storage_bytes` 则拒绝（413），不落盘。
2. **生成任务入队前**：预估产物大小（按分辨率与张数粗估，或直接按 `per_image` 上限）做预检，避免任务跑完才发现存不下。

生成类的预检不能精确，所以策略是**软预检**：超额时拒绝新建任务，但已入队任务照常执行——宁可短暂超一点，也不要让用户付了积分却拿不到图。

管理后台提供「重算用量」按钮：重新 `stat` 全部文件并修正 `size_bytes`，用于处理磁盘被外部清理后与数据库不一致的情况。

### 4.8 充值订单与支付

```sql
CREATE TABLE IF NOT EXISTS payment_orders (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL,
  kind                  TEXT NOT NULL,        -- credits | subscription
  plan_id               TEXT,                 -- kind=subscription 时必填
  credits_microcredits  INTEGER NOT NULL DEFAULT 0,
  amount_cents          INTEGER NOT NULL,
  currency              TEXT NOT NULL DEFAULT 'CNY',
  status                TEXT NOT NULL,        -- created | pending | paid | closed | failed
  provider              TEXT NOT NULL,        -- wechat_native | alipay_page | ...
  provider_config_json  TEXT NOT NULL,        -- 下单时的渠道配置快照（含版本），不读实时配置
  provider_order_no     TEXT,
  provider_trade_no     TEXT,
  paid_at               TEXT,
  credited_at           TEXT,
  expires_at            TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_payment_orders_user ON payment_orders(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_provider_no
  ON payment_orders(provider, provider_order_no) WHERE provider_order_no IS NOT NULL;

-- 回调收件箱。先落库再处理，保证回调不丢。
CREATE TABLE IF NOT EXISTS payment_notifications (
  id           TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  event_id     TEXT NOT NULL,       -- 渠道侧唯一事件号（无则用签名后正文哈希）
  payload_json TEXT NOT NULL,
  status       TEXT NOT NULL,       -- pending | processed | failed | ignored
  error_json   TEXT,
  created_at   TEXT NOT NULL,
  processed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_notifications_event
  ON payment_notifications(provider, event_id);
```

幂等链：`(provider, event_id)` 唯一 → 重复回调直接返回 204；`payment_orders.credited_at` 为空才允许加积分，加积分与置 `credited_at` 在同一事务。

阶段 1 只接**一个**渠道（建议微信 Native，回调最简单）。支付渠道抽象成接口，但只实现一个，不要提前写五个适配器。

## 5. 认证设计

**用 httpOnly Cookie，不用 Bearer Token。**

理由是具体的：文件路由 `/api/v1/files/outputs/:id`、`/files/assets/:id`、`/files/thumbnails/:hash` 都是被 `<img src>`、`<a download>` 直接消费的。Bearer 方案下这些请求带不上 `Authorization` 头，只能把 token 塞进查询串——那会进访问日志、浏览器历史、Referer，是明确的安全倒退。Cookie 让图片标签天然带凭证。

参数：

```
Set-Cookie: ecomgen_session=<32B base64url>; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000[; Secure]
```

- `Secure` 由环境变量控制（本地 http 调试时关掉）。
- CSRF：`SameSite=Lax` 挡掉跨站 POST；再加一条 `onRequest` 校验——所有非 GET 请求的 `Origin` 必须在允许列表内，缺失 Origin 的拒绝（同源 fetch 一定会带）。
- 会话不存明文：Cookie 里是随机 token，库里只存 `sha256(token)`。查库用哈希。
- 登录成功轮换 token；改密码时撤销该用户全部会话。

**密码哈希用 Node 内置 `crypto.scrypt`**，不引入新依赖。参数 N=16384, r=8, p=1，16 字节 salt，32 字节输出，格式 `scrypt$16384$8$1$<salt_b64>$<hash_b64>`。校验用 `timingSafeEqual`。

## 6. 归属隔离的落实方式

这是 131 个接口里最容易漏、漏了就数据泄露的部分。分三层防：

**第一层：统一入口鉴权。** `app.ts` 加一个 `onRequest` 钩子，除白名单外一律要求有效会话，解析出 `request.user`。白名单：`/health`、`/api/v1/auth/*`、静态资源。

**第二层：仓储实例级作用域 + 查询级谓词。** 已落地，见 `packages/core/src/scope.ts`。

> 原方案是"每个方法加 `ownerId` 参数"。实施时改为实例级作用域，原因如下：
>
> - **原方案覆盖不到子查询。** `listAssets(projectId)` 即使调用方忘了先校验项目，也照样返回别人的素材；签名改造管不到这一点。
> - **原方案要动 163 个方法 + 131 个处理器 + 526 个用例**，而它只能证明"你传了 owner"，证明不了"你传对了"。
>
> 现在的做法：作用域绑定在仓储实例上（`repository.forOwner(userId)`），每个能触达用户数据的查询都注入归属谓词，子表则 join 父表取归属。`SYSTEM_SCOPE` 注入空片段，SQL 与改造前逐字相同，所以行为完全中立。

```ts
// 根实体：直接比 owner_id
getProject(id) → WHERE id = ? AND owner_id = ?
// 子实体：join 父表，调用方忘了校验父实体也拿不到别人的数据
getAsset(id)   → SELECT a.* FROM assets a JOIN projects p ON p.id=a.project_id
                 WHERE a.id = ? AND p.owner_id = ?
```

写入时 `ownerValue(scope)` 自动落 `owner_id`（系统作用域写 NULL，可被 `claimOrphanRows` 认领）。拿不到就返回 `undefined`，路由层统一转 404（**不返回 403**，避免暴露"这个 id 存在但不是你的"）。

**第三层：跨租户探针测试。** 建两个用户 A、B，A 建项目并产出资产/输出/任务/花型，然后遍历所有注册路由，用 B 的身份带上 A 的资源 id 逐个请求，断言全部 404/403。路由表从 Fastify 实例动态枚举，所以**将来新加接口会自动被这个测试覆盖**——这是防止后续开发引入越权的最有效手段。仓储层的隔离已由 `packages/core/src/scope.test.ts`（13 例）覆盖，HTTP 层的探针测试随鉴权钩子一起加。

另外：

- `providers` 与 `search_sources` 是平台级配置（已确认平台代付），不加 `owner_id`：普通用户只读、不可增删改，写操作由管理员钩子拦截。
- 管理员接口全部走 `/api/v1/admin/*` 前缀，独立前置钩子校验 `role IN ('owner','admin','support')`，`support` 只读。

## 7. 迁移策略（存量数据不能丢）

现在 Docker 里已经有一个跑着的实例，迁移必须让"单用户旧库"平滑升级。

`migrate()` 末尾追加一步 `migrateSaasFoundation(database)`，幂等：

1. 建上面所有新表（`CREATE TABLE IF NOT EXISTS`）。
2. 若 `users` 为空：
   - 读 `ECOMGEN_BOOTSTRAP_EMAIL` / `ECOMGEN_BOOTSTRAP_PASSWORD`；
   - 未设置则生成随机密码，用 `app.log.warn` 打印**一次**；
   - 建 `role='owner'` 的用户，同时建 `credit_accounts` 行并写一条 `signup_bonus` 流水（额度取 `app_settings.signup_bonus_microcredits`，默认给足试用）。
3. 给 §4.3 的表补 `owner_id` 列（`ALTER TABLE ... ADD COLUMN`，可空），然后把 `owner_id IS NULL` 的行**全部**回填为 bootstrap owner 的 id。`providers` / `search_sources` 保持 `NULL`（升级后变成平台渠道，正好符合语义）。
4. 回填完再建索引。
5. 种子 `plans`：`free` 一个即可，权益取当前功能全开的保守值，保证老用户升级后能力不缩水。

> 注意：SQLite 的 `ALTER TABLE ADD COLUMN` 不能加 `NOT NULL` 无默认值的列。所以列先可空、回填、再由应用层保证写入时必填。要真正的 `NOT NULL` 只能重建表——考虑到 `projects` 表已被重建过两次，阶段 1 我不再重建，接受"数据库层可空、应用层必填"的折中，并在 repository 写入处强制。

**注册开关**：`app_settings.registration_enabled` 默认 `false`（自部署/内测），公网开放时由管理员在后台打开。这与参考项目的 `CANVAS_REGISTRATION_ENABLED=false` 默认值一致。

## 8. 后端改造清单

按依赖顺序，每步都能独立编译和测试：

1. **schema + 迁移**：`packages/core/src/database.ts` 追加 `migrateSaasFoundation`；新增 `packages/core/src/repositories/{userRepository,creditRepository,planRepository,paymentRepository}.ts`。
2. **密码与会话**：`packages/core/src/auth.ts`（scrypt 哈希、token 生成与校验）。
3. **认证路由**：`apps/api/src/routes/auth.ts` — `POST /auth/register`、`POST /auth/login`、`POST /auth/logout`、`GET /auth/me`、`POST /auth/password-reset/request`、`POST /auth/password-reset/confirm`。
4. **鉴权钩子**：`apps/api/src/auth-guard.ts`，在 `buildApi` 注册。
5. **仓储加 owner**：16 个仓储模块逐个改签名 + 调用点。**这步单独一个提交，不夹带别的改动**，方便出问题时整体回退。
6. **权益与配额**：`packages/core/src/entitlements.ts`（`resolveEntitlements(userId)` → 合并订阅计划与 free 计划）。
7. **计费服务**：`packages/core/src/billing.ts`（`reserveForJob` / `settleJob` / `refundJob` / `markUncertain`），全部在事务内完成"改余额 + 写流水"。
8. **存储统计**：`packages/core/src/storage.ts`（`usedBytes(ownerId)` 聚合查询、`recordSize()`、`recount()`）；写入点补 `size_bytes`。
8. **接入任务创建**：在 `storyboard.ts` 的 generation-jobs、`projects.ts` 的 planning/copywriting-jobs、`patterns.ts`、`patternDrafts.ts`、`suiteForge.ts`、`models.ts` 的 cast-jobs 等处调用 `reserveForJob`。
9. **Worker 结算**：`apps/worker` 在任务终态处调用 settle/refund/uncertain。
10. **管理接口**：`apps/api/src/routes/admin/*.ts` — users、credits、plans、providers、prices、payment-orders、audit、dashboard。
11. **支付**：`packages/providers/src/payment/` 抽象 + 单渠道实现 + 回调路由。

## 9. 前端改造清单

1. `apps/web/src/features/auth/` — 登录、注册、找回密码三个页面。
2. `apps/web/src/api/session.ts` — `useSession()`，启动时 `GET /auth/me`，未登录跳 `/login`。
3. 路由守卫：`app/router.tsx` 包一层 `RequireAuth`；`/admin/*` 再包 `RequireRole`。
4. `AppTopbar` 右侧加用户菜单（昵称、积分余额、账单、设置、退出）；管理员多一个「后台」入口。
5. 积分相关：生成按钮旁显示预计消耗；余额不足时禁用并引导充值。
6. `apps/web/src/features/billing/` — 充值页、订单列表、流水明细。
7. `apps/web/src/features/admin/` — 复用 antd，左侧菜单 + 表格；先做：仪表盘、用户、积分调整、Provider、价目、订单、审计日志。

## 10. 验收标准

阶段 1 完成，必须同时满足：

- [ ] 旧数据升级后不丢：升级前记录项目/资产/输出/花型数量，升级后逐项相等，且全部归到 bootstrap owner。
- [ ] 新用户注册 → 自动获得赠送积分 → 建项目 → 生成 → 余额按实际用量下降。
- [ ] 余额不足时创建任务被拒（402/422），且不产生 `jobs` 行。
- [ ] 任务明确失败 → 全额退回，流水有 `job_refund`。
- [ ] 任务在外部请求发出后中断 → `billing_orders.status='uncertain'`，**不**自动退款。
- [ ] 跨租户探针测试全绿。
- [ ] 被禁用用户所有接口返回 401，已发出的会话立即失效。
- [ ] 管理员调积分/封禁/改价都留下 `admin_audit_events`。
- [ ] 支付回调重复投递 5 次，积分只加一次。
- [ ] 存储：上传超配额返回 413 且不落盘；删除项目后已用空间立即下降；`size_bytes` 回填后与磁盘实际占用一致。
- [ ] `pnpm build`、`pnpm test`、`pnpm verify-contracts`、`pnpm test:e2e:mock` 全绿。

## 11. 工作量粗估

| 部分 | 相对量 | 风险 |
| --- | --- | --- |
| schema + 迁移 + 新仓储 | 中 | 低（幂等，可反复跑） |
| 认证 + 会话 + 守卫 | 中 | 低 |
| 仓储加 owner（16 模块 / 163 方法） | **大** | **中高**：机械但量大，编译器能兜住漏改 |
| 权益 + 计费 + 预扣接入 | 中 | 中：事务边界要想清楚 |
| 管理后台（接口 + 页面） | 大 | 低 |
| 支付（单渠道 + 回调 + 幂等） | 中 | 中：验签与幂等容易出细节错 |
| 前端登录/积分/充值页面 | 中 | 低 |

最大的单点风险是第 3 项。缓解办法就是 §6 的三层防护，尤其是"签名强制带 owner"——让编译器而不是人来保证完备性。

## 12. 已确认的三个决定

| 决定 | 结论 | 影响 |
| --- | --- | --- |
| 计价单位 | **积分** | 保留 `credit_accounts` / `credit_ledger_entries`；金额一律整数微积分 |
| 渠道费用 | **平台代付** | `providers` 与 `search_sources` 保持平台级、不加 `owner_id`；用户只读；必须有 `provider_model_prices` 才能算扣费 |
| 存储配额 | **阶段 1 做** | 先给 11 张表补 `size_bytes` 并回填；用聚合查询而非计数器 |

平台代付带来的一个额外要求：**用户看不到、也拿不到任何 Provider 的 API Key**。现有 `publicProvider()` 已经剥掉密钥字段，改造时要保证 `/api/v1/providers` 对普通用户只返回可用的模型清单，写操作一律 403。同时因为平台承担成本，`provider_model_prices.cost_microcredits`（平台成本）必须与售价分开记录，否则算不出毛利，也无法发现定价倒挂的模型。

## 13. 与参考项目的关系

`open-ai-canvas` 是 MIT，可以借鉴设计和代码。本文的积分账本、计费状态机、支付回调收件箱、权益键值表都参考了它的思路，但**没有直接复制它的表结构**——它是 Go + GORM，且按影视创作建模，直接搬会带进大量无关耦合。

如果要复用它的具体实现，注意保留其 MIT 版权声明（`LICENSE` 要求"substantial portions"保留声明），建议在仓库根加 `NOTICE` 或在对应文件头注明来源。
