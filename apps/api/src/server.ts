import { resolve } from "node:path";
import { resolveDataDir } from "@ecomgen/core";
import { buildApi } from "./app.js";
import { corsOriginsFromEnv } from "./cors.js";

const masterKey = process.env.ECOMGEN_MASTER_KEY;
if (!masterKey) throw new Error("ECOMGEN_MASTER_KEY must be a base64-encoded 32-byte key");
const projectRoot = resolve(import.meta.dirname, "../../..");
const app = await buildApi({
  dataDir: resolveDataDir(process.env.ECOMGEN_DATA_DIR, projectRoot),
  redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  masterKey,
  corsOrigins: corsOriginsFromEnv(process.env.ECOMGEN_CORS_ORIGINS),
  // 生产走 HTTPS 必须开启；本地 http 调试保持关闭，否则浏览器不回传会话 cookie。
  secureCookies: process.env.ECOMGEN_SECURE_COOKIES === "true",
  bootstrap: {
    email: process.env.ECOMGEN_BOOTSTRAP_EMAIL,
    password: process.env.ECOMGEN_BOOTSTRAP_PASSWORD,
  },
});
await app.listen({ host: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 8787) });

// 收到终止信号时尝试优雅关闭；SSE 等长连接可能阻塞 close()，超时后强制退出兜底。
// Windows 上 wrapper 的 taskkill 强杀路径不经过这里，孤儿清理由 watchdog 负责兜底。
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    const forceTimer = setTimeout(() => process.exit(0), 3000);
    forceTimer.unref();
    void app.close().finally(() => process.exit(0));
  });
}
