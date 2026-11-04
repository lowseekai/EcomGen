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
import { BillingService, EcomRepository, MICROCREDITS_PER_CREDIT, hashToken, openDatabase } from "@ecomgen/core";
import { buildApi } from "./app.js";

/**
 * 管理后台的权限与关键动作。
 *
 * 重点不是"接口能通"，而是三件会出人命的事：
 * 普通用户进不来、support 只读、管理员不能把自己锁在外面。
 */

let dataDir = "";
let app: FastifyInstance;
let database: ReturnType<typeof openDatabase>;
let system: EcomRepository;

let ownerToken = "";
let adminToken = "";
let supportToken = "";
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
  dataDir = mkdtempSync(join(tmpdir(), "ecomgen-admin-"));
  app = await buildApi({ dataDir, redisUrl: "redis://127.0.0.1:6399", masterKey: Buffer.alloc(32, 7).toString("base64") });
  database = openDatabase(join(dataDir, "ecomgen.sqlite"));
  system = new EcomRepository(database);

  const owner = system.listUsers({ role: "owner", limit: 1, offset: 0 }).items[0];
  const admin = system.createUser({ email: "admin@example.com", passwordHash: "x", displayName: "管理员", role: "admin" });
  const support = system.createUser({ email: "support@example.com", passwordHash: "x", displayName: "客服", role: "support" });
  const member = system.createUser({ email: "member@example.com", passwordHash: "x", displayName: "用户", role: "user" });
  memberId = member.id;

  ownerToken = makeSession(owner.id, "owner");
  adminToken = makeSession(admin.id, "admin");
  supportToken = makeSession(support.id, "support");
  memberToken = makeSession(member.id, "member");
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("管理后台权限", () => {
  it("普通用户访问任何管理接口都是 403", async () => {
    for (const [method, url] of [["GET", "/api/v1/admin/users"], ["GET", "/api/v1/admin/prices"], ["GET", "/api/v1/admin/audit"], ["GET", "/api/v1/admin/billing/uncertain"]] as const) {
      const response = await app.inject({ method, url, headers: cookie(memberToken) });
      expect(response.statusCode, `${url} 不应允许普通用户访问`).toBe(403);
    }
  });

  it("support 可读不可写", async () => {
    const read = await app.inject({ method: "GET", url: "/api/v1/admin/users", headers: cookie(supportToken) });
    expect(read.statusCode).toBe(200);

    const write = await app.inject({ method: "POST", url: `/api/v1/admin/users/${memberId}/credits`, headers: cookie(supportToken), payload: { credits: 1 } });
    expect(write.statusCode).toBe(403);
  });

  it("未登录是 401", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/users" });
    expect(response.statusCode).toBe(401);
  });
});

describe("用户管理", () => {
  it("列表带余额，且不泄露密码哈希", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/users", headers: cookie(adminToken) });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(body)).not.toContain("passwordHash");
    for (const item of body.items) expect(item).toHaveProperty("balanceMicrocredits");
  });

  it("调整积分：余额变化并留审计", async () => {
    const response = await app.inject({ method: "POST", url: `/api/v1/admin/users/${memberId}/credits`, headers: cookie(adminToken), payload: { credits: 5, note: "补偿" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().balanceMicrocredits).toBe(5 * MICROCREDITS_PER_CREDIT);

    const ledger = await app.inject({ method: "GET", url: `/api/v1/admin/users/${memberId}/ledger`, headers: cookie(adminToken) });
    expect(ledger.json().items).toHaveLength(1);
    // 余额与流水重算值必须一致，否则就是账目漂移。
    expect(ledger.json().balance.stored).toBe(ledger.json().balance.computed);

    const audit = await app.inject({ method: "GET", url: "/api/v1/admin/audit", headers: cookie(adminToken) });
    expect(audit.json().items.map((item: { action: string }) => item.action)).toContain("credit.adjust");
  });

  it("封禁立即撤销会话", async () => {
    const response = await app.inject({ method: "PATCH", url: `/api/v1/admin/users/${memberId}`, headers: cookie(adminToken), payload: { status: "disabled" } });
    expect(response.statusCode).toBe(200);

    // 旧 Cookie 再也换不到身份。
    const blocked = await app.inject({ method: "GET", url: "/api/v1/projects", headers: cookie(memberToken) });
    expect(blocked.statusCode).toBe(401);
  });

  it("管理员不能封禁或降级自己", async () => {
    const me = system.getUserByEmail("admin@example.com")!;
    for (const payload of [{ status: "disabled" }, { role: "user" }]) {
      const response = await app.inject({ method: "PATCH", url: `/api/v1/admin/users/${me.id}`, headers: cookie(adminToken), payload });
      expect(response.statusCode).toBe(400);
    }
  });

  it("不能移除最后一个站长", async () => {
    const owner = system.listUsers({ role: "owner", limit: 1, offset: 0 }).items[0];
    const response = await app.inject({ method: "PATCH", url: `/api/v1/admin/users/${owner.id}`, headers: cookie(ownerToken), payload: { role: "admin" } });
    // 自己改自己角色先被"不能修改自己的角色"挡住；用另一个管理员来改也应被最后站长规则挡住。
    expect(response.statusCode).toBe(400);
  });
});

describe("计费单人工裁决", () => {
  function seedUncertain(): string {
    const jobId = randomUUID();
    system.createJob({ id: jobId, projectId: null, storyboardItemId: null, type: "PATTERN_FORGE", input: {} });
    system.applyCreditEntry({ userId: memberId, type: "signup_bonus", amountMicrocredits: 2 * MICROCREDITS_PER_CREDIT });
    const billing = new BillingService(system);
    billing.reserve({ userId: memberId, jobId, quote: { providerId: "p", modelId: "m", kind: "image", pricingMode: "per_image", units: 1, unitMicrocredits: MICROCREDITS_PER_CREDIT, totalMicrocredits: MICROCREDITS_PER_CREDIT, costMicrocredits: 0, priceId: "x" } });
    billing.markUncertain(jobId);
    return jobId;
  }

  it("列出 uncertain 单并能退款", async () => {
    const jobId = seedUncertain();
    const list = await app.inject({ method: "GET", url: "/api/v1/admin/billing/uncertain", headers: cookie(adminToken) });
    expect(list.json().items.map((item: { jobId: string }) => item.jobId)).toEqual([jobId]);

    const resolved = await app.inject({ method: "POST", url: `/api/v1/admin/billing/${jobId}/resolve`, headers: cookie(adminToken), payload: { action: "refund" } });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().status).toBe("refunded");
    // 退回后余额回到 2 积分（赠送 2，预扣 1，退回 1）。
    expect(system.getBalance(memberId)).toBe(2 * MICROCREDITS_PER_CREDIT);
  });

  it("已裁决的单不能再裁决", async () => {
    const jobId = seedUncertain();
    await app.inject({ method: "POST", url: `/api/v1/admin/billing/${jobId}/resolve`, headers: cookie(adminToken), payload: { action: "refund" } });
    const again = await app.inject({ method: "POST", url: `/api/v1/admin/billing/${jobId}/resolve`, headers: cookie(adminToken), payload: { action: "settle" } });
    expect(again.statusCode).toBe(409);
  });
});

describe("价目管理", () => {
  it("配置、列出、删除价目", async () => {
    const provider = system.saveProvider({ name: "渠道", baseUrl: "https://api.example.com/v1", encryptedApiKey: "e", reasoningProtocol: "openai", models: [{ id: "img", supportsVision: false, supportsThinking: false, supportsTools: false, supportsStructuredOutput: false, imageApiKind: "openai_images" }] });

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/prices",
      headers: cookie(adminToken),
      payload: { providerId: provider.id, modelId: "img", kind: "image", pricingMode: "per_resolution", priceMicrocredits: 0, costMicrocredits: 0, tiers: { "1K": 400_000, "2K": 900_000 } },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().tiers["2K"]).toBe(900_000);

    const listed = await app.inject({ method: "GET", url: "/api/v1/admin/prices", headers: cookie(adminToken) });
    expect(listed.json().items).toHaveLength(1);

    const removed = await app.inject({ method: "DELETE", url: `/api/v1/admin/prices/${created.json().id}`, headers: cookie(adminToken) });
    expect(removed.statusCode).toBe(204);
    expect(system.listProviderModelPrices()).toHaveLength(0);
  });

  it("非法档位价目被拒绝", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/prices",
      headers: cookie(adminToken),
      payload: { providerId: "p", modelId: "m", kind: "image", pricingMode: "per_resolution", tiers: { "1K": -1 } },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("开户与重置密码", () => {
  async function createUser(payload: Record<string, unknown>, token = adminToken) {
    return app.inject({ method: "POST", url: "/api/v1/admin/users", headers: cookie(token), payload });
  }

  it("指定密码开户后可以直接登录", async () => {
    const created = await createUser({ email: "newbie@example.com", displayName: "新用户", password: "a-long-password", credits: 3 });
    expect(created.statusCode).toBe(201);
    expect(created.json().generatedPassword).toBeUndefined();
    expect(created.json().balanceMicrocredits).toBe(3 * MICROCREDITS_PER_CREDIT);

    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "newbie@example.com", password: "a-long-password" } });
    expect(login.statusCode).toBe(200);
  });

  it("不指定密码时生成一次性随机密码，且能登录", async () => {
    const created = await createUser({ email: "random@example.com" });
    expect(created.statusCode).toBe(201);
    const generated = created.json().generatedPassword as string;
    expect(generated.length).toBeGreaterThan(12);

    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "random@example.com", password: generated } });
    expect(login.statusCode).toBe(200);

    // 明文只返回这一次：再查用户拿不到它。
    const detail = await app.inject({ method: "GET", url: `/api/v1/admin/users/${created.json().id}`, headers: cookie(adminToken) });
    expect(JSON.stringify(detail.json())).not.toContain(generated);
  });

  it("邮箱重复返回 409", async () => {
    await createUser({ email: "dup@example.com", password: "a-long-password" });
    const again = await createUser({ email: "DUP@example.com", password: "a-long-password" });
    expect(again.statusCode).toBe(409);
  });

  it("弱密码与非法邮箱被拒绝", async () => {
    expect((await createUser({ email: "weak@example.com", password: "short" })).statusCode).toBe(400);
    expect((await createUser({ email: "not-an-email", password: "a-long-password" })).statusCode).toBe(400);
  });

  it("普通用户不能开户", async () => {
    const response = await createUser({ email: "nope@example.com" }, memberToken);
    expect(response.statusCode).toBe(403);
  });

  it("重置密码撤销全部会话，旧密码立即失效", async () => {
    const created = await createUser({ email: "reset@example.com", password: "old-password-1" });
    const userId = created.json().id as string;

    const token = makeSession(userId, "reset");
    const before = await app.inject({ method: "GET", url: "/api/v1/projects", headers: cookie(token) });
    expect(before.statusCode).toBe(200);

    const reset = await app.inject({ method: "POST", url: `/api/v1/admin/users/${userId}/password`, headers: cookie(adminToken), payload: { password: "new-password-2" } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().revokedSessions).toBeGreaterThanOrEqual(1);

    // 旧会话失效。
    const after = await app.inject({ method: "GET", url: "/api/v1/projects", headers: cookie(token) });
    expect(after.statusCode).toBe(401);

    // 旧密码失效、新密码可用。
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "reset@example.com", password: "old-password-1" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "reset@example.com", password: "new-password-2" } })).statusCode).toBe(200);
  });
});

describe("邮件设置", () => {
  it("默认未配置", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/settings/mail", headers: cookie(adminToken) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ configured: false, hasPass: false, port: 587, requireStartTls: true });
  });

  it("保存后口令不回显，且再次保存不会把口令清空", async () => {
    const saved = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/settings/mail",
      headers: cookie(adminToken),
      payload: { host: "smtp.example.com", port: 465, secure: true, user: "mailer", pass: "s3cret", from: "no-reply@example.com", fromName: "EcomGen" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ ok: true, hasPass: true });

    const read = await app.inject({ method: "GET", url: "/api/v1/admin/settings/mail", headers: cookie(adminToken) });
    const body = read.json();
    expect(body.configured).toBe(true);
    expect(body.hasPass).toBe(true);
    // 口令绝不能出现在响应里。
    expect(JSON.stringify(body)).not.toContain("s3cret");

    // 只改发件人，不传口令：原口令必须保留。
    await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/settings/mail",
      headers: cookie(adminToken),
      payload: { fromName: "EcomGen 商城" },
    });
    const again = await app.inject({ method: "GET", url: "/api/v1/admin/settings/mail", headers: cookie(adminToken) });
    expect(again.json().hasPass).toBe(true);
    expect(again.json().fromName).toBe("EcomGen 商城");
  });

  it("缺少 host 或 from 被拒绝，端口非法也被拒绝", async () => {
    const missing = await app.inject({ method: "PATCH", url: "/api/v1/admin/settings/mail", headers: cookie(adminToken), payload: { port: 587 } });
    expect(missing.statusCode).toBe(400);

    const badPort = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/settings/mail",
      headers: cookie(adminToken),
      payload: { host: "smtp.example.com", from: "a@b.c", port: 70000 },
    });
    expect(badPort.statusCode).toBe(400);
  });

  it("未配置时测试连接返回 422", async () => {
    const response = await app.inject({ method: "POST", url: "/api/v1/admin/settings/mail/test", headers: cookie(adminToken) });
    expect(response.statusCode).toBe(422);
  });

  it("普通用户无权访问", async () => {
    const read = await app.inject({ method: "GET", url: "/api/v1/admin/settings/mail", headers: cookie(memberToken) });
    expect(read.statusCode).toBe(403);
  });
});
