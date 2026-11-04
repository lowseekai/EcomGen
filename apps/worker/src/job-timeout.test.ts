import { afterEach, describe, expect, it, vi } from "vitest";

import type { EcomRepository } from "@ecomgen/core";
import { JobTimeout, readJobTimeout, startJobCancellation } from "./context.js";

/**
 * 任务墙钟超时。
 *
 * Node 的 fetch 没有默认超时，Provider 挂起（连上但不回）会让 await 永不 settle。
 * 没有这条上限，两个挂起的任务就能把并发只有 2 的 Worker 完全堵死，
 * 而用户只看到"一直在生成"。
 */

const CANCEL_POLL_INTERVAL_MS = 1_000;

function stubRepository(status: string, cancelRequested = false): EcomRepository {
  return { getJob: () => ({ id: "job-1", status, cancelRequested }) } as unknown as EcomRepository;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("任务超时", () => {
  it("超过墙钟上限后以 JobTimeout 中止", async () => {
    vi.useFakeTimers();
    const { signal, dispose } = startJobCancellation(stubRepository("RUNNING"), { id: "job-1" } as never);

    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(16 * 60_000);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(JobTimeout);
    dispose();
  });

  it("用户取消仍然走 JobCancelled，不会被超时抢走", async () => {
    vi.useFakeTimers();
    const { signal, dispose } = startJobCancellation(stubRepository("CANCELLED", true), { id: "job-1" } as never);

    await vi.advanceTimersByTimeAsync(CANCEL_POLL_INTERVAL_MS * 2);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).not.toBeInstanceOf(JobTimeout);
    dispose();
  });

  it("dispose 之后不再触发超时", async () => {
    vi.useFakeTimers();
    const { signal, dispose } = startJobCancellation(stubRepository("RUNNING"), { id: "job-1" } as never);
    dispose();

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(signal.aborted).toBe(false);
  });
});

describe("超时配置解析", () => {
  // 空值是最危险的输入：compose 里漏写默认表达式就会产生它，
  // 而 Number("") === 0 会让 setTimeout(0) 把每个任务刚启动就中止。
  it("空串与非法值一律退回 15 分钟默认值", () => {
    expect(readJobTimeout(undefined)).toBe(900_000);
    expect(readJobTimeout("")).toBe(900_000);
    expect(readJobTimeout("abc")).toBe(900_000);
    expect(readJobTimeout("0")).toBe(900_000);
    expect(readJobTimeout("-5")).toBe(900_000);
  });

  it("合法值按原样生效", () => {
    expect(readJobTimeout("60000")).toBe(60_000);
  });
});
