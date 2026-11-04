import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 与 app.test.ts 同因：鉴权测试不关心 Redis，只需要队列连接是替身。
vi.mock("@ecomgen/jobs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ecomgen/jobs")>();
  const connection = { duplicate: () => connection, quit: async () => { } };
  return {
    ...actual,
    QUEUE_NAME: "ecomgen-auth-test",
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
import { EcomRepository, openDatabase } from "@ecomgen/core";
import { buildApi } from "./app.js";
import { clearRateLimits } from "./rate-limit.js";

const OWNER_EMAIL = "owner@test.local";
const OWNER_PASSWORD = "owner-password-123";
const MASTER_KEY = Buffer.alloc(32, 9).toString("base64");

let dataDir = "";
let app: FastifyInstance;
let repository: EcomRepository;
/** 与 buildApi 共享同一个库文件的第二个连接；必须显式关闭，否则 Windows 上删临时目录会 EBUSY。 */
let secondaryDatabase: ReturnType<typeof openDatabase> | undefined;

async function boot(options: { secureCookies?: boolean } = {}): Promise<void> {
  app = await buildApi({
    dataDir,
    redisUrl: "redis://127.0.0.1:6399",
    masterKey: MASTER_KEY,
    bootstrap: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
    ...options,
  });
  secondaryDatabase = openDatabase(join(dataDir, "ecomgen.sqlite"));
  repository = new EcomRepository(secondaryDatabase);
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "ecomgen-auth-test-"));
  // 限流是进程级全局状态，用例之间必须清零，否则后一个用例会莫名 429。
  clearRateLimits();
});

afterEach(async () => {
  await app.close();
  secondaryDatabase?.close();
  secondaryDatabase = undefined;
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** 从 Set-Cookie 里取出会话明文，模拟浏览器的 Cookie 罐。 */
function sessionTokenFrom(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const header = Array.isArray(raw) ? raw.join(";") : String(raw ?? "");
  const match = /ecomgen_session=([^;]+)/.exec(header);
  if (!match) throw new Error(`响应里没有会话 cookie：${header}`);
  return decodeURIComponent(match[1]);
}

describe("未登录访问", () => {
  it("受保护接口一律 401", async () => {
    await boot();
    for (const url of ["/api/v1/projects", "/api/v1/providers", "/api/v1/models", "/api/v1/patterns", "/api/v1/user-templates"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(401);
      expect(response.json().error.code).toBe("UNAUTHORIZED");
    }
  });

  it("auth/me 匿名返回 user: null 而不是 401", async () => {
    await boot();
    const response = await app.inject({ method: "GET", url: "/api/v1/auth/me" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ user: null });
  });

  it("健康检查保持公开", async () => {
    await boot();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
  });

  it("伪造的会话令牌换不到身份", async () => {
    await boot();
    const response = await app.inject({ method: "GET", url: "/api/v1/projects", headers: { cookie: "ecomgen_session=forged" } });
    expect(response.statusCode).toBe(401);
  });
});

describe("登录", () => {
  it("密码正确时下发会话 cookie 并返回用户信息", async () => {
    await boot();
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD } });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.user.email).toBe(OWNER_EMAIL);
    expect(body.user.role).toBe("owner");
    // 密码哈希绝不能出现在任何响应里。
    expect(JSON.stringify(body)).not.toContain("scrypt$");
    expect(body.planCode).toBe("unlimited");

    const token = sessionTokenFrom(response);
    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: `ecomgen_session=${token}` } });
    expect(me.json().user.email).toBe(OWNER_EMAIL);
  });

  it("密码错误返回 401 且不泄露账号是否存在", async () => {
    await boot();
    const wrongPassword = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: OWNER_EMAIL, password: "wrong-password" } });
    const unknownEmail = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "nobody@test.local", password: "wrong-password" } });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json().error.message).toBe(unknownEmail.json().error.message);
  });

  it("连续失败触发限流", async () => {
    await boot();
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: OWNER_EMAIL, password: "nope" } });
      expect(response.statusCode).toBe(401);
    }
    const blocked = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: OWNER_EMAIL, password: "nope" } });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("RATE_LIMITED");
  });

  it("secureCookies 打开时 cookie 带 Secure", async () => {
    await boot({ secureCookies: true });
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD } });
    const raw = response.headers["set-cookie"];
    const header = Array.isArray(raw) ? raw.join(";") : String(raw);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Secure");
  });
});

describe("注册", () => {
  it("默认关闭注册", async () => {
    await boot();
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email: "new@test.local", password: "new-password-1" } });
    expect(response.statusCode).toBe(403);
  });

  it("打开注册后能建号并获得赠送额度", async () => {
    await boot();
    repository.setSetting("registration_enabled", true);

    const response = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email: "new@test.local", password: "new-password-1" } });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.user.role).toBe("user");
    expect(body.planCode).toBe("free");
    // 默认赠送 2 积分 = 2_000_000 微积分。
    expect(body.balanceMicrocredits).toBe(2_000_000);
  });

  it("重复邮箱返回 409", async () => {
    await boot();
    repository.setSetting("registration_enabled", true);
    await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email: "dup@test.local", password: "new-password-1" } });
    const again = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email: "dup@test.local", password: "new-password-1" } });
    expect(again.statusCode).toBe(409);
  });

  it("拒绝过短密码与非法邮箱", async () => {
    await boot();
    repository.setSetting("registration_enabled", true);
    const shortPassword = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email: "a@test.local", password: "123" } });
    const badEmail = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email: "not-an-email", password: "long-enough-1" } });
    expect(shortPassword.statusCode).toBe(400);
    expect(badEmail.statusCode).toBe(400);
  });
});

describe("登出与封禁", () => {
  it("登出后旧 cookie 立即失效", async () => {
    await boot();
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD } });
    const token = sessionTokenFrom(login);

    const logout = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie: `ecomgen_session=${token}` } });
    expect(logout.statusCode).toBe(204);

    const after = await app.inject({ method: "GET", url: "/api/v1/projects", headers: { cookie: `ecomgen_session=${token}` } });
    expect(after.statusCode).toBe(401);
  });

  it("封禁用户后其会话立即被拒", async () => {
    await boot();
    repository.setSetting("registration_enabled", true);
    const registered = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email: "victim@test.local", password: "victim-pass-1" } });
    const token = sessionTokenFrom(registered);
    const userId = registered.json().user.id;

    repository.updateUser(userId, { status: "disabled" });

    const blocked = await app.inject({ method: "GET", url: "/api/v1/projects", headers: { cookie: `ecomgen_session=${token}` } });
    expect(blocked.statusCode).toBe(401);
    // 封禁必须撤销全部会话，而不是只在下次请求时拒绝。
    expect(repository.listUserSessions(userId).every((session) => session.revokedAt !== null)).toBe(true);
  });
});

describe("同源校验", () => {
  it("跨站来源的写请求被拒", async () => {
    await boot();
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD } });
    const token = sessionTokenFrom(login);

    const blocked = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { cookie: `ecomgen_session=${token}`, origin: "https://evil.example" },
      payload: { name: "x", platformTargets: [], defaultMode: "CREATIVE" },
    });
    expect(blocked.statusCode).toBe(403);
  });

  it("白名单来源可以写", async () => {
    await boot();
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD } });
    const token = sessionTokenFrom(login);

    const allowed = await app.inject({
      method: "POST",
      url: "/api/v1/user-templates",
      headers: { cookie: `ecomgen_session=${token}`, origin: "http://127.0.0.1:5173" },
      payload: { name: "合法来源模板", prompt: "a product photo" },
    });
    expect(allowed.statusCode).toBe(201);
  });
});

describe("修改密码", () => {
  it("改密后旧会话全部失效", async () => {
    await boot();
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD } });
    const token = sessionTokenFrom(login);

    const changed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password",
      headers: { cookie: `ecomgen_session=${token}` },
      payload: { currentPassword: OWNER_PASSWORD, newPassword: "brand-new-password" },
    });
    expect(changed.statusCode).toBe(204);

    const after = await app.inject({ method: "GET", url: "/api/v1/projects", headers: { cookie: `ecomgen_session=${token}` } });
    expect(after.statusCode).toBe(401);

    const relogin = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: OWNER_EMAIL, password: "brand-new-password" } });
    expect(relogin.statusCode).toBe(200);
  });

  it("当前密码错误时拒绝", async () => {
    await boot();
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD } });
    const token = sessionTokenFrom(login);

    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password",
      headers: { cookie: `ecomgen_session=${token}` },
      payload: { currentPassword: "not-the-password", newPassword: "brand-new-password" },
    });
    expect(rejected.statusCode).toBe(401);
  });
});

describe("找回密码", () => {
  it("未接邮件服务时默认不返回令牌，且不泄露账号是否存在", async () => {
    await boot();
    const existing = await app.inject({ method: "POST", url: "/api/v1/auth/password-reset/request", payload: { email: OWNER_EMAIL } });
    const unknown = await app.inject({ method: "POST", url: "/api/v1/auth/password-reset/request", payload: { email: "ghost@test.local" } });

    expect(existing.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(existing.json()).toEqual({ accepted: true });
    expect(unknown.json()).toEqual({ accepted: true });
  });

  it("打开临时开关后可用令牌重置密码", async () => {
    await boot();
    repository.setSetting("password_reset_expose_token", true);

    const requested = await app.inject({ method: "POST", url: "/api/v1/auth/password-reset/request", payload: { email: OWNER_EMAIL } });
    const token = requested.json().token as string;
    expect(token).toBeTruthy();

    const confirmed = await app.inject({ method: "POST", url: "/api/v1/auth/password-reset/confirm", payload: { token, password: "reset-password-9" } });
    expect(confirmed.statusCode).toBe(204);

    // 令牌一次性：重复使用必须失败。
    const replay = await app.inject({ method: "POST", url: "/api/v1/auth/password-reset/confirm", payload: { token, password: "another-password-9" } });
    expect(replay.statusCode).toBe(400);

    const relogin = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: OWNER_EMAIL, password: "reset-password-9" } });
    expect(relogin.statusCode).toBe(200);
  });
});
