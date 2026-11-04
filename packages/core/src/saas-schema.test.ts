import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, type SqliteDatabase } from "./database.js";

/**
 * SaaS 基础层迁移的守卫测试。
 *
 * 这里断言的是"表/列/种子数据存在"，不是业务行为：后续给 repository 加 owner 过滤时，
 * 一旦有人误删或重命名这些列，本文件会先于业务测试失败，定位成本最低。
 */

function tableNames(database: SqliteDatabase): Set<string> {
  const rows = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function columnNames(database: SqliteDatabase, table: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

const SAAS_TABLES = [
  "users",
  "user_sessions",
  "password_reset_tokens",
  "login_events",
  "admin_audit_events",
  "app_settings",
  "plans",
  "plan_entitlements",
  "subscriptions",
  "credit_accounts",
  "credit_ledger_entries",
  "billing_orders",
  "provider_model_prices",
  "payment_orders",
  "payment_notifications",
];

/** 加 owner_id 的表：只覆盖"不属于项目"的实体；assets/outputs 经 project_id 推导归属。 */
const OWNED_TABLES = ["projects", "models", "patterns", "pattern_drafts", "user_templates", "user_suites", "jobs"];

/** 文件落点：配额聚合查询依赖这些列，漏一个就会少算。 */
const SIZED_TABLES = [
  "assets",
  "outputs",
  "exports",
  "edit_reference_assets",
  "patterns",
  "draft_media",
  "draft_candidates",
  "model_portraits",
  "models",
  "layer_exports",
  "print_packs",
];

describe("SaaS 基础层迁移", () => {
  it("建出全部身份、计费、支付表", () => {
    const database = openDatabase(":memory:");
    const tables = tableNames(database);
    for (const table of SAAS_TABLES) expect(tables, `缺少表 ${table}`).toContain(table);
    database.close();
  });

  it("给需要归属的实体补 owner_id，且不冗余到项目下属实体", () => {
    const database = openDatabase(":memory:");
    for (const table of OWNED_TABLES) {
      expect(columnNames(database, table), `${table} 缺少 owner_id`).toContain("owner_id");
    }
    // assets/outputs 始终挂在 project_id 下，归属由项目推导；冗余存储会造成两处真相。
    expect(columnNames(database, "assets")).not.toContain("owner_id");
    expect(columnNames(database, "outputs")).not.toContain("owner_id");
    database.close();
  });

  it("给全部文件落点补 size_bytes", () => {
    const database = openDatabase(":memory:");
    for (const table of SIZED_TABLES) {
      expect(columnNames(database, table), `${table} 缺少 size_bytes`).toContain("size_bytes");
    }
    database.close();
  });

  it("种子免费与专业套餐，且免费计划权益齐全", () => {
    const database = openDatabase(":memory:");
    const plans = database.prepare("SELECT id, code FROM plans ORDER BY sort_order").all() as Array<{ id: string; code: string }>;
    expect(plans.map((plan) => plan.code)).toEqual(["free", "pro"]);

    const entitlements = database
      .prepare("SELECT key, value_json FROM plan_entitlements WHERE plan_id=?")
      .all("plan-free") as Array<{ key: string; value_json: string }>;
    const byKey = new Map(entitlements.map((entry) => [entry.key, JSON.parse(entry.value_json) as unknown]));
    // 免费计划必须能建项目、能生成，否则新用户无法完成任何工作。
    expect(byKey.get("max_projects")).toBe(3);
    expect(byKey.get("max_concurrent_jobs")).toBe(1);
    expect(byKey.get("max_storage_bytes")).toBe(5_368_709_120);
    expect(byKey.get("max_image_resolution")).toBe("2K");
    database.close();
  });

  it("种子设置默认关闭注册", () => {
    const database = openDatabase(":memory:");
    const read = (key: string) =>
      JSON.parse((database.prepare("SELECT value_json FROM app_settings WHERE key=?").get(key) as { value_json: string }).value_json) as unknown;
    // 自部署与内测默认不开放注册；公网开放由管理员在后台显式打开。
    expect(read("registration_enabled")).toBe(false);
    expect(read("signup_bonus_microcredits")).toBe(2_000_000);
    database.close();
  });

  it("迁移幂等：同一文件重复打开不重复插种子、不报错", () => {
    const dir = mkdtempSync(join(tmpdir(), "ecomgen-saas-"));
    const file = join(dir, "ecomgen.sqlite");
    try {
      const first = openDatabase(file);
      const count = () => (first.prepare("SELECT COUNT(*) AS n FROM plan_entitlements").get() as { n: number }).n;
      const before = count();
      first.close();

      const second = openDatabase(file);
      const after = (second.prepare("SELECT COUNT(*) AS n FROM plan_entitlements").get() as { n: number }).n;
      const plans = (second.prepare("SELECT COUNT(*) AS n FROM plans").get() as { n: number }).n;
      second.close();

      expect(after).toBe(before);
      expect(plans).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("升级既有旧库：业务表新增列后旧数据保留", () => {
    const dir = mkdtempSync(join(tmpdir(), "ecomgen-saas-legacy-"));
    const file = join(dir, "ecomgen.sqlite");
    try {
      // 先建一个"旧库"：只有业务表，没有 SaaS 表。
      const legacy = openDatabase(file);
      legacy.exec("PRAGMA foreign_keys = OFF");
      legacy.exec("DROP TABLE IF EXISTS plan_entitlements");
      legacy.exec("DROP TABLE IF EXISTS plans");
      legacy.exec("DROP TABLE IF EXISTS app_settings");
      legacy.exec("DROP TABLE IF EXISTS users");
      legacy.prepare(
        "INSERT INTO projects (id,name,platform_targets_json,default_mode,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      ).run("legacy-project", "旧项目", "[]", "CREATIVE", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
      legacy.close();

      // 再打开：迁移应补出 SaaS 表与 owner_id，且不动既有行。
      const upgraded = openDatabase(file);
      expect(tableNames(upgraded)).toContain("users");
      expect(columnNames(upgraded, "projects")).toContain("owner_id");
      const row = upgraded.prepare("SELECT name, owner_id FROM projects WHERE id=?").get("legacy-project") as { name: string; owner_id: string | null };
      expect(row.name).toBe("旧项目");
      // owner_id 由启动期 claimOrphanRows 回填，迁移本身保持 NULL。
      expect(row.owner_id).toBeNull();
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
