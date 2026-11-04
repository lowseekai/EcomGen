import { describe, expect, it } from "vitest";

import { corsOriginsFromEnv } from "./cors.js";

/**
 * CORS 白名单解析。
 *
 * 重点是"空串"这一条：compose 里 `${ECOMGEN_CORS_ORIGINS:-}` 在未设置时就是空串，
 * 若把它当成"显式配置了一个空来源"就会在启动时抛错——容器起不来，且报错信息
 * 指向 CORS 配置，很难让人联想到是 compose 的默认值造成的。
 */
describe("corsOriginsFromEnv", () => {
  it("未设置时返回 undefined，走默认白名单", () => {
    expect(corsOriginsFromEnv(undefined)).toBeUndefined();
  });

  it("空串与纯空白按未配置处理", () => {
    expect(corsOriginsFromEnv("")).toBeUndefined();
    expect(corsOriginsFromEnv("   ")).toBeUndefined();
  });

  it("逗号分隔并去除首尾空白", () => {
    expect(corsOriginsFromEnv("https://a.example.com, https://b.example.com")).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
  });

  it("中间出现空项仍然报错（这是真正的配置错误，不能静默回退）", () => {
    expect(() => corsOriginsFromEnv("https://a.example.com,,https://b.example.com")).toThrow(/empty origins/);
    expect(() => corsOriginsFromEnv("https://a.example.com,")).toThrow(/empty origins/);
  });
});
