import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

vi.mock("@ecomgen/jobs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ecomgen/jobs")>();
  const connection = { duplicate: () => connection, quit: async () => { } };
  return {
    ...actual,
    QUEUE_NAME: "ecomgen-test",
    createRedisConnection: () => connection,
    createJobQueue: () => ({ close: async () => { }, getJob: async () => undefined }),
    enqueue: vi.fn(async () => { }),
    RedisProjectEventBus: class {
      public async publish(projectId: string, type: string, data: unknown) {
        return { id: randomUUID(), projectId, type, occurredAt: new Date().toISOString(), data };
      }
      public async subscribe(_projectId: string, listener: (event: unknown) => void) {
        return async () => void listener;
      }
      public async close() { }
    }
  };
});

import type { FastifyInstance } from "fastify";
import { EcomRepository, hashToken, openDatabase } from "@ecomgen/core";
import { buildApi, readTrustProxy } from "./app.js";

/**
 * 上传安全（审计 P0-1）。
 *
 * 漏洞成因是三处叠加：只校验 `image/` 前缀 → 保留 .svg 扩展名 → 下载时用客户端声明的 mime
 * 且没有 nosniff。任何一处回退都会让存储型 XSS 重新成立，所以这里把三处都断言住。
 */

let dataDir = "";
let app: FastifyInstance;
let database: ReturnType<typeof openDatabase>;
let token = "";
let projectId = "";

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ecomgen-upload-"));
  app = await buildApi({ dataDir, redisUrl: "redis://127.0.0.1:6399", masterKey: Buffer.alloc(32, 7).toString("base64") });
  database = openDatabase(join(dataDir, "ecomgen.sqlite"));
  const system = new EcomRepository(database);

  const user = system.createUser({ email: "u@example.com", passwordHash: "x", displayName: "U", role: "user" });
  token = `u-${randomUUID()}`;
  system.createSession({ userId: user.id, tokenHash: hashToken(token), userAgent: "vitest", ip: "127.0.0.1", expiresAt: new Date(Date.now() + 3600_000).toISOString() });

  const owned = system.forOwner(user.id);
  projectId = owned.createProject({
    name: "上传测试", category: null, productDescription: null, verifiedFacts: [], prohibitedClaims: [], brandGuidelines: {},
    platformTargets: [], targetMarket: null, copyLanguage: null, reasoningProviderId: null, reasoningModelId: null,
    imageProviderId: null, imageModelId: null, defaultMode: "CREATIVE", imageResolution: "1K", imageAspectRatio: "AUTO", candidatesPerType: 1,
  }).id;
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const auth = () => ({ cookie: `ecomgen_session=${token}` });

async function upload(filename: string, mimeType: string, content: Buffer) {
  const form = new FormData();
  form.append("role", "PRODUCT_TRUTH");
  form.append("file", new Blob([new Uint8Array(content)], { type: mimeType }), filename);
  return app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/assets`, headers: auth(), payload: form });
}

describe("上传安全", () => {
  it("拒绝 SVG（mimetype 与扩展名两层都挡）", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

    const byMime = await upload("payload.png", "image/svg+xml", svg);
    expect(byMime.statusCode).toBe(400);
    expect(byMime.json().error.message).toContain("SVG");

    const byName = await upload("payload.svg", "image/png", svg);
    expect(byName.statusCode).toBe(400);
    expect(byName.json().error.message).toContain("SVG");
  });

  it("拒绝其它非位图类型（白名单而非前缀匹配）", async () => {
    const xml = Buffer.from("<svg/>");
    const response = await upload("x.xml", "application/xml", xml);
    expect(response.statusCode).toBe(400);
  });

  it("正常 PNG 仍可上传，且下载时内联渲染并带 nosniff", async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
    const created = await upload("ok.png", "image/png", png);
    expect(created.statusCode).toBe(200);
    const asset = created.json();

    const download = await app.inject({ method: "GET", url: `/api/v1/files/assets/${asset.id}`, headers: auth() });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toContain("image/png");
    expect(download.headers["x-content-type-options"]).toBe("nosniff");
    // 位图可以内联，不应被强制下载。
    expect(download.headers["content-disposition"]).toBeUndefined();
  });

  it("全站响应都带安全头", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/projects", headers: auth() });
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(String(response.headers["content-security-policy"])).toContain("object-src 'none'");
  });
});

describe("ECOMGEN_TRUST_PROXY 解析", () => {
  it("未设置或 false 时不信任代理", () => {
    expect(readTrustProxy(undefined)).toBe(false);
    expect(readTrustProxy("")).toBe(false);
    expect(readTrustProxy("false")).toBe(false);
    expect(readTrustProxy("0")).toBe(false);
  });

  it("纯数字按跳数信任（以判定函数表达）", () => {
    const oneHop = readTrustProxy("1");
    expect(typeof oneHop).toBe("function");
    const trust = oneHop as (address: string, hop: number) => boolean;
    // hop 从 0 开始（最近的代理）；信任 1 跳即只信任最近一跳。
    expect(trust("10.0.0.1", 0)).toBe(true);
    expect(trust("10.0.0.1", 1)).toBe(false);

    const twoHops = readTrustProxy("2") as (address: string, hop: number) => boolean;
    expect(twoHops("10.0.0.1", 1)).toBe(true);
    expect(twoHops("10.0.0.1", 2)).toBe(false);
  });

  it("地址列表按受信代理解析，且不接受 true", () => {
    expect(readTrustProxy("10.0.0.1, 10.0.0.2")).toEqual(["10.0.0.1", "10.0.0.2"]);
    // 无条件信任 X-Forwarded-For 会让限流可被伪造绕过，必须按 false 处理。
    expect(readTrustProxy("true")).toBe(false);
  });
});
