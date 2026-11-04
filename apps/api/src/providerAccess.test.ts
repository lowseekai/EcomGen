import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 与 app.test.ts 同一套替身：这里不关心队列，只要入队不抛错。
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
 * 平台渠道的写权限边界。
 *
 * 已确认平台代付：Provider 与联网搜索源由管理员统一配置、API Key 由平台持有。
 * 如果普通用户能写，破坏面是跨租户的——删除 Provider 会级联把所有人的项目模型引用置空，
 * 并把在途任务取消；连通性测试则会拿平台的 Key 去打上游，等于把平台当探测代理。
 */

let dataDir = "";
let app: FastifyInstance;
let database: ReturnType<typeof openDatabase>;
let repository: EcomRepository;
let memberToken = "";
let adminToken = "";

function cookie(token: string): Record<string, string> {
  return { cookie: `ecomgen_session=${token}` };
}

function issueSession(userId: string, token: string): void {
  repository.createSession({
    userId,
    tokenHash: hashToken(token),
    userAgent: "vitest",
    ip: "127.0.0.1",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ecomgen-provider-access-"));
  app = await buildApi({ dataDir, redisUrl: "redis://127.0.0.1:6399", masterKey: Buffer.alloc(32, 7).toString("base64") });
  database = openDatabase(join(dataDir, "ecomgen.sqlite"));
  repository = new EcomRepository(database);

  const owner = repository.listUsers({ role: "owner", limit: 1, offset: 0 }).items[0];
  const member = repository.createUser({ email: "member@example.com", passwordHash: "x", displayName: "普通用户", role: "user" });

  adminToken = `owner-${randomUUID()}`;
  memberToken = `member-${randomUUID()}`;
  issueSession(owner.id, adminToken);
  issueSession(member.id, memberToken);
});

afterEach(async () => {
  await app.close();
  // 第二个连接由本文件持有，必须先关掉，否则 Windows 上删临时目录会 EBUSY。
  database.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const PROVIDER_BODY = { name: "平台渠道", baseUrl: "https://api.example.com/v1", apiKey: "sk-platform", reasoningProtocol: "openai", models: [{ id: "img-1", supportsVision: false, supportsThinking: false, supportsTools: false, supportsStructuredOutput: false, imageApiKind: "openai_images" }] };

describe("Provider 写权限", () => {
  it("普通用户可以读渠道列表", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/providers", headers: cookie(memberToken) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], nextCursor: null });
  });

  it("普通用户不能新增渠道", async () => {
    const response = await app.inject({ method: "POST", url: "/api/v1/providers", headers: cookie(memberToken), payload: PROVIDER_BODY });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
    // 拒绝必须是真的没写进去，而不只是回了 403。
    expect(repository.listProviders()).toHaveLength(0);
  });

  it("普通用户不能修改、删除或测试渠道", async () => {
    const created = await app.inject({ method: "POST", url: "/api/v1/providers", headers: cookie(adminToken), payload: PROVIDER_BODY });
    expect(created.statusCode).toBe(201);
    const providerId = created.json().id as string;

    const patched = await app.inject({ method: "PATCH", url: `/api/v1/providers/${providerId}`, headers: cookie(memberToken), payload: { name: "被改名" } });
    expect(patched.statusCode).toBe(403);

    const tested = await app.inject({ method: "POST", url: `/api/v1/providers/${providerId}/test`, headers: cookie(memberToken), payload: { modelId: "img-1", kind: "image" } });
    expect(tested.statusCode).toBe(403);

    const deleted = await app.inject({ method: "DELETE", url: `/api/v1/providers/${providerId}`, headers: cookie(memberToken) });
    expect(deleted.statusCode).toBe(403);

    expect(repository.listProviders()[0].name).toBe("平台渠道");
  });

  it("管理员可以新增并留下审计记录，且响应不含密钥", async () => {
    const response = await app.inject({ method: "POST", url: "/api/v1/providers", headers: cookie(adminToken), payload: PROVIDER_BODY });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.hasApiKey).toBe(true);
    expect(body.encryptedApiKey).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("sk-platform");

    const audit = repository.listAuditEvents(10, 0) as Array<{ action: string; target_id: string }>;
    expect(audit.map((event) => event.action)).toContain("provider.create");
  });
});

describe("联网搜索源写权限", () => {
  it("普通用户不能写，管理员可以写", async () => {
    const body = { name: "Brave", kind: "brave", apiKey: "brave-key", priority: 1 };

    const rejected = await app.inject({ method: "POST", url: "/api/v1/search-sources", headers: cookie(memberToken), payload: body });
    expect(rejected.statusCode).toBe(403);
    expect(repository.listSearchSources()).toHaveLength(0);

    const accepted = await app.inject({ method: "POST", url: "/api/v1/search-sources", headers: cookie(adminToken), payload: body });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().encryptedApiKey).toBeUndefined();
    expect(repository.listSearchSources()).toHaveLength(1);
  });

  it("普通用户可以读搜索源列表", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/search-sources", headers: cookie(memberToken) });
    expect(response.statusCode).toBe(200);
  });
});
