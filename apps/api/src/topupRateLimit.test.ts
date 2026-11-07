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
 * 充值下单限流（审计 P2）。
 *
 * 下单会写订单行并生成网关跳转链接，不限流时可被脚本刷出大量垃圾订单。
 * 这里断言限流发生在业务校验之前——即使支付渠道未配置，也应先被限流挡住。
 */

let dataDir = "";
let app: FastifyInstance;
let database: ReturnType<typeof openDatabase>;
let token = "";

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ecomgen-topup-"));
  app = await buildApi({ dataDir, redisUrl: "redis://127.0.0.1:6399", masterKey: Buffer.alloc(32, 7).toString("base64") });
  database = openDatabase(join(dataDir, "ecomgen.sqlite"));
  const system = new EcomRepository(database);
  const user = system.createUser({ email: "buyer@example.com", passwordHash: "x", displayName: "买家", role: "user" });
  token = `buyer-${randomUUID()}`;
  system.createSession({ userId: user.id, tokenHash: hashToken(token), userAgent: "vitest", ip: "127.0.0.1", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("充值下单限流", () => {
  it("连续下单超过上限后返回 429", async () => {
    const headers = { cookie: `ecomgen_session=${token}` };
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const response = await app.inject({ method: "POST", url: "/api/v1/billing/topup-orders", headers, payload: { credits: 10 } });
      statuses.push(response.statusCode);
    }

    // 前 5 次通过限流（此处因未配置支付渠道返回 422），第 6 次被限流拦下。
    expect(statuses.slice(0, 5).every((code) => code !== 429)).toBe(true);
    expect(statuses[5]).toBe(429);

    const blocked = await app.inject({ method: "POST", url: "/api/v1/billing/topup-orders", headers, payload: { credits: 10 } });
    expect(blocked.json().error.code).toBe("RATE_LIMITED");
  });
});
