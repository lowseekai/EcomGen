import { randomBytes } from "node:crypto";

/**
 * 时间有序的 UUID（RFC 9562 的 version 7）。
 *
 * 为什么不用 `randomUUID()`（v4）：主键随机意味着 `ORDER BY id` 与插入顺序无关。
 * 之前有 8 处查询用 `rowid` 做"同一毫秒内的次序兜底"，而 PostgreSQL 没有 rowid
 * （`ctid` 会随 VACUUM 变化，不能用）。换成 v7 之后 `ORDER BY id` 就是插入序，
 * rowid 可以彻底去掉，也不再需要为迁移做特殊处理。
 *
 * 仍然是合法的 UUID 字符串，契约里的 `format: "uuid"` 与所有校验都不受影响。
 *
 * 同一毫秒内用 12 位计数器递增（RFC 9562 的 monotonic 方法），保证**单进程内严格单调**。
 * 跨进程同毫秒的次序由随机位决定——那种情况本身没有可观测的因果顺序。
 */

/** 最近一次使用的时间戳（毫秒）与计数器；计数器占 12 位，同毫秒最多 4096 个。 */
let lastTimestamp = -1;
let counter = 0;

export function newId(now: number = Date.now()): string {
  const bytes = randomBytes(16);

  // 时间戳取高水位：计数器溢出时会把 lastTimestamp 推到 now+1，
  // 之后的调用不能再把它拉回 now，否则 id 会倒退。
  const timestamp = Math.max(now, lastTimestamp);
  if (timestamp === lastTimestamp) {
    counter += 1;
    // 计数器溢出说明同一毫秒写了 4096 行，退化为下一毫秒并重新随机，避免回绕导致乱序。
    if (counter > 0xfff) {
      lastTimestamp = timestamp + 1;
      counter = randomBytes(2).readUInt16BE(0) & 0x0fff;
    }
  } else {
    lastTimestamp = timestamp;
    counter = randomBytes(2).readUInt16BE(0) & 0x0fff;
  }

  const stamp = BigInt(lastTimestamp);
  // 前 48 位：毫秒时间戳，大端。
  bytes[0] = Number((stamp >> 40n) & 0xffn);
  bytes[1] = Number((stamp >> 32n) & 0xffn);
  bytes[2] = Number((stamp >> 24n) & 0xffn);
  bytes[3] = Number((stamp >> 16n) & 0xffn);
  bytes[4] = Number((stamp >> 8n) & 0xffn);
  bytes[5] = Number(stamp & 0xffn);

  // 第 7 字节高 4 位是版本号 7，低 4 位是计数器的最高 4 位。
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f);
  bytes[7] = counter & 0xff;
  // 第 9 字节高 2 位是变体 10（RFC 4122 变体），其余保持随机。
  bytes[8] = 0x80 | (bytes[8] & 0x3f);

  return formatUuid(bytes);
}

function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 仅测试使用：复位单调状态，让用例之间互不影响。 */
export function resetIdState(): void {
  lastTimestamp = -1;
  counter = 0;
}
