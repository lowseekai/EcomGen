import { describe, expect, it } from "vitest";

import { newId, resetIdState } from "./ids.js";

/**
 * UUIDv7 生成器。
 *
 * 断言的是三件会让"按 id 排序等于插入序"失效的事：格式仍合法、版本/变体位正确、
 * 同毫秒内严格递增。
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("newId", () => {
  it("是合法 UUID 字符串", () => {
    resetIdState();
    const id = newId();
    expect(id).toMatch(UUID_PATTERN);
    expect(id).toHaveLength(36);
  });

  it("版本位为 7、变体位为 10", () => {
    resetIdState();
    for (let i = 0; i < 20; i++) {
      const id = newId();
      // 第 15 个字符（第 7 字节高 4 位）是版本号。
      expect(id[14]).toBe("7");
      // 第 20 个字符（第 9 字节高 2 位）必须是 8/9/a/b。
      expect(["8", "9", "a", "b"]).toContain(id[19]);
    }
  });

  it("同一毫秒内严格递增（字典序即插入序）", () => {
    resetIdState();
    const fixed = 1_700_000_000_000;
    const ids = Array.from({ length: 200 }, () => newId(fixed));
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
    // 去重：同毫秒也不能撞。
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("跨毫秒时按时间递增", () => {
    resetIdState();
    const early = newId(1_700_000_000_000);
    const later = newId(1_700_000_000_001);
    expect(later > early).toBe(true);
  });

  it("计数器溢出后退到下一毫秒而不是回绕", () => {
    resetIdState();
    const fixed = 1_700_000_000_000;
    // 计数器 12 位，同毫秒第 4097 个会进位。
    const ids = Array.from({ length: 4100 }, () => newId(fixed));
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });
});
