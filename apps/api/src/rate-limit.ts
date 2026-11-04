/**
 * 限流。
 *
 * 只用于挡住登录爆破、注册刷号、找回密码轰炸这类低速率攻击。
 *
 * **多实例部署必须用 Redis 计数**：进程内存版本在每个实例各算一份，
 * 开两个 API 容器等于把放行量翻倍。`buildApi` 会用真实 Redis 连接装配 Redis 存储；
 * 拿不到可用连接时退回进程内存并只记一次日志（见下方 fallback 说明）。
 */

export interface RateLimitResult {
  allowed: boolean;
  /** 被拒时建议的重试等待秒数。 */
  retryAfterSeconds: number;
}

export interface RateLimitStore {
  consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
  reset(key: string): Promise<void>;
  clear(): Promise<void>;
}

// ---------------- 进程内存实现 ----------------

interface Bucket {
  count: number;
  resetAt: number;
}

/** 定期清理过期桶，避免长时间运行后 Map 无限增长。 */
const SWEEP_INTERVAL_MS = 60_000;

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = Date.now();

  public async consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    this.sweep(now);
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (bucket.count >= limit) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
    }
    bucket.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  public async reset(key: string): Promise<void> {
    this.buckets.delete(key);
  }

  public async clear(): Promise<void> {
    this.buckets.clear();
    this.lastSweep = Date.now();
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

// ---------------- Redis 实现 ----------------

/** 需要的最小 Redis 能力；只依赖这两个方法，测试里可以用替身。 */
export interface RedisLike {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  keys(pattern: string): Promise<string[]>;
}

/**
 * 计数与过期必须原子完成。
 *
 * 分两条命令写（INCR 然后 PEXPIRE）会有个坏窗口：INCR 成功、PEXPIRE 失败时
 * 键永不过期，那个 key 的限流窗口就变成永久的——用户会被永久锁死。
 */
const CONSUME_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
return {count, ttl}
`;

const PREFIX = "ecomgen:ratelimit:";

export class RedisRateLimitStore implements RateLimitStore {
  public constructor(private readonly redis: RedisLike) { }

  public async consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const raw = await this.redis.eval(CONSUME_SCRIPT, 1, PREFIX + key, windowMs);
    // ioredis 返回 [count, ttl]；ttl 为 -1 表示没有过期时间（不该发生），按整个窗口兜底。
    const [count, ttl] = Array.isArray(raw) ? raw.map(Number) : [Number(raw), windowMs];
    const remainingMs = Number.isFinite(ttl) && ttl > 0 ? ttl : windowMs;
    if (count > limit) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)) };
    return { allowed: true, retryAfterSeconds: 0 };
  }

  public async reset(key: string): Promise<void> {
    await this.redis.del(PREFIX + key);
  }

  public async clear(): Promise<void> {
    const keys = await this.redis.keys(`${PREFIX}*`);
    if (keys.length > 0) await this.redis.del(...keys);
  }
}

// ---------------- 装配 ----------------

const memory = new MemoryRateLimitStore();
let active: RateLimitStore = memory;
let fallbackLogged = false;

/**
 * 装配限流存储。
 *
 * 传入的连接不可用时（测试替身、Redis 未就绪）**退回进程内存**而不是抛错：
 * 登录接口不能因为限流组件故障就整体 500。代价是多实例下这段时间的限流会弱化，
 * 所以只记一次日志提醒，而不是每次请求都刷屏。
 */
export function configureRateLimit(redis: RedisLike | null | undefined): void {
  if (!redis || typeof redis.eval !== "function") {
    active = memory;
    return;
  }
  active = new RedisRateLimitStore(redis);
  fallbackLogged = false;
}

export async function consumeRateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  try {
    return await active.consume(key, limit, windowMs);
  } catch (error) {
    if (!fallbackLogged) {
      fallbackLogged = true;
      console.error(`rate limit store unavailable, falling back to in-memory: ${error instanceof Error ? error.message : String(error)}`);
    }
    active = memory;
    return memory.consume(key, limit, windowMs);
  }
}

/** 登录成功后清空该键，避免"成功登录也要继续吃失败配额"。 */
export async function resetRateLimit(key: string): Promise<void> {
  try {
    await active.reset(key);
  } catch {
    await memory.reset(key);
  }
}

/** 仅测试使用：在用例之间清空状态，并把存储复位到内存实现。 */
export async function clearRateLimits(): Promise<void> {
  await active.clear().catch(() => undefined);
  active = memory;
  await memory.clear();
  fallbackLogged = false;
}
