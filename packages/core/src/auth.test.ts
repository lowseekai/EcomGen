import { describe, expect, it } from "vitest";
import { openDatabase } from "./database.js";
import { EcomRepository } from "./repository.js";
import { hashPassword, isAcceptablePassword, issueSessionToken, verifyPassword } from "./auth.js";
import { ensureBootstrapOwner } from "./bootstrap.js";

function setup() {
  const db = openDatabase(":memory:");
  return { db, repository: new EcomRepository(db) };
}

describe("密码哈希", () => {
  it("同一密码每次哈希不同（随机盐），但都能校验通过", () => {
    const first = hashPassword("correct horse battery staple");
    const second = hashPassword("correct horse battery staple");
    expect(first).not.toBe(second);
    expect(verifyPassword("correct horse battery staple", first)).toBe(true);
    expect(verifyPassword("correct horse battery staple", second)).toBe(true);
  });

  it("错误密码校验失败", () => {
    const stored = hashPassword("s3cret-password");
    expect(verifyPassword("s3cret-passwore", stored)).toBe(false);
    expect(verifyPassword("", stored)).toBe(false);
  });

  it("损坏的哈希行返回 false 而不是抛错", () => {
    // 关键行为：坏数据不能让登录接口 500，否则等于向攻击者暴露"这个账号数据异常"。
    for (const broken of ["", "garbage", "scrypt$1$2$3", "bcrypt$16384$8$1$aa$bb", "scrypt$0$8$1$aa$bb"]) {
      expect(() => verifyPassword("whatever", broken)).not.toThrow();
      expect(verifyPassword("whatever", broken)).toBe(false);
    }
  });

  it("密码长度规则", () => {
    expect(isAcceptablePassword("1234567")).toBe(false);
    expect(isAcceptablePassword("12345678")).toBe(true);
    expect(isAcceptablePassword("x".repeat(201))).toBe(false);
  });
});

describe("会话令牌", () => {
  it("每次签发都不同，且哈希不等于明文", () => {
    const first = issueSessionToken();
    const second = issueSessionToken();
    expect(first.token).not.toBe(second.token);
    expect(first.tokenHash).not.toBe(first.token);
    // 库中只存哈希；同样输入哈希稳定，才能按 token 查会话。
    expect(issueSessionToken.call(null) && first.tokenHash).toHaveLength(64);
  });

  it("按哈希能取回未过期会话，撤销后取不到", () => {
    const { repository } = setup();
    const user = repository.createUser({ email: "s@example.com", passwordHash: "x", displayName: "s" });
    const { tokenHash } = issueSessionToken();
    const session = repository.createSession({
      userId: user.id,
      tokenHash,
      userAgent: "vitest",
      ip: "127.0.0.1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(repository.findActiveSession(tokenHash)?.user.id).toBe(user.id);

    repository.revokeSession(session.id);
    expect(repository.findActiveSession(tokenHash)).toBeUndefined();
  });

  it("过期会话取不到", () => {
    const { repository } = setup();
    const user = repository.createUser({ email: "t@example.com", passwordHash: "x", displayName: "t" });
    const { tokenHash } = issueSessionToken();
    repository.createSession({
      userId: user.id,
      tokenHash,
      userAgent: null,
      ip: null,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(repository.findActiveSession(tokenHash)).toBeUndefined();
  });

  it("封禁用户后撤销全部会话", () => {
    const { repository } = setup();
    const user = repository.createUser({ email: "u@example.com", passwordHash: "x", displayName: "u" });
    const tokens = [issueSessionToken(), issueSessionToken()];
    for (const { tokenHash } of tokens) {
      repository.createSession({ userId: user.id, tokenHash, userAgent: null, ip: null, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    }
    expect(repository.revokeUserSessions(user.id)).toBe(2);
    for (const { tokenHash } of tokens) expect(repository.findActiveSession(tokenHash)).toBeUndefined();
  });
});

describe("首次启动引导", () => {
  it("空库建出 owner、发放初始额度并回填历史行", () => {
    const { db, repository } = setup();
    db.prepare("INSERT INTO projects (id,name,platform_targets_json,default_mode,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run("legacy", "旧项目", "[]", "CREATIVE", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

    const result = ensureBootstrapOwner(repository, { email: "boss@example.com", password: "a-long-password", signupBonusMicrocredits: 1000 });

    expect(result.created).toBe(true);
    expect(result.owner.role).toBe("owner");
    expect(result.owner.email).toBe("boss@example.com");
    expect(result.generatedPassword).toBeUndefined();
    expect(result.claimed.projects).toBe(1);
    expect(repository.getBalance(result.owner.id)).toBe(1000);
    expect(verifyPassword("a-long-password", result.owner.passwordHash)).toBe(true);
  });

  it("未提供密码时生成随机密码，且只返回一次", () => {
    const { repository } = setup();
    const result = ensureBootstrapOwner(repository);
    expect(result.created).toBe(true);
    expect(result.generatedPassword).toBeTruthy();
    expect(result.generatedPassword!.length).toBeGreaterThan(12);
    expect(verifyPassword(result.generatedPassword!, result.owner.passwordHash)).toBe(true);
  });

  it("已初始化时幂等：不新建账号、不重复发放", () => {
    const { repository } = setup();
    const first = ensureBootstrapOwner(repository, { password: "a-long-password", signupBonusMicrocredits: 1000 });
    const second = ensureBootstrapOwner(repository, { password: "another-password", signupBonusMicrocredits: 1000 });

    expect(second.created).toBe(false);
    expect(second.owner.id).toBe(first.owner.id);
    expect(repository.countUsers()).toBe(1);
    expect(repository.getBalance(first.owner.id)).toBe(1000);
  });

  it("孤儿回填只做一次：后续启动不再把新出现的无主行判给站长", () => {
    const { db, repository } = setup();
    ensureBootstrapOwner(repository, { password: "a-long-password" });

    // 模拟"之后才出现的无主行"：多租户下把这类行悄悄划给站长等于把别人的数据判给自己。
    db.prepare("INSERT INTO projects (id,name,platform_targets_json,default_mode,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run("late-orphan", "后来出现的无主项目", "[]", "CREATIVE", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

    const second = ensureBootstrapOwner(repository, { password: "a-long-password" });
    expect(second.claimed).toEqual({});

    const row = db.prepare("SELECT owner_id FROM projects WHERE id=?").get("late-orphan") as { owner_id: string | null };
    expect(row.owner_id).toBeNull();
  });

  it("拒绝过短的引导密码", () => {
    const { repository } = setup();
    expect(() => ensureBootstrapOwner(repository, { password: "short" })).toThrow(/at least/);
  });
});
