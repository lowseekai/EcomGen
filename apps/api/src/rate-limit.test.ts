import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MemoryRateLimitStore,
  RedisRateLimitStore,
  clearRateLimits,
  configureRateLimit,
  consumeRateLimit,
  resetRateLimit,
  type RedisLike,
} from "./rate-limit.js";

/**
 * 限流。
 *
 * 重点不是"能拦住"，而是三件容易静默坏掉的事：
 * 窗口到期后要放行、成功登录要清配额、Redis 不可用不能把登录接口带崩。
 */

/** 按 CONSUME_SCRIPT 的语义模拟：INCR → 首次设置过期 → PTTL。 */
class FakeRedis implements RedisLike {
  public readonly store = new Map<string, { count: number; expiresAt: number }>();
  public evalCalls = 0;

  public async eval(_script: string, _numberOfKeys: number, ...args: Array<string | number>): Promise<unknown> {
    this.evalCalls += 1;
    const key = String(args[0]);
    const windowMs = Number(args[1]);
    const now = Date.now();
    const existing = this.store.get(key);
    if (!existing || existing.expiresAt <= now) {
      this.store.set(key, { count: 1, expiresAt: now + windowMs });
      return [1, windowMs];
    }
    existing.count += 1;
    return [existing.count, existing.expiresAt - now];
  }

  public async del(...keys: string[]): Promise<unknown> {
    for (const key of keys) this.store.delete(key);
    return keys.length;
  }

  public async keys(pattern: string): Promise<string[]> {
    const prefix = pattern.replace(/\*$/, "");
    return [...this.store.keys()].filter((key) => key.startsWith(prefix));
  }
}

beforeEach(() => {
  configureRateLimit(null);
});

afterEach(async () => {
  vi.useRealTimers();
  await clearRateLimits();
});

describe("进程内存实现", () => {
  it("允许到上限，之后拒绝并给出重试秒数", async () => {
    const store = new MemoryRateLimitStore();
    for (let i = 0; i < 3; i++) expect((await store.consume("k", 3, 60_000)).allowed).toBe(true);

    const blocked = await store.consume("k", 3, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("窗口到期后重新放行", async () => {
    vi.useFakeTimers();
    const store = new MemoryRateLimitStore();
    expect((await store.consume("k", 1, 1000)).allowed).toBe(true);
    expect((await store.consume("k", 1, 1000)).allowed).toBe(false);

    vi.advanceTimersByTime(1001);
    expect((await store.consume("k", 1, 1000)).allowed).toBe(true);
  });

  it("reset 清掉配额（登录成功后不该继续吃失败配额）", async () => {
    const store = new MemoryRateLimitStore();
    await store.consume("k", 1, 60_000);
    await store.reset("k");
    expect((await store.consume("k", 1, 60_000)).allowed).toBe(true);
  });
});

describe("Redis 实现", () => {
  it("按脚本返回值判断放行，且键带命名空间前缀", async () => {
    const redis = new FakeRedis();
    const store = new RedisRateLimitStore(redis);

    expect((await store.consume("login:a@b:1.2.3.4", 2, 60_000)).allowed).toBe(true);
    expect((await store.consume("login:a@b:1.2.3.4", 2, 60_000)).allowed).toBe(true);
    const blocked = await store.consume("login:a@b:1.2.3.4", 2, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);

    expect([...redis.store.keys()]).toEqual(["ecomgen:ratelimit:login:a@b:1.2.3.4"]);
  });

  it("reset 删除对应的键", async () => {
    const redis = new FakeRedis();
    const store = new RedisRateLimitStore(redis);
    await store.consume("k", 1, 60_000);
    await store.reset("k");
    expect(redis.store.size).toBe(0);
  });

  it("TTL 缺失时按整个窗口兜底，不返回 0 秒", async () => {
    // PTTL 返回 -1（键没有过期时间）时不能算出 retryAfter=0，否则客户端会立刻重试。
    const redis: RedisLike = {
      eval: async () => [5, -1],
      del: async () => 0,
      keys: async () => [],
    };
    const blocked = await new RedisRateLimitStore(redis).consume("k", 1, 30_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(30);
  });
});

describe("装配与降级", () => {
  it("未提供 Redis 时用进程内存", async () => {
    configureRateLimit(null);
    expect((await consumeRateLimit("k", 1, 60_000)).allowed).toBe(true);
    expect((await consumeRateLimit("k", 1, 60_000)).allowed).toBe(false);
  });

  it("Redis 抛错时退回内存，登录接口不会因此崩掉", async () => {
    const broken: RedisLike = {
      eval: async () => {
        throw new Error("redis down");
      },
      del: async () => 0,
      keys: async () => [],
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    configureRateLimit(broken);
    // 第一次：Redis 失败 → 退回内存 → 放行。
    expect((await consumeRateLimit("k", 1, 60_000)).allowed).toBe(true);
    // 第二次：已在内存实现上，仍能正确拦截。
    expect((await consumeRateLimit("k", 1, 60_000)).allowed).toBe(false);
    // 只记一次日志，不刷屏。
    expect(errorSpy).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
  });

  it("resetRateLimit 在存储故障时也不抛错", async () => {
    const broken: RedisLike = {
      eval: async () => [1, 1000],
      del: async () => {
        throw new Error("redis down");
      },
      keys: async () => [],
    };
    configureRateLimit(broken);
    await expect(resetRateLimit("k")).resolves.toBeUndefined();
  });
});
