import { describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";

import { openDatabase } from "./database.js";
import { EcomRepository } from "./repository.js";
import { MICROCREDITS_PER_CREDIT } from "./repositories/creditRepository.js";
import {
  EpayGateway,
  epaySign,
  handlePaymentNotification,
  yuanToCents,
  type EpayConfig,
} from "./payment.js";

/**
 * 支付回调的正确性。
 *
 * 这里每一条都对应一类真实事故：签名能被伪造、金额能被篡改、回调重投导致重复入账、
 * 未支付的状态被当成已支付。任何一条失守都是直接的资金损失。
 */

const CONFIG: EpayConfig = { gateway: "https://pay.example.com", pid: "1001", key: "merchant-secret", payType: "alipay" };

function setup() {
  const db = openDatabase(":memory:");
  const repository = new EcomRepository(db);
  const user = repository.createUser({ email: "payer@example.com", passwordHash: "x", displayName: "付款人", role: "user" });
  return { repository, user };
}

/** 建一笔待支付订单，providerOrderNo 用订单 id（与路由一致）。 */
function createOrder(repository: EcomRepository, userId: string, credits = 5, amountCents = 500) {
  const order = repository.createPaymentOrder({
    userId,
    kind: "credits",
    planId: null,
    creditsMicrocredits: credits * MICROCREDITS_PER_CREDIT,
    amountCents,
    currency: "CNY",
    provider: "epay",
    providerConfig: { pid: CONFIG.pid },
    expiresAt: new Date(Date.now() + 1800_000).toISOString(),
  });
  repository.updatePaymentOrder(order.id, { status: "pending", providerOrderNo: order.id });
  return repository.getPaymentOrder(order.id)!;
}

/** 构造一条网关通知，签名由给定密钥生成。 */
function notification(orderId: string, amountYuan: string, overrides: Record<string, string> = {}, key = CONFIG.key): Record<string, string> {
  const params: Record<string, string> = {
    pid: CONFIG.pid,
    trade_no: `TRADE-${orderId.slice(0, 8)}`,
    out_trade_no: orderId,
    type: "alipay",
    name: "EcomGen 积分",
    money: amountYuan,
    trade_status: "TRADE_SUCCESS",
    ...overrides,
  };
  return { ...params, sign: epaySign(params, key), sign_type: "MD5" };
}

describe("易支付签名", () => {
  it("按参数名升序拼接，跳过空值与 sign/sign_type", () => {
    const params = { b: "2", a: "1", sign: "should-be-ignored", sign_type: "MD5", empty: "" };
    const expected = createHash("md5").update(`a=1&b=2${CONFIG.key}`).digest("hex");
    expect(epaySign(params, CONFIG.key)).toBe(expected);
  });

  it("密钥不同则签名不同", () => {
    const params = { a: "1" };
    expect(epaySign(params, "k1")).not.toBe(epaySign(params, "k2"));
  });

  it("金额解析：只接受两位小数以内的正数", () => {
    expect(yuanToCents("5")).toBe(500);
    expect(yuanToCents("5.5")).toBe(550);
    expect(yuanToCents("5.55")).toBe(555);
    expect(yuanToCents("0.01")).toBe(1);
    expect(yuanToCents("5.555")).toBeNull();
    expect(yuanToCents("-1")).toBeNull();
    expect(yuanToCents("abc")).toBeNull();
  });

  it("验签：正确签名通过，错误签名拒绝", () => {
    const gateway = new EpayGateway();
    const params = notification(randomUUID(), "5.00");
    expect(gateway.verifySignature(params, CONFIG.key)).toBe(true);
    expect(gateway.verifySignature(params, "wrong-key")).toBe(false);
    expect(gateway.verifySignature({ ...params, money: "1.00" }, CONFIG.key)).toBe(false);
    expect(gateway.verifySignature({ ...params, sign: undefined as unknown as string }, CONFIG.key)).toBe(false);
  });
});

describe("支付回调入账", () => {
  it("验签通过、金额一致时入账一次", () => {
    const { repository, user } = setup();
    const order = createOrder(repository, user.id);
    const gateway = new EpayGateway();

    const outcome = handlePaymentNotification(repository, { provider: "epay", params: notification(order.id, "5.00"), config: CONFIG, gateway });

    expect(outcome.status).toBe("credited");
    expect(repository.getBalance(user.id)).toBe(5 * MICROCREDITS_PER_CREDIT);
    const paid = repository.getPaymentOrder(order.id)!;
    expect(paid.status).toBe("paid");
    expect(paid.creditedAt).not.toBeNull();
  });

  it("同一通知重投只入账一次", () => {
    const { repository, user } = setup();
    const order = createOrder(repository, user.id);
    const gateway = new EpayGateway();
    const params = notification(order.id, "5.00");

    handlePaymentNotification(repository, { provider: "epay", params, config: CONFIG, gateway });
    const second = handlePaymentNotification(repository, { provider: "epay", params, config: CONFIG, gateway });

    expect(second.status).toBe("duplicate");
    expect(repository.getBalance(user.id)).toBe(5 * MICROCREDITS_PER_CREDIT);
  });

  it("换一个交易号重投同一订单也不二次入账", () => {
    const { repository, user } = setup();
    const order = createOrder(repository, user.id);
    const gateway = new EpayGateway();

    handlePaymentNotification(repository, { provider: "epay", params: notification(order.id, "5.00"), config: CONFIG, gateway });
    // eventId 不同（交易号变了），但 credited_at 已经写过，仍不能重复加钱。
    const again = handlePaymentNotification(repository, { provider: "epay", params: notification(order.id, "5.00", { trade_no: "TRADE-OTHER" }), config: CONFIG, gateway });

    expect(again.status).toBe("duplicate");
    expect(repository.getBalance(user.id)).toBe(5 * MICROCREDITS_PER_CREDIT);
  });

  it("签名错误拒绝入账，但留下收件箱证据", () => {
    const { repository, user } = setup();
    const order = createOrder(repository, user.id);
    const gateway = new EpayGateway();

    const outcome = handlePaymentNotification(repository, { provider: "epay", params: notification(order.id, "5.00", {}, "attacker-key"), config: CONFIG, gateway });

    expect(outcome.status).toBe("failed");
    expect(repository.getBalance(user.id)).toBe(0);
    expect(repository.getPaymentOrder(order.id)!.status).toBe("pending");
    expect(repository.listPaymentNotifications(10, 0)).toHaveLength(1);
  });

  it("金额被篡改拒绝入账", () => {
    const { repository, user } = setup();
    const order = createOrder(repository, user.id, 5, 500);
    const gateway = new EpayGateway();

    // 用真实密钥签一个 0.01 元的通知：签名合法，但金额与订单不符。
    const outcome = handlePaymentNotification(repository, { provider: "epay", params: notification(order.id, "0.01"), config: CONFIG, gateway });

    expect(outcome.status).toBe("failed");
    expect(repository.getBalance(user.id)).toBe(0);
  });

  it("未支付状态只记录不改变订单", () => {
    const { repository, user } = setup();
    const order = createOrder(repository, user.id);
    const gateway = new EpayGateway();

    const outcome = handlePaymentNotification(repository, { provider: "epay", params: notification(order.id, "5.00", { trade_status: "WAIT_BUYER_PAY" }), config: CONFIG, gateway });

    expect(outcome.status).toBe("ignored");
    expect(repository.getPaymentOrder(order.id)!.status).toBe("pending");
    expect(repository.getBalance(user.id)).toBe(0);
  });

  it("订单不存在时拒绝", () => {
    const { repository } = setup();
    const gateway = new EpayGateway();
    const outcome = handlePaymentNotification(repository, { provider: "epay", params: notification(randomUUID(), "5.00"), config: CONFIG, gateway });
    expect(outcome.status).toBe("failed");
  });
});

describe("收银台地址", () => {
  it("包含订单号、金额、签名与回调地址", () => {
    const gateway = new EpayGateway();
    const url = gateway.createCheckout({
      config: CONFIG,
      orderNo: "order-1",
      amountCents: 550,
      subject: "EcomGen 5 积分",
      notifyUrl: "https://app.example.com/api/v1/payments/notify/epay",
      returnUrl: "https://app.example.com/billing/return",
    });

    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://pay.example.com");
    expect(parsed.searchParams.get("out_trade_no")).toBe("order-1");
    expect(parsed.searchParams.get("money")).toBe("5.50");
    expect(parsed.searchParams.get("sign_type")).toBe("MD5");
    expect(parsed.searchParams.get("sign")).toHaveLength(32);
    expect(parsed.searchParams.get("notify_url")).toContain("/payments/notify/epay");
  });
});
