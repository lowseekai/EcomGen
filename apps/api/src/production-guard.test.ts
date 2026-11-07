import { afterEach, describe, expect, it, vi } from "vitest";

import { assertProductionConfig } from "./production-guard.js";

/**
 * 生产配置守卫。
 *
 * 部署清单靠人执行，而人一定会漏。这里把最关键的两条变成启动硬约束：
 * 生产模式下没开 Secure Cookie、或 master key 还是占位值，直接拒绝启动。
 */

const GOOD = {
  ECOMGEN_PRODUCTION: "true",
  ECOMGEN_SECURE_COOKIES: "true",
  ECOMGEN_MASTER_KEY: "l6HCstHxyAzxioiDgvTE6/1bSCH02OZ6LYKzLH57670=",
  ECOMGEN_TRUST_PROXY: "1",
} as unknown as NodeJS.ProcessEnv;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("生产配置守卫", () => {
  it("非生产模式下完全不干预", () => {
    expect(() => assertProductionConfig({} as NodeJS.ProcessEnv)).not.toThrow();
    expect(() => assertProductionConfig({ ECOMGEN_PRODUCTION: "false" } as unknown as NodeJS.ProcessEnv)).not.toThrow();
  });

  it("生产模式下没开 Secure Cookie 时拒绝启动", () => {
    expect(() => assertProductionConfig({ ...GOOD, ECOMGEN_SECURE_COOKIES: "false" } as unknown as NodeJS.ProcessEnv)).toThrow(
      /SECURE_COOKIES/,
    );
  });

  it("生产模式下 master key 仍是占位值时拒绝启动", () => {
    expect(() =>
      assertProductionConfig({ ...GOOD, ECOMGEN_MASTER_KEY: "replace-with-a-base64-encoded-32-byte-key" } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/MASTER_KEY/);
  });

  it("多个问题一次性全部列出，而不是修一个报一个", () => {
    const env = { ECOMGEN_PRODUCTION: "true", ECOMGEN_SECURE_COOKIES: "false" } as unknown as NodeJS.ProcessEnv;
    let message = "";
    try {
      assertProductionConfig(env);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("SECURE_COOKIES");
    expect(message).toContain("MASTER_KEY");
  });

  it("TRUST_PROXY 未设置只告警、不阻断（直连部署本来就不该设）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { ECOMGEN_TRUST_PROXY: _omit, ...withoutProxy } = GOOD as unknown as Record<string, string>;
    expect(() => assertProductionConfig(withoutProxy as unknown as NodeJS.ProcessEnv)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("TRUST_PROXY"));
  });

  it("配置齐全时静默通过", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() => assertProductionConfig(GOOD)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});
