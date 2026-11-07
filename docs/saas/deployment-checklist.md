# 上线部署清单

> 依据：`docker-compose.yml`、`.env.example`、`apps/api/src/app.ts`、`auth-guard.ts`、`rate-limit.ts`、`packages/core/src/database.ts` 的当前实现。
> 每一条都对应代码里的真实行为，不是通用建议。

## 1. 阻断项：不改就不能上线

| # | 项目 | 现状 | 必须改成 |
| --- | --- | --- | --- |
| 1 | `ECOMGEN_MASTER_KEY` | `.env.example` 是占位符 | 生成真实的 32 字节密钥。**上线后不可再改**——它加密着所有 Provider API Key，换了等于全部失效 |
| 2 | `ECOMGEN_BOOTSTRAP_PASSWORD` | 开发环境用的是仓库里的默认值（见 `.env`，不入库） | 改成强密码，或**留空**让启动日志打印一次性随机密码 |
| 3 | `ECOMGEN_SECURE_COOKIES` | `false` | HTTPS 部署下必须 `true` |
| 4 | `public_base_url`（站点设置） | 开发值是 `http://127.0.0.1:8787` | 改成公网 HTTPS 域名。支付回调与密码重置链接都由它派生 |
| 5 | 支付渠道 | 开发值是占位 `https://pay.example.com/` + 假商户号 | 换成真实易支付商户信息 |
| 6 | SMTP | 开发值是占位 `smtp.invalid` | 换成真实邮件服务商（国内多为**授权码**而非登录密码） |
| 7 | 站长密码 | 开发环境是默认口令 | 登录后立即在个人设置里改掉 |

> 第 3 条的两个方向都会坏：`Secure` 为 `false` 时 HTTPS 站点仍能登录，只是 cookie 少了保护；设成 `true` 却用 HTTP 访问，浏览器**不会回传 cookie**，表现为"登录成功但立刻掉线"。

## 2. 环境变量

以下变量现在都由 `docker-compose.yml` 显式转发，在 `.env` 里改就会生效：

| 变量 | 作用 | 默认值 |
| --- | --- | --- |
| `WORKER_CONCURRENCY` | Worker 并发数 | `2` |
| `WORKER_JOB_TIMEOUT_MS` | 单任务墙钟上限 | `900000`（15 分钟） |
| `ECOMGEN_QUEUE_NAME` | 队列名（API 与 Worker 必须一致） | `ecomgen` |
| `ECOMGEN_CORS_ORIGINS` | 前端来源白名单，逗号分隔 | 空（只允许本机 dev server） |
| `ECOMGEN_TRUST_PROXY` | 受信代理跳数或地址列表 | 空（不信任任何代理） |
| `ECOMGEN_ALLOW_PRIVATE_PROVIDER_URLS` | 允许 Provider 返回内网图片 URL | `false` |

### `ECOMGEN_TRUST_PROXY`：放在反代后面必须设置

**不设置它的后果**：`request.ip` 恒为反向代理的地址，所有用户共享同一个限流桶。
攻击者只要持续失败登录，就能在窗口期内把**全站**的登录/注册/找回密码一起锁死。

| 部署形态 | 取值 |
| --- | --- |
| 无反向代理（直接暴露） | 不设置 |
| Nginx / Caddy 单层 | `1` |
| CDN + 反代两层 | `2` |
| 只信任特定地址 | `10.0.0.5,172.17.0.0/16` |

> **绝对不要写 `true`**。代码会显式把它当作 `false` 处理——无条件信任
> `X-Forwarded-For` 会让限流可被伪造请求头绕过，等于没有限流。

### `ECOMGEN_ALLOW_PRIVATE_PROVIDER_URLS`

Worker 会下载 Provider 返回的图片 URL。默认拒绝私有网段、回环、链路本地与云元数据地址
（`169.254.169.254`），防止被攻陷的 Provider 把 Worker 当成进入内网的跳板。
**只有**自建 Provider 且确实部署在内网时才打开。

> **同源部署（API 自托管 Web）不需要 CORS**，留空即可。
> 一旦把前端拆到别的域，必须设置 `ECOMGEN_CORS_ORIGINS`，否则前端所有请求被 CORS 拦掉，
> 而 API 日志里看不到明显错误。
>
> 空串按"未配置"处理：`${ECOMGEN_CORS_ORIGINS:-}` 在未设置时产生空串，
> 若把它当成"显式配置了一个空来源"，容器会启动即崩。

## 3. 反向代理与 TLS

应用本身**不终止 TLS**，`HOST=0.0.0.0:8787` 是明文 HTTP。必须前置 Nginx / Caddy：

```nginx
server {
  listen 443 ssl http2;
  server_name your-domain.com;

  # SSE 长连接：必须关缓冲，否则 /api/v1/events 会卡住不推送
  location /api/v1/events {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 1h;
  }

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

两个容易漏的点：

- **`proxy_buffering off`** 只对 SSE 路径需要。全局关掉会让图片下载变慢。
- **`proxy_set_header Host $host`** 必须设：`public_base_url` 未配置时，回调与重置链接是从请求头推导的，缺了它会推出容器内网地址。

## 4. 数据与备份

业务数据全部在 `ecomgen_data` 命名卷里：

```
/app/data/ecomgen.sqlite        # 主库（WAL 模式，还有 -wal / -shm 两个伴随文件）
/app/data/assets/               # 上传素材
/app/data/outputs/              # 生成结果
/app/data/exports/ layers/ patterns/ print-packs/ thumbs/ ...
```

**备份不能只拷 `.sqlite`**：WAL 模式下未 checkpoint 的事务在 `-wal` 里，只拷主文件会丢最近的数据。实测过：主库文件 4 KB，而一致性备份出来 733 KB —— 差的全部在 WAL 里。

正确做法（用 SQLite 官方的在线备份 API，不需要停服务）。仓库已内置 CLI：

```bash
# 生成一份一致性快照到 /app/data/backups/，并自动清理旧快照
docker compose exec -T api node apps/api/dist/backup-cli.js

# 保留最近 14 份（默认 7）
docker compose exec -T -e ECOMGEN_BACKUP_KEEP=14 api node apps/api/dist/backup-cli.js

# 把快照取出到宿主机
docker compose cp api:/app/data/backups ./backups
```

建议用宿主 cron 每天跑一次：

```cron
0 3 * * * cd /srv/ecomgen && docker compose exec -T api node apps/api/dist/backup-cli.js >> /var/log/ecomgen-backup.log 2>&1
```

> **备份必须包含素材目录**。数据库只记录路径，真正的图片在 `assets/ outputs/ layers/ exports/ patterns/` 下。
> 只恢复数据库、不恢复这些目录，结果是"记录都在、图全打不开"。
> 完整做法：`docker compose cp api:/app/data ./backup-$(date +%F)`（含库与全部产物）。

> **恢复演练**：至少做一次"把快照放进空卷 → 启动 → 登录并打开一个项目"的验证。
> 没演练过的备份等于没有备份。

### 恢复流程

**先停服务**。运行中的进程持有数据库连接，替换主库会导致它继续写旧文件。

```bash
docker compose stop api worker

# 1) 看有哪些快照，挑一份（脚本会先校验完整性，损坏的直接拒绝）
docker compose run --rm api node apps/api/dist/restore-cli.js /app/data/backups/ecomgen-<时间戳>.sqlite

# 2) 如果目标库还在，需要显式确认覆盖（脚本会先把当前库备份成 pre-restore-<时间戳>.sqlite）
docker compose run --rm -e ECOMGEN_RESTORE_FORCE=true api \
  node apps/api/dist/restore-cli.js /app/data/backups/ecomgen-<时间戳>.sqlite

# 3) 恢复素材目录（数据库只记路径，不恢复它就会「记录都在、图全打不开」）
docker compose cp ./backup-2026-11-05/assets api:/app/data/
docker compose cp ./backup-2026-11-05/outputs api:/app/data/

docker compose start api worker
```

脚本会做四件事：校验快照 `integrity_check`、给当前库做安全备份、连同 `-wal`/`-shm` 一起替换、
恢复后再校验一次并打印关键表行数。

### 演练

```bash
pnpm rehearse:restore
```

在临时目录里造数据 → 备份 → 删库 → 恢复 → 核对，并验证三个护栏
（拒绝覆盖已有库、强制覆盖前留安全备份、拒绝损坏快照）。**CI 每次都会跑这个演练。**


`docker compose down -v` 会**删除命名卷**，即清空所有数据。升级时只用 `docker compose down`（不带 `-v`）。

## 5. 已知架构限制（单实例假设）

这些不是 bug，是当前设计的边界。越过之前必须先改代码：

| 限制 | 表现 | 越过前要做什么 |
| --- | --- | --- |
| ~~**限流是进程内内存**~~ | ~~多实例部署时每个实例各算一份，实际放行量翻倍~~ | **已解决**：限流已改为 Redis 计数（`apps/api/src/rate-limit.ts`），多实例共享同一份配额 |
| **API 与 Worker 共用同一个 SQLite 文件** | 两者必须在同一台主机、同一个卷上 | 拆分前先迁 PostgreSQL |
| **SQLite 单写者** | 写入排队；管理后台的大统计查询会拖慢写事务 | 同上 |
| **没有内置 TLS** | 明文 HTTP | 必须前置反代 |
| **`uncertain` 计费单无提醒** | 只能靠人主动看后台 | 加定时扫描 + 通知 |

> 限流键的命名是 `ecomgen:ratelimit:<场景>:<标识>`，TTL 就是窗口长度。
> 需要手工解封某个账号时：`redis-cli --scan --pattern "ecomgen:ratelimit:login:<邮箱>:*" | xargs -r redis-cli DEL`。
>
> Redis 不可用时限流会**退回进程内存**并只记一次日志——登录接口不能因为限流组件故障整体 500。
> 代价是那段时间的限流会弱化到单实例语义。

**什么时候该迁 PostgreSQL**：出现第二个 API 实例、或写入排队开始影响体验、或单库超过几十 GB。在那之前 SQLite 不是瓶颈。

## 6. 上线验收（逐条可执行）

```bash
BASE=https://your-domain.com/api/v1

# 1. 健康检查
curl -s https://your-domain.com/health
# 期望：{"status":"ok","webResearchAvailable":false}

# 2. 未登录必须被拒
curl -s -o /dev/null -w "%{http_code}\n" $BASE/projects
# 期望：401

# 3. 注册默认关闭
curl -s -o /dev/null -w "%{http_code}\n" -X POST $BASE/auth/register \
  -H 'content-type: application/json' -d '{"email":"x@y.com","password":"12345678"}'
# 期望：403（要开放注册时再在后台打开）

# 4. 登录并确认 cookie 带 Secure
curl -si -X POST $BASE/auth/login -H 'content-type: application/json' \
  -d '{"email":"owner@your-domain.com","password":"..."}' | grep -i set-cookie
# 期望：包含 HttpOnly、SameSite=Lax、Secure

# 5. 管理接口可达
curl -s -b cookies.txt $BASE/admin/dashboard | head -c 200
# 期望：包含 users / billing / credits 等分组

# 6. 支付回调地址可从公网访问（在管理后台「支付配置」保存后）
curl -s -w " [%{http_code}]\n" -X POST $BASE/payments/notify/epay
# 期望：200 + 文本 success（渠道已配置）
#       200 + 文本 fail（渠道未配置 —— 链路通、配置没到位，不是路由问题）
# 关键是 200 + 纯文本：拿到 404/405 说明路径或反代不对

# 7. 邮件连通性：管理后台「邮件」页签点「测试连接」
# 期望：提示"连接与认证通过"
```

> 第 6 条：这个接口**永远返回 200**，即使验签失败也返回 `success`——否则网关会无限重投。
> 所以"200"只证明链路通，不证明配置对。真正的判据是响应体：`success` = 已配置，`fail` = 未配置。

> SSE 路径 `/api/v1/events` 需要登录态（在鉴权钩子的保护范围内），未带 Cookie 会返回 401，这是正确的。
> 排查"实时刷新不工作"时不能拿裸 curl 试，要带 Cookie 看是否持续收到心跳。

第 6 条要特别注意：**回调地址必须公网可达**。若 `public_base_url` 还是 `127.0.0.1`，用户付了钱网关通知打不进来，订单会永远停在 `pending`，只能靠管理后台「对账」页的"已付未入账"人工发现。

## 7. 日常运维

- **`uncertain` 计费单**：每次 Provider 超时或进程崩溃都会产生。定期看 `/admin` 的「待裁决计费单」，用 settle/refund 收口。
- **对账**：`/admin/payment-orders/reconcile` 列出"已付未入账"与"超期未付"两类异常，建议每天看一次。
- **审计**：`/admin/audit` 记录所有管理动作（改余额、封禁、改价目、改支付/邮件配置）。
- **日志**：API 与 Worker 都是 JSON 行日志，`docker compose logs -f api worker`。

## 8. 上线后建议立刻做的两件事

1. **关闭 `password_reset_expose_token`**（默认已是 false，确认没被打开过）。打开时重置令牌会直接出现在接口响应里。
2. **确认注册开关状态**（`app_settings.registration_enabled`，默认 `false`）。要开放注册的话，先补邮件验证或邀请码，否则会被批量刷号——限流是按 IP 的，换 IP 即可绕过。
