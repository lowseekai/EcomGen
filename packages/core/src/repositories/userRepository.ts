import type { SqliteDatabase } from "../database.js";
import { newId } from "../ids.js";
import { type Row, json, now, parse } from "./internal.js";

export type UserRole = "owner" | "admin" | "support" | "user";
export type UserStatus = "active" | "disabled";

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  emailVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 会话只持有 token 的 sha256；明文仅存在于 Cookie 中，永不落库。 */
export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface UserListQuery {
  keyword?: string;
  role?: string;
  status?: string;
  limit: number;
  offset: number;
}

export interface LoginEventInput {
  userId: string | null;
  email: string;
  ip: string | null;
  userAgent: string | null;
  outcome: "success" | "bad_credentials" | "disabled" | "rate_limited";
}

export interface AuditEventInput {
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string | null;
  summary: string;
  data?: unknown;
}

/**
 * 身份、会话、审计与站点设置。
 *
 * 邮箱统一小写存储：`email` 列有 UNIQUE 约束，若允许大小写混存，`A@x.com` 与 `a@x.com`
 * 会变成两个账号，密码重置和登录都会按"哪个先建"随机命中。
 */
export class UserRepository {
  public constructor(private readonly db: SqliteDatabase) { }

  // ---- 用户 ----

  public createUser(input: { email: string; passwordHash: string; displayName: string; role?: UserRole; status?: UserStatus; emailVerifiedAt?: string | null }): UserRecord {
    const timestamp = now();
    const record: UserRecord = {
      id: newId(),
      email: normalizeEmail(input.email),
      passwordHash: input.passwordHash,
      displayName: input.displayName,
      role: input.role ?? "user",
      status: input.status ?? "active",
      emailVerifiedAt: input.emailVerifiedAt ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db.prepare(`INSERT INTO users (id,email,password_hash,display_name,role,status,email_verified_at,created_at,updated_at)
      VALUES (@id,@email,@passwordHash,@displayName,@role,@status,@emailVerifiedAt,@createdAt,@updatedAt)`)
      .run(record);
    return record;
  }

  public getUser(id: string): UserRecord | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    return row ? mapUser(row as Row) : undefined;
  }

  public getUserByEmail(email: string): UserRecord | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE email = ?").get(normalizeEmail(email));
    return row ? mapUser(row as Row) : undefined;
  }

  public countUsers(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  }

  public listUsers(query: UserListQuery): { items: UserRecord[]; total: number } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.keyword) {
      clauses.push("(email LIKE ? OR display_name LIKE ?)");
      params.push(`%${query.keyword}%`, `%${query.keyword}%`);
    }
    if (query.role) { clauses.push("role = ?"); params.push(query.role); }
    if (query.status) { clauses.push("status = ?"); params.push(query.status); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM users ${where}`).get(...params) as { n: number }).n;
    const rows = this.db.prepare(`SELECT * FROM users ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, query.limit, query.offset) as Row[];
    return { items: rows.map(mapUser), total };
  }

  public updateUser(id: string, patch: Partial<Pick<UserRecord, "displayName" | "role" | "status" | "passwordHash" | "emailVerifiedAt">>): UserRecord | undefined {
    const existing = this.getUser(id);
    if (!existing) return undefined;
    const next: UserRecord = { ...existing, ...patch, updatedAt: now() };
    this.db.prepare(`UPDATE users SET display_name=@displayName, role=@role, status=@status, password_hash=@passwordHash,
      email_verified_at=@emailVerifiedAt, updated_at=@updatedAt WHERE id=@id`).run(next);
    return next;
  }

  public deleteUser(id: string): boolean {
    return this.db.prepare("DELETE FROM users WHERE id = ?").run(id).changes > 0;
  }

  // ---- 会话 ----

  public createSession(input: { userId: string; tokenHash: string; userAgent: string | null; ip: string | null; expiresAt: string }): SessionRecord {
    const timestamp = now();
    const record: SessionRecord = { id: newId(), revokedAt: null, createdAt: timestamp, lastSeenAt: timestamp, ...input };
    this.db.prepare(`INSERT INTO user_sessions (id,user_id,token_hash,user_agent,ip,created_at,last_seen_at,expires_at,revoked_at)
      VALUES (@id,@userId,@tokenHash,@userAgent,@ip,@createdAt,@lastSeenAt,@expiresAt,@revokedAt)`).run(record);
    return record;
  }

  /** 按 token 哈希取会话，只返回未撤销且未过期的行；过期判断放在 SQL 里，避免调用方各自比较时间。 */
  public findActiveSession(tokenHash: string): { session: SessionRecord; user: UserRecord } | undefined {
    const row = this.db.prepare(`SELECT s.id AS s_id, s.user_id AS s_user_id, s.token_hash AS s_token_hash, s.user_agent AS s_user_agent,
        s.ip AS s_ip, s.created_at AS s_created_at, s.last_seen_at AS s_last_seen_at, s.expires_at AS s_expires_at, s.revoked_at AS s_revoked_at
      FROM user_sessions s WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`).get(tokenHash, now()) as Row | undefined;
    if (!row) return undefined;
    const user = this.getUser(String(row.s_user_id));
    if (!user) return undefined;
    return {
      session: {
        id: String(row.s_id),
        userId: String(row.s_user_id),
        tokenHash: String(row.s_token_hash),
        userAgent: row.s_user_agent === null ? null : String(row.s_user_agent),
        ip: row.s_ip === null ? null : String(row.s_ip),
        createdAt: String(row.s_created_at),
        lastSeenAt: String(row.s_last_seen_at),
        expiresAt: String(row.s_expires_at),
        revokedAt: null,
      },
      user,
    };
  }

  public touchSession(id: string): void {
    this.db.prepare("UPDATE user_sessions SET last_seen_at=? WHERE id=?").run(now(), id);
  }

  public revokeSession(id: string): void {
    this.db.prepare("UPDATE user_sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(now(), id);
  }

  /** 改密码、封禁、删号都必须撤销全部会话，否则旧 Cookie 仍可继续访问。 */
  public revokeUserSessions(userId: string): number {
    return this.db.prepare("UPDATE user_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL").run(now(), userId).changes;
  }

  public listUserSessions(userId: string): SessionRecord[] {
    return (this.db.prepare("SELECT * FROM user_sessions WHERE user_id=? ORDER BY last_seen_at DESC").all(userId) as Row[]).map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      tokenHash: String(row.token_hash),
      userAgent: row.user_agent === null ? null : String(row.user_agent),
      ip: row.ip === null ? null : String(row.ip),
      createdAt: String(row.created_at),
      lastSeenAt: String(row.last_seen_at),
      expiresAt: String(row.expires_at),
      revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
    }));
  }

  // ---- 密码重置 ----

  public createPasswordResetToken(userId: string, tokenHash: string, expiresAt: string): string {
    const id = newId();
    this.db.prepare("INSERT INTO password_reset_tokens (id,user_id,token_hash,created_at,expires_at,used_at) VALUES (?,?,?,?,?,NULL)")
      .run(id, userId, tokenHash, now(), expiresAt);
    return id;
  }

  /** 消费即作废：同一条 token 只能成功一次，并发重放第二次返回 undefined。 */
  public consumePasswordResetToken(tokenHash: string): string | undefined {
    const consume = this.db.transaction(() => {
      const row = this.db.prepare("SELECT id, user_id FROM password_reset_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at > ?")
        .get(tokenHash, now()) as { id: string; user_id: string } | undefined;
      if (!row) return undefined;
      this.db.prepare("UPDATE password_reset_tokens SET used_at=? WHERE id=?").run(now(), row.id);
      return row.user_id;
    });
    return consume();
  }

  // ---- 审计 ----

  public recordLoginEvent(input: LoginEventInput): void {
    this.db.prepare("INSERT INTO login_events (id,user_id,email,ip,user_agent,outcome,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(newId(), input.userId, normalizeEmail(input.email), input.ip, input.userAgent, input.outcome, now());
  }

  public listLoginEvents(limit: number, offset: number, userId?: string): Row[] {
    return userId
      ? this.db.prepare("SELECT * FROM login_events WHERE user_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?").all(userId, limit, offset) as Row[]
      : this.db.prepare("SELECT * FROM login_events ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset) as Row[];
  }

  public recordAuditEvent(input: AuditEventInput): void {
    this.db.prepare("INSERT INTO admin_audit_events (id,actor_user_id,action,target_type,target_id,summary,data_json,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(newId(), input.actorUserId, input.action, input.targetType, input.targetId, input.summary, json(input.data ?? {}), now());
  }

  public listAuditEvents(limit: number, offset: number): Row[] {
    return this.db.prepare("SELECT * FROM admin_audit_events ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset) as Row[];
  }

  // ---- 站点设置 ----

  public getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare("SELECT value_json FROM app_settings WHERE key=?").get(key) as { value_json: string } | undefined;
    return row ? parse<T>(row.value_json) : fallback;
  }

  public setSetting(key: string, value: unknown): void {
    this.db.prepare(`INSERT INTO app_settings (key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`).run(key, json(value), now());
  }

  // ---- 存量数据归属 ----

  /**
   * 把 owner_id 为空的历史行归到引导管理员名下。
   *
   * 单用户旧库升级时，所有既有项目/模特/花型/草稿/模板/套图/任务都属于同一个使用者；
   * 迁移只加列不回填（数据库层无法知道归属），归属由应用层在首次启动时补齐。
   * 幂等：没有空行时每个 UPDATE 影响 0 行，可安全重复调用。
   */
  public claimOrphanRows(ownerId: string): Record<string, number> {
    const tables = ["projects", "models", "patterns", "pattern_drafts", "user_templates", "user_suites", "jobs"];
    const claimed: Record<string, number> = {};
    const claim = this.db.transaction(() => {
      for (const table of tables) {
        claimed[table] = this.db.prepare(`UPDATE ${table} SET owner_id=? WHERE owner_id IS NULL`).run(ownerId).changes;
      }
    });
    claim();
    return claimed;
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function mapUser(row: Row): UserRecord {
  return {
    id: String(row.id),
    email: String(row.email),
    passwordHash: String(row.password_hash),
    displayName: String(row.display_name),
    role: row.role as UserRole,
    status: row.status as UserStatus,
    emailVerifiedAt: row.email_verified_at === null ? null : String(row.email_verified_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
