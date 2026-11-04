import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { openDatabase, type SqliteDatabase } from "./database.js";
import { EcomRepository } from "./repository.js";
import { SYSTEM_SCOPE, ownerScope } from "./scope.js";

/**
 * 归属隔离测试。
 *
 * 断言的是"用户 B 看不到也改不动用户 A 的东西"，覆盖根实体与经项目/花型推导的子实体。
 * 这些规则一旦失效不会抛错，只会静默返回别人的数据，所以必须有显式用例。
 */

function setup() {
  const db = openDatabase(":memory:");
  const system = new EcomRepository(db);
  const alice = system.createUser({ email: "alice@example.com", passwordHash: "x", displayName: "Alice" });
  const bob = system.createUser({ email: "bob@example.com", passwordHash: "x", displayName: "Bob" });
  return { db, system, alice, bob, aliceRepo: system.forOwner(alice.id), bobRepo: system.forOwner(bob.id) };
}

function makeProject(repository: EcomRepository, name: string) {
  return repository.createProject({ name, category: null, productDescription: null, verifiedFacts: [], prohibitedClaims: [], brandGuidelines: {}, platformTargets: [], targetMarket: null, copyLanguage: null, reasoningProviderId: null, reasoningModelId: null, imageProviderId: null, imageModelId: null, defaultMode: "CREATIVE", imageResolution: "1K", imageAspectRatio: "AUTO", candidatesPerType: 1 });
}

describe("根实体隔离", () => {
  it("owner 作用域只看到自己的项目，系统作用域看到全部", () => {
    const { system, alice, bob, aliceRepo, bobRepo } = setup();
    makeProject(aliceRepo, "Alice 的项目");
    makeProject(bobRepo, "Bob 的项目");

    expect(aliceRepo.listProjects().map((project) => project.name)).toEqual(["Alice 的项目"]);
    expect(bobRepo.listProjects().map((project) => project.name)).toEqual(["Bob 的项目"]);
    // 系统作用域保持改造前的行为：全部可见。
    expect(system.listProjects()).toHaveLength(2);
    expect(alice.id).not.toBe(bob.id);
  });

  it("拿别人的项目 id 取不到", () => {
    const { aliceRepo, bobRepo } = setup();
    const project = makeProject(aliceRepo, "私有");

    expect(aliceRepo.getProject(project.id)).toBeDefined();
    expect(bobRepo.getProject(project.id)).toBeUndefined();
  });

  it("改不动别人的项目", () => {
    const { aliceRepo, bobRepo } = setup();
    const project = makeProject(aliceRepo, "原名");

    expect(bobRepo.updateProject(project.id, { name: "被改名" })).toBeUndefined();
    expect(aliceRepo.getProject(project.id)?.name).toBe("原名");
  });

  it("删不掉别人的项目", () => {
    const { aliceRepo, bobRepo } = setup();
    const project = makeProject(aliceRepo, "保留");
    aliceRepo.updateProject(project.id, { archivedAt: new Date().toISOString() });

    expect(bobRepo.deleteArchivedProject(project.id)).toBe("missing");
    expect(aliceRepo.getProject(project.id)).toBeDefined();
  });

  it("写入时自动落 owner_id", () => {
    const { db, alice, aliceRepo } = setup();
    const project = makeProject(aliceRepo, "归属");
    const row = db.prepare("SELECT owner_id FROM projects WHERE id=?").get(project.id) as { owner_id: string };
    expect(row.owner_id).toBe(alice.id);
  });
});

describe("子实体经父表推导归属", () => {
  it("素材：看不到别人的上传，也删不掉", () => {
    const { aliceRepo, bobRepo } = setup();
    const project = makeProject(aliceRepo, "有素材");
    const asset = aliceRepo.createAsset({ projectId: project.id, role: "PRODUCT_TRUTH", storagePath: "assets/a.png", hash: "h1", originalName: "a.png", mimeType: "image/png", width: 10, height: 10 });

    expect(aliceRepo.listAssets(project.id)).toHaveLength(1);
    expect(bobRepo.listAssets(project.id)).toEqual([]);
    expect(bobRepo.getAsset(asset.id)).toBeUndefined();
    expect(bobRepo.deleteAsset(asset.id)).toBeUndefined();
    expect(aliceRepo.getAsset(asset.id)).toBeDefined();
  });

  it("分镜：拿 itemId 直接访问也取不到", () => {
    const { aliceRepo, bobRepo } = setup();
    const project = makeProject(aliceRepo, "有分镜");
    const storyboard = aliceRepo.saveStoryboard(project.id, "lock", "DRAFT", [
      { assetType: "hero-image", displayName: "主图", shotRole: "HERO", templateVariant: null, candidateCount: 1, referencedAssets: [], mode: "CREATIVE", status: "DRAFT", promptInstruction: "cup", compiledPrompt: null, factClaims: [], riskFlags: [], sortOrder: 0 },
    ]);
    const items = aliceRepo.listStoryboardItems(project.id);
    expect(items).toHaveLength(1);
    expect(storyboard.version).toBe(1);

    expect(bobRepo.getStoryboardItem(items[0].id)).toBeUndefined();
    expect(bobRepo.deleteStoryboardItem(items[0].id)).toBeUndefined();
    expect(bobRepo.listStoryboardItems(project.id)).toEqual([]);
    expect(aliceRepo.getStoryboardItem(items[0].id)).toBeDefined();
  });

  it("任务：按 id 取与按项目列都受归属约束", () => {
    const { aliceRepo, bobRepo } = setup();
    const project = makeProject(aliceRepo, "有任务");
    const job = aliceRepo.createJob({ id: randomUUID(), projectId: project.id, storyboardItemId: null, type: "PLAN", input: {} });

    expect(aliceRepo.getJob(job.id)).toBeDefined();
    expect(bobRepo.getJob(job.id)).toBeUndefined();
    expect(bobRepo.listJobs(project.id)).toEqual([]);
    expect(bobRepo.updateJob(job.id, { status: "FAILED" })).toBeUndefined();
  });

  it("输出：按 id 取受归属约束", () => {
    const { aliceRepo, bobRepo } = setup();
    const project = makeProject(aliceRepo, "有输出");
    const job = aliceRepo.createJob({ id: randomUUID(), projectId: project.id, storyboardItemId: null, type: "GENERATE", input: {} });
    aliceRepo.saveStoryboard(project.id, "lock", "CONFIRMED", [
      { assetType: "hero-image", displayName: "主图", shotRole: "HERO", templateVariant: null, candidateCount: 1, referencedAssets: [], mode: "CREATIVE", status: "CONFIRMED", promptInstruction: "cup", compiledPrompt: null, factClaims: [], riskFlags: [], sortOrder: 0 },
    ]);
    const items = aliceRepo.listStoryboardItems(project.id);
    const output = aliceRepo.createOutput({ projectId: project.id, storyboardItemId: items[0].id, jobId: job.id, candidateIndex: 1, generationKey: "g1", generationSnapshot: null, storagePath: "outputs/o.png", hash: "h", width: 1, height: 1, parentOutputId: null, rootOutputId: null, editSessionId: null, editTurnId: null });

    expect(aliceRepo.getOutput(output.id)).toBeDefined();
    expect(bobRepo.getOutput(output.id)).toBeUndefined();
    expect(bobRepo.listOutputs(project.id)).toEqual([]);
  });

  it("花型与模特按 owner_id 直接隔离", () => {
    const { aliceRepo, bobRepo } = setup();
    const pattern = aliceRepo.createPattern({ name: "花型", sourceType: "UPLOADED", sourceJobId: null, sourceAssetHash: null, parentPatternId: null, storagePath: "patterns/p.png", fileHash: "fh", width: 10, height: 10, tags: [] });
    const model = aliceRepo.createModel({ name: "模特", spec: {} as never, notes: "" });

    expect(aliceRepo.listPatterns()).toHaveLength(1);
    expect(bobRepo.listPatterns()).toEqual([]);
    expect(bobRepo.getPattern(pattern.id)).toBeUndefined();
    expect(bobRepo.deletePattern(pattern.id)).toBe(false);

    expect(bobRepo.listModels()).toEqual([]);
    expect(bobRepo.getModel(model.id)).toBeUndefined();
    expect(bobRepo.deleteModel(model.id)).toBe(false);
  });

  it("资产库按分支过滤，不串到别人的项目", () => {
    const { aliceRepo, bobRepo } = setup();
    const project = makeProject(aliceRepo, "库");
    aliceRepo.createAsset({ projectId: project.id, role: "PRODUCT_TRUTH", storagePath: "assets/a.png", hash: "h1", originalName: "a.png", mimeType: "image/png", width: 10, height: 10 });

    expect(aliceRepo.listLibraryItems().items).toHaveLength(1);
    expect(bobRepo.listLibraryItems().items).toEqual([]);
  });
});

describe("作用域语义", () => {
  it("forOwner 派生出的实例共享同一连接，但作用域不同", () => {
    const { alice, aliceRepo, system } = setup();
    expect(system.currentScope).toEqual(SYSTEM_SCOPE);
    expect(aliceRepo.currentScope).toEqual(ownerScope(alice.id));
  });

  it("系统作用域写入的归属为空，可被后续 claimOrphanRows 认领", () => {
    const { db, system, alice } = setup();
    const project = makeProject(system, "无主项目");
    const before = db.prepare("SELECT owner_id FROM projects WHERE id=?").get(project.id) as { owner_id: string | null };
    expect(before.owner_id).toBeNull();

    system.claimOrphanRows(alice.id);
    const after = db.prepare("SELECT owner_id FROM projects WHERE id=?").get(project.id) as { owner_id: string | null };
    expect(after.owner_id).toBe(alice.id);
  });
});
