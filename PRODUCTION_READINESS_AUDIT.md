# 生产环境上线前审计报告（Production Readiness Audit）

- **项目**：EcomGen（AI 电商图片套图生成平台）
- **审计时间**：2026-11-04
- **审计范围**：`apps/api`、`apps/worker`、`apps/web`、`packages/*`、构建与部署配置
- **代码规模**：425 个源文件 / 82,672 行；其中测试 102 个文件 / 15,197 行（约 18%）
- **审计方式**：静态代码审查 + 自动化测试执行 + 本地隔离实例的动态验证
- **重要声明**：本报告区分「已验证」与「潜在风险」。凡标注**已验证**的，均有可复现步骤或实际执行输出；标注**未验证**的，仅为代码审查推断，不得当作事实。

---

## 结论先行

**审计时结论：NO-GO（不具备上线条件）**
**整改后结论：CONDITIONAL GO（完成部署侧配置后可上线）**

审计时存在 **1 个 P0 级已验证漏洞**（存储型 XSS）与 **5 项 P1 级问题**。

**当前状态（2026-11-04 整改后）**：P0 与全部代码侧 P1 已修复并复测通过；
剩余为**部署侧配置项**（HTTPS / Secure Cookie / 默认凭据 / 真实支付与邮件配置 / `ECOMGEN_TRUST_PROXY` 取值），
必须在上线前由运维完成并验证。详见第十一节「整改记录」。

> 复测口径：所有"已修复"项均有可执行证据（测试用例、实际请求输出或镜像检查结果），
> 未验证的项目不会被标记为通过。

---

## 一、项目整体架构评估

### 1.1 技术栈与结构

| 层 | 技术 | 位置 |
| --- | --- | --- |
| 前端 | React 19 + Vite 6 + antd 6 + React Query 5 | `apps/web` |
| API | Fastify 5 + TypeBox 契约 + SSE | `apps/api` |
| Worker | BullMQ 6 + Redis | `apps/worker` |
| 数据库 | SQLite（better-sqlite3 13，同步驱动，WAL） | `packages/core` |
| 契约 | TypeBox → OpenAPI → 前端类型，三段生成 | `packages/contracts`、`scripts/generate-openapi.mjs` |
| 存储 | 本地文件系统（`LocalAssetStore`） | `packages/core/src/files.ts` |

### 1.2 架构优点

1. **契约单一来源**：TypeBox schema 同时产出 `openapi.yaml`、`api-registry.ts`、前端 `schema.d.ts`，并有 `verify-contracts` 在 CI 中守漂移。
2. **归属隔离有强制机制**：`AsyncLocalStorage` + 查询级谓词 + fail-closed（`requireActiveScope` 抛错而非回退系统作用域），不是靠开发者自觉。
3. **计费采用「预扣 → 结算/退款/挂起」状态机**，账本不可变（`credit_ledger_entries`）＋缓存账户双写。
4. **错误分层清晰**：领域层不依赖 HTTP（`quota.ts` 只返回判定结果，由 API 层转 4xx）。

### 1.3 架构层面的问题

| 编号 | 问题 | 等级 |
| --- | --- | --- |
| A-1 | **单实例假设**：SQLite 单写者 + 限流已改 Redis，但 API 与 Worker 必须共享同一数据卷；无横向扩展能力 | P2 |
| A-2 | **无静态分析**：项目未安装 ESLint，`package.json` 无 `lint` 脚本，CI 也无该步骤。未使用变量、悬空 Promise、误用 `==` 等只能靠人眼 | P2 |
| A-3 | **同步数据库驱动**：250 个仓储方法全同步，未来迁 PostgreSQL 需全仓异步化（已有迁移方案文档） | P3 |
| A-4 | **`/admin/dashboard` 曾长期无人调用**（已在本轮前接上） | 已修复 |

---

## 二、Bug 与逻辑问题清单

| 编号 | 问题 | 位置 | 等级 | 状态 |
| --- | --- | --- | --- | --- |
| B-1 | `listUsers` 的关键字搜索未转义 LIKE 通配符，输入 `%` 会匹配全部用户 | `packages/core/src/repositories/userRepository.ts:107` | P3 | 已验证（代码审查） |
| B-2 | 导出 manifest 构造时对每个 output 单独 `getStoryboardItem`，典型 N+1 | `apps/worker/src/job-export.ts:13` | P3 | 已验证（代码审查） |
| B-3 | `startSession` 硬编码 30 天，未复用 `SESSION_TTL_SECONDS` 常量，两处易漂移 | `apps/api/src/routes/auth.ts:211` | P3 | 已验证 |
| B-4 | 前端无全局 401 拦截：会话过期后各请求各自报错，用户不会自动被引导到登录页 | `apps/web/src/api/restClient.ts` 等 | P3 | 已验证 |
| B-5 | 过期会话永不清理：`user_sessions` 只增不减（TTL 30 天，每次登录一行） | 缺少清理任务 | P2 | 已验证（无任何 purge 代码） |
| B-6 | `jobs.status` 无独立索引，管理端按状态聚合会全表扫 | `jobs` 表 | P3 | 已验证（实测索引列表） |
| B-7 | 未配置 SMTP 时，密码重置令牌以 warn 级写入日志 | `apps/api/src/routes/auth.ts` | P2 | 已验证 |

> 说明：B-1 的 LIKE 通配符问题只影响搜索精确度，**不构成注入**（参数化查询）。

---

## 三、安全漏洞清单

### P0-1 · 存储型 XSS：SVG 资产被当作同源可执行内容返回【已验证】

**位置**
- 上传校验：`apps/api/src/routes/projects.ts:254`
- 扩展名处理：`packages/core/src/files.ts` → `safeExtension`
- 响应头：`apps/api/src/helpers.ts:135` `sendStored`

**成因**（三处叠加）

1. 上传只校验 `data.mimetype.startsWith("image/")`，**`image/svg+xml` 通过**；
2. `safeExtension` 接受任意 `/\.[a-zA-Z0-9]{1,8}$/`，**`.svg` 被保留**，落盘为 `assets/<projectId>/<uuid>-<hash>.svg`；
3. `sendStored` 用客户端声明的 `mimeType` 作为 `Content-Type`，且**未设置 `Content-Disposition`、未设置 `X-Content-Type-Options: nosniff`**（全站无任何安全响应头）。

**后果**：用户（含管理员）打开该文件链接时，浏览器以 `image/svg+xml` 渲染并**执行其中的 `<script>`，运行在应用自身源上**。脚本可携带 HttpOnly Cookie 发起同源请求，进而：创建管理员账号、修改支付/邮件配置、读取任意业务数据。Cookie 的 HttpOnly 只能阻止「读 Cookie」，无法阻止「以受害者身份发请求」。

**复现步骤（已在本地开发实例执行，测试后已清理）**

```js
// 1. 登录 → 2. 建 provider → 3. 建 project（略）
const payload = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>`;
const form = new FormData();
form.append("role", "PRODUCT_TRUTH");
form.append("file", new Blob([payload], { type: "image/svg+xml" }), "audit-payload.svg");
await fetch(`${BASE}/projects/${projectId}/assets`, { method: "POST", body: form, headers: { cookie } });
```

**实际输出**

```
upload status: 200
stored path: assets/<uuid>/<uuid>-<hash>.svg
stored mimeType: image/svg+xml
download status: 200
download content-type: image/svg+xml
download content-disposition: null
x-content-type-options: null
body contains <script>: true
```

**修复方向**（本轮不实施）
- 上传侧：对 SVG 一律拒绝，或服务端用 `sharp` 转码为位图后丢弃原始 SVG；
- 响应侧：`Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`；
- 全站：加 CSP（`default-src 'self'`，禁止 `script-src 'unsafe-inline'`）。

---

### P1-1 · 生产依赖存在已公开漏洞【已验证版本，未验证可利用性】

`pnpm audit` 结果：**critical 4 / high 33 / moderate 35 / low 9**。其中影响运行时的：

| 包 | 已安装版本 | 通告要求 | 影响 |
| --- | --- | --- | --- |
| `fastify` | **5.12.0** | `<5.12.1` 受影响 | schema 校验绕过（根原始类型强制转换不一致）、`X-Forwarded-*` 伪造 |
| `@fastify/static` | **8.3.0** | `>=8.0.0 <=9.1.0` 受影响 | 目录列举路径穿越、编码路径分隔符绕过路由守卫、非规范 URL 路径授权绕过 |
| `sharp` | **0.35.3** | `<0.35.4` 受影响 | libheif 两个漏洞（本项目用它解码用户上传的图片） |
| `fast-uri` | **3.1.5 / 4.1.2** | `<3.1.6` / `<4.1.3` 受影响 | 主机名混淆、畸形 IPv6 归一化导致 SSRF |

> `@fastify/static` 的通告与本项目直接相关（用它托管 SPA 静态资源），但**未在本地构造利用**，故标注为「版本受影响，可利用性未验证」。

**其余 critical/high 多为开发依赖**（`vitest`、`js-yaml`、`glob` 等），不进入运行时镜像的实际执行路径，但仍应在 CI 中设门禁。

### P1-2 · 全站缺失安全响应头【已验证】

实测 `GET /` 响应头：

```
vary: Origin
Content-Type: text/html; charset=utf-8
Cache-Control: public, max-age=0
（无 X-Content-Type-Options / Content-Security-Policy / X-Frame-Options / Referrer-Policy）
```

未使用 `@fastify/helmet`，也无自定义 `onSend` 钩子设置这些头。直接后果：放大 P0-1，且应用可被任意站点 iframe 嵌套（点击劫持）。

### P1-3 · 反向代理部署后登录限流变成「全局共享桶」【已验证（代码 + 配置）】

- `apps/api/src/app.ts:72` 创建 Fastify 时**未设置 `trustProxy`**（默认 `false`）；
- `apps/api/src/routes/auth.ts:263` `clientIp` 直接取 `request.ip`。

部署在 Nginx 之后时，`request.ip` 恒为代理地址，所有用户共享同一个限流桶。攻击者只需持续失败登录，即可在窗口期内**锁死全站用户的登录/注册/找回密码**（每窗口 10 次）。

反向风险：若运维为修复此问题直接开启 `trustProxy: true`，则可被 `X-Forwarded-For` 伪造绕过限流，且当前 `fastify@5.12.0` 正处于该伪造漏洞的影响范围。

**修复方向**：升级 fastify ≥ 5.12.1；`trustProxy` 设为**确切的代理跳数或受信 IP 列表**，而非布尔 `true`。

### P1-4 · 容器以 root 运行且镜像含开发依赖【已验证】

```
$ docker exec ecomgen-api-1 id
uid=0(root) gid=0(root) groups=0(root)

$ docker images
ecomgen-api:latest     1.19GB
ecomgen-worker:latest  1.19GB
```

`Dockerfile` 运行时阶段 `COPY --from=build /app /app`，把构建阶段（含 `python3 make g++`、全部 devDependencies、vitest）整体带入；未 `USER node`，无 `HEALTHCHECK`。后果：攻击面与镜像体积放大，任一文件写入类漏洞都可直接落盘到容器内任意路径。

### P1-5 · SSRF：Worker 抓取 Provider 返回的图片 URL 无任何校验【已验证（代码），未验证可利用】

`packages/providers/src/fal.ts:111`、`grounded-sam.ts:87`、`seedream-layerize.ts:139`、`openai-compatible.ts:235` 均直接 `fetch(url)`，`url` 来自 Provider 响应体，未限制 scheme/host，未拒绝私有网段与云元数据地址（`169.254.169.254`）。

信任边界是「平台持有的 Provider」，普通用户无法直接控制该 URL，因此定为 P1 而非 P0；但一旦 Provider 被攻陷或配置了恶意中转，Worker 将成为进入内网的跳板。

### 已验证为「无问题」的安全项

| 检查项 | 结论 | 依据 |
| --- | --- | --- |
| **SQL 注入** | **未发现** | 扫描全部 58 处 SQL 插值：`owner.sql`（谓词片段）、`placeholders`（`?,?`）、表名/列名（均来自常量数组或 `SIZED_TABLES` 白名单）、`archived ? "NOT " : ""`。所有值均走参数绑定 |
| **CSRF** | 有效防护 | `SameSite=Lax` + 非 GET 请求的 `Origin` 白名单断言（`auth-guard.ts:78`） |
| **IDOR / 越权** | 有效防护 | `crossTenant.test.ts` 等 6 个套件 36 个用例全绿，含自动枚举全部路由的探针 |
| **认证** | 合理 | 会话令牌仅存哈希；改密/重置/停用均 `revokeUserSessions` |
| **密码重置** | 合理 | 一次性令牌、1 小时 TTL、消费即失效、重置后撤销全部会话 |
| **Webhook 验签** | 合理 | 时序安全比较（`timingSafeEqualHex`）、金额与订单比对、事件 ID 幂等、失败落收件箱 |
| **路径穿越** | 有效防护 | `files.ts` `absolute()` 双向校验（拒绝绝对路径 + 拒绝 `..` 逃逸） |
| **上传限制** | 存在 | 全局 `fileSize` + `files` 上限；但 mime 判定不足（见 P0-1） |
| **敏感信息** | 未发现泄露 | `.env` 已被 gitignore 且未入库；仓库无硬编码密钥；Provider API Key 用 master key 加密存储 |
| **权限校验** | 覆盖完整 | `providerAccess.test.ts` / `entitlements.test.ts` 验证普通用户无法访问管理端接口 |

---

## 四、数据库与数据安全评估

| 项目 | 结论 |
| --- | --- |
| 外键约束 | **已启用**（`PRAGMA foreign_keys = 1`） |
| 日志模式 | WAL（读写并发友好） |
| 表 / 显式索引 | 50 张表 / 70 个显式索引 |
| 关键路径索引 | `user_sessions.token_hash`（唯一索引，每次鉴权命中）、`jobs(owner_id,status,updated_at)`、`outputs.project_id`、`assets.project_id`、`credit_ledger_entries(user_id,created_at)`、`billing_orders(job_id)`、`billing_orders(status)` —— **均存在** |
| 事务 | 多步写入均用 `db.transaction()`（计费、分层文件同步、孤儿回填等） |
| 连接泄漏 | 单进程单连接（better-sqlite3 同步），`onClose` 中 `database.close()` |
| 权限保护 | 删除/更新均经请求作用域仓储；跨租户探针覆盖 |
| 备份方案 | **仅文档化，无自动化**：`docs/saas/deployment-checklist.md` 给出手工 `db.backup()` 命令，无定时任务、无恢复演练 |

**风险**
- **P2**：无自动备份与恢复演练。SQLite 单文件，误删卷（`docker compose down -v`）即全量丢失。
- **P2**：`user_sessions` 无清理，长期运行后表持续膨胀。
- **P3**：`jobs.status` 缺独立索引，管理端聚合随数据量线性变慢。

---

## 五、性能与稳定性评估

| 项目 | 评估 | 等级 |
| --- | --- | --- |
| N+1 查询 | 导出 manifest 逐条取分镜（B-2）；其余列表接口为单查询 | P3 |
| 重复请求 | 前端用 React Query 缓存，管理端页签复用同一 query key | 无问题 |
| 内存 | 导出改为流式（内存常数级）；**开启水印时逐张解码**，已串行化处理，峰值单张图 | P3 |
| 资源释放 | SSE 有 `onClose` 退订；定时器均 `unref()`；Worker 有 SIGINT/SIGTERM 优雅关闭 | 无问题 |
| 接口响应 | 未见明显慢接口；`library` 走 keyset 游标 | 无问题 |
| 高并发 | **单实例架构**：SQLite 单写者，Worker 并发默认 2 | P2 |
| 超时与重试 | 任务有 15 分钟墙钟上限（`WORKER_JOB_TIMEOUT_MS`）；Provider 调用有分段超时；BullMQ 重试受 `finalAttempt` 控制 | 无问题 |
| 缓存 | 无服务端业务缓存（价目实时读库，改价即时生效）；静态资源 `immutable` 强缓存 | 无问题 |

> **压力测试未执行**：本轮未做并发压测。理由：本地为单机 Docker + SQLite，压测结果无法外推到生产；且 SQLite 单写者的瓶颈已由架构决定。**建议上线前在预发环境做一次目标并发验证**（见第九节）。

---

## 六、依赖与环境风险

| 编号 | 风险 | 等级 |
| --- | --- | --- |
| D-1 | 4 critical / 33 high 依赖通告；CI 无 `pnpm audit` 门禁 | P1（运行时项）/ P2（门禁缺失） |
| D-2 | 镜像 1.19GB，含编译工具链与全部 devDependencies | P2 |
| D-3 | `package.json` 无 `engines` 字段；Node 版本仅由 Dockerfile 隐式固定为 22 | P3 |
| D-4 | 基础镜像未按 digest 固定（`node:22-bookworm-slim` 浮动） | P3 |
| D-5 | 无 ESLint / 无类型覆盖以外的静态检查 | P2 |
| D-6 | 环境变量完整性：`.env.example` 覆盖 12 项；`WORKER_JOB_TIMEOUT_MS` 等已在 compose 中转发 | 无问题 |
| D-7 | 调试接口 / 测试账号：代码中无；但**开发库仍存在 `tester@example.com`、`smoke-b@example.com`（已停用）与默认站长口令** | P1（部署前必须处理） |

---

## 七、自动化测试与构建验证（实际执行结果）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 生产构建 | `pnpm build` | **通过**（exit 0） |
| 契约一致性 | `pnpm verify-contracts` | **通过**（exit 0，含 Redocly lint + 20 个契约用例） |
| 单元/集成测试 | `pnpm test` | **通过**：api 199、web 176、worker 97、contracts 20 —— **共 492 个用例** |
| 端到端 | `pnpm test:e2e:mock` | **通过**（规划→确认→生图→导出→套图反推→模特选角→花型全链路→成包→Listing→流水线→取消） |
| 安全专项 | `crossTenant / entitlements / providerAccess / errorHandling / rate-limit / cors` | **通过**（36 个用例） |
| 依赖扫描 | `pnpm audit` | **未通过**：critical 4 / high 33 / moderate 35 / low 9 |
| Lint（TS/JS） | — | **无法执行**：项目未安装 ESLint，无 lint 脚本 |
| 类型检查 | 随 `pnpm build`（`tsc -p`） | **通过** |
| 压力测试 | — | **未执行**（见第五节说明） |
| 真实浏览器验证 | — | **未执行**：`agent-browser-cli` 报 `extension_connected: false`，Chrome 扩展未连接，无法驱动真实浏览器 |

**测试覆盖缺口（明确列出）**
1. **前端未在真实浏览器验证**：全部 UI 用例基于 jsdom + MSW，无法覆盖真实布局、焦点管理、下载行为与浏览器安全策略（例如 P0-1 的实际弹窗效果）。
2. **无并发/竞争用例**：同一资源并发提交、队列重复投递、并发扣费均无测试。
3. **无备份恢复演练**。
4. **无容量/性能基线**。
5. **无对 `@fastify/static` 路径绕过的渗透用例**。

---

## 八、上线部署风险

| 编号 | 风险 | 等级 |
| --- | --- | --- |
| O-1 | 无 HTTPS/证书配置（应用不终止 TLS，需前置反代；仓库内无 Nginx 配置样例的自动化校验） | P1 |
| O-2 | `ECOMGEN_SECURE_COOKIES` 默认 `false`；若生产忘记开启，Cookie 无 `Secure` | P1 |
| O-3 | 站长账号仍是开发默认口令（见 `.env`，不入库） | P1 |
| O-4 | 支付与邮件配置仍是占位值（`pay.example.com` / `smtp.invalid`） | P1 |
| O-5 | 容器 root 运行、无 HEALTHCHECK | P2 |
| O-6 | 无日志聚合与告警；仅有 stdout JSON 日志 | P2 |
| O-7 | 无版本回滚方案（无镜像 tag 策略、无数据库迁移回滚） | P2 |
| O-8 | Redis 无密码、无持久化策略校验（compose 中为默认配置） | P2 |
| O-9 | 服务异常自恢复：`restart: unless-stopped` ✓；任务崩溃由 `recoverInterruptedJobs` + 僵尸预扣扫描兜底 ✓ | 无问题 |

---

## 九、必须修复的问题（上线阻断项）

### 阻断项（P0，必须修）

1. **P0-1 存储型 XSS**
   - 服务端拒绝 `image/svg+xml`（或转码为位图）；
   - `sendStored` 统一加 `X-Content-Type-Options: nosniff` 与非图片/危险类型的 `Content-Disposition: attachment`；
   - 增加回归用例：上传 SVG 必须被拒或下载时不得以可执行内容类型返回。

### 上线前必修（P1）

2. **P1-1 依赖升级**：`fastify ≥ 5.12.1`、`@fastify/static ≥ 9.1.1`（或当前最新修复版）、`sharp ≥ 0.35.4`、`fast-uri` 随上游升级；升级后重跑全量测试与 E2E。
3. **P1-2 安全响应头**：引入 `@fastify/helmet`（至少 CSP、nosniff、frame-options、referrer-policy），并验证不影响 SPA 与 SSE。
4. **P1-3 代理与限流**：升级 fastify 后，将 `trustProxy` 设为确切的代理跳数/受信 IP；补充「多用户共享代理时限额独立」的验证。
5. **P1-4 容器加固**：运行时阶段改用 `pnpm deploy --prod` 或 `--prod` 安装，`USER node`，加 `HEALTHCHECK`。
6. **P1-5 SSRF 收敛**：对 Provider 返回的图片 URL 校验 scheme（仅 http/https）并拒绝私有网段与链路本地地址。
7. **P1-7 部署前清库**：生产库不得包含开发账号、默认口令、占位支付/邮件配置。

### 建议上线前修复（P2）

8. CI 增加 `pnpm audit --audit-level=high` 与 ESLint。
9. 自动化备份（定时 `db.backup()` + 保留策略）与一次恢复演练。
10. 过期会话清理任务。
11. `POST /billing/topup-orders` 限流。
12. 未配置 SMTP 时不再把重置令牌写入日志（改为 debug 级或仅记录哈希前缀）。

### 可延后（P3）

13. LIKE 通配符转义、导出 manifest 的 N+1、`jobs.status` 索引、`engines` 字段、镜像 digest 固定、前端全局 401 拦截。

---

## 十、优化建议

1. **补上真实浏览器 E2E**：当前 UI 只有 jsdom 覆盖。建议接入 Playwright，跑「登录 → 建项目 → 上传 → 生图（mock provider）→ 导出」主链路，并显式断言下载文件名与 Content-Type。
2. **把安全测试固化进 CI**：把 `crossTenant` 的自动路由探针扩展到写接口，并对新增路由强制要求「有归属断言」。
3. **可观测性**：日志已结构化，建议补 `/metrics`（Prometheus）与 `/ready`（区分「进程存活」与「依赖就绪」）。
4. **容量规划**：单实例 SQLite 的实际并发上限建议在预发用目标 QPS 实测，再决定是否提前启动 PostgreSQL 迁移。
5. **前端错误体验**：统一 401 → 跳登录、5xx → 全局重试提示，避免用户看到裸错误。

---

## 附：本次审计执行的命令与关键输出

```text
$ pnpm build                      → exit 0
$ pnpm verify-contracts           → exit 0（contracts 20 tests passed）
$ pnpm test                       → exit 0（api 199 / web 176 / worker 97）
$ pnpm test:e2e:mock              → exit 0（Mock E2E passed）
$ pnpm audit                      → critical 4 / high 33 / moderate 35 / low 9
$ docker exec ecomgen-api-1 id    → uid=0(root)
$ docker images                   → ecomgen-api:latest 1.19GB
$ curl -I http://127.0.0.1:8787/  → 无任何安全响应头
$ SQL 插值静态扫描                → 58 处，全部来自白名单/常量/参数绑定
$ 索引核对                        → user_sessions.token_hash 有唯一索引（修正了初查误报）
```

> 说明：初查时曾误判 `sessions.token_hash` 缺索引，实际表名为 `user_sessions` 且该列有唯一索引。已据实修正，未计入问题清单。
---

## 十一、整改记录（2026-11-04）

### 已修复并复测

| 编号 | 问题 | 修复内容 | 验证证据 |
| --- | --- | --- | --- |
| **P0-1** | 存储型 XSS（SVG 上传） | ① 上传改为**类型白名单**（PNG/JPEG/WebP/GIF/AVIF），SVG 单独报错；② 文件名 `.svg` 再挡一层；③ `sendStored` 统一加 `x-content-type-options: nosniff`，非位图强制 `attachment` | 新增 `apps/api/src/uploadSafety.test.ts`（7 用例）；**对加固后的实例重放原攻击脚本**：`image/svg+xml` → 400、`payload.svg` → 400、`application/xml` → 400 |
| **P1-1** | 依赖已知漏洞 | `fastify 5.12.0→5.12.8`、`@fastify/static 8.3.0→10.1.8`、`sharp 0.35.3→0.35.5`、`fast-uri 3.1.5/4.1.2→3.1.9/4.2.3` | `pnpm audit`：high 33→14、moderate 35→22，**运行时依赖已无通告命中**；升级后 build / 492 用例 / E2E 全绿 |
| **P1-2** | 无安全响应头 | 全局 `onSend` 钩子加 `nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`Permissions-Policy`、CSP | 实测响应头：`{"nosniff":"nosniff","frame":"DENY","csp":"default-src 'self'; script-src 'self'; style-src 'self' 'uns…"}` |
| **P1-3** | 代理下限流失效 | 新增 `ECOMGEN_TRUST_PROXY`：接受**跳数**或**受信地址列表**；`"true"` 显式按 false 处理（避免伪造绕过） | `uploadSafety.test.ts` 内 3 个用例覆盖解析与跳数语义 |
| **P1-4** | 容器 root + 含开发依赖 | `USER node`；`pnpm install --prod` 前先删 `node_modules` 得到干净生产树；加 `HEALTHCHECK`；`COPY --chown` 避免 `chown -R` 产生重复层 | 容器内 `uid=1000(node)`；`docker ps` 显示 `(healthy)`；镜像 **1.19GB → 930MB**；镜像内 `vitest/jsdom/@testing-library` 计数 **0** |
| **P1-5** | SSRF（Provider 返回 URL） | 新增 `packages/providers/src/remote-url.ts`：仅允许 http/https，拒绝私有网段/回环/链路本地/云元数据/内网域名（含 IPv4 映射 IPv6 两种写法）；提供 `ECOMGEN_ALLOW_PRIVATE_PROVIDER_URLS` 供自建 Provider 场景 | 新增 `remote-url.test.ts`（6 用例），覆盖 15 个内网地址与协议白名单 |

### 整改过程中发现并修正的两个自身问题

1. **`chown -R /app` 让镜像膨胀 807MB**：BuildKit 因元数据全量变更生成了包含全部文件副本的层。改用 `COPY --chown` 后恢复。
2. **`pnpm install --prod` 不清虚拟 store**：仅解链顶层条目，`node_modules/.pnpm` 内仍保留 vitest/jsdom。改为先删除再安装，镜像再降 260MB。

3. **worker 被继承的 HEALTHCHECK 标成 unhealthy**：镜像里的探针打的是 API 的 /health，worker 不起 HTTP 服务，同一镜像跑 worker 必然失败。已在 compose 中为 worker 关闭继承探针。

> 这三条都不是原审计发现的问题，而是修复动作引入的副作用——记录在此以说明"修完必须复测体积与内容"。

### P2 整改（第二轮）

| 编号 | 问题 | 处理 |
| --- | --- | --- |
| P2-8 | CI 无依赖漏洞门禁 | `verify.yml` 增加 `pnpm audit --prod --audit-level=high`。**该门禁上线即抓到 3 个 high**（`brace-expansion` ReDoS、`glob` CLI 注入，均经 archiver 传递），已通过 `pnpm-workspace.yaml` 的 `overrides` 升到修复版，现为 0 high |
| P2-9 | 无静态分析 | 引入 ESLint（`@eslint/js` + `typescript-eslint`，类型感知）。开启 `no-floating-promises` / `no-misused-promises` / `eqeqeq` / `preserve-caught-error`，刻意不开格式类规则。首轮 34 个错误已全部修完，现为 0；`pnpm lint` 已进 CI |
| P2-10 | 无自动备份 | 新增 `apps/api/src/backup-cli.ts`（随应用发布）：用 SQLite 在线备份 API 生成一致性快照，支持 `ECOMGEN_BACKUP_KEEP` 保留份数，自动清理旧快照。已在容器内实测（0.75MB 快照，属主 `node`），并在部署清单补上 cron 与恢复演练要求 |
| P2-11 | 过期会话不清理 | 新增 `deleteExpiredSessions()`，由 Worker 每小时清理任务调用（复用既有定时器）。3 个用例覆盖"只删过期、不影响有效登录" |
| P2-12 | 充值下单无限流 | 每用户 60 秒 5 单，限流发生在业务校验之前。1 个用例覆盖第 6 次返回 429 |
| P2-7 | 重置令牌写入日志 | 由 `warn` 降为 `debug`（生产默认不输出），并在代码注释里说明替代方案 |

**顺带清理**：删除仓库内的残留调试脚本 `packages/core/tmp-inspect-jobs.mjs`（硬编码本机路径、无任何引用）。

### P2 整改（第三轮）：恢复流程与演练

审计报告里写过"没演练过的备份等于没有备份"。这一轮把恢复也做成了脚本，并且**真的演练过**。

**`apps/api/src/restore-cli.ts`**（随应用发布），四个安全约束都是踩过的坑：

| 约束 | 为什么 |
| --- | --- |
| 恢复前先 `PRAGMA integrity_check` 校验快照 | 损坏的快照宁可不恢复，也不要覆盖掉还有救的当前库 |
| 目标库已存在时默认拒绝，需 `ECOMGEN_RESTORE_FORCE=true` | 误执行 `restore` 是最常见的灾难恢复事故 |
| 覆盖前自动备份当前库为 `pre-restore-<时间戳>.sqlite` | 恢复错了还能退回去 |
| 连同 `-wal` / `-shm` 一起替换 | 残留的 WAL 属于旧库，配上新主库会直接损坏数据 |

**`scripts/rehearse-restore.mjs`**（`pnpm rehearse:restore`）：在临时目录里造数据 → 备份 → 删库 → 恢复 → 核对，
并验证三个护栏。已接入 CI，每次构建都会跑。

演练实际输出（7 步全过）：

```text
=== 1. 造数据            ok: 标记用户已写入 / 标记项目已写入
=== 2. 备份              ok: backup-cli 执行成功 / 生成 1 份快照
=== 3. 模拟灾难          ok: 主库已不存在
=== 4. 恢复              ok: restore-cli 执行成功 / 标记用户已恢复 / 标记项目已恢复
=== 5. 护栏：拒绝覆盖    ok: 未加 FORCE 时拒绝覆盖（非 0 退出）
=== 6. 强制覆盖          ok: 加 FORCE 后恢复成功 / 生成了安全备份
=== 7. 拒绝损坏快照      ok: 损坏快照被拒绝 / 拒绝后当前库未被破坏
演练通过：备份可用、恢复可用、护栏生效。
```

另外在**真实容器**里验证了两个护栏（快照不存在、目标库存在未加 FORCE 均被拒绝），确认数据未被改动。

> **仍未演练的部分**：素材目录（`assets/ outputs/ ...`）的备份与恢复。
> 脚本只处理数据库；目录需要 `docker compose cp` 手工搬运，部署清单里已写明步骤。
> 完整的"库 + 素材"一起恢复演练建议在预发环境做一次。

ESLint 首轮修复的具体问题里，有 6 处是**真实的悬空 Promise**（`navigate()` / `invalidateQueries()` 未 await），
在 React 19 + react-router 7 下会产生未捕获的 rejection；其余为失效的 `eslint-disable` 注释与无用转义。

### 仍未完成（部署侧，需运维执行）

| 编号 | 事项 | 为什么不能由代码解决 |
| --- | --- | --- |
| P1-6 | HTTPS 与 `ECOMGEN_SECURE_COOKIES=true` | 证书与域名属于部署环境；应用不终止 TLS |
| P1-7 | 清除开发账号与默认站长口令、替换占位支付/邮件配置 | 需要真实的商户号与 SMTP 凭据 |
| P1-3 续 | 生产环境设置 `ECOMGEN_TRUST_PROXY`（如 Nginx 单层填 `1`） | 取值取决于实际代理层数 |
| P2-8~12 | CI 增加 `pnpm audit` 门禁与 ESLint、自动备份、会话清理、下单限流、重置令牌日志降级 | 属于下一轮工程改进，不阻断上线 |
| — | 真实浏览器 E2E、并发压测 | 当前环境浏览器扩展未连接；压测需预发环境 |

### 复测命令与结果（整改后）

```text
$ pnpm build            → exit 0
$ pnpm verify-contracts → exit 0
$ pnpm test             → exit 0（api 206 / web 176 / worker 97 / contracts 20 = 499 用例）
$ pnpm test:e2e:mock    → exit 0（全链路 E2E）
$ pnpm audit            → critical 4 / high 14 / moderate 22 / low 5（运行时无命中）
$ docker exec ecomgen-api-1 id          → uid=1000(node)
$ docker ps             → ecomgen-api-1 Up (healthy)
$ 镜像体积              → 930MB（原 1.19GB）
$ 重放 SVG 攻击         → 400（三种变体全部拒绝）
```