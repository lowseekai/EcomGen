import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS, hashToken, ownerScope, runWithScope, type EcomRepository, type UserRecord } from "@ecomgen/core";

import { ApiError } from "./errors.js";

declare module "fastify" {
  interface FastifyRequest {
    /** 当前登录用户；未登录为 null。只在经过鉴权钩子后有意义。 */
    authUser: UserRecord | null;
    /** 当前会话 id；未登录为 null。 */
    authSessionId: string | null;
  }
}

/**
 * 免鉴权的接口白名单（按路径匹配，忽略查询串）。
 *
 * 只放"必须能匿名访问"的入口：登录、注册、登出、找回密码。
 * 注意这些路径**完全不解析会话**——它们自己处理凭证，钩子不介入。
 */
const PUBLIC_API_PATHS = new Set([
  "/api/v1/auth/login",
  "/api/v1/auth/register",
  "/api/v1/auth/logout",
  "/api/v1/auth/password-reset/request",
  "/api/v1/auth/password-reset/confirm",
]);

/**
 * 可选登录：有会话就解析出身份，没有也放行。
 *
 * `/auth/me` 必须走这里而不是上面的白名单——前端启动时无条件调它判断状态，
 * 若被当成"完全公开"直接跳过，带 cookie 也拿不到用户，登录态就永远读不出来。
 */
const OPTIONAL_AUTH_PATHS = new Set(["/api/v1/auth/me"]);

/**
 * 前缀白名单：支付网关的异步通知不带我们的会话 Cookie，必须匿名可达。
 *
 * 安全性不靠会话，靠网关签名——路由内部会验签（见 payment.ts 的 verifySignature），
 * 验签失败的回调只会落一条 failed 收件箱记录，不会入账。
 */
const PUBLIC_API_PREFIXES = ["/api/v1/payments/notify/"];

/** 会话最后活跃时间的回写节流：每个请求都写库会让 SQLite 变成写热点。 */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export interface AuthGuardOptions {
  repository: EcomRepository;
  /** CORS 允许来源，同时用作同源校验的白名单。 */
  allowedOrigins: string[];
}

/**
 * 统一鉴权入口。
 *
 * 只拦 `/api/v1/*`：静态资源与 SPA 外壳必须匿名可达，否则登录页自己都加载不出来。
 *
 * CSRF 采用两道：
 * 1. Cookie 是 SameSite=Lax，跨站 POST 根本带不上凭证；
 * 2. 这里再校验 `Origin`：存在且不在白名单就拒绝。缺失 Origin 时放行——
 *    浏览器发起跨站请求一定会带 Origin（那道已被 SameSite 挡住），
 *    而 curl / 服务端调用 / 测试注入本来就没有 Origin。
 */
export function registerAuthGuard(app: FastifyInstance, options: AuthGuardOptions): void {
  app.decorateRequest("authUser", null);
  app.decorateRequest("authSessionId", null);

  app.addHook("onRequest", (request: FastifyRequest, reply: FastifyReply, done: (error?: Error) => void) => {
    void reply;
    try {
      const path = pathname(request.url);
      if (!path.startsWith("/api/v1/")) return done();
      if (PUBLIC_API_PATHS.has(path)) return done();
      if (PUBLIC_API_PREFIXES.some((prefix) => path.startsWith(prefix))) return done();

      const optional = OPTIONAL_AUTH_PATHS.has(path);
      assertSameOrigin(request, options.allowedOrigins);

      const token = readSessionCookie(request.headers.cookie);
      if (!token) {
        if (optional) return done();
        throw new ApiError(401, "UNAUTHORIZED", "请先登录");
      }

      const found = options.repository.findActiveSession(hashToken(token));
      if (!found) {
        if (optional) return done();
        throw new ApiError(401, "UNAUTHORIZED", "登录已过期，请重新登录");
      }
      if (found.user.status !== "active") {
        // 封禁必须立即生效：撤销全部会话，旧 Cookie 再也换不到身份。
        options.repository.revokeUserSessions(found.user.id);
        if (optional) return done();
        throw new ApiError(401, "UNAUTHORIZED", "账号已被禁用");
      }

      request.authUser = found.user;
      request.authSessionId = found.session.id;

      const lastSeen = Date.parse(found.session.lastSeenAt);
      if (Number.isFinite(lastSeen) && Date.now() - lastSeen > TOUCH_INTERVAL_MS) {
        options.repository.touchSession(found.session.id);
      }

      // 关键：在归属作用域内调用 done()。Fastify 在 done() 的同步调用栈里继续跑后续钩子与 handler，
      // 因此 AsyncLocalStorage 的上下文能一路带到业务查询；出了这里就只剩系统作用域。
      return runWithScope(ownerScope(found.user.id), () => done());
    } catch (error) {
      return done(error as Error);
    }
  });
}

/** 取当前用户；调用方在受保护路由里使用，未登录视为内部错误而不是 401（钩子已拦截）。 */
export function currentUser(request: FastifyRequest): UserRecord {
  if (!request.authUser) throw new ApiError(401, "UNAUTHORIZED", "请先登录");
  return request.authUser;
}

export function requireRole(request: FastifyRequest, roles: Array<UserRecord["role"]>): UserRecord {
  const user = currentUser(request);
  if (!roles.includes(user.role)) throw new ApiError(403, "FORBIDDEN", "没有权限执行该操作");
  return user;
}

export function pathname(url: string): string {
  const index = url.indexOf("?");
  return index === -1 ? url : url.slice(0, index);
}

function assertSameOrigin(request: FastifyRequest, allowedOrigins: string[]): void {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
  const origin = request.headers.origin;
  if (typeof origin !== "string" || origin === "") return;
  if (allowedOrigins.includes(origin)) return;
  throw new ApiError(403, "FORBIDDEN", "请求来源不被允许");
}

/** 手写 Cookie 解析：只为读一个会话 cookie，不值得引入额外依赖。 */
export function readSessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    return value === "" ? null : decodeURIComponent(value);
  }
  return null;
}

export function sessionCookie(token: string, options: { secure: boolean }): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  // Secure 由部署环境决定：本地 http 调试时必须关掉，否则浏览器不会回传。
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearedSessionCookie(options: { secure: boolean }): string {
  const parts = [`${SESSION_COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}
