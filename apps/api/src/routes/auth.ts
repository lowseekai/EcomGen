import type { FastifyInstance } from "fastify";
import {
  MIN_PASSWORD_LENGTH,
  PASSWORD_RESET_TTL_SECONDS,
  hashPassword,
  hashToken,
  isAcceptablePassword,
  buildPasswordResetMessage,
  issueSessionToken,
  readSmtpConfig,
  sendMail,
  verifyPassword,
  type UserRecord,
} from "@ecomgen/core";

import type { ApiContext } from "../context.js";
import { ApiError } from "../errors.js";
import { currentUser, clearedSessionCookie, readSessionCookie, sessionCookie } from "../auth-guard.js";
import { consumeRateLimit, resetRateLimit } from "../rate-limit.js";

/** 登录失败上限：同一「邮箱 + IP」15 分钟内 10 次。 */
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
/** 注册与找回密码按 IP 限流，防止批量刷号与邮件轰炸。 */
const REGISTER_LIMIT = 5;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;
const RESET_LIMIT = 5;
const RESET_WINDOW_MS = 60 * 60 * 1000;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function registerAuthRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { repository } = ctx;

  app.post("/api/v1/auth/register", async (request, reply) => {
    if (!repository.getSetting("registration_enabled", false)) {
      throw new ApiError(403, "FORBIDDEN", "当前未开放注册，请联系管理员开通账号");
    }
    const ip = clientIp(request);
    const limit = await consumeRateLimit(`register:${ip}`, REGISTER_LIMIT, REGISTER_WINDOW_MS);
    if (!limit.allowed) throw new ApiError(429, "RATE_LIMITED", `注册过于频繁，请 ${limit.retryAfterSeconds} 秒后再试`);

    const body = request.body as Record<string, unknown> | undefined;
    const email = readEmail(body?.email);
    const password = readPassword(body?.password);
    const displayName = readDisplayName(body?.displayName, email);

    if (repository.getUserByEmail(email)) {
      throw new ApiError(409, "CONFLICT", "该邮箱已注册");
    }

    const user = repository.createUser({ email, passwordHash: hashPassword(password), displayName, role: "user" });
    const bonus = Number(repository.getSetting("signup_bonus_microcredits", 0));
    // 赠送为 0 时也要落一条流水，保证账户行存在，避免首次扣费影响 0 行。
    repository.applyCreditEntry({
      userId: user.id,
      type: bonus > 0 ? "signup_bonus" : "admin_grant",
      amountMicrocredits: bonus > 0 ? bonus : 0,
      note: "注册赠送",
    });

    const token = startSession(ctx, request, user.id);
    reply.header("set-cookie", sessionCookie(token, { secure: ctx.secureCookies }));
    return reply.code(201).send(sessionPayload(ctx, user));
  });

  app.post("/api/v1/auth/login", async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    const email = readEmail(body?.email);
    const password = typeof body?.password === "string" ? body.password : "";
    const ip = clientIp(request);
    const limitKey = `login:${email}:${ip}`;

    const limit = await consumeRateLimit(limitKey, LOGIN_LIMIT, LOGIN_WINDOW_MS);
    if (!limit.allowed) {
      repository.recordLoginEvent({ userId: null, email, ip, userAgent: userAgent(request), outcome: "rate_limited" });
      throw new ApiError(429, "RATE_LIMITED", `尝试过于频繁，请 ${limit.retryAfterSeconds} 秒后再试`);
    }

    const user = repository.getUserByEmail(email);
    // 先验密码再判状态：否则「账号已禁用」会在密码错误时也返回，等于泄露账号存在。
    if (!user || !verifyPassword(password, user.passwordHash)) {
      repository.recordLoginEvent({ userId: user?.id ?? null, email, ip, userAgent: userAgent(request), outcome: "bad_credentials" });
      throw new ApiError(401, "UNAUTHORIZED", "邮箱或密码不正确");
    }
    if (user.status !== "active") {
      repository.recordLoginEvent({ userId: user.id, email, ip, userAgent: userAgent(request), outcome: "disabled" });
      throw new ApiError(403, "FORBIDDEN", "账号已被禁用");
    }

    await resetRateLimit(limitKey);
    const token = startSession(ctx, request, user.id);
    repository.recordLoginEvent({ userId: user.id, email, ip, userAgent: userAgent(request), outcome: "success" });
    reply.header("set-cookie", sessionCookie(token, { secure: ctx.secureCookies }));
    return sessionPayload(ctx, user);
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const token = readSessionCookie(request.headers.cookie);
    if (token) {
      const found = repository.findActiveSession(hashToken(token));
      if (found) repository.revokeSession(found.session.id);
    }
    reply.header("set-cookie", clearedSessionCookie({ secure: ctx.secureCookies }));
    return reply.code(204).send();
  });

  /**
   * 当前会话。
   *
   * 未登录时返回 `{ user: null }` 而不是 401：前端启动时无条件调用它来判断状态，
   * 用 401 会让登录页在控制台里刷满错误，也让「未登录」和「网络故障」混在一起。
   */
  app.get("/api/v1/auth/me", async (request) => {
    const user = request.authUser;
    if (!user) return { user: null };
    return sessionPayload(ctx, user);
  });

  app.post("/api/v1/auth/password-reset/request", async (request, reply) => {
    const ip = clientIp(request);
    const limit = await consumeRateLimit(`reset:${ip}`, RESET_LIMIT, RESET_WINDOW_MS);
    if (!limit.allowed) throw new ApiError(429, "RATE_LIMITED", `请求过于频繁，请 ${limit.retryAfterSeconds} 秒后再试`);

    const body = request.body as Record<string, unknown> | undefined;
    const email = readEmail(body?.email);
    const user = repository.getUserByEmail(email);

    // 无论账号是否存在都返回 202：否则这个接口就成了账号枚举器。
    if (!user) return reply.code(202).send({ accepted: true });

    const { token, tokenHash } = issueSessionToken();
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_SECONDS * 1000).toISOString();
    repository.createPasswordResetToken(user.id, tokenHash, expiresAt);

    const resetUrl = `${publicBaseUrl(ctx, request)}/reset-password?token=${encodeURIComponent(token)}`;
    const smtp = readSmtpConfig(ctx.systemRepository);
    if (smtp) {
      // 发信失败**不能**让接口报错：那等于告诉攻击者"这个邮箱存在但发信失败"。
      // 失败只记日志，用户侧仍然看到 202。
      try {
        await sendMail(smtp, buildPasswordResetMessage({ to: user.email, resetUrl, expiresInMinutes: Math.round(PASSWORD_RESET_TTL_SECONDS / 60) }));
      } catch (error) {
        request.log.error({ err: error, email }, "password reset mail failed");
      }
    } else {
      // 没配 SMTP 时令牌无处可去，只能落日志供管理员手工取用。
      request.log.warn({ email, resetToken: token, expiresAt }, "password reset token issued (no mailer configured)");
    }

    // 内测环境可临时打开该开关把令牌直接返回，生产必须关闭。
    const expose = repository.getSetting("password_reset_expose_token", false);
    return reply.code(202).send(expose ? { accepted: true, token, expiresAt } : { accepted: true });
  });

  app.post("/api/v1/auth/password-reset/confirm", async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (token === "") throw new ApiError(400, "VALIDATION_ERROR", "重置令牌不能为空");
    const password = readPassword(body?.password);

    const userId = repository.consumePasswordResetToken(hashToken(token));
    if (!userId) throw new ApiError(400, "VALIDATION_ERROR", "重置链接无效或已过期");

    repository.updateUser(userId, { passwordHash: hashPassword(password) });
    // 改密码必须让所有既有会话失效，否则泄露的旧 Cookie 仍然可用。
    repository.revokeUserSessions(userId);
    return reply.code(204).send();
  });

  app.post("/api/v1/auth/password", async (request, reply) => {
    const user = currentUser(request);
    const body = request.body as Record<string, unknown> | undefined;
    const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
    const newPassword = readPassword(body?.newPassword);

    if (!verifyPassword(currentPassword, user.passwordHash)) {
      throw new ApiError(401, "UNAUTHORIZED", "当前密码不正确");
    }

    repository.updateUser(user.id, { passwordHash: hashPassword(newPassword) });
    repository.revokeUserSessions(user.id);
    reply.header("set-cookie", clearedSessionCookie({ secure: ctx.secureCookies }));
    return reply.code(204).send();
  });
}

/**
 * 对外可访问的基地址。
 *
 * 邮件里的链接必须是用户浏览器能打开的地址，不能用容器内网地址；
 * 与充值回调同口径：站点设置优先，其次请求来源。
 */
function publicBaseUrl(ctx: ApiContext, request: { headers: Record<string, string | string[] | undefined> }): string {
  const configured = ctx.systemRepository.getSetting<string>("public_base_url", "");
  if (configured) return configured.replace(/\/+$/, "");
  const origin = request.headers.origin;
  if (typeof origin === "string" && origin) return origin.replace(/\/+$/, "");
  const host = typeof request.headers.host === "string" ? request.headers.host : "127.0.0.1:8787";
  return `http://${host}`;
}

/** 建会话并返回明文 token；库里只留哈希。 */
function startSession(ctx: ApiContext, request: Parameters<typeof clientIp>[0], userId: string): string {
  const { token, tokenHash } = issueSessionToken();
  ctx.repository.createSession({
    userId,
    tokenHash,
    userAgent: userAgent(request),
    ip: clientIp(request),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  });
  return token;
}

function sessionPayload(ctx: ApiContext, user: UserRecord) {
  const { entitlements, planCode } = ctx.repository.resolveEntitlements(user);
  return {
    user: publicUser(user),
    planCode,
    entitlements,
    balanceMicrocredits: ctx.repository.getBalance(user.id),
    usedStorageBytes: ctx.repository.usedStorageBytes(user.id),
  };
}

function publicUser(user: UserRecord) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
  };
}

function readEmail(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new ApiError(400, "VALIDATION_ERROR", "请填写邮箱");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) throw new ApiError(400, "VALIDATION_ERROR", "邮箱格式不正确");
  return email;
}

function readPassword(value: unknown): string {
  if (typeof value !== "string") throw new ApiError(400, "VALIDATION_ERROR", "请填写密码");
  if (!isAcceptablePassword(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", `密码长度需在 ${MIN_PASSWORD_LENGTH} 到 200 个字符之间`);
  }
  return value;
}

function readDisplayName(value: unknown, email: string): string {
  if (typeof value === "string" && value.trim() !== "") {
    const name = value.trim();
    if (name.length > 64) throw new ApiError(400, "VALIDATION_ERROR", "昵称最多 64 个字符");
    return name;
  }
  return email.split("@")[0];
}

function clientIp(request: { ip?: string; headers: Record<string, unknown> }): string {
  return request.ip ?? "unknown";
}

function userAgent(request: { headers: Record<string, unknown> }): string | null {
  const value = request.headers["user-agent"];
  return typeof value === "string" && value !== "" ? value.slice(0, 512) : null;
}
