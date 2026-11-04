import type { BillingOrderRecord, PricingMode, ProviderModelPriceRecord } from "./repositories/billingRepository.js";
import { MICROCREDITS_PER_CREDIT } from "./repositories/creditRepository.js";
import type { EcomRepository } from "./repository.js";

/**
 * 任务计费编排。
 *
 * 三个不变量，缺一就会算错账：
 * 1. **预扣发生在建任务时，不在 Worker 里**。否则用户可以无限排队，Worker 事后才发现余额不足。
 * 2. **价格来自下单时的快照**。后台改价不能改写历史订单。
 * 3. **状态机只从 reserved 出发**。重复结算/退款被 status 守卫挡掉，不会二次改账。
 */

export interface JobQuote {
  providerId: string;
  modelId: string;
  kind: string;
  pricingMode: PricingMode;
  units: number;
  /**
   * 单位售价（微积分/张）。结算时按"实际产出 × 单价"重算，
   * 所以单价必须落进快照——只存总额的话部分成功就没法找回单价。
   */
  unitMicrocredits: number;
  /** 对用户售价（微积分）。 */
  totalMicrocredits: number;
  /** 平台成本（微积分），仅用于毛利核算，永不下发前端。 */
  costMicrocredits: number;
  priceId: string;
}

export type QuoteResult = { ok: true; quote: JobQuote } | { ok: false; reason: "PRICE_NOT_CONFIGURED" | "PRICE_TIER_MISSING"; detail: string };

/**
 * 按平台价目表算出本次任务的售价与成本。
 *
 * 平台代付模式下没有价目就不能收费，因此宁可拒绝任务也不要静默免费出图——
 * 后者会让用户在"管理员漏配价目"的窗口里白拿算力。
 */
export function quoteJob(
  repository: EcomRepository,
  input: { providerId: string; modelId: string; kind: string; units?: number; resolution?: string },
): QuoteResult {
  const price = repository.getProviderModelPrice(input.providerId, input.modelId, input.kind);
  if (!price) {
    return { ok: false, reason: "PRICE_NOT_CONFIGURED", detail: `${input.providerId}/${input.modelId} (${input.kind}) 未配置价目` };
  }
  const units = Math.max(1, Math.trunc(input.units ?? 1));
  const unit = unitPrice(price, input.resolution);
  if (unit === null) {
    return { ok: false, reason: "PRICE_TIER_MISSING", detail: `价目缺少分辨率档位 ${input.resolution ?? "(未指定)"}` };
  }
  return {
    ok: true,
    quote: {
      providerId: input.providerId,
      modelId: input.modelId,
      kind: input.kind,
      pricingMode: price.pricingMode,
      units,
      unitMicrocredits: unit,
      totalMicrocredits: unit * units,
      costMicrocredits: price.costMicrocredits * units,
      priceId: price.id,
    },
  };
}

function unitPrice(price: ProviderModelPriceRecord, resolution: string | undefined): number | null {
  if (price.pricingMode === "per_resolution") {
    if (!resolution) return null;
    const tier = price.tiers[resolution];
    return typeof tier === "number" ? tier : null;
  }
  // fixed_request / per_image / token 都按单价 × 单位数计费；token 的 units 由调用方换算成百万 token。
  return price.priceMicrocredits;
}

export type ReserveResult =
  | { ok: true; billingOrder: BillingOrderRecord; balanceMicrocredits: number }
  | { ok: false; reason: "INSUFFICIENT_CREDITS"; balanceMicrocredits: number; requiredMicrocredits: number };

/**
 * 把僵尸预扣单标成 uncertain 并返回处理条数。
 *
 * 只标 uncertain、不自动退款：任务可能真的跑完了只是没来得及结算，
 * 自动退款会让平台白送一次生成。交给管理员按日志裁决。
 */
export function markStaleReservationsUncertain(repository: EcomRepository): number {
  const stale = repository.listStaleReservations();
  for (const order of stale) repository.transitionBillingOrder(order.id, "uncertain");
  return stale.length;
}

export class BillingService {
  public constructor(private readonly repository: EcomRepository) { }

  /**
   * 建任务时预扣。余额不足直接返回失败，调用方必须放弃建任务——
   * 不能"先建任务再想办法扣"，那会留下无法结算的孤儿计费单。
   */
  public reserve(input: { userId: string; jobId: string; quote: JobQuote }): ReserveResult {
    const required = input.quote.totalMicrocredits;
    const debit = this.repository.applyCreditEntry({
      userId: input.userId,
      type: "job_reserve",
      amountMicrocredits: -required,
      jobId: input.jobId,
      note: `${input.quote.kind}:${input.quote.modelId}×${input.quote.units}`,
    });
    if (!debit.ok) {
      return { ok: false, reason: "INSUFFICIENT_CREDITS", balanceMicrocredits: debit.balanceMicrocredits, requiredMicrocredits: required };
    }
    // 扣费成功后立刻落计费单；两张表在同一连接上，失败时由调用方回滚整笔。
    const billingOrder = this.repository.createBillingReservation({
      userId: input.userId,
      jobId: input.jobId,
      reservedMicrocredits: required,
      costSnapshot: input.quote,
    });
    return { ok: true, billingOrder, balanceMicrocredits: debit.entry.balanceAfterMicrocredits };
  }

  /**
   * 结算：按实际用量找平差额。
   *
   * 差额用 `job_settle` 单独记一笔而不是改预扣流水——历史流水不可变，改它等于抹掉"当时扣了多少"。
   * allowNegative 打开：结算必须精确到分，余额不够也要如实记账，否则账本与真实欠款脱节。
   */
  public settle(jobId: string, actualMicrocredits: number): BillingOrderRecord | undefined {
    const order = this.repository.getBillingOrderByJob(jobId);
    if (!order || order.status !== "reserved") return order;
    const delta = order.reservedMicrocredits - actualMicrocredits;
    if (delta !== 0) {
      this.repository.applyCreditEntry({
        userId: order.userId,
        type: "job_settle",
        amountMicrocredits: delta,
        jobId,
        billingOrderId: order.id,
        note: delta > 0 ? "结算退回多扣" : "结算补扣差额",
      }, { allowNegative: true });
    }
    return this.repository.transitionBillingOrder(order.id, "settled", actualMicrocredits);
  }

  /** 明确失败且未发出外部请求：全额退回。 */
  public refund(jobId: string, note = "任务失败全额退回"): BillingOrderRecord | undefined {
    const order = this.repository.getBillingOrderByJob(jobId);
    if (!order || order.status !== "reserved") return order;
    this.repository.applyCreditEntry({
      userId: order.userId,
      type: "job_refund",
      amountMicrocredits: order.reservedMicrocredits,
      jobId,
      billingOrderId: order.id,
      note,
    });
    return this.repository.transitionBillingOrder(order.id, "refunded");
  }

  /**
   * 外部请求已发出但结果未知（进程崩溃/超时）：不自动退款。
   *
   * Provider 侧可能已经计费，自动退款等于平台白贴成本；这笔进后台待人工核对。
   * 对应 Worker 里已有的 EXTERNAL_REQUEST_STARTED 标记。
   */
  public markUncertain(jobId: string): BillingOrderRecord | undefined {
    const order = this.repository.getBillingOrderByJob(jobId);
    if (!order || order.status !== "reserved") return order;
    return this.repository.transitionBillingOrder(order.id, "uncertain");
  }

  /**
   * 人工裁决：uncertain → settled，按人工确认的金额找平。
   *
   * 这条路径绕开 reserved 守卫是必要的：uncertain 是待处理态而不是终态，
   * 没有出口的话这笔预扣会永久占用用户的积分。
   */
  public settleUncertain(jobId: string, settledMicrocredits: number): BillingOrderRecord | undefined {
    const order = this.repository.getBillingOrderByJob(jobId);
    if (!order || order.status !== "uncertain") return order;
    const delta = order.reservedMicrocredits - settledMicrocredits;
    if (delta !== 0) {
      this.repository.applyCreditEntry({
        userId: order.userId,
        type: "job_settle",
        amountMicrocredits: delta,
        jobId,
        billingOrderId: order.id,
        note: "人工核对后结算",
      }, { allowNegative: true });
    }
    return this.repository.transitionBillingOrder(order.id, "settled", settledMicrocredits, "uncertain");
  }

  /** 人工裁决：uncertain → refunded，全额退回。 */
  public refundUncertain(jobId: string, note = "人工核对后全额退回"): BillingOrderRecord | undefined {
    const order = this.repository.getBillingOrderByJob(jobId);
    if (!order || order.status !== "uncertain") return order;
    this.repository.applyCreditEntry({
      userId: order.userId,
      type: "job_refund",
      amountMicrocredits: order.reservedMicrocredits,
      jobId,
      billingOrderId: order.id,
      note,
    });
    return this.repository.transitionBillingOrder(order.id, "refunded", undefined, "uncertain");
  }
}

/** 积分展示用：微积分 → 积分数（保留两位小数，仅供 UI，不参与计算）。 */
export function toCredits(microcredits: number): number {
  return Math.round((microcredits / MICROCREDITS_PER_CREDIT) * 100) / 100;
}

/**
 * 按实际产出重算"应该结多少"。
 *
 * 背景：批量任务（一次出 N 张）在创建时按 N 预扣，但执行可能只成功一部分。
 * 若按预扣额结算，用户会为没拿到的图付钱。
 *
 * 实际数量从**领域记录**推断，而不是让每个执行器回报——执行器已经把它们写进
 * 定妆照/花型/槽位表，再回报一遍就有两个真相源。
 *
 * 返回 `actualUnits === null` 表示"这类任务无法从记录推断"，调用方按预扣额结算。
 */
export function settleAmountForJob(
  repository: EcomRepository,
  jobId: string,
): { settledMicrocredits: number; actualUnits: number | null } | null {
  const order = repository.getBillingOrderByJob(jobId);
  if (!order) return null;

  const job = repository.getJob(jobId);
  if (!job) return { settledMicrocredits: order.reservedMicrocredits, actualUnits: null };

  const snapshot = order.costSnapshot as Partial<JobQuote> | null;
  const unit = typeof snapshot?.unitMicrocredits === "number" ? snapshot.unitMicrocredits : null;
  const actualUnits = actualUnitsFor(repository, jobId, job.type, job.input);
  if (actualUnits === null || unit === null) {
    return { settledMicrocredits: order.reservedMicrocredits, actualUnits: null };
  }
  // 成功任务不该比预扣更贵：超出部分需要用户另行确认，这里不自动补扣。
  return { settledMicrocredits: Math.min(order.reservedMicrocredits, Math.max(0, unit * actualUnits)), actualUnits };
}

function actualUnitsFor(repository: EcomRepository, jobId: string, type: string, input: unknown): number | null {
  switch (type) {
    case "MODEL_CAST":
      // 一次选角产出多张定妆照；落库张数就是实际用量。
      return repository.listModelPortraitsByJobId(jobId).length;
    case "PATTERN_FORGE":
    case "PATTERN_VARIANT":
    case "PATTERN_EXTRACT":
      return repository.listPatternsByJobId(jobId).length;
    case "PATTERN_DRAFT_GENERATE":
    case "PATTERN_DRAFT_EDIT":
    case "PATTERN_DRAFT_CUTOUT": {
      const batchId = input && typeof input === "object" && "batchId" in input ? (input as { batchId?: unknown }).batchId : null;
      if (typeof batchId !== "string") return null;
      return repository.listDraftSlots(batchId).filter((slot) => slot.status === "SUCCEEDED").length;
    }
    default:
      // 生图/规划/文案这类"一个任务一个产物"的类型，预扣额就是实际额。
      return null;
  }
}
