import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { BillingService, EXTERNAL_REQUEST_STARTED, EcomRepository, MICROCREDITS_PER_CREDIT, openDatabase } from "@ecomgen/core";
import { settleJobBilling } from "./job-billing.js";

/**
 * Worker 终态结算。
 *
 * 关键断言是"钱有没有退"，以及"请求已发出时不能退"——后者是最容易写错、也最费钱的分支。
 */

const PRICE = 500_000;

function setup() {
  const db = openDatabase(":memory:");
  const repository = new EcomRepository(db);
  const user = repository.createUser({ email: "worker@example.com", passwordHash: "x", displayName: "买家", role: "user" });
  repository.applyCreditEntry({ userId: user.id, type: "signup_bonus", amountMicrocredits: 2 * MICROCREDITS_PER_CREDIT });

  const provider = repository.saveProvider({
    name: "平台渠道",
    baseUrl: "https://api.example.com/v1",
    encryptedApiKey: "enc",
    reasoningProtocol: "openai",
    models: [{ id: "img", supportsVision: false, supportsThinking: false, supportsTools: false, supportsStructuredOutput: false, imageApiKind: "openai_images" }],
  });
  repository.upsertProviderModelPrice({ providerId: provider.id, modelId: "img", kind: "image", pricingMode: "per_image", priceMicrocredits: PRICE, costMicrocredits: 0, tiers: {}, active: true });
  return { repository, user };
}

/** 建任务并预扣，返回 jobId 与预扣后的余额。 */
function reserveJob(
  repository: EcomRepository,
  userId: string,
  options: { units?: number; type?: string; input?: Record<string, unknown> } = {},
) {
  const units = options.units ?? 1;
  const jobId = randomUUID();
  repository.createJob({ id: jobId, projectId: null, storyboardItemId: null, type: (options.type ?? "PATTERN_FORGE") as never, input: options.input ?? {}, providerId: "p", modelId: "img" });
  new BillingService(repository).reserve({
    userId,
    jobId,
    quote: { providerId: "p", modelId: "img", kind: "image", pricingMode: "per_image", units, unitMicrocredits: PRICE, totalMicrocredits: PRICE * units, costMicrocredits: 0, priceId: "x" },
  });
  return { jobId, afterReserve: repository.getBalance(userId) };
}

describe("Worker 终态结算", () => {
  it("成功：结为 settled，不退款", () => {
    const { repository, user } = setup();
    // 生图这类"一个任务一个产物"的类型没有领域记录可查，按预扣额结算。
    const { jobId, afterReserve } = reserveJob(repository, user.id, { type: "GENERATE" });

    settleJobBilling(repository, jobId, "succeeded", null);

    expect(repository.getBillingOrderByJob(jobId)?.status).toBe("settled");
    expect(repository.getBalance(user.id)).toBe(afterReserve);
  });

  it("失败且请求未发出：全额退回", () => {
    const { repository, user } = setup();
    const { jobId } = reserveJob(repository, user.id);

    settleJobBilling(repository, jobId, "failed", null);

    expect(repository.getBillingOrderByJob(jobId)?.status).toBe("refunded");
    expect(repository.getBalance(user.id)).toBe(2 * MICROCREDITS_PER_CREDIT);
  });

  it("失败但请求已发出：挂 uncertain，绝不自动退款", () => {
    const { repository, user } = setup();
    const { jobId, afterReserve } = reserveJob(repository, user.id);

    settleJobBilling(repository, jobId, "failed", EXTERNAL_REQUEST_STARTED);

    expect(repository.getBillingOrderByJob(jobId)?.status).toBe("uncertain");
    // Provider 可能已经计费，这笔钱不能退。
    expect(repository.getBalance(user.id)).toBe(afterReserve);
    expect(repository.listUncertainBillingOrders(10, 0).map((order) => order.jobId)).toEqual([jobId]);
  });

  it("取消且请求未发出：全额退回", () => {
    const { repository, user } = setup();
    const { jobId } = reserveJob(repository, user.id);

    settleJobBilling(repository, jobId, "cancelled", null);

    expect(repository.getBillingOrderByJob(jobId)?.status).toBe("refunded");
    expect(repository.getBalance(user.id)).toBe(2 * MICROCREDITS_PER_CREDIT);
  });

  it("取消但请求已发出：挂 uncertain", () => {
    const { repository, user } = setup();
    const { jobId, afterReserve } = reserveJob(repository, user.id);

    settleJobBilling(repository, jobId, "cancelled", EXTERNAL_REQUEST_STARTED);

    expect(repository.getBillingOrderByJob(jobId)?.status).toBe("uncertain");
    expect(repository.getBalance(user.id)).toBe(afterReserve);
  });

  it("没有计费单的本地任务：直接跳过，不报错", () => {
    const { repository } = setup();
    const jobId = randomUUID();
    repository.createJob({ id: jobId, projectId: null, storyboardItemId: null, type: "PRINT_PACK", input: {} });

    expect(() => settleJobBilling(repository, jobId, "succeeded", null)).not.toThrow();
    expect(repository.getBillingOrderByJob(jobId)).toBeUndefined();
  });

  it("重复调用幂等：已结算的单不会被二次改账", () => {
    const { repository, user } = setup();
    const { jobId, afterReserve } = reserveJob(repository, user.id, { type: "GENERATE" });

    settleJobBilling(repository, jobId, "succeeded", null);
    settleJobBilling(repository, jobId, "failed", null);

    expect(repository.getBillingOrderByJob(jobId)?.status).toBe("settled");
    expect(repository.getBalance(user.id)).toBe(afterReserve);
  });
});

describe("按实际产出结算", () => {
  it("批量任务部分成功：只按成功张数收费，其余退回", () => {
    const { repository, user } = setup();
    // 一次出 3 张，预扣 3 × 500000。
    const { jobId, afterReserve } = reserveJob(repository, user.id, { units: 3, type: "MODEL_CAST", input: { modelId: "m" } });
    expect(afterReserve).toBe(2 * MICROCREDITS_PER_CREDIT - 3 * PRICE);

    // 只有 1 张真的落库。
    const model = repository.createModel({ name: "模特", spec: {} as never, notes: "" });
    repository.createModelPortrait({ modelId: model.id, jobId, storagePath: "models/p1.png", hash: "h1", width: null, height: null, providerId: "p", imageModelId: "img", aspectRatio: "1:1" });

    settleJobBilling(repository, jobId, "succeeded", null);

    const order = repository.getBillingOrderByJob(jobId);
    expect(order?.status).toBe("settled");
    expect(order?.settledMicrocredits).toBe(PRICE);
    // 退回多扣的 2 张。
    expect(repository.getBalance(user.id)).toBe(2 * MICROCREDITS_PER_CREDIT - PRICE);
  });

  it("一张都没成功：全额退回", () => {
    const { repository, user } = setup();
    const { jobId } = reserveJob(repository, user.id, { units: 2, type: "MODEL_CAST", input: { modelId: "m" } });

    settleJobBilling(repository, jobId, "succeeded", null);

    expect(repository.getBillingOrderByJob(jobId)?.settledMicrocredits).toBe(0);
    expect(repository.getBalance(user.id)).toBe(2 * MICROCREDITS_PER_CREDIT);
  });

  it("没有领域记录可查的类型按预扣额结算", () => {
    const { repository, user } = setup();
    const { jobId, afterReserve } = reserveJob(repository, user.id, { units: 1, type: "GENERATE" });

    settleJobBilling(repository, jobId, "succeeded", null);

    expect(repository.getBillingOrderByJob(jobId)?.settledMicrocredits).toBe(PRICE);
    expect(repository.getBalance(user.id)).toBe(afterReserve);
  });

  it("产出比预扣多时不自动补扣（需要用户另行确认）", () => {
    const { repository, user } = setup();
    const { jobId } = reserveJob(repository, user.id, { units: 1, type: "PATTERN_FORGE", input: {} });
    const afterReserve = repository.getBalance(user.id);

    // 同一个任务落了 3 个花型。
    for (const hash of ["a", "b", "c"]) {
      repository.createPattern({ name: `花型${hash}`, sourceType: "GENERATED", sourceJobId: jobId, sourceAssetHash: null, parentPatternId: null, storagePath: `patterns/${hash}.png`, fileHash: hash, width: 8, height: 8, tags: [] });
    }

    settleJobBilling(repository, jobId, "succeeded", null);

    // 结算封顶在预扣额，余额不再下降。
    expect(repository.getBillingOrderByJob(jobId)?.settledMicrocredits).toBe(PRICE);
    expect(repository.getBalance(user.id)).toBe(afterReserve);
  });
});
