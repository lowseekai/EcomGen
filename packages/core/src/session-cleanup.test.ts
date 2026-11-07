import { describe, expect, it } from "vitest";

import { openDatabase } from "./database.js";
import { EcomRepository } from "./repository.js";

/**
 * 过期会话清理。
 *
 * 会话 TTL 30 天且每次登录新增一行，没有清理的话 user_sessions 只增不减。
 * 过期行不影响鉴权（查询自带 expires_at 条件），但会持续占用空间与索引。
 */

function setup() {
  const db = openDatabase(":memory:");
  const repository = new EcomRepository(db);
  const user = repository.createUser({ email: "u@example.com", passwordHash: "x", displayName: "U", role: "user" });
  return { db, repository, user };
}

const past = () => new Date(Date.now() - 60_000).toISOString();
const future = () => new Date(Date.now() + 3_600_000).toISOString();

describe("deleteExpiredSessions", () => {
  it("只删除已过期的会话，保留仍有效的", () => {
    const { db, repository, user } = setup();
    repository.createSession({ userId: user.id, tokenHash: "expired-1", userAgent: null, ip: null, expiresAt: past() });
    repository.createSession({ userId: user.id, tokenHash: "expired-2", userAgent: null, ip: null, expiresAt: past() });
    repository.createSession({ userId: user.id, tokenHash: "alive", userAgent: null, ip: null, expiresAt: future() });

    const removed = repository.deleteExpiredSessions(new Date().toISOString());
    expect(removed).toBe(2);

    const remaining = db.prepare("SELECT token_hash FROM user_sessions").all() as Array<{ token_hash: string }>;
    expect(remaining.map((row) => row.token_hash)).toEqual(["alive"]);
    db.close();
  });

  it("清理不会影响仍有效的登录态", () => {
    const { db, repository, user } = setup();
    repository.createSession({ userId: user.id, tokenHash: "alive", userAgent: null, ip: null, expiresAt: future() });

    repository.deleteExpiredSessions(new Date().toISOString());
    expect(repository.findActiveSession("alive")?.user.id).toBe(user.id);
    db.close();
  });

  it("没有过期会话时返回 0", () => {
    const { db, repository } = setup();
    expect(repository.deleteExpiredSessions(new Date().toISOString())).toBe(0);
    db.close();
  });
});
