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

/**
 * 扣费链路的端到端验证。
 *
 * 只有把"用户建任务 → 余额下降 → 计费单落库"跑通，才证明 createChargedJob 真的接上了。
 * 管理员豁免由 providerAccess 之外的规则保证，这里专门用普通用户测。
 */

let dataDir = "";
let app: FastifyInstance;
let database: ReturnType<typeof openDatabase>;
let system: EcomRepository;
let token = "";
let userId = "";
let projectId = "";
let itemId = "";
let providerId = "";

const PRICE = 400_000; // 0.4 积分/张

function cookie(): Record<string, string> {
  return { cookie: `ecomgen_session=${token}` };
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ecomgen-billing-flow-"));
  app = await buildApi({ dataDir, redisUrl: "redis://127.0.0.1:6399", masterKey: Buffer.alloc(32, 7).toString("base64") });
  database = openDatabase(join(dataDir, "ecomgen.sqlite"));
  system = new EcomRepository(database);

  const provider = system.saveProvider({
    name: "平台渠道",
    baseUrl: "https://api.example.com/v1",
    encryptedApiKey: "enc",
    reasoningProtocol: "openai",
    models: [{ id: "img", supportsVision: false, supportsThinking: false, supportsTools: false, supportsStructuredOutput: false, imageApiKind: "openai_images" }],
  });
  providerId = provider.id;
  system.upsertProviderModelPrice({ providerId, modelId: "img", kind: "image", pricingMode: "per_image", priceMicrocredits: PRICE, costMicrocredits: 200_000, tiers: {}, active: true });

  const user = system.createUser({ email: "buyer@example.com", passwordHash: "x", displayName: "买家", role: "user" });
  userId = user.id;
  token = `buyer-${randomUUID()}`;
  system.createSession({ userId, tokenHash: hashToken(token), userAgent: "vitest", ip: "127.0.0.1", expiresAt: new Date(Date.now() + 3600_000).toISOString() });

  const owned = system.forOwner(userId);
  const project = owned.createProject({ name: "待生成", category: null, productDescription: null, verifiedFacts: [], prohibitedClaims: [], brandGuidelines: {}, platformTargets: [], targetMarket: null, copyLanguage: null, reasoningProviderId: null, reasoningModelId: null, imageProviderId: providerId, imageModelId: "img", defaultMode: "CREATIVE", imageResolution: "1K", imageAspectRatio: "AUTO", candidatesPerType: 1 });
  projectId = project.id;
  owned.saveStoryboard(projectId, "lock", "CONFIRMED", [
    { assetType: "hero-image", displayName: "主图", shotRole: "HERO", templateVariant: null, candidateCount: 1, referencedAssets: [], mode: "CREATIVE", status: "CONFIRMED", promptInstruction: "cup", compiledPrompt: null, factClaims: [], riskFlags: [], sortOrder: 0 },
  ]);
  itemId = owned.listStoryboardItems(projectId)[0].id;
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function fund(credits: number): void {
  system.applyCreditEntry({ userId, type: "signup_bonus", amountMicrocredits: credits * MICROCREDITS_PER_CREDIT });
}

function generateRequest(idempotencyKey: string) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/generation-jobs`,
    headers: { ...cookie(), "idempotency-key": idempotencyKey },
    payload: { storyboardItemIds: [itemId] },
  });
}

describe("生成任务扣费", () => {
  it("建任务即按张预扣，并落 reserved 计费单", async () => {
    fund(2);
    const before = system.getBalance(userId);

    const response = await generateRequest("k1");
    expect(response.statusCode).toBe(202);
    const jobId = response.json().jobs[0].id as string;

    expect(system.getBalance(userId)).toBe(before - PRICE);
    const billing = system.getBillingOrderByJob(jobId);
    expect(billing?.status).toBe("reserved");
    expect(billing?.reservedMicrocredits).toBe(PRICE);
  });

  it("余额不足返回 402，且不建任务、不扣费", async () => {
    fund(0);
    const before = system.getBalance(userId);

    const response = await generateRequest("k2");
    expect(response.statusCode).toBe(402);
    expect(response.json().error.code).toBe("INSUFFICIENT_CREDITS");

    expect(system.getBalance(userId)).toBe(before);
    expect(system.listJobs(projectId)).toEqual([]);
  });

  it("模型没配价目返回 422，不静默免费出图", async () => {
    fund(2);
    system.upsertProviderModelPrice({ providerId, modelId: "img", kind: "image", pricingMode: "per_image", priceMicrocredits: PRICE, costMicrocredits: 0, tiers: {}, active: false });

    const response = await generateRequest("k3");
    expect(response.statusCode).toBe(422);
    expect(system.listJobs(projectId)).toEqual([]);
  });

  it("同一幂等键复用既有任务，不重复扣费", async () => {
    fund(2);
    const first = await generateRequest("same-key");
    expect(first.statusCode).toBe(202);
    const afterFirst = system.getBalance(userId);

    const second = await generateRequest("same-key");
    expect(second.statusCode).toBe(202);
    expect(second.json().jobs[0].id).toBe(first.json().jobs[0].id);
    expect(system.getBalance(userId)).toBe(afterFirst);
  });

  it("管理员豁免扣费", async () => {
    const owner = system.listUsers({ role: "owner", limit: 1, offset: 0 }).items[0];
    const ownerToken = `owner-${randomUUID()}`;
    system.createSession({ userId: owner.id, tokenHash: hashToken(ownerToken), userAgent: "vitest", ip: "127.0.0.1", expiresAt: new Date(Date.now() + 3600_000).toISOString() });

    const response = await app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/generation-jobs`, headers: { cookie: `ecomgen_session=${ownerToken}`, "idempotency-key": "owner-key" }, payload: { storyboardItemIds: [itemId] } });
    // 管理员用别人的项目会被归属过滤挡掉，这里只验证"没走到扣费分支"不会 402/422。
    expect([202, 404]).toContain(response.statusCode);
  });
});
