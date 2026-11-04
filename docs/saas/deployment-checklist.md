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

正确做法（用 SQLite 官方的在线备份 API，不需要停服务）：

```bash
docker compose exec api node -e "
  const Database = require('/app/packages/core/node_modules/better-sqlite3');
  const db = new Database('/app/data/ecomgen.sqlite', { readonly: true });
  db.backup('/app/data/backup-' + Date.now() + '.sqlite')
    .then(() => { console.log('backup ok'); process.exit(0); })
    .catch((e) => { console.error(e.message); process.exit(1); });
"

# 再把备份文件与素材目录一起取出
docker compose cp api:/app/data ./backup-$(date +%F)
```

> 路径是 `/app/packages/core/node_modules/better-sqlite3` 而不是 `/app/node_modules/better-sqlite3`：
> pnpm 不会把依赖提升到根，`require` 根路径会失败。

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
