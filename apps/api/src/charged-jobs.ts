import type { FastifyRequest } from "fastify";
import { BillingService, MICROCREDITS_PER_CREDIT, quoteJob, toCredits, type EcomRepository, type JobRecord } from "@ecomgen/core";

import { currentUser } from "./auth-guard.js";
import type { ApiContext } from "./context.js";
import { ApiError } from "./errors.js";
import { assertConcurrencyQuota } from "./helpers.js";

/** 会真正调用 Provider 的任务类型；本地合成任务（规格包、验缝、导出）不收费。 */
export type ChargeKind = "image" | "reasoning" | "segmentation";

export interface ChargeSpec {
  kind: ChargeKind;
  providerId: string | null | undefined;
  modelId: string | null | undefined;
  /** 计费单位数：图片张数、百万 token 等。默认 1。 */
  units?: number;
  /** per_resolution 计价需要；其余模式忽略。 */
  resolution?: string | null;
}

/**
 * 建任务并预扣积分。
 *
 * 所有会花钱的任务创建都必须走这里，而不是各自调用 `repository.createJob`。
 * 这样"先报价、再扣费、最后落任务"的顺序只有一份实现，任何新入口都不会漏掉扣费。
 *
 * 三个拒绝分支，语义不同：
 * - 未配置价目 → 422：平台代付模式下没价目就不能出图，宁可拒绝也不能白送算力。
 * - 积分不足 → 402：用户该去充值。
 * - 并发超限 → 429：用户该等任务跑完。
 *
 * 调用方通常在 `database.transaction` 内调用：抛错会连同已扣的积分一起回滚，
 * 因此不存在"扣了钱但任务没建"的中间态。
 */
export function createChargedJob(
  ctx: ApiContext,
  request: FastifyRequest,
  jobInput: Parameters<EcomRepository["createJob"]>[0],
  charge: ChargeSpec,
): JobRecord {
  // 未指定 Provider/模型的任务（本地任务、或尚未配置模型的项目）不进入计费。
  // 真正的"必须选模型"校验由各路由的 verifyModel 负责，这里不重复。
  if (!charge.providerId || !charge.modelId) return ctx.repository.createJob(jobInput);

  const user = currentUser(request);
  // 站长与管理员就是平台方，不给自己扣费：否则运维调个模型还得先给自营渠道配价目，
  // 且一旦价格配错会把管理员的余额扣成负数，掩盖真正的账目问题。
  if (user.role === "owner" || user.role === "admin") return ctx.repository.createJob(jobInput);

  assertConcurrencyQuota(ctx.repository, user);

  const quoted = quoteJob(ctx.repository, {
    providerId: charge.providerId,
    modelId: charge.modelId,
    kind: charge.kind,
    units: charge.units,
    resolution: charge.resolution ?? undefined,
  });
  if (!quoted.ok) {
    throw new ApiError(422, "PROVIDER_NOT_CONFIGURED", `该模型尚未配置价目，暂时无法出图：${quoted.detail}`);
  }

  const reserved = new BillingService(ctx.repository).reserve({
    userId: user.id,
    jobId: jobInput.id,
    quote: quoted.quote,
  });
  if (!reserved.ok) {
    throw new ApiError(
      402,
      "INSUFFICIENT_CREDITS",
      `积分不足：本次需要 ${toCredits(reserved.requiredMicrocredits)}，当前余额 ${toCredits(reserved.balanceMicrocredits)}`,
    );
  }

  return ctx.repository.createJob(jobInput);
}

/** 任务入队失败时退回预扣。与 app.ts 的 enqueueOrMarkFailed 配套。 */
export function refundJobCharge(repository: EcomRepository, jobId: string): void {
  new BillingService(repository).refund(jobId, "任务入队失败，全额退回");
}

/** 微积分换算，供提示文案复用。 */
export { MICROCREDITS_PER_CREDIT };
