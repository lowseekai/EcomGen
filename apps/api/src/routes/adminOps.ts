import type { FastifyInstance, FastifyRequest } from "fastify";
import { MICROCREDITS_PER_CREDIT, toCredits, type PlanRecord, type UserRecord } from "@ecomgen/core";

import { requireRole } from "../auth-guard.js";
import type { ApiContext } from "../context.js";
import { ApiError } from "../errors.js";
import { missing } from "../helpers.js";
import { enumValue, parameter, readOptionalText, readText } from "../input-normalizers.js";

/**
 * 管理后台的运营侧接口：仪表盘、套餐、支付订单与对账。
 *
 * 与 `admin.ts` 分开成独立模块，而不是继续往里堆：那边是"用户与渠道"的写操作，
 * 这里是"平台运行状况"的读操作 + 少量对账动作，两者的审计关注点不同。
 *
 * 一律走 `systemRepository`：管理员要跨用户看数据，请求作用域实例会被自己的 owner 过滤掉。
 */

const WRITE_ROLES: Array<UserRecord["role"]> = ["owner", "admin"];
const READ_ROLES: Array<UserRecord["role"]> = ["owner", "admin", "support"];

function requireWrite(request: FastifyRequest): UserRecord {
  return requireRole(request, WRITE_ROLES);
}

function requireRead(request: FastifyRequest): UserRecord {
  return requireRole(request, READ_ROLES);
}

function pagination(request: FastifyRequest): { limit: number; offset: number } {
  const query = (request.query ?? {}) as Record<string, unknown>;
  return {
    limit: Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200),
    offset: Math.max(Number(query.offset ?? 0) || 0, 0),
  };
}

export function registerAdminOpsRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { systemRepository: repository } = ctx;

  // ---- 仪表盘 ----

  app.get("/api/v1/admin/dashboard", async (request) => {
    requireRead(request);
    const overview = repository.adminOverview();
    return {
      ...overview,
      // 金额同时给微积分与积分两种口径：前者是真相，后者给人看。
      display: {
        settledCredits: toCredits(overview.billing.settledMicrocredits),
        toppedUpCredits: toCredits(overview.credits.toppedUpMicrocredits),
        spentCredits: toCredits(overview.credits.spentMicrocredits),
      },
    };
  });

  // ---- 套餐 ----

  app.get("/api/v1/admin/plans", async (request) => {
    requireRead(request);
    // 含停用套餐：管理员要能看到自己下架了什么，否则会以为记录丢了。
    return { items: repository.listPlans(true) };
  });

  app.patch("/api/v1/admin/plans/:planId", async (request) => {
    const actor = requireWrite(request);
    const planId = parameter(request, "planId");
    const current = repository.getPlan(planId);
    if (!current) missing("plan", planId);

    const body = (request.body ?? {}) as Record<string, unknown>;
    const next: Omit<PlanRecord, "createdAt" | "updatedAt"> & { id?: string } = {
      id: current.id,
      code: current.code,
      name: body.name === undefined ? current.name : readText(body.name, "name"),
      description: body.description === undefined ? current.description : readText(body.description, "description"),
      priceCents: body.priceCents === undefined ? current.priceCents : readNonNegativeInt(body.priceCents, "priceCents"),
      currency: current.currency,
      billingPeriod: body.billingPeriod === undefined
        ? current.billingPeriod
        : enumValue<PlanRecord["billingPeriod"]>(body.billingPeriod, ["none", "month", "year"], "billingPeriod"),
      active: body.active === undefined ? current.active : Boolean(body.active),
      sortOrder: body.sortOrder === undefined ? current.sortOrder : readNonNegativeInt(body.sortOrder, "sortOrder"),
      // 权益做浅合并：只传变化的键，不传的保持原值。整体替换会让漏传一项就把能力清零。
      entitlements: { ...current.entitlements, ...readEntitlements(body.entitlements) },
    };

    const updated = repository.upsertPlan(next);
    repository.recordAuditEvent({
      actorUserId: actor.id,
      action: "plan.update",
      targetType: "plan",
      targetId: updated.id,
      summary: `修改套餐 ${updated.code}`,
      data: { active: updated.active, priceCents: updated.priceCents, entitlements: updated.entitlements },
    });
    return updated;
  });

  // ---- 支付订单与对账 ----

  app.get("/api/v1/admin/payment-orders", async (request) => {
    requireRead(request);
    const { limit, offset } = pagination(request);
    const query = (request.query ?? {}) as Record<string, unknown>;
    const rawStatus = readOptionalText(query.status);
    const status = rawStatus === undefined
      ? undefined
      : enumValue(rawStatus, ["created", "pending", "paid", "closed", "failed"] as const, "status");
    return {
      items: repository.listAllPaymentOrders(limit, offset, status).map((order) => ({
        ...order,
        // providerConfig 里可能含渠道侧标识，只给管理员看，且不含密钥（创建时就已剥离）。
        credits: toCredits(order.creditsMicrocredits),
        user: publicUser(repository.getUser(order.userId) ?? null),
      })),
      limit,
      offset,
    };
  });

  /**
   * 对账视图。
   *
   * 两类异常必须能一眼看到：
   * - 已付款但没加积分：钱收了、货没给，用户会来投诉。
   * - 超期未付：应关闭，否则订单会无限挂着占统计。
   */
  app.get("/api/v1/admin/payment-orders/reconcile", async (request) => {
    requireRead(request);
    const { limit, offset } = pagination(request);
    const now = new Date().toISOString();
    return {
      paidNotCredited: repository.listPaidButNotCredited(limit, offset),
      expiredUnpaid: repository.listExpiredUnpaid(now, limit, offset),
      limit,
      offset,
    };
  });

  /**
   * 人工确认到账（线下转账、扫码后手工核对）。
   *
   * 顺序有意为之：**先置已付、再加积分**。反过来崩溃会留下"积分已加、订单待付"，
   * 用户多拿钱且对账看不出来；现在这种顺序崩溃只会留下"已付未入账"，
   * 恰好落在上面的对账列表里，可以被发现并补处理。
   */
  app.post("/api/v1/admin/payment-orders/:orderId/confirm", async (request) => {
    const actor = requireWrite(request);
    const orderId = parameter(request, "orderId");
    const order = repository.getPaymentOrder(orderId);
    if (!order) missing("order", orderId);

    const body = (request.body ?? {}) as Record<string, unknown>;
    const tradeNo = readOptionalText(body.tradeNo) ?? null;

    if (order.status !== "paid" && order.creditedAt === null) {
      repository.updatePaymentOrder(orderId, {
        status: "paid",
        paidAt: new Date().toISOString(),
        providerTradeNo: tradeNo ?? order.providerTradeNo,
      });
    }

    // credited_at 为空才加积分：重复点确认不会重复到账。
    const result = repository.creditPaymentOrderOnce(orderId, (target) => {
      repository.applyCreditEntry({
        userId: target.userId,
        type: "payment_topup",
        amountMicrocredits: target.creditsMicrocredits,
        paymentOrderId: target.id,
        note: `人工确认到账 ${target.id}`,
      });
    });

    repository.recordAuditEvent({
      actorUserId: actor.id,
      action: "payment.confirm",
      targetType: "payment_order",
      targetId: orderId,
      summary: `人工确认到账 ${orderId}`,
      data: { creditsMicrocredits: order.creditsMicrocredits, credited: result.credited, tradeNo },
    });
    return { credited: result.credited, order: result.order };
  });

  /** 关闭超期未付订单。只改状态，不动钱。 */
  app.post("/api/v1/admin/payment-orders/:orderId/close", async (request) => {
    const actor = requireWrite(request);
    const orderId = parameter(request, "orderId");
    const order = repository.getPaymentOrder(orderId);
    if (!order) missing("order", orderId);
    if (order.creditedAt !== null) throw new ApiError(409, "CONFLICT", "已入账的订单不能关闭");

    const updated = repository.updatePaymentOrder(orderId, { status: "closed" });
    repository.recordAuditEvent({
      actorUserId: actor.id,
      action: "payment.close",
      targetType: "payment_order",
      targetId: orderId,
      summary: `关闭订单 ${orderId}`,
      data: {},
    });
    return updated;
  });
}

function publicUser(user: UserRecord | null): Record<string, unknown> | null {
  if (!user) return null;
  const { passwordHash: _passwordHash, ...rest } = user;
  return rest;
}

function readNonNegativeInt(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new ApiError(400, "VALIDATION_ERROR", `${field} must be a non-negative integer`);
  return parsed;
}

/**
 * 权益局部更新。只接受已知键，未知键直接拒绝——
 * 静默丢弃拼错的键会让管理员以为改成功了。
 */
function readEntitlements(value: unknown): Partial<PlanRecord["entitlements"]> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object") throw new ApiError(400, "VALIDATION_ERROR", "entitlements must be an object");
  const known = new Set([
    "monthlyCredits", "maxProjects", "maxConcurrentJobs", "maxImageResolution", "maxStorageBytes",
    "allowPsdExport", "allowLayerExport", "allowWebResearch", "allowSuiteForge",
    "allowModelLibrary", "allowPatternStudio", "watermarkExports",
  ]);
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!known.has(key)) throw new ApiError(400, "VALIDATION_ERROR", `unknown entitlement: ${key}`);
    if (key === "maxImageResolution") {
      result[key] = enumValue(raw, ["1K", "2K", "4K"], key);
      continue;
    }
    if (typeof raw === "boolean") { result[key] = raw; continue; }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) throw new ApiError(400, "VALIDATION_ERROR", `entitlement ${key} must be an integer`);
    result[key] = parsed;
  }
  return result as Partial<PlanRecord["entitlements"]>;
}

/** 微积分单位换算，导出给测试复用。 */
export { MICROCREDITS_PER_CREDIT };
