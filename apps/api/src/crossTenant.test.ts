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
 * 跨租户探针：用 B 的身份访问 A 的资源，必须全部 404。
 *
 * 这是归属隔离的最终守卫。仓储层已有单元测试（packages/core/src/scope.test.ts），
 * 但真正会泄露数据的是 HTTP 层——某个路由忘了让查询走请求作用域，仓储测试是看不见的。
 * 这里断言的是端到端行为：登录态、鉴权钩子、作用域传播、路由实现，缺一环就红。
 */

let dataDir = "";
let app: FastifyInstance;
let database: ReturnType<typeof openDatabase>;
let system: EcomRepository;
let aliceToken = "";
let bobToken = "";
let aliceId = "";

let projectId = "";
let assetId = "";
let jobId = "";
let patternId = "";
let modelId = "";
let storyboardItemId = "";
let outputId = "";
let portraitId = "";
let draftId = "";
let exportId = "";
let layerPlanId = "";
let layerExportId = "";
let paymentOrderId = "";
let templateId = "";
let suiteId = "";
let printPackId = "";
let sessionId = "";
let turnId = "";
let mediaId = "";
let batchId = "";
let candidateId = "";
let referenceAssetId = "";

function cookie(token: string): Record<string, string> {
  return { cookie: `ecomgen_session=${token}` };
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ecomgen-cross-tenant-"));
  app = await buildApi({ dataDir, redisUrl: "redis://127.0.0.1:6399", masterKey: Buffer.alloc(32, 7).toString("base64") });
  database = openDatabase(join(dataDir, "ecomgen.sqlite"));
  system = new EcomRepository(database);

  const alice = system.createUser({ email: "alice@example.com", passwordHash: "x", displayName: "Alice", role: "user" });
  const bob = system.createUser({ email: "bob@example.com", passwordHash: "x", displayName: "Bob", role: "user" });
  aliceId = alice.id;

  aliceToken = `alice-${randomUUID()}`;
  bobToken = `bob-${randomUUID()}`;
  for (const [userId, token] of [[alice.id, aliceToken], [bob.id, bobToken]] as const) {
    system.createSession({ userId, tokenHash: hashToken(token), userAgent: "vitest", ip: "127.0.0.1", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  }

  // A 的资源全部经 owner 作用域写入，模拟真实请求路径产生的归属。
  const aliceRepo = system.forOwner(alice.id);
  const project = aliceRepo.createProject({ name: "A 的项目", category: null, productDescription: null, verifiedFacts: [], prohibitedClaims: [], brandGuidelines: {}, platformTargets: [], targetMarket: null, copyLanguage: null, reasoningProviderId: null, reasoningModelId: null, imageProviderId: null, imageModelId: null, defaultMode: "CREATIVE", imageResolution: "1K", imageAspectRatio: "AUTO", candidatesPerType: 1 });
  projectId = project.id;

  const asset = aliceRepo.createAsset({ projectId, role: "PRODUCT_TRUTH", storagePath: "assets/a.png", hash: "h-a", originalName: "a.png", mimeType: "image/png", width: 8, height: 8 });
  assetId = asset.id;

  const storyboard = aliceRepo.saveStoryboard(projectId, "lock", "CONFIRMED", [
    { assetType: "hero-image", displayName: "主图", shotRole: "HERO", templateVariant: null, candidateCount: 1, referencedAssets: [], mode: "CREATIVE", status: "CONFIRMED", promptInstruction: "cup", compiledPrompt: null, factClaims: [], riskFlags: [], sortOrder: 0 },
  ]);
  expect(storyboard.version).toBe(1);
  storyboardItemId = aliceRepo.listStoryboardItems(projectId)[0].id;

  jobId = aliceRepo.createJob({ id: randomUUID(), projectId, storyboardItemId: null, type: "PLAN", input: {} }).id;
  patternId = aliceRepo.createPattern({ name: "A 的花型", sourceType: "UPLOADED", sourceJobId: null, sourceAssetHash: null, parentPatternId: null, storagePath: "patterns/p.png", fileHash: "fh-a", width: 8, height: 8, tags: [] }).id;
  modelId = aliceRepo.createModel({ name: "A 的模特", spec: {} as never, notes: "" }).id;
  portraitId = aliceRepo.createModelPortrait({ modelId, jobId, storagePath: "models/portrait.png", hash: "portrait-hash", width: 8, height: 8, providerId: "p", imageModelId: "img", aspectRatio: "1:1" }).id;
  draftId = aliceRepo.createPatternDraft({ name: "A 的起稿", composeType: "PLACEMENT", conditions: {} }).id;
  outputId = aliceRepo.createOutput({ projectId, storyboardItemId, jobId, candidateIndex: 1, generationKey: "g-1", generationSnapshot: null, storagePath: "outputs/a.png", hash: "hash-1", width: 8, height: 8, parentOutputId: null, rootOutputId: null, editSessionId: null, editTurnId: null }).id;
  exportId = aliceRepo.createExport({ projectId, jobId, status: "SUCCEEDED", storagePath: "exports/a.zip" }).id;
  layerPlanId = aliceRepo.createLayerPlan({ projectId, outputId, jobId, outputHash: "hash-1", status: "SUCCEEDED", elements: [], error: null }).id;
  layerExportId = aliceRepo.createLayerExport({ projectId, outputId, jobId, planId: layerPlanId, status: "SUCCEEDED", includeBackground: true, psdStoragePath: "layers/a.psd", layerFiles: null, error: null }).id;
  templateId = aliceRepo.saveUserTemplate({ id: randomUUID(), name: "A 的模板", prompt: "a cup on a table", defaultSize: "1024x1024", supportsImageReference: false }).id;
  suiteId = aliceRepo.saveUserSuite({ id: randomUUID(), name: "A 的套图", l1: "测试品类", l2: "测试二级", leaf: "测试叶子", productFamily: null, payload: {} as never }).id;
  printPackId = aliceRepo.createPrintPack({ patternId, jobId, specId: "spec-a", specVersion: "1" }).id;
  sessionId = aliceRepo.createEditSession({ id: randomUUID(), projectId, currentOutputId: outputId, status: "ACTIVE", memorySummary: {} }).id;
  turnId = aliceRepo.createEditTurn({ id: randomUUID(), sessionId, projectId, baseOutputId: outputId, status: "SUCCEEDED", message: "改一下背景", annotations: {}, editMaskPath: null, editMaskHash: null, protectMaskPath: null, protectMaskHash: null, referenceAssetIds: [] as string[], plan: null, error: null }).id;
  mediaId = aliceRepo.createDraftMedia({ draftId, role: "REFERENCE", source: "UPLOAD", sourcePatternId: null, storagePath: "drafts/a-ref.png", fileHash: "draft-hash-a", mimeType: "image/png", width: 8, height: 8, originalName: "a-ref.png", notes: null }).id;
  batchId = aliceRepo.createDraftBatch({ draftId, operation: "GENERATE", parentCandidateId: null, providerId: null, imageModelId: null, candidateCount: 1, instruction: null, snapshot: {}, clientKey: "ck-a" }).batch.id;
  candidateId = aliceRepo.createDraftCandidate({ draftId, batchId, slotIndex: 0, parentCandidateId: null, storagePath: "drafts/a-cand.png", fileHash: "draft-cand-hash", mimeType: "image/png", width: 8, height: 8, transform: "GENERATE", hasAlpha: false }).id;
  referenceAssetId = aliceRepo.createEditReferenceAsset({ id: randomUUID(), projectId, sessionId, turnId: null, storagePath: "edits/ref.png", hash: "edit-ref-hash", originalName: "ref.png", mimeType: "image/png", purpose: "PRODUCT_APPEARANCE", expiresAt: new Date(Date.now() + 86_400_000).toISOString() }).id;
  paymentOrderId = aliceRepo.createPaymentOrder({ userId: alice.id, kind: "credits", planId: null, creditsMicrocredits: 1_000_000, amountCents: 100, currency: "CNY", provider: "epay", providerConfig: {}, expiresAt: new Date(Date.now() + 600_000).toISOString() }).id;
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("跨租户访问必须 404", () => {
  it("列表接口看不到别人的项目", async () => {
    const mine = await app.inject({ method: "GET", url: "/api/v1/projects", headers: cookie(aliceToken) });
    expect(mine.json().items.map((item: { id: string }) => item.id)).toEqual([projectId]);

    const others = await app.inject({ method: "GET", url: "/api/v1/projects", headers: cookie(bobToken) });
    expect(others.statusCode).toBe(200);
    expect(others.json().items).toEqual([]);
  });

  it("按 id 直取别人的资源一律 404", async () => {
    const probes: Array<[string, string]> = [
      ["GET", `/api/v1/projects/${projectId}`],
      ["GET", `/api/v1/models/${modelId}`],
      ["GET", `/api/v1/patterns/${patternId}`],
      ["GET", `/api/v1/jobs/${jobId}`],
      ["GET", `/api/v1/projects/${projectId}/outputs`],
      ["GET", `/api/v1/projects/${projectId}/storyboard`],
      ["GET", `/api/v1/files/assets/${assetId}`],
    ];
    for (const [method, url] of probes) {
      const response = await app.inject({ method: method as "GET", url, headers: cookie(bobToken) });
      expect(response.statusCode, `${method} ${url} 泄露了别人的数据`).toBe(404);
    }
  });

  it("改不动、删不掉别人的资源", async () => {
    const patched = await app.inject({ method: "PATCH", url: `/api/v1/projects/${projectId}`, headers: cookie(bobToken), payload: { name: "被改名" } });
    expect(patched.statusCode).toBe(404);

    const deletedAsset = await app.inject({ method: "DELETE", url: `/api/v1/assets/${assetId}`, headers: cookie(bobToken) });
    expect(deletedAsset.statusCode).toBe(404);

    const deletedItem = await app.inject({ method: "DELETE", url: `/api/v1/storyboard-items/${storyboardItemId}`, headers: cookie(bobToken) });
    expect(deletedItem.statusCode).toBe(404);

    // 拒绝必须是真的没写进去。
    const aliceRepo = system.forOwner(aliceId);
    expect(aliceRepo.getProject(projectId)?.name).toBe("A 的项目");
    expect(aliceRepo.getAsset(assetId)).toBeDefined();
  });

  it("资源所有者自己访问正常", async () => {
    for (const url of [`/api/v1/projects/${projectId}`, `/api/v1/models/${modelId}`, `/api/v1/patterns/${patternId}`, `/api/v1/jobs/${jobId}`]) {
      const response = await app.inject({ method: "GET", url, headers: cookie(aliceToken) });
      expect(response.statusCode, `${url} 对所有者应可访问`).toBe(200);
    }
  });

  it("未登录一律 401", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/projects" });
    expect(response.statusCode).toBe(401);
  });
});

/**
 * 全路由自动探针。
 *
 * 路由表从 Fastify 实例动态解析，所以**新增接口会自动进入覆盖范围**——
 * 之前手工维护清单时，`/outputs/:outputId/layer-exports` 这类按父 id 取的路由就漏掉了，
 * 直到某次改动才发现那 6 个方法根本没有归属复核。
 *
 * 断言两条：
 * 1. 不得返回 2xx（B 不能读到、也不能改动 A 的资源）；
 * 2. 响应体里不得出现 A 的任何标识（id、存储路径）——即便状态码是 400，
 *    只要回显了 A 的数据同样是泄露。
 */
describe("全路由自动探针", () => {
  /** 把路由里的占位参数换成 A 的真实资源 id；缺映射的参数说明该路由不在覆盖范围。 */
  function paramValue(name: string): string | undefined {
    const map: Record<string, string> = {
      projectId, outputId, jobId, assetId, modelId, portraitId, patternId, draftId,
      storyboardItemId, exportId, layerPlanId, layerExportId, orderId: paymentOrderId,
      templateId, suiteId, printPackId, sessionId, turnId,
      itemId: storyboardItemId, mediaId, batchId, candidateId, referenceAssetId,
    };
    return map[name];
  }

  /** 解析 printRoutes 的树形输出：按缩进还原完整路径。 */
  function listRoutes(tree: string): Array<{ method: string; url: string }> {
    const routes: Array<{ method: string; url: string }> = [];
    const pathByDepth: string[] = [];
    for (const line of tree.split("\n")) {
      const match = line.match(/^([│ ]*)(?:├── |└── )(.*)$/);
      if (!match) continue;
      const depth = match[1].length / 4;
      const body = match[2].trim();
      const handled = body.match(/^(.*?) \(([A-Z, ]+)\)$/);
      const segment = handled ? handled[1] : body;
      const parent = depth === 0 ? "" : (pathByDepth[depth - 1] ?? "");
      const url = segment.startsWith("/") || segment.startsWith("-") || parent.endsWith("/")
        ? `${parent}${segment}`
        : `${parent}/${segment}`;
      pathByDepth[depth] = url;
      pathByDepth.length = depth + 1;
      if (!handled) continue;
      for (const method of handled[2].split(", ")) {
        if (method === "HEAD") continue;
        routes.push({ method, url });
      }
    }
    return routes;
  }

  it("B 访问 A 的任一资源都拿不到 2xx，也读不到 A 的数据", async () => {
    const routes = listRoutes(app.printRoutes({ commonPrefix: false }));
    expect(routes.length).toBeGreaterThan(100);

    const aliceIds = [projectId, outputId, jobId, assetId, modelId, patternId, draftId, exportId, layerExportId, paymentOrderId, "hash-1", "outputs/"];
    const failures: string[] = [];
    const uncovered = new Set<string>();

    for (const route of routes) {
      const params = [...route.url.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1]);
      if (params.length === 0) continue;

      const values = params.map(paramValue);
      if (values.some((value) => value === undefined)) {
        for (const param of params) if (paramValue(param) === undefined) uncovered.add(param);
        continue;
      }

      let url = route.url;
      params.forEach((param, index) => { url = url.replace(`:${param}`, values[index]!); });

      const response = await app.inject({
        method: route.method as "GET",
        url,
        headers: cookie(bobToken),
        payload: route.method === "GET" || route.method === "DELETE" ? undefined : {},
      });

      // 404 的报错会回显调用方自己传的 id——那不是泄露（请求方本来就知道）。
      // 只检查"URL 里没有出现过的" A 的标识，以及任何存储路径。
      const body = response.body ?? "";
      const echoedInUrl = new Set(values as string[]);
      const leaked = aliceIds.some((id) => id && !echoedInUrl.has(id) && body.includes(id))
        || ["outputs/", "assets/", "layers/", "patterns/"].some((prefix) => body.includes(prefix));
      if (response.statusCode < 400 || leaked) {
        failures.push(`${route.method} ${url} → ${response.statusCode}${leaked ? "（响应体含 A 的标识）" : ""}`);
      }
    }

    // 未覆盖的参数名打印出来，方便补种子数据；不影响通过。
    if (uncovered.size > 0) console.log(`探针未覆盖的参数：${[...uncovered].join(", ")}`);
    expect(failures).toEqual([]);
  });
});
