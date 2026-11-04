import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { openDatabase } from "./database.js";
import { EcomRepository } from "./repository.js";
import { BillingService, markStaleReservationsUncertain, quoteJob, toCredits } from "./billing.js";
import { checkConcurrency, checkProjectQuota, checkStorageQuota, formatBytes } from "./quota.js";
import { MICROCREDITS_PER_CREDIT } from "./repositories/creditRepository.js";
import { mergeEntitlements } from "./repositories/planRepository.js";

/**
 * 计费与配额的行为测试。
 *
 * 这些规则错了不会抛异常，只会把钱算错，所以每条都要显式断言余额与流水。
 */

function setup() {
  const db = openDatabase(":memory:");
  const system = new EcomRepository(db);
  const user = system.createUser({ email: "buyer@example.com", passwordHash: "x", displayName: "买家", role: "user" });
  const repo = system.forOwner(user.id);
  const provider = system.saveProvider({
    name: "平台渠道",
    baseUrl: "https://api.example.com/v1",
    encryptedApiKey: "enc",
    reasoningProtocol: "openai",
    models: [{ id: "img", supportsVision: false, supportsThinking: false, supportsTools: false, supportsStructuredOutput: false, imageApiKind: "openai_images" }],
  });
  return { db, system, user, repo, providerId: provider.id };
}

function fund(repository: EcomRepository, userId: string, credits: number) {
  repository.applyCreditEntry({ userId, type: "signup_bonus", amountMicrocredits: credits * MICROCREDITS_PER_CREDIT });
}

describe("报价", () => {
  it("没有价目就不能收费，直接拒绝而不是静默免费", () => {
    const { repo, providerId } = setup();
    const result = quoteJob(repo, { providerId, modelId: "img", kind: "image" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("PRICE_NOT_CONFIGURED");
  });

  it("按张计价：单价 × 张数", () => {
    const { repo, providerId } = setup();
    repo.upsertProviderModelPrice({ providerId, modelId: "img", kind: "image", pricingMode: "per_image", priceMicrocredits: 500_000, costMicrocredits: 300_000, tiers: {}, active: true });
    const result = quoteJob(repo, { providerId, modelId: "img", kind: "image", units: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.quote.totalMicrocredits).toBe(1_500_000);
      expect(result.quote.costMicrocredits).toBe(900_000);
    }
  });

  it("按分辨率计价：缺档位就拒绝", () => {
    const { repo, providerId } = setup();
    repo.upsertProviderModelPrice({ providerId, modelId: "img", kind: "image", pricingMode: "per_resolution", priceMicrocredits: 0, costMicrocredits: 0, tiers: { "1K": 400_000, "2K": 900_000 }, active: true });

    const ok = quoteJob(repo, { providerId, modelId: "img", kind: "image", resolution: "2K" });
    expect(ok.ok && ok.quote.totalMicrocredits).toBe(900_000);

    const missing = quoteJob(repo, { providerId, modelId: "img", kind: "image", resolution: "4K" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe("PRICE_TIER_MISSING");
  });
});

describe("预扣 / 结算 / 退款", () => {
  it("余额不足时不建计费单，余额也不动", () => {
    const { repo, user, providerId } = setup();
    repo.upsertProviderModelPrice({ providerId, modelId: "img", kind: "image", pricingMode: "per_image", priceMicrocredits: 2 * MICROCREDITS_PER_CREDIT, costMicrocredits: 0, tiers: {}, active: true });
    fund(repo, user.id, 1);

    const quote = quoteJob(repo, { providerId, modelId: "img", kind: "image", units: 1 });
    expect(quote.ok).toBe(true);
    if (!quote.ok) return;

    const service = new BillingService(repo);
    const jobId = randomUUID();
    const reserved = service.reserve({ userId: user.id, jobId, quote: quote.quote });

    expect(reserved.ok).toBe(false);
    expect(repo.getBalance(user.id)).toBe(1 * MICROCREDITS_PER_CREDIT);
    expect(repo.getBillingOrderByJob(jobId)).toBeUndefined();
  });

  it("预扣成功后余额下降并落计费单", () => {
    const { repo, user, providerId } = setup();
    repo.upsertProviderModelPrice({ providerId, modelId: "img", kind: "image", pricingMode: "per_image", priceMicrocredits: 400_000, costMicrocredits: 0, tiers: {}, active: true });
    fund(repo, user.id, 2);

    const quote = quoteJob(repo, { providerId, modelId: "img", kind: "image", units: 1 });
    if (!quote.ok) throw new Error("quote failed");
    const jobId = randomUUID();
    const reserved = new BillingService(repo).reserve({ userId: user.id, jobId, quote: quote.quote });

    expect(reserved.ok).toBe(true);
    expect(repo.getBalance(user.id)).toBe(2 * MICROCREDITS_PER_CREDIT - 400_000);
    expect(repo.getBillingOrderByJob(jobId)?.status).toBe("reserved");
  });

  it("结算按实际用量找平差额，且只能结算一次", () => {
    const { repo, user, providerId } = setup();
    repo.upsertProviderModelPrice({ providerId, modelId: "img", kind: "image", pricingMode: "per_image", priceMicrocredits: 500_000, costMicrocredits: 0, tiers: {}, active: true });
    fund(repo, user.id, 2);

    const quote = quoteJob(repo, { providerId, modelId: "img", kind: "image", units: 2 });
    if (!quote.ok) throw new Error("quote failed");
    const jobId = randomUUID();
    const service = new BillingService(repo);
    service.reserve({ userId: user.id, jobId, quote: quote.quote });
    const afterReserve = repo.getBalance(user.id);

    // 实际只成功一张：应退回一半。
    service.settle(jobId, 500_000);
    expect(repo.getBalance(user.id)).toBe(afterReserve + 500_000);
    expect(repo.getBillingOrderByJob(jobId)?.status).toBe("settled");

    // 重复结算不得二次改账。
    const balance = repo.getBalance(user.id);
    service.settle(jobId, 0);
    expect(repo.getBalance(user.id)).toBe(balance);
  });

  it("明确失败全额退回", () => {
    const { repo, user, providerId } = setup();
    repo.upsertProviderModelPrice({ providerId, modelId: "img", kind: "image", pricingMode: "fixed_request", priceMicrocredits: 700_000, costMicrocredits: 0, tiers: {}, active: true });
    fund(repo, user.id, 2);

    const quote = quoteJob(repo, { providerId, modelId: "img", kind: "image" });
    if (!quote.ok) throw new Error("quote failed");
    const jobId = randomUUID();
    const service = new BillingService(repo);
    const before = repo.getBalance(user.id);
    service.reserve({ userId: user.id, jobId, quote: quote.quote });
    service.refund(jobId);

    expect(repo.getBalance(user.id)).toBe(before);
    expect(repo.getBillingOrderByJob(jobId)?.status).toBe("refunded");
  });

  it("结果未知时挂起，不自动退款", () => {
    const { repo, user, providerId } = setup();
    repo.upsertProviderModelPrice({ providerId, modelId: "img", kind: "image", pricingMode: "fixed_request", priceMicrocredits: 700_000, costMicrocredits: 0, tiers: {}, active: true });
    fund(repo, user.id, 2);

    const quote = quoteJob(repo, { providerId, modelId: "img", kind: "image" });
    if (!quote.ok) throw new Error("quote failed");
    const jobId = randomUUID();
    const service = new BillingService(repo);
    service.reserve({ userId: user.id, jobId, quote: quote.quote });
    const afterReserve = repo.getBalance(user.id);

    service.markUncertain(jobId);

    expect(repo.getBillingOrderByJob(jobId)?.status).toBe("uncertain");
    // 关键：Provider 可能已计费，钱不能退。
    expect(repo.getBalance(user.id)).toBe(afterReserve);
    expect(repo.listUncertainBillingOrders(10, 0).map((order) => order.jobId)).toEqual([jobId]);
  });
});

describe("配额", () => {
  const base = mergeEntitlements({});

  it("存储：超额才拒绝，边界值放行", () => {
    const { repo, user } = setup();
    const entitlements = { ...base, maxStorageBytes: 1000 };
    expect(checkStorageQuota(repo, user.id, entitlements, 1000)).toBeNull();
    const violation = checkStorageQuota(repo, user.id, entitlements, 1001);
    expect(violation?.code).toBe("STORAGE_QUOTA_EXCEEDED");
  });

  it("存储：-1 表示不限", () => {
    const { repo, user } = setup();
    expect(checkStorageQuota(repo, user.id, { ...base, maxStorageBytes: -1 }, 10 ** 12)).toBeNull();
  });

  it("项目数：达到上限即拒绝", () => {
    const { repo } = setup();
    const entitlements = { ...base, maxProjects: 3 };
    expect(checkProjectQuota(repo, entitlements, 2)).toBeNull();
    expect(checkProjectQuota(repo, entitlements, 3)?.code).toBe("PROJECT_QUOTA_EXCEEDED");
  });

  it("并发：只数 QUEUED/RUNNING，已结束的不占额度", () => {
    const { repo, user } = setup();
    const entitlements = { ...base, maxConcurrentJobs: 1 };

    const queued = repo.createJob({ id: randomUUID(), projectId: null, storyboardItemId: null, type: "PLAN", input: {} });
    expect(checkConcurrency(repo, user.id, entitlements)?.code).toBe("CONCURRENCY_LIMIT_EXCEEDED");

    repo.updateJob(queued.id, { status: "SUCCEEDED", progress: 100 });
    expect(checkConcurrency(repo, user.id, entitlements)).toBeNull();
  });
});

describe("展示换算", () => {
  it("微积分换积分保留两位小数", () => {
    expect(toCredits(1_000_000)).toBe(1);
    expect(toCredits(1_234_567)).toBe(1.23);
  });

  it("字节格式化", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
  });
});

describe("僵尸预扣", () => {
  it("任务已终态却仍 reserved 的预扣会被标成 uncertain", () => {
    const { system, user, repo } = setup();
    system.applyCreditEntry({ userId: user.id, type: "admin_grant", amountMicrocredits: 100 * MICROCREDITS_PER_CREDIT, note: "测试额度" });

    const job = repo.createJob({ id: randomUUID(), projectId: null, storyboardItemId: null, type: "GENERATE", input: {} });
    const order = system.createBillingReservation({ userId: user.id, jobId: job.id, reservedMicrocredits: 10 * MICROCREDITS_PER_CREDIT, costSnapshot: { kind: "GENERATE", units: 1 } });
    expect(order.status).toBe("reserved");

    // 模拟"进程在结算前被杀"：任务停在终态，预扣没人释放。
    system.updateJob(job.id, { status: "FAILED" });

    const marked = markStaleReservationsUncertain(system);
    expect(marked).toBe(1);
    expect(system.getBillingOrder(order.id)?.status).toBe("uncertain");
  });

  it("任务还在跑的时候不能动它的预扣", () => {
    const { system, user, repo } = setup();
    system.applyCreditEntry({ userId: user.id, type: "admin_grant", amountMicrocredits: 100 * MICROCREDITS_PER_CREDIT, note: "测试额度" });

    const job = repo.createJob({ id: randomUUID(), projectId: null, storyboardItemId: null, type: "GENERATE", input: {} });
    const order = system.createBillingReservation({ userId: user.id, jobId: job.id, reservedMicrocredits: 10 * MICROCREDITS_PER_CREDIT, costSnapshot: { kind: "GENERATE", units: 1 } });
    system.updateJob(job.id, { status: "RUNNING" });

    expect(markStaleReservationsUncertain(system)).toBe(0);
    expect(system.getBillingOrder(order.id)?.status).toBe("reserved");
  });
});
