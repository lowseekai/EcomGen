import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { openDatabase } from "./database.js";

/**
 * 事务模式：读-改-写必须用 BEGIN IMMEDIATE。
 *
 * 背景（实测）：API 与 Worker 是两个进程写同一个 SQLite 文件。deferred 事务
 * 在"读之后、写之前"若另一个进程提交了，升级写锁会抛 `SQLITE_BUSY_SNAPSHOT`，
 * 而这个错误不受 `busy_timeout` 约束——表现为偶发 500 而不是等待。
 *
 * 判定方式：A 的事务里先读再让 B 写。
 * - deferred（旧行为）：A 只持读锁，B 写得进去；等 A 再写时才会撞 BUSY_SNAPSHOT。
 * - immediate（现在）：A 在 BEGIN 时就持写锁，B 直接等锁（busy_timeout=0 时立刻 SQLITE_BUSY）。
 */

let dir = "";
let file = "";

function setup(): void {
  dir = mkdtempSync(join(tmpdir(), "ecomgen-tx-"));
  file = join(dir, "tx.sqlite");
  const seed = new Database(file);
  seed.pragma("journal_mode = WAL");
  seed.exec("CREATE TABLE credit_accounts (user_id TEXT PRIMARY KEY, balance_microcredits INTEGER NOT NULL)");
  seed.prepare("INSERT INTO credit_accounts VALUES (?, ?)").run("u1", 100);
  seed.close();
}

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("事务模式", () => {
  it("默认事务在 BEGIN 时就取写锁，另一个连接写不进去", () => {
    setup();
    const a = openDatabase(file);
    const b = new Database(file);
    b.pragma("journal_mode = WAL");
    b.pragma("busy_timeout = 0"); // 不等待，立刻暴露锁冲突

    let blocked: unknown = null;
    const transaction = a.transaction(() => {
      a.prepare("SELECT balance_microcredits FROM credit_accounts WHERE user_id=?").get("u1");
      // A 已持写锁；B 的写入应当被挡在锁外。
      try {
        b.prepare("UPDATE credit_accounts SET balance_microcredits=1 WHERE user_id=?").run("u1");
      } catch (error) {
        blocked = error;
      }
    });
    transaction();

    expect(blocked).not.toBeNull();
    expect(String((blocked as { code?: string }).code)).toBe("SQLITE_BUSY");

    a.close();
    b.close();
  });

  it("事务提交后另一个连接可以正常写入（锁已释放）", () => {
    setup();
    const a = openDatabase(file);
    const b = new Database(file);
    b.pragma("journal_mode = WAL");
    b.pragma("busy_timeout = 0");

    a.transaction(() => {
      a.prepare("UPDATE credit_accounts SET balance_microcredits=90 WHERE user_id=?").run("u1");
    })();

    expect(() => b.prepare("UPDATE credit_accounts SET balance_microcredits=80 WHERE user_id=?").run("u1")).not.toThrow();
    const value = b.prepare("SELECT balance_microcredits AS v FROM credit_accounts WHERE user_id=?").get("u1") as { v: number };
    expect(value.v).toBe(80);

    a.close();
    b.close();
  });

  it("事务内抛错时回滚，余额保持原值", () => {
    setup();
    const a = openDatabase(file);

    expect(() =>
      a.transaction(() => {
        a.prepare("UPDATE credit_accounts SET balance_microcredits=0 WHERE user_id=?").run("u1");
        throw new Error("boom");
      })(),
    ).toThrow("boom");

    const value = a.prepare("SELECT balance_microcredits AS v FROM credit_accounts WHERE user_id=?").get("u1") as { v: number };
    expect(value.v).toBe(100);
    a.close();
  });
});
