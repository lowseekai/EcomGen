import { afterEach, describe, expect, it } from "vitest";

import { assertSafeRemoteUrl } from "./remote-url.js";

/**
 * Provider 返回 URL 的 SSRF 防护。
 *
 * Worker 会直接抓取 Provider 给的图片地址。若该地址指向内网或云元数据服务，
 * Worker 就成了进入内网的跳板。
 */

afterEach(() => {
  delete process.env.ECOMGEN_ALLOW_PRIVATE_PROVIDER_URLS;
});

describe("assertSafeRemoteUrl", () => {
  it("放行正常的公网 http(s) 地址", () => {
    expect(assertSafeRemoteUrl("https://cdn.example.com/a.png").hostname).toBe("cdn.example.com");
    expect(assertSafeRemoteUrl("http://example.com/a.png").protocol).toBe("http:");
  });

  it("拒绝非 HTTP 协议", () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/a.png", "data:image/png;base64,AAAA", "gopher://x/"]) {
      expect(() => assertSafeRemoteUrl(url)).toThrow(/non-HTTP|invalid resource URL/);
    }
  });

  it("拒绝内网、回环与云元数据地址", () => {
    const blocked = [
      "http://localhost/a.png",
      "http://127.0.0.1/a.png",
      "http://10.1.2.3/a.png",
      "http://192.168.1.1/a.png",
      "http://172.16.0.1/a.png",
      "http://172.31.255.255/a.png",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/a.png",
      "http://0.0.0.0/a.png",
      "http://metadata.google.internal/x",
      "http://printer.local/a.png",
      "http://[::1]/a.png",
      "http://[fd00::1]/a.png",
      "http://[fe80::1]/a.png",
      "http://[::ffff:127.0.0.1]/a.png",
    ];
    for (const url of blocked) {
      expect(() => assertSafeRemoteUrl(url), url).toThrow(/private address/);
    }
  });

  it("172.32 与 172.15 不在私有段内，应当放行", () => {
    expect(assertSafeRemoteUrl("http://172.32.0.1/a.png").hostname).toBe("172.32.0.1");
    expect(assertSafeRemoteUrl("http://172.15.0.1/a.png").hostname).toBe("172.15.0.1");
  });

  it("显式开启后允许内网地址（自建 Provider 场景）", () => {
    process.env.ECOMGEN_ALLOW_PRIVATE_PROVIDER_URLS = "true";
    expect(assertSafeRemoteUrl("http://10.0.0.5/a.png").hostname).toBe("10.0.0.5");
  });

  it("非法字符串报错而不是抛原生 TypeError", () => {
    expect(() => assertSafeRemoteUrl("not a url")).toThrow(/invalid resource URL/);
  });
});
