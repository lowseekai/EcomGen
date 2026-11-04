import { createHash } from "node:crypto";

import { MICROCREDITS_PER_CREDIT } from "./repositories/creditRepository.js";
import type { PaymentOrderRecord } from "./repositories/paymentRepository.js";
import type { EcomRepository } from "./repository.js";

/**
 * 支付网关适配。
 *
 * 当前只实现易支付（epay）协议：它是国内独立开发者最常用的聚合网关，签名规则简单
 * （MD5 排序拼接），且可以完全用本地假网关验证——不像微信/支付宝那样依赖商户资质与
 * RSA 证书，在拿到真实商户号之前无法联调。
 *
 * 新增渠道时实现 `PaymentGateway` 即可，订单状态机与入账逻辑不必改动。
 */

export interface PaymentGateway {
  /** 网关标识，写进 payment_orders.provider。 */
  readonly id: string;
  /** 生成收银台地址（跳转或二维码内容由网关决定）。 */
  createCheckout(input: CheckoutInput): string;
  /** 校验异步通知，返回归一化结果或失败原因。 */
  verifyNotification(params: Record<string, string>): NotificationResult;
}

export interface CheckoutInput {
  config: EpayConfig;
  orderNo: string;
  amountCents: number;
  subject: string;
  notifyUrl: string;
  returnUrl: string;
}

export interface EpayConfig {
  /** 网关根地址，如 https://pay.example.com */
  gateway: string;
  /** 商户 ID */
  pid: string;
  /** 商户密钥（参与 MD5 签名） */
  key: string;
  /** 支付方式：alipay / wxpay 等，由网关定义 */
  payType: string;
}

export type NotificationResult =
  | {
      ok: true;
      orderNo: string;
      tradeNo: string;
      amountCents: number;
      paidAt: string | null;
      eventId: string;
    }
  | { ok: false; reason: "SIGN_INVALID" | "MALFORMED" | "NOT_PAID" };

/**
 * 易支付签名：按参数名 ASCII 升序拼接 `k=v`（跳过空值与 sign/sign_type），末尾接密钥后取 MD5 小写。
 *
 * 这是网关侧的唯一真相，改动会直接导致验签全失败，因此不提供任何"兼容模式"。
 */
export function epaySign(params: Record<string, string>, key: string): string {
  const pairs = Object.keys(params)
    .filter((name) => name !== "sign" && name !== "sign_type" && params[name] !== "" && params[name] !== undefined)
    .sort()
    .map((name) => `${name}=${params[name]}`);
  return md5(`${pairs.join("&")}${key}`);
}

function md5(value: string): string {
  return createHash("md5").update(value, "utf8").digest("hex");
}

/** 金额解析：网关传的是元（字符串，两位小数），内部一律用分，避免浮点误差。 */
export function yuanToCents(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

export class EpayGateway implements PaymentGateway {
  public readonly id = "epay";

  public createCheckout(input: CheckoutInput): string {
    const { config } = input;
    const params: Record<string, string> = {
      pid: config.pid,
      type: config.payType,
      out_trade_no: input.orderNo,
      notify_url: input.notifyUrl,
      return_url: input.returnUrl,
      name: input.subject,
      money: (input.amountCents / 100).toFixed(2),
    };
    const signed = { ...params, sign: epaySign(params, config.key), sign_type: "MD5" };
    const query = Object.entries(signed)
      .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
      .join("&");
    return `${config.gateway.replace(/\/+$/, "")}/submit.php?${query}`;
  }

  public verifyNotification(params: Record<string, string>): NotificationResult {
    const orderNo = params.out_trade_no;
    const tradeNo = params.trade_no;
    const money = params.money;
    if (!orderNo || !tradeNo || !money) return { ok: false, reason: "MALFORMED" };

    const amountCents = yuanToCents(money);
    if (amountCents === null) return { ok: false, reason: "MALFORMED" };

    // 只有 TRADE_SUCCESS 视为已支付；其它状态（等待/关闭）不改变订单。
    if (params.trade_status !== "TRADE_SUCCESS") return { ok: false, reason: "NOT_PAID" };

    // eventId 用「订单号 + 交易号 + 金额」：网关重投同一笔时完全相同，
    // 而同一订单出现不同交易号（异常）时不会被静默吞掉。
    return {
      ok: true,
      orderNo,
      tradeNo,
      amountCents,
      paidAt: params.endtime ?? null,
      eventId: `${orderNo}:${tradeNo}:${amountCents}`,
    };
  }

  /** 验签单独暴露：调用方要先取到该商户的 key 才能验，顺序不能反。 */
  public verifySignature(params: Record<string, string>, key: string): boolean {
    const provided = params.sign;
    if (!provided) return false;
    // 长度不等时定长比较没有意义，直接拒绝。
    if (provided.length !== 32) return false;
    return timingSafeEqualHex(epaySign(params, key), provided.toLowerCase());
  }
}

/** 定长十六进制比较，避免按字符短路泄露签名前缀。 */
function timingSafeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index++) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

export type NotificationOutcome =
  | { status: "credited"; order: PaymentOrderRecord; creditedMicrocredits: number }
  | { status: "duplicate"; order: PaymentOrderRecord }
  | { status: "ignored"; reason: string }
  | { status: "failed"; reason: string };

/**
 * 处理支付回调。
 *
 * 顺序不可交换，每一步都在补一个具体的坑：
 * 1. **先落回调收件箱**再处理 —— 处理过程中崩溃时，网关重投仍能靠 (provider,event_id) 唯一索引识别；
 * 2. **验签** —— 不验签等于任何人都能给自己的订单"付款"；
 * 3. **核对金额** —— 网关传的金额必须与订单一致，否则就是篡改或串单；
 * 4. **幂等入账** —— `credited_at IS NULL` 才加积分，重复回调只加一次。
 */
export function handlePaymentNotification(
  repository: EcomRepository,
  input: {
    provider: string;
    params: Record<string, string>;
    config: EpayConfig;
    gateway: EpayGateway;
  },
): NotificationOutcome {
  const repo = repository;
  const verification = input.gateway.verifyNotification(input.params);

  // 验签失败也要落收件箱：这是排查"网关说发了、我们说没收到"的唯一证据。
  const signatureOk = input.gateway.verifySignature(input.params, input.config.key);
  const eventId = verification.ok ? verification.eventId : `invalid:${md5(JSON.stringify(input.params))}`;
  const recorded = repo.recordPaymentNotification({ provider: input.provider, eventId, payload: input.params });
  if (recorded.duplicate) {
    const existing = repo.getPaymentOrderByProviderNo(input.provider, input.params.out_trade_no ?? "");
    return existing ? { status: "duplicate", order: existing } : { status: "ignored", reason: "重复回调" };
  }

  if (!signatureOk) {
    repo.markPaymentNotification(recorded.id, "failed", { reason: "SIGN_INVALID" });
    return { status: "failed", reason: "SIGN_INVALID" };
  }
  if (!verification.ok) {
    const failed = verification.reason !== "NOT_PAID";
    repo.markPaymentNotification(recorded.id, failed ? "failed" : "ignored", { reason: verification.reason });
    return { status: failed ? "failed" : "ignored", reason: verification.reason };
  }

  const order = repo.getPaymentOrderByProviderNo(input.provider, verification.orderNo);
  if (!order) {
    repo.markPaymentNotification(recorded.id, "failed", { reason: "ORDER_NOT_FOUND" });
    return { status: "failed", reason: "ORDER_NOT_FOUND" };
  }
  if (order.amountCents !== verification.amountCents) {
    repo.markPaymentNotification(recorded.id, "failed", { reason: "AMOUNT_MISMATCH" });
    return { status: "failed", reason: "AMOUNT_MISMATCH" };
  }

  const credited = repo.creditPaymentOrderOnce(order.id, (target) => {
    if (target.creditsMicrocredits > 0) {
      repo.applyCreditEntry({
        userId: target.userId,
        type: "payment_topup",
        amountMicrocredits: target.creditsMicrocredits,
        paymentOrderId: target.id,
        note: `充值到账 ${target.creditsMicrocredits / MICROCREDITS_PER_CREDIT} 积分`,
      });
    }
    repo.updatePaymentOrder(target.id, { status: "paid", providerTradeNo: verification.tradeNo, paidAt: verification.paidAt ?? new Date().toISOString() });
  });

  repo.markPaymentNotification(recorded.id, "processed");
  const finalOrder = credited.order ?? order;
  return credited.credited
    ? { status: "credited", order: finalOrder, creditedMicrocredits: finalOrder.creditsMicrocredits }
    : { status: "duplicate", order: finalOrder };
}
