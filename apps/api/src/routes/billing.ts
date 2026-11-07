import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  EpayGateway,
  MICROCREDITS_PER_CREDIT,
  handlePaymentNotification,
  toCredits,
  type EpayConfig,
} from "@ecomgen/core";

import { currentUser } from "../auth-guard.js";
import { consumeRateLimit } from "../rate-limit.js";

/** 充值下单限流：每用户每分钟 5 单。下单会写订单行并生成网关链接，不限流可被脚本刷量。 */
const TOPUP_LIMIT = 5;
const TOPUP_WINDOW_MS = 60_000;
import type { ApiContext } from "../context.js";
import { ApiError } from "../errors.js";
import { missing } from "../helpers.js";
import { parameter, readOptionalText, readText } from "../input-normalizers.js";

/**
 * 充值：下单、查单、网关回调。
 *
 * 金额口径：用户按「积分」购买，单价来自站点设置 `topup_price_per_credit_cents`（分/积分）。
 * 所有金额内部一律用「分」与「微积分」两种整数，绝不出现浮点。
 */

const EPLAY_SETTINGS_KEY = "payment.epay";

/** 从站点设置读网关配置；未配置时下单直接失败，而不是生成一个付不了的订单。 */
function readEpayConfig(ctx: ApiContext): EpayConfig | null {
  const raw = ctx.systemRepository.getSetting<Partial<EpayConfig> | null>(EPLAY_SETTINGS_KEY, null);
  if (!raw || !raw.gateway || !raw.pid || !raw.key) return null;
  return { gateway: raw.gateway, pid: raw.pid, key: raw.key, payType: raw.payType || "alipay" };
}

/** 回调与跳转地址必须可从公网访问；优先用站点设置，其次退回请求自身的来源。 */
function publicBaseUrl(ctx: ApiContext, request: FastifyRequest): string {
  const configured = ctx.systemRepository.getSetting<string>("public_base_url", "");
  if (configured) return configured.replace(/\/+$/, "");
  const origin = request.headers.origin;
  if (typeof origin === "string" && origin) return origin.replace(/\/+$/, "");
  const host = request.headers.host ?? "127.0.0.1:8787";
  return `http://${host}`;
}

export function registerBillingRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { repository } = ctx;
  const gateway = new EpayGateway();

  /** 我的充值订单。 */
  app.get("/api/v1/billing/orders", async (request) => {
    const user = currentUser(request);
    const query = (request.query ?? {}) as Record<string, unknown>;
    const limit = Math.min(Math.max(Number(query.limit ?? 20) || 20, 1), 100);
    const offset = Math.max(Number(query.offset ?? 0) || 0, 0);
    return {
      items: repository.listPaymentOrders(user.id, limit, offset).map(publicOrder),
      // 前端展示"1 积分 = 多少元"，避免用户在两处看到不同价格。
      pricePerCreditCents: ctx.systemRepository.getSetting<number>("topup_price_per_credit_cents", 100),
      limit,
      offset,
    };
  });

  /** 下单：创建订单并返回收银台地址。 */
  app.post("/api/v1/billing/topup-orders", async (request, reply) => {
    const user = currentUser(request);
    // 每用户限流：下单会写一行订单并生成网关链接，不限流时可被脚本刷出大量垃圾订单。
    const limit = await consumeRateLimit(`topup:${user.id}`, TOPUP_LIMIT, TOPUP_WINDOW_MS);
    if (!limit.allowed) throw new ApiError(429, "RATE_LIMITED", `操作过于频繁，请 ${limit.retryAfterSeconds} 秒后再试`);
    const config = readEpayConfig(ctx);
    if (!config) throw new ApiError(422, "PROVIDER_NOT_CONFIGURED", "支付渠道尚未配置，请联系管理员");

    const body = (request.body ?? {}) as Record<string, unknown>;
    const credits = Number(body.credits);
    if (!Number.isFinite(credits) || credits <= 0) throw new ApiError(400, "VALIDATION_ERROR", "credits must be a positive number");

    const pricePerCredit = ctx.systemRepository.getSetting<number>("topup_price_per_credit_cents", 100);
    const amountCents = Math.round(credits * pricePerCredit);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new ApiError(400, "VALIDATION_ERROR", "金额超出允许范围");

    // 30 分钟未支付自动关闭：挂在订单上而不是定时任务里，查询时按 expires_at 判断。
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const order = repository.createPaymentOrder({
      userId: user.id,
      kind: "credits",
      planId: null,
      creditsMicrocredits: Math.round(credits * MICROCREDITS_PER_CREDIT),
      amountCents,
      currency: "CNY",
      provider: gateway.id,
      providerConfig: { pid: config.pid, payType: config.payType },
      expiresAt,
    });
    // out_trade_no 用订单 id：回调按 (provider, provider_order_no) 反查，必须在创建时就对上。
    repository.updatePaymentOrder(order.id, { status: "pending", providerOrderNo: order.id });

    const base = publicBaseUrl(ctx, request);
    const checkoutUrl = gateway.createCheckout({
      config,
      orderNo: order.id,
      amountCents,
      subject: `EcomGen ${credits} 积分`,
      notifyUrl: `${base}/api/v1/payments/notify/${gateway.id}`,
      returnUrl: `${base}/billing/return?orderId=${order.id}`,
    });

    return reply.code(201).send({ order: publicOrder(repository.getPaymentOrder(order.id) ?? order), checkoutUrl });
  });

  app.get("/api/v1/billing/orders/:orderId", async (request) => {
    const user = currentUser(request);
    const orderId = parameter(request, "orderId");
    const order = repository.getPaymentOrder(orderId);
    // 别人的订单按不存在处理，不泄露存在性。
    if (!order || order.userId !== user.id) missing("order", orderId);
    return publicOrder(order);
  });

  /**
   * 网关异步通知。
   *
   * 匿名可达（见 auth-guard 的前缀白名单），安全性由验签保证：
   * 签名不对只落一条 failed 收件箱记录，不入账。
   * 无论结果如何都返回网关约定的 success 文本，否则网关会无限重投。
   */
  app.post("/api/v1/payments/notify/:provider", async (request, reply) => {
    const provider = parameter(request, "provider");
    const config = readEpayConfig(ctx);
    if (!config || provider !== gateway.id) return reply.code(200).type("text/plain").send("fail");

    // 网关可能以表单或查询串提交，两种都要能收。
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries((request.query ?? {}) as Record<string, unknown>)) {
      if (typeof value === "string") params[key] = value;
    }
    for (const [key, value] of Object.entries((request.body ?? {}) as Record<string, unknown>)) {
      if (typeof value === "string") params[key] = value;
    }

    // 回调没有会话，必须用系统作用域仓储。
    const outcome = handlePaymentNotification(ctx.systemRepository, { provider, params, config, gateway });
    request.log.info({ provider, outcome: outcome.status }, "payment notification");
    return reply.code(200).type("text/plain").send("success");
  });
}

/** 密钥永远不出接口：providerConfig 里只留非敏感的 pid 与支付方式。 */
function publicOrder(order: {
  id: string;
  kind: string;
  creditsMicrocredits: number;
  amountCents: number;
  currency: string;
  status: string;
  provider: string;
  providerTradeNo: string | null;
  paidAt: string | null;
  creditedAt: string | null;
  expiresAt: string;
  createdAt: string;
}): Record<string, unknown> {
  return {
    id: order.id,
    kind: order.kind,
    credits: toCredits(order.creditsMicrocredits),
    amountCents: order.amountCents,
    currency: order.currency,
    status: order.status,
    provider: order.provider,
    tradeNo: order.providerTradeNo,
    paidAt: order.paidAt,
    creditedAt: order.creditedAt,
    expiresAt: order.expiresAt,
    createdAt: order.createdAt,
  };
}

/** 管理端读写支付配置。 */
export function registerPaymentAdminRoutes(app: FastifyInstance, ctx: ApiContext, requireAdminWrite: (request: FastifyRequest) => unknown, requireAdminRead: (request: FastifyRequest) => unknown): void {
  const { systemRepository } = ctx;

  app.get("/api/v1/admin/payments/config", async (request) => {
    requireAdminRead(request);
    const config = systemRepository.getSetting<Partial<EpayConfig> | null>(EPLAY_SETTINGS_KEY, null);
    return {
      provider: config ? "epay" : null,
      // 密钥不回显，只告诉管理员"已配置"。
      hasKey: Boolean(config?.key),
      gateway: config?.gateway ?? null,
      pid: config?.pid ?? null,
      payType: config?.payType ?? "alipay",
      pricePerCreditCents: systemRepository.getSetting<number>("topup_price_per_credit_cents", 100),
      publicBaseUrl: systemRepository.getSetting<string>("public_base_url", ""),
    };
  });

  app.patch("/api/v1/admin/payments/config", async (request) => {
    const actor = requireAdminWrite(request) as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;

    const current = systemRepository.getSetting<Partial<EpayConfig> | null>(EPLAY_SETTINGS_KEY, null);
    const gatewayUrl = readOptionalText(body.gateway);
    const pid = readOptionalText(body.pid);
    const key = readOptionalText(body.key);
    const payType = readOptionalText(body.payType);

    // key 只在显式提供时覆盖：管理端回显不了密钥，保存其它字段时不该把密钥清空。
    const next: EpayConfig = {
      gateway: gatewayUrl ?? current?.gateway ?? "",
      pid: pid ?? current?.pid ?? "",
      key: key ?? current?.key ?? "",
      payType: payType ?? current?.payType ?? "alipay",
    };
    if (!next.gateway || !next.pid || !next.key) throw new ApiError(400, "VALIDATION_ERROR", "gateway / pid / key 均为必填");

    systemRepository.setSetting(EPLAY_SETTINGS_KEY, next);
    if (body.pricePerCreditCents !== undefined) {
      const price = Number(body.pricePerCreditCents);
      if (!Number.isSafeInteger(price) || price <= 0) throw new ApiError(400, "VALIDATION_ERROR", "pricePerCreditCents 必须是正整数（分）");
      systemRepository.setSetting("topup_price_per_credit_cents", price);
    }
    if (body.publicBaseUrl !== undefined) {
      systemRepository.setSetting("public_base_url", readText(body.publicBaseUrl, "publicBaseUrl"));
    }

    systemRepository.recordAuditEvent({
      actorUserId: actor.id,
      action: "payment.config",
      targetType: "app_settings",
      targetId: EPLAY_SETTINGS_KEY,
      summary: "更新支付渠道配置",
      data: { gateway: next.gateway, pid: next.pid, payType: next.payType, keyRotated: Boolean(key) },
    });
    return { ok: true, hasKey: Boolean(next.key) };
  });
}
