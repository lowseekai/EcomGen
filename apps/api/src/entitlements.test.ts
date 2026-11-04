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
import { EcomRepository, hashToken, openDatabase } from "@ecomgen/core";
import { buildApi } from "./app.js";

/**
 * 套餐功能开关。
 *
 * 这些字段曾经只在管理端可编辑、任何地方都不判定——管理员把"免费版不允许 PSD 导出"
 * 配好，实际什么都不会发生。这里断言：免费套餐被拦，站长（无限权益）不被拦。
 */

let dataDir = "";
let app: FastifyInstance;
let database: ReturnType<typeof openDatabase>;
let memberToken = "";
let ownerToken = "";

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ecomgen-entitlements-"));
  app = await buildApi({ dataDir, redisUrl: "redis://127.0.0.1:6399", masterKey: Buffer.alloc(32, 7).toString("base64") });
  database = openDatabase(join(dataDir, "ecomgen.sqlite"));
  const system = new EcomRepository(database);

  const member = system.createUser({ email: "member@example.com", passwordHash: "x", displayName: "会员", role: "user" });
  const owner = system.createUser({ email: "owner@example.com", passwordHash: "x", displayName: "站长", role: "owner" });
  memberToken = `member-${randomUUID()}`;
  ownerToken = `owner-${randomUUID()}`;
  for (const [userId, token] of [[member.id, memberToken], [owner.id, ownerToken]] as const) {
    system.createSession({ userId, tokenHash: hashToken(token), userAgent: "vitest", ip: "127.0.0.1", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  }
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const as = (token: string) => ({ cookie: `ecomgen_session=${token}` });

describe("套餐功能开关", () => {
  it("免费套餐不能建套图反推任务", async () => {
    const response = await app.inject({ method: "POST", url: "/api/v1/suite-forge-jobs", headers: as(memberToken) });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(response.json().error.message).toContain("套图反推");
  });

  it("免费套餐不能下载 PSD", async () => {
    const response = await app.inject({ method: "GET", url: `/api/v1/files/layer-exports/${randomUUID()}`, headers: as(memberToken) });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain("PSD");
  });

  it("免费套餐不能开联网研究", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: as(memberToken),
      payload: { name: "研究项目", reasoningProviderId: randomUUID(), reasoningModelId: "m", imageProviderId: randomUUID(), imageModelId: "m", defaultMode: "CREATIVE", webResearchEnabled: true },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain("联网研究");
  });

  it("免费套餐最高 2K，请求 4K 被拒绝", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: as(memberToken),
      payload: { name: "高清项目", reasoningProviderId: randomUUID(), reasoningModelId: "m", imageProviderId: randomUUID(), imageModelId: "m", defaultMode: "CREATIVE", imageResolution: "4K" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain("2K");
  });

  it("管理员关掉套餐开关后立即生效", async () => {
    // 这条断言的是"配置真的接到了执行点"：只测默认值不变的话，
    // 即使开关根本没被任何代码读取，测试也会绿。
    const patch = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/plans/plan-free",
      headers: as(ownerToken),
      payload: { entitlements: { allowPatternStudio: false } },
    });
    expect(patch.statusCode).toBe(200);

    const blocked = await app.inject({ method: "POST", url: "/api/v1/patterns/upload", headers: as(memberToken) });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.message).toContain("花型工坊");
  });

  it("站长走无限权益，不被功能开关拦截", async () => {
    // 站长缺参数会得到 400/422，但绝不该是 403 —— 那说明权益判定把管理员也拦住了。
    const forge = await app.inject({ method: "POST", url: "/api/v1/suite-forge-jobs", headers: as(ownerToken) });
    expect(forge.statusCode).not.toBe(403);

    const psd = await app.inject({ method: "GET", url: `/api/v1/files/layer-exports/${randomUUID()}`, headers: as(ownerToken) });
    expect(psd.statusCode).not.toBe(403);
  });
});
