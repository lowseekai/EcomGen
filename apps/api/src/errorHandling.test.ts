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
 * 错误响应的边界。
 *
 * 重点是把"客户端发错了"和"服务端坏了"分开：前者必须 4xx 且不泄露内部信息，
 * 后者才允许 5xx。之前 Fastify 自己抛的 4xx（畸形 JSON）会被统一报成 500，
 * 调用方以为是服务故障，运维也会被无意义的告警淹没。
 */

let dataDir = "";
let app: FastifyInstance;
let database: ReturnType<typeof openDatabase>;
let token = "";

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ecomgen-errors-"));
  app = await buildApi({ dataDir, redisUrl: "redis://127.0.0.1:6399", masterKey: Buffer.alloc(32, 7).toString("base64") });
  database = openDatabase(join(dataDir, "ecomgen.sqlite"));
  const system = new EcomRepository(database);
  const user = system.createUser({ email: "user@example.com", passwordHash: "x", displayName: "U", role: "user" });
  token = `user-${randomUUID()}`;
  system.createSession({ userId: user.id, tokenHash: hashToken(token), userAgent: "vitest", ip: "127.0.0.1", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const auth = () => ({ cookie: `ecomgen_session=${token}` });

describe("错误响应边界", () => {
  it("畸形 JSON 返回 400，而不是 500", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...auth(), "content-type": "application/json" },
      payload: "{ this is not json",
    });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.requestId).toBeTruthy();
  });

  it("请求体不符合契约时给出可定位的字段路径", async () => {
    const response = await app.inject({ method: "POST", url: "/api/v1/projects", headers: auth(), payload: {} });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details.length).toBeGreaterThan(0);
    expect(body.error.details[0].path).toMatch(/^body\./);
  });

  it("未知路由返回 404 且不暴露内部结构", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/definitely-not-a-route", headers: auth() });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("at Object.");
  });

  it("未知资源返回 404，且响应体不含堆栈", async () => {
    const response = await app.inject({ method: "GET", url: `/api/v1/projects/${randomUUID()}`, headers: auth() });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("stack");
    expect(response.body).not.toContain("node_modules");
  });

  it("未登录是 401，不是 500", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/projects" });
    expect(response.statusCode).toBe(401);
  });
});
