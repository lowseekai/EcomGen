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
import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import { API_SCHEMA_REGISTRY } from "@ecomgen/contracts";
import { EcomRepository, hashToken, openDatabase } from "@ecomgen/core";
import { buildApi } from "./app.js";
// 导入即注册 format: uuid / date-time，否则校验会把合法的 v7 主键判成非法。
import "./http-input.js";

/**
 * 响应体契约一致性。
 *
 * 之前只校验**请求**（parseBody），响应从来没人校验——后端多返回、少返回、
 * 类型漂移都不会被任何测试发现，而前端拿到形状不对的数据只会在运行时炸。
 * 这里拿契约里的 TypeBox schema 直接校验真实响应。
 */

const references = Object.values(API_SCHEMA_REGISTRY);

function schema(name: string): TSchema {
  const found = (API_SCHEMA_REGISTRY as Record<string, unknown>)[name];
  if (!found) throw new Error(`schema not registered: ${name}`);
  return found as TSchema;
}

let dataDir = "";
let app: FastifyInstance;
let database: ReturnType<typeof openDatabase>;
let token = "";

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ecomgen-contract-"));
  app = await buildApi({ dataDir, redisUrl: "redis://127.0.0.1:6399", masterKey: Buffer.alloc(32, 7).toString("base64") });
  database = openDatabase(join(dataDir, "ecomgen.sqlite"));
  const system = new EcomRepository(database);
  const owner = system.createUser({ email: "owner@example.com", passwordHash: "x", displayName: "站长", role: "owner" });
  token = `owner-${randomUUID()}`;
  system.createSession({ userId: owner.id, tokenHash: hashToken(token), userAgent: "vitest", ip: "127.0.0.1", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const CASES: Array<{ url: string; schemaName: string }> = [
  { url: "/api/v1/auth/me", schemaName: "SessionState" },
  { url: "/api/v1/projects", schemaName: "ProjectList" },
  { url: "/api/v1/patterns", schemaName: "PatternList" },
  { url: "/api/v1/providers", schemaName: "ProviderList" },
  { url: "/api/v1/models", schemaName: "ModelList" },
  { url: "/api/v1/admin/plans", schemaName: "PlanList" },
  { url: "/api/v1/admin/audit", schemaName: "AuditEventList" },
  { url: "/api/v1/admin/users", schemaName: "AdminUserList" },
  { url: "/api/v1/admin/dashboard", schemaName: "AdminDashboard" },
  { url: "/api/v1/billing/orders", schemaName: "PaymentOrderList" },
];

describe("响应体符合契约", () => {
  for (const testCase of CASES) {
    it(`${testCase.url} 符合 ${testCase.schemaName}`, async () => {
      const response = await app.inject({ method: "GET", url: testCase.url, headers: { cookie: `ecomgen_session=${token}` } });
      expect(response.statusCode).toBe(200);

      const body = response.json();
      const target = schema(testCase.schemaName);
      if (!Value.Check(target, references, body)) {
        const errors = [...Value.Errors(target, references, body)].slice(0, 5).map((error) => `${error.path}: ${error.message}`);
        throw new Error(`${testCase.url} 不符合 ${testCase.schemaName}\n${errors.join("\n")}`);
      }
    });
  }
});
