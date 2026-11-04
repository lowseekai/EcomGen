import type { FastifyInstance } from "fastify";
import { hashToken, type EcomRepository, type UserRecord } from "@ecomgen/core";

/**
 * 测试夹具：给 inject 默认带上站长会话。
 *
 * 鉴权钩子开启后，所有 `/api/v1/*` 都需要有效 Cookie。逐个用例补 Cookie 会淹没真正的断言，
 * 所以在夹具里建一条真实会话（真哈希、真过期时间、真落库），再把 inject 包一层默认注入。
 *
 * 这不是绕过鉴权：会话是真的，钩子照常校验。专门验证"未登录被拒"的用例请另建 app，
 * 见 auth.test.ts。
 */
export const TEST_SESSION_TOKEN = "vitest-owner-session-token";

export function authenticateTestClient(app: FastifyInstance, repository: EcomRepository): UserRecord {
  const owner = repository.listUsers({ role: "owner", limit: 1, offset: 0 }).items[0];
  if (!owner) throw new Error("测试夹具找不到引导管理员：buildApi 应已创建 owner");

  repository.createSession({
    userId: owner.id,
    tokenHash: hashToken(TEST_SESSION_TOKEN),
    userAgent: "vitest",
    ip: "127.0.0.1",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });

  const original = app.inject.bind(app);
  const patched = ((options?: Record<string, unknown>) => {
    const headers = (options?.headers ?? {}) as Record<string, string>;
    return original({ ...options, headers: { ...headers, cookie: `ecomgen_session=${TEST_SESSION_TOKEN}` } } as never);
  }) as typeof app.inject;
  app.inject = patched;
  return owner;
}
