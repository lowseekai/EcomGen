import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@ecomgen/jobs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ecomgen/jobs")>();
  const connection = { duplicate: () => connection, quit: async () => { } };
  return {
    ...actual,
    QUEUE_NAME: "ecomgen-test",
    createRedisConnection: () => connection,
    createJobQueue: () => ({ close: async () => { }, getJob: async () => undefined }),
    enqueue: vi.fn(async () => { }),
    RedisProjectEventBus: class {
      public async publish(projectId: string, type: string, data: unknown) {
        return { id: randomUUID(), projectId, type, occurredAt: new Date().toISOString(), data };
      }
      public async subscribe(_projectId: string, listener: (event: unknown) => void) {
        return async () => void listener;
      }
      public async close() { }
    }
  };
});

import type { FastifyInstance } from "fastify";
import { EcomRepository, MICROCREDITS_PER_CREDIT, epaySign, hashToken, openDatabase } from "@ecomgen/core";
import { buildApi } from "./app.js";

/**
 * 充值的端到端链路：下单 → 网关回调 → 入账。
 *
 * 回调故意不带 Cookie，验证"匿名可达 + 靠签名保证安全"这条设计。
 * 同时验证表单提交能被解析——网关普遍用 form-urlencoded，Fastify 默认不解析它。
 */

const GATEWAY_KEY = "merchant-secret";

let dataDir = "";
let app: FastifyInstance;
let database: ReturnType<typeof openDatabase>;
let system: EcomRepository;
let userToken = "";
let userId = "";

function cookie(): Record<string, string> {
  return { cookie: `ecomgen_session=${userToken}` };
}

function signedNotify(orderId: string, money: string, overrides: Record<string, string> = {}, key = GATEWAY_KEY): string {
  const params: Record<string, string> = {
    pid: "1001",
    trade_no: `TRADE-${randomUUID().slice(0, 8)}`,
    out_trade_no: orderId,
    type: "alipay",
    name: "EcomGen 积分",
    money,
    trade_status: "TRADE_SUCCESS",
    ...overrides,
  };
  return new URLSearchParams({ ...params, sign: epaySign(params, key), sign_type: "MD5" }).toString();
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ecomgen-payment-"));
  app = await buildApi({ dataDir, redisUrl: "redis://127.0.0.1:6399", masterKey: Buffer.alloc(32, 7).toString("base64") });
  database = openDatabase(join(dataDir, "ecomgen.sqlite"));
  system = new EcomRepository(database);

  const user = system.createUser({ email: "payer@example.com", passwordHash: "x", displayName: "付款人", role: "user" });
  userId = user.id;
  userToken = `payer-${randomUUID()}`;
  system.createSession({ userId, tokenHash: hashToken(userToken), userAgent: "vitest", ip: "127.0.0.1", expiresAt: new Date(Date.now() + 3600_000).toISOString() });

  // 管理员配置支付渠道：1 积分 = 1 元（100 分）。
  system.setSetting("payment.epay", { gateway: "https://pay.example.com", pid: "1001", key: GATEWAY_KEY, payType: "alipay" });
  system.setSetting("topup_price_per_credit_cents", 100);
  system.setSetting("public_base_url", "https://app.example.com");
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("充值", () => {
  it("下单返回收银台地址，金额按积分单价换算", async () => {
    const response = await app.inject({ method: "POST", url: "/api/v1/billing/topup-orders", headers: cookie(), payload: { credits: 10 } });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.order.credits).toBe(10);
    expect(body.order.amountCents).toBe(1000);
    expect(body.order.status).toBe("pending");
    expect(body.checkoutUrl).toContain("out_trade_no=");
    expect(body.checkoutUrl).toContain("money=10.00");
  });

  it("回调入账：余额增加、订单变 paid", async () => {
    const created = await app.inject({ method: "POST", url: "/api/v1/billing/topup-orders", headers: cookie(), payload: { credits: 10 } });
    const orderId = created.json().order.id as string;

    // 关键：不带任何 Cookie，模拟网关服务器直接回调。
    const notified = await app.inject({
      method: "POST",
      url: "/api/v1/payments/notify/epay",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: signedNotify(orderId, "10.00"),
    });
    expect(notified.statusCode).toBe(200);
    expect(notified.body).toBe("success");

    expect(system.getBalance(userId)).toBe(10 * MICROCREDITS_PER_CREDIT);
    expect(system.getPaymentOrder(orderId)?.status).toBe("paid");
  });

  it("回调重投不重复入账", async () => {
    const created = await app.inject({ method: "POST", url: "/api/v1/billing/topup-orders", headers: cookie(), payload: { credits: 10 } });
    const orderId = created.json().order.id as string;
    const payload = signedNotify(orderId, "10.00");

    for (let index = 0; index < 3; index++) {
      await app.inject({ method: "POST", url: "/api/v1/payments/notify/epay", headers: { "content-type": "application/x-www-form-urlencoded" }, payload });
    }

    expect(system.getBalance(userId)).toBe(10 * MICROCREDITS_PER_CREDIT);
  });

  it("签名错误的回调不入账，但网关仍收到 success（否则会无限重投）", async () => {
    const created = await app.inject({ method: "POST", url: "/api/v1/billing/topup-orders", headers: cookie(), payload: { credits: 10 } });
    const orderId = created.json().order.id as string;

    const notified = await app.inject({
      method: "POST",
      url: "/api/v1/payments/notify/epay",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: signedNotify(orderId, "10.00", {}, "attacker-key"),
    });

    expect(notified.body).toBe("success");
    expect(system.getBalance(userId)).toBe(0);
    expect(system.getPaymentOrder(orderId)?.status).toBe("pending");
  });

  it("未配置渠道时下单被拒绝，而不是生成付不了的订单", async () => {
    system.setSetting("payment.epay", null);
    const response = await app.inject({ method: "POST", url: "/api/v1/billing/topup-orders", headers: cookie(), payload: { credits: 10 } });
    expect(response.statusCode).toBe(422);
  });

  it("订单列表只返回自己的订单", async () => {
    await app.inject({ method: "POST", url: "/api/v1/billing/topup-orders", headers: cookie(), payload: { credits: 3 } });

    const mine = await app.inject({ method: "GET", url: "/api/v1/billing/orders", headers: cookie() });
    expect(mine.json().items).toHaveLength(1);
    expect(mine.json().pricePerCreditCents).toBe(100);

    // 另一个用户看不到这笔。
    const other = system.createUser({ email: "other@example.com", passwordHash: "x", displayName: "别人", role: "user" });
    const otherToken = `other-${randomUUID()}`;
    system.createSession({ userId: other.id, tokenHash: hashToken(otherToken), userAgent: "vitest", ip: "127.0.0.1", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    const theirs = await app.inject({ method: "GET", url: "/api/v1/billing/orders", headers: { cookie: `ecomgen_session=${otherToken}` } });
    expect(theirs.json().items).toEqual([]);
  });
});
