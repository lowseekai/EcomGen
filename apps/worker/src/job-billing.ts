import { BillingService, EXTERNAL_REQUEST_STARTED, settleAmountForJob, type EcomRepository } from "@ecomgen/core";

export type JobOutcome = "succeeded" | "cancelled" | "failed";

/**
 * 任务终态结算。
 *
 * 三个分支对应三种真实结局，判断依据是"外部请求有没有发出去"——即写终态**之前**读到的
 * `job.providerTaskId` 是否还是 EXTERNAL_REQUEST_STARTED 标记：
 *
 * - 成功：按**实际产出**结算。批量任务（一次出 N 张）可能只成功一部分，
 *   按预扣额结会让用户为没拿到的图付钱；实际数量从领域记录推断（见 settleAmountForJob）。
 *   生图/规划这类"一个任务一个产物"的类型没有领域记录可查，按预扣额结算。
 * - 失败/取消且请求未发出：全额退回。用户不该为一次没发生的调用付钱。
 * - 失败/取消但请求已发出：挂 uncertain，不自动退款。Provider 可能已经计费，
 *   自动退款等于平台白贴成本；这笔留给后台人工核对。
 *
 * 本函数**绝不抛错**：它跑在任务终态之后，抛错只会把已经成功的任务改判为失败。
 * 结算异常记日志，计费单留在 reserved，后台可见并可人工处理。
 */
export function settleJobBilling(
  repository: EcomRepository,
  jobId: string,
  outcome: JobOutcome,
  providerTaskIdBeforeTerminal: string | null,
): void {
  try {
    const order = repository.getBillingOrderByJob(jobId);
    if (!order || order.status !== "reserved") return;

    const billing = new BillingService(repository);
    if (outcome === "succeeded") {
      const amount = settleAmountForJob(repository, jobId);
      billing.settle(jobId, amount?.settledMicrocredits ?? order.reservedMicrocredits);
      return;
    }
    if (providerTaskIdBeforeTerminal === EXTERNAL_REQUEST_STARTED) {
      // 外部请求已发出、结果未知：不能自动退款。
      billing.markUncertain(jobId);
      return;
    }
    billing.refund(jobId, outcome === "cancelled" ? "任务已取消，全额退回" : "任务失败，全额退回");
  } catch (error) {
    console.error(`billing settle failed for job ${jobId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
