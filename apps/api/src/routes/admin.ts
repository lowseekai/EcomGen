import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import {
  BillingService,
  MAIL_SETTINGS_KEY,
  MICROCREDITS_PER_CREDIT,
  MIN_PASSWORD_LENGTH,
  SmtpError,
  hashPassword,
  isAcceptablePassword,
  normalizeEmail,
  readSmtpConfig,
  verifySmtp,
  type SmtpConfig,
  type UserRecord,
} from "@ecomgen/core";

import { requireRole } from "../auth-guard.js";
import type { ApiContext } from "../context.js";
import { ApiError } from "../errors.js";
import { missing } from "../helpers.js";
import { enumValue, parameter, readOptionalText, readText } from "../input-normalizers.js";
import { registerPaymentAdminRoutes } from "./billing.js";

/**
 * 管理后台接口。
 *
 * 两个必须遵守的约定：
 *
 * 1. **一律走 `ctx.systemRepository`**。`ctx.repository` 是请求作用域实例，会按当前登录用户过滤；
 *    管理员要用它查别人的项目、任务、订单，拿到的会是空集。这是最容易写错的地方。
 *
 * 2. **每个写操作都要留审计**。管理动作没有审计就等于没有追责依据；
 *    而这里能改的东西（余额、封禁、价目）都直接影响用户的真实钱与可用性。
 *
 * 权限分层：`support` 只读；`owner` / `admin` 可写。
 */

const WRITE_ROLES: Array<UserRecord["role"]> = ["owner", "admin"];
const READ_ROLES: Array<UserRecord["role"]> = ["owner", "admin", "support"];

/** 只做最基本的形态校验：真正的投递可行性由后续邮件通道验证。 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requireAdminWrite(request: FastifyRequest): UserRecord {
  return requireRole(request, WRITE_ROLES);
}

function requireAdminRead(request: FastifyRequest): UserRecord {
  return requireRole(request, READ_ROLES);
}

/** 分页参数：管理端列表用 limit/offset，比游标简单且够用。 */
function pagination(request: FastifyRequest): { limit: number; offset: number } {
  const query = (request.query ?? {}) as Record<string, unknown>;
  const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(query.offset ?? 0) || 0, 0);
  return { limit, offset };
}

export function registerAdminRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { systemRepository: repository } = ctx;

  // ---- 用户 ----

  app.get("/api/v1/admin/users", async (request) => {
    requireAdminRead(request);
    const { limit, offset } = pagination(request);
    const query = (request.query ?? {}) as Record<string, unknown>;
    const page = repository.listUsers({
      keyword: readOptionalText(query.keyword) ?? undefined,
      role: readOptionalText(query.role) ?? undefined,
      status: readOptionalText(query.status) ?? undefined,
      limit,
      offset,
    });
    // 列表带余额：管理员排查"为什么用户说扣了钱"时第一眼就要看到这个。
    return {
      items: page.items.map((user) => ({ ...publicUser(user), balanceMicrocredits: repository.getBalance(user.id) })),
      total: page.total,
      limit,
      offset,
    };
  });

  app.get("/api/v1/admin/users/:userId", async (request) => {
    requireAdminRead(request);
    const userId = parameter(request, "userId");
    const user = repository.getUser(userId);
    if (!user) missing("user", userId);
    return {
      ...publicUser(user),
      balanceMicrocredits: repository.getBalance(user.id),
      activeSubscription: repository.getActiveSubscription(user.id) ?? null,
      entitlements: repository.resolveEntitlements(user),
      sessions: repository.listUserSessions(user.id).map((session) => ({
        id: session.id,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        revokedAt: session.revokedAt,
        userAgent: session.userAgent,
        ip: session.ip,
      })),
    };
  });

  app.patch("/api/v1/admin/users/:userId", async (request) => {
    const actor = requireAdminWrite(request);
    const userId = parameter(request, "userId");
    const target = repository.getUser(userId);
    if (!target) missing("user", userId);
    const body = (request.body ?? {}) as Record<string, unknown>;

    // 自己把自己降级/封禁会让平台失去最后一个可操作账号，直接拒绝。
    if (target.id === actor.id) {
      if (body.status !== undefined && String(body.status) !== "active") throw new ApiError(400, "VALIDATION_ERROR", "不能封禁自己");
      if (body.role !== undefined && String(body.role) !== target.role) throw new ApiError(400, "VALIDATION_ERROR", "不能修改自己的角色");
    }

    const patch: Parameters<typeof repository.updateUser>[1] = {};
    if (body.displayName !== undefined) patch.displayName = readText(body.displayName, "displayName");
    if (body.status !== undefined) patch.status = enumValue<UserRecord["status"]>(body.status, ["active", "disabled"], "status");
    if (body.role !== undefined) {
      const role = enumValue<UserRecord["role"]>(body.role, ["owner", "admin", "support", "user"], "role");
      // 至少要留一个 owner，否则没人能再进后台。
      if (target.role === "owner" && role !== "owner" && countOwners(repository) <= 1) {
        throw new ApiError(400, "VALIDATION_ERROR", "至少要保留一个站长账号");
      }
      patch.role = role;
    }

    const updated = repository.updateUser(userId, patch);
    if (!updated) missing("user", userId);
    // 封禁必须立刻生效：撤销全部会话，旧 Cookie 再也换不到身份。
    if (patch.status === "disabled") repository.revokeUserSessions(userId);
    repository.recordAuditEvent({
      actorUserId: actor.id,
      action: "user.update",
      targetType: "user",
      targetId: userId,
      summary: `修改用户 ${updated.email}`,
      data: { ...patch, passwordHash: undefined },
    });
    return { ...publicUser(updated), balanceMicrocredits: repository.getBalance(updated.id) };
  });

  /**
   * 创建用户。
   *
   * 注册默认关闭（自部署与内测不该开放匿名注册），所以这是唯一的开户入口。
   * 未提供密码时生成一次性随机密码并**只在本次响应里返回**——服务端不存明文，
   * 管理员必须当场抄下来交给用户。
   */
  app.post("/api/v1/admin/users", async (request, reply) => {
    const actor = requireAdminWrite(request);
    const body = (request.body ?? {}) as Record<string, unknown>;

    const email = normalizeEmail(readText(body.email, "email"));
    if (!EMAIL_PATTERN.test(email)) throw new ApiError(400, "VALIDATION_ERROR", "邮箱格式不正确");
    if (repository.getUserByEmail(email)) throw new ApiError(409, "CONFLICT", "该邮箱已被使用");

    const displayName = readOptionalText(body.displayName) ?? email.split("@")[0];
    const role = body.role === undefined ? "user" : enumValue<UserRecord["role"]>(body.role, ["owner", "admin", "support", "user"], "role");

    const provided = readOptionalText(body.password);
    if (provided !== undefined && !isAcceptablePassword(provided)) {
      throw new ApiError(400, "VALIDATION_ERROR", `密码至少 ${MIN_PASSWORD_LENGTH} 个字符`);
    }
    // 未指定密码时生成 18 字节随机串：比任何"默认密码"都安全，且不可能被猜到。
    const generatedPassword = provided === undefined ? randomBytes(18).toString("base64url") : undefined;

    const user = repository.createUser({
      email,
      passwordHash: hashPassword(provided ?? generatedPassword!),
      displayName,
      role,
      status: "active",
    });

    const credits = Number(body.credits ?? 0);
    if (Number.isFinite(credits) && credits !== 0) {
      repository.applyCreditEntry({
        userId: user.id,
        type: credits > 0 ? "admin_grant" : "admin_adjust",
        amountMicrocredits: Math.round(credits * MICROCREDITS_PER_CREDIT),
        note: "管理员开户初始额度",
      }, { allowNegative: true });
    }

    repository.recordAuditEvent({
      actorUserId: actor.id,
      action: "user.create",
      targetType: "user",
      targetId: user.id,
      summary: `创建用户 ${user.email}（${role}）`,
      data: { role, credits, passwordGenerated: generatedPassword !== undefined },
    });

    // 明文密码只出现这一次，不落库、不进审计、不可再次读取。
    return reply.code(201).send({ ...publicUser(user), balanceMicrocredits: repository.getBalance(user.id), generatedPassword });
  });

  /**
   * 重置密码。
   *
   * 邮件通道还没接，用户忘记密码只能靠管理员重置。重置必须撤销该用户全部会话：
   * 否则旧设备上的登录态会继续有效，等于密码没换。
   */
  app.post("/api/v1/admin/users/:userId/password", async (request) => {
    const actor = requireAdminWrite(request);
    const userId = parameter(request, "userId");
    const user = repository.getUser(userId);
    if (!user) missing("user", userId);

    const body = (request.body ?? {}) as Record<string, unknown>;
    const provided = readOptionalText(body.password);
    if (provided !== undefined && !isAcceptablePassword(provided)) {
      throw new ApiError(400, "VALIDATION_ERROR", `密码至少 ${MIN_PASSWORD_LENGTH} 个字符`);
    }
    const generatedPassword = provided === undefined ? randomBytes(18).toString("base64url") : undefined;

    repository.updateUser(userId, { passwordHash: hashPassword(provided ?? generatedPassword!) });
    const revoked = repository.revokeUserSessions(userId);

    repository.recordAuditEvent({
      actorUserId: actor.id,
      action: "user.password_reset",
      targetType: "user",
      targetId: userId,
      summary: `重置用户 ${user.email} 的密码`,
      data: { revokedSessions: revoked, passwordGenerated: generatedPassword !== undefined },
    });
    return { revokedSessions: revoked, generatedPassword };
  });

  app.post("/api/v1/admin/users/:userId/credits", async (request) => {
    const actor = requireAdminWrite(request);
    const userId = parameter(request, "userId");
    const user = repository.getUser(userId);
    if (!user) missing("user", userId);

    const body = (request.body ?? {}) as Record<string, unknown>;
    const credits = Number(body.credits);
    if (!Number.isFinite(credits) || credits === 0) throw new ApiError(400, "VALIDATION_ERROR", "credits must be a non-zero number");
    const amountMicrocredits = Math.round(credits * MICROCREDITS_PER_CREDIT);
    if (!Number.isSafeInteger(amountMicrocredits) || amountMicrocredits === 0) throw new ApiError(400, "VALIDATION_ERROR", "credits is too small or too large");
    const note = readOptionalText(body.note) ?? "管理员调整";

    // 管理员调整允许扣成负数：这是人工冲正，不是用户消费，必须如实记账。
    const result = repository.applyCreditEntry(
      { userId, type: amountMicrocredits > 0 ? "admin_grant" : "admin_adjust", amountMicrocredits, note },
      { allowNegative: true },
    );
    if (!result.ok) throw new ApiError(409, "CONFLICT", "余额调整失败");
    repository.recordAuditEvent({
      actorUserId: actor.id,
      action: "credit.adjust",
      targetType: "user",
      targetId: userId,
      summary: `调整用户 ${user.email} 积分 ${credits}`,
      data: { amountMicrocredits, note, balanceAfter: result.entry.balanceAfterMicrocredits },
    });
    return { balanceMicrocredits: result.entry.balanceAfterMicrocredits, entry: result.entry };
  });

  app.get("/api/v1/admin/users/:userId/ledger", async (request) => {
    requireAdminRead(request);
    const userId = parameter(request, "userId");
    if (!repository.getUser(userId)) missing("user", userId);
    const { limit, offset } = pagination(request);
    return {
      items: repository.listCreditLedger(userId, limit, offset),
      total: repository.countCreditLedger(userId),
      // 余额与流水重算值的差异就是账目漂移，管理端必须能一眼看出来。
      balance: repository.recomputeBalance(userId),
      limit,
      offset,
    };
  });

  // ---- 计费单：uncertain 的人工出口 ----

  app.get("/api/v1/admin/billing/uncertain", async (request) => {
    requireAdminRead(request);
    const { limit, offset } = pagination(request);
    return {
      items: repository.listUncertainBillingOrders(limit, offset).map((order) => ({
        ...order,
        user: publicUser(repository.getUser(order.userId) ?? null),
      })),
      limit,
      offset,
    };
  });

  app.post("/api/v1/admin/billing/:jobId/resolve", async (request) => {
    const actor = requireAdminWrite(request);
    const jobId = parameter(request, "jobId");
    const order = repository.getBillingOrderByJob(jobId);
    if (!order) missing("billing order", jobId);
    if (order.status !== "uncertain") throw new ApiError(409, "CONFLICT", `只有 uncertain 状态的计费单可以人工裁决（当前 ${order.status}）`);

    const body = (request.body ?? {}) as Record<string, unknown>;
    const action = enumValue<"settle" | "refund">(body.action, ["settle", "refund"], "action");
    const billing = new BillingService(repository);
    // 人工裁决要能越过 reserved 守卫：uncertain 是待处理态，不是终态。
    const resolved = action === "settle"
      ? billing.settleUncertain(jobId, Number(body.settledMicrocredits ?? order.reservedMicrocredits))
      : billing.refundUncertain(jobId, readOptionalText(body.note) ?? "人工核对后全额退回");

    repository.recordAuditEvent({
      actorUserId: actor.id,
      action: `billing.${action}`,
      targetType: "billing_order",
      targetId: order.id,
      summary: `人工裁决任务 ${jobId} 的计费单：${action}`,
      data: { jobId, reserved: order.reservedMicrocredits, action },
    });
    return resolved;
  });

  // ---- 价目 ----

  app.get("/api/v1/admin/prices", async (request) => {
    requireAdminRead(request);
    return { items: repository.listProviderModelPrices() };
  });

  app.post("/api/v1/admin/prices", async (request) => {
    const actor = requireAdminWrite(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const record = repository.upsertProviderModelPrice({
      providerId: readText(body.providerId, "providerId"),
      modelId: readText(body.modelId, "modelId"),
      kind: enumValue(body.kind, ["image", "reasoning", "segmentation"], "kind"),
      pricingMode: enumValue(body.pricingMode, ["fixed_request", "per_image", "per_resolution", "token"], "pricingMode"),
      priceMicrocredits: Math.max(0, Math.round(Number(body.priceMicrocredits ?? 0))),
      costMicrocredits: Math.max(0, Math.round(Number(body.costMicrocredits ?? 0))),
      tiers: readTiers(body.tiers),
      active: body.active === undefined ? true : Boolean(body.active),
    });
    repository.recordAuditEvent({
      actorUserId: actor.id,
      action: "price.upsert",
      targetType: "provider_model_price",
      targetId: record.id,
      summary: `配置价目 ${record.providerId}/${record.modelId}`,
      data: { pricingMode: record.pricingMode, price: record.priceMicrocredits, cost: record.costMicrocredits },
    });
    return record;
  });

  app.delete("/api/v1/admin/prices/:priceId", async (request, reply) => {
    const actor = requireAdminWrite(request);
    const priceId = parameter(request, "priceId");
    if (!repository.deleteProviderModelPrice(priceId)) missing("price", priceId);
    repository.recordAuditEvent({
      actorUserId: actor.id,
      action: "price.delete",
      targetType: "provider_model_price",
      targetId: priceId,
      summary: `删除价目 ${priceId}`,
      data: {},
    });
    return reply.code(204).send();
  });

  // 支付渠道配置：读写都在管理端，密钥不回显。
  registerPaymentAdminRoutes(app, ctx, requireAdminWrite, requireAdminRead);

  // ---- 邮件（SMTP） ----

  app.get("/api/v1/admin/settings/mail", async (request) => {
    requireAdminRead(request);
    const config = readSmtpConfig(repository);
    return {
      configured: config !== null,
      host: config?.host ?? null,
      port: config?.port ?? 587,
      secure: config?.secure ?? false,
      requireStartTls: config?.requireStartTls !== false,
      user: config?.user ?? null,
      from: config?.from ?? null,
      fromName: config?.fromName ?? null,
      // 口令永不回显，只说有没有。
      hasPass: Boolean(config?.pass),
    };
  });

  app.patch("/api/v1/admin/settings/mail", async (request) => {
    const actor = requireAdminWrite(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const current = repository.getSetting<Partial<SmtpConfig> | null>(MAIL_SETTINGS_KEY, null);

    const host = readOptionalText(body.host);
    const from = readOptionalText(body.from);
    const pass = readOptionalText(body.pass);

    const next: SmtpConfig = {
      host: host ?? current?.host ?? "",
      port: body.port === undefined ? (current?.port ?? 587) : Math.trunc(Number(body.port)),
      secure: body.secure === undefined ? Boolean(current?.secure) : Boolean(body.secure),
      // 口令只在显式提供时覆盖：回显不了原文，保存其它字段时不该把它清空。
      user: readOptionalText(body.user) ?? current?.user ?? "",
      pass: pass ?? current?.pass ?? "",
      from: from ?? current?.from ?? "",
      fromName: readOptionalText(body.fromName) ?? current?.fromName,
      requireStartTls: body.requireStartTls === undefined ? (current?.requireStartTls ?? true) : Boolean(body.requireStartTls),
    };
    if (!next.host || !next.from) throw new ApiError(400, "VALIDATION_ERROR", "host 与 from 均为必填");
    if (!Number.isInteger(next.port) || next.port <= 0 || next.port > 65535) throw new ApiError(400, "VALIDATION_ERROR", "port 必须是 1-65535 的整数");

    repository.setSetting(MAIL_SETTINGS_KEY, next);
    repository.recordAuditEvent({
      actorUserId: actor.id,
      action: "mail.config",
      targetType: "app_settings",
      targetId: MAIL_SETTINGS_KEY,
      summary: "更新邮件服务器配置",
      data: { host: next.host, port: next.port, secure: next.secure, from: next.from, passRotated: Boolean(pass) },
    });
    return { ok: true, hasPass: Boolean(next.pass) };
  });

  /** 只做连通性与认证检查，不发信——管理员要确认的是配置对不对。 */
  app.post("/api/v1/admin/settings/mail/test", async (request) => {
    requireAdminRead(request);
    const config = readSmtpConfig(repository);
    if (!config) throw new ApiError(422, "PROVIDER_NOT_CONFIGURED", "尚未配置邮件服务器");
    try {
      await verifySmtp(config);
      return { ok: true };
    } catch (error) {
      // 只回状态码级信息：SMTP 原文可能含账号提示。
      const message = error instanceof SmtpError ? error.message : "连接失败";
      throw new ApiError(502, "PROVIDER_ERROR", message);
    }
  });

  // ---- 审计 ----

  app.get("/api/v1/admin/audit", async (request) => {
    requireAdminRead(request);
    const { limit, offset } = pagination(request);
    return { items: repository.listAuditEvents(limit, offset), limit, offset };
  });
}

/** 密码哈希永不出接口，邮箱只做展示。 */
function publicUser(user: UserRecord | null): Record<string, unknown> | null {
  if (!user) return null;
  const { passwordHash: _passwordHash, ...rest } = user;
  return { ...rest, email: normalizeEmail(user.email) };
}

function countOwners(repository: ApiContext["systemRepository"]): number {
  return repository.listUsers({ role: "owner", limit: 200, offset: 0 }).total;
}

/** 分辨率档位价目：只接受正数，非法值直接丢弃而不是写进去一个 NaN。 */
function readTiers(value: unknown): Record<string, number> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object") throw new ApiError(400, "VALIDATION_ERROR", "tiers must be an object");
  const tiers: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const price = Number(raw);
    if (!Number.isFinite(price) || price < 0) throw new ApiError(400, "VALIDATION_ERROR", `tiers.${key} must be a non-negative number`);
    tiers[key] = Math.round(price);
  }
  return tiers;
}
