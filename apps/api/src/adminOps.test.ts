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
import { EcomRepository, MICROCREDITS_PER_CREDIT, hashToken, openDatabase } from "@ecomgen/core";
import { buildApi } from "./app.js";

/** 运营侧管理接口：仪表盘、套餐、支付订单与对账。 */

let dataDir = "";
let app: FastifyInstance;
let database: ReturnType<typeof openDatabase>;
let system: EcomRepository;
let adminToken = "";
let memberToken = "";
let memberId = "";

function cookie(token: string): Record<string, string> {
  return { cookie: `ecomgen_session=${token}` };
}

function makeSession(userId: string, prefix: string): string {
  const token = `${prefix}-${randomUUID()}`;
  system.createSession({ userId, tokenHash: hashToken(token), userAgent: "vitest", ip: "127.0.0.1", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  return token;
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ecomgen-admin-ops-"));
  app = await buildApi({ dataDir, redisUrl: "redis://127.0.0.1:6399", masterKey: Buffer.alloc(32, 7).toString("base64") });
  database = openDatabase(join(dataDir, "ecomgen.sqlite"));
  system = new EcomRepository(database);

  const owner = system.listUsers({ role: "owner", limit: 1, offset: 0 }).items[0];
  const member = system.createUser({ email: "member@example.com", passwordHash: "x", displayName: "用户", role: "user" });
  memberId = member.id;
  adminToken = makeSession(owner.id, "owner");
  memberToken = makeSession(member.id, "member");
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function seedOrder(overrides: Partial<Parameters<typeof system.createPaymentOrder>[0]> = {}) {
  return system.createPaymentOrder({
    userId: memberId,
    kind: "credits",
    planId: null,
    creditsMicrocredits: 5 * MICROCREDITS_PER_CREDIT,
    amountCents: 500,
    currency: "CNY",
    provider: "epay",
    providerConfig: { pid: "1001" },
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    ...overrides,
  });
}

describe("运营接口权限", () => {
  it("普通用户访问运营接口一律 403", async () => {
    for (const url of ["/api/v1/admin/dashboard", "/api/v1/admin/plans", "/api/v1/admin/payment-orders", "/api/v1/admin/payment-orders/reconcile"]) {
      const response = await app.inject({ method: "GET", url, headers: cookie(memberToken) });
      expect(response.statusCode, url).toBe(403);
    }
  });
});

describe("仪表盘", () => {
  it("返回跨用户的统计口径", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/dashboard", headers: cookie(adminToken) });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.users.total).toBeGreaterThanOrEqual(2);
    expect(body.users.active).toBeGreaterThanOrEqual(2);
    expect(body.jobs).toHaveProperty("queued");
    expect(body.billing).toHaveProperty("uncertain");
    // 金额同时给微积分与积分两种口径。
    expect(body.display).toHaveProperty("settledCredits");
  });
});

describe("套餐管理", () => {
  it("列出免费与专业套餐（含停用）", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/plans", headers: cookie(adminToken) });
    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((plan: { code: string }) => plan.code)).toEqual(["free", "pro"]);
  });

  it("权益是浅合并不是整体替换", async () => {
    const free = system.getPlanByCode("free")!;
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/plans/${free.id}`,
      headers: cookie(adminToken),
      payload: { entitlements: { maxProjects: 9 } },
    });
    expect(response.statusCode).toBe(200);
    const updated = response.json();
    expect(updated.entitlements.maxProjects).toBe(9);
    // 没传的键必须保持原值，否则漏传一项就把能力清零。
    expect(updated.entitlements.maxConcurrentJobs).toBe(1);
    expect(updated.entitlements.allowPatternStudio).toBe(true);
  });

  it("未知权益键被拒绝而不是静默丢弃", async () => {
    const free = system.getPlanByCode("free")!;
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/plans/${free.id}`,
      headers: cookie(adminToken),
      payload: { entitlements: { maxProjectz: 9 } },
    });
    expect(response.statusCode).toBe(400);
  });

  it("修改套餐留审计", async () => {
    const free = system.getPlanByCode("free")!;
    await app.inject({ method: "PATCH", url: `/api/v1/admin/plans/${free.id}`, headers: cookie(adminToken), payload: { priceCents: 1234 } });
    const audit = system.listAuditEvents(20, 0) as Array<{ action: string }>;
    expect(audit.map((event) => event.action)).toContain("plan.update");
  });
});

describe("支付订单与对账", () => {
  it("人工确认到账只加一次积分", async () => {
    const order = seedOrder();
    const before = system.getBalance(memberId);

    const first = await app.inject({ method: "POST", url: `/api/v1/admin/payment-orders/${order.id}/confirm`, headers: cookie(adminToken), payload: { tradeNo: "T-1" } });
    expect(first.statusCode).toBe(200);
    expect(first.json().credited).toBe(true);
    expect(system.getBalance(memberId)).toBe(before + 5 * MICROCREDITS_PER_CREDIT);

    const second = await app.inject({ method: "POST", url: `/api/v1/admin/payment-orders/${order.id}/confirm`, headers: cookie(adminToken), payload: {} });
    expect(second.json().credited).toBe(false);
    expect(system.getBalance(memberId)).toBe(before + 5 * MICROCREDITS_PER_CREDIT);
  });

  it("对账能看到「已付款但未入账」", async () => {
    const order = seedOrder();
    // 模拟"钱收了、积分没加"：直接置已付但不走入账。
    system.updatePaymentOrder(order.id, { status: "paid", paidAt: new Date().toISOString() });

    const response = await app.inject({ method: "GET", url: "/api/v1/admin/payment-orders/reconcile", headers: cookie(adminToken) });
    expect(response.statusCode).toBe(200);
    expect(response.json().paidNotCredited.map((item: { id: string }) => item.id)).toEqual([order.id]);
  });

  it("对账能看到超期未付订单", async () => {
    const order = seedOrder({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/payment-orders/reconcile", headers: cookie(adminToken) });
    expect(response.json().expiredUnpaid.map((item: { id: string }) => item.id)).toEqual([order.id]);
  });

  it("已入账订单不能关闭", async () => {
    const order = seedOrder();
    await app.inject({ method: "POST", url: `/api/v1/admin/payment-orders/${order.id}/confirm`, headers: cookie(adminToken), payload: {} });

    const close = await app.inject({ method: "POST", url: `/api/v1/admin/payment-orders/${order.id}/close`, headers: cookie(adminToken) });
    expect(close.statusCode).toBe(409);
  });

  it("列表支持按状态筛选", async () => {
    seedOrder();
    const paid = seedOrder();
    system.updatePaymentOrder(paid.id, { status: "paid", paidAt: new Date().toISOString() });

    const response = await app.inject({ method: "GET", url: "/api/v1/admin/payment-orders?status=paid", headers: cookie(adminToken) });
    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((item: { id: string }) => item.id)).toEqual([paid.id]);
  });

  it("非法状态值被拒绝", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/payment-orders?status=bogus", headers: cookie(adminToken) });
    expect(response.statusCode).toBe(400);
  });
});
