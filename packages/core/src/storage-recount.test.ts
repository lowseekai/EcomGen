import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type SqliteDatabase } from "./database.js";
import { EcomRepository } from "./repository.js";

/**
 * 存储用量重算。
 *
 * 这段逻辑的价值在于"磁盘与数据库对不上时能修回来"，所以测试的重点是
 * **每一张有文件的表都被扫到**、以及**文件缺失时不清零**。
 *
 * 之所以补这组用例：`recount` 曾经给 print_packs 拼出 `SELECT psd_storage_path`，
 * 而该表根本没有这一列，SQLite 会直接报 no such column——也就是说重算功能一按就崩。
 */

let dataDir = "";
let database: SqliteDatabase;
let repository: EcomRepository;

/** 在数据目录下写一个指定字节数的文件，返回相对路径。 */
function writeFile(relativePath: string, bytes: number): string {
  const absolute = join(dataDir, relativePath);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, Buffer.alloc(bytes, 7));
  return relativePath;
}

function seedProject(id: string): void {
  database.prepare("INSERT INTO projects (id,name,platform_targets_json,default_mode,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(id, id, "[]", "CREATIVE", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "ecomgen-recount-"));
  database = openDatabase(join(dataDir, "ecomgen.sqlite"));
  repository = new EcomRepository(database);
  seedProject("p1");
});

afterEach(() => {
  database.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("存储重算", () => {
  it("单文件表按磁盘实际大小回填", () => {
    const path = writeFile("assets/a.png", 1234);
    database.prepare("INSERT INTO assets (id,project_id,role,storage_path,hash,original_name,mime_type,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("a1", "p1", "PRODUCT_TRUTH", path, "h1", "a.png", "image/png", "2026-01-01T00:00:00.000Z");

    const result = repository.recountStorage(dataDir);

    expect(result.updated).toBe(1);
    expect(result.missing).toBe(0);
    expect(repository.usedStorageBytes("owner-x")).toBe(0); // 无归属时不串到别人
    const row = database.prepare("SELECT size_bytes FROM assets WHERE id=?").get("a1") as { size_bytes: number };
    expect(row.size_bytes).toBe(1234);
  });

  it("print_packs 能重算（该表没有 psd_storage_path 列）", () => {
    const first = writeFile("print-packs/1.png", 100);
    const second = writeFile("print-packs/2.png", 250);
    database.prepare("INSERT INTO patterns (id,name,source_type,storage_path,file_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("pt1", "花型", "UPLOADED", "patterns/p.png", "fh", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    database.prepare("INSERT INTO print_packs (id,pattern_id,job_id,spec_id,spec_version,status,files_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("pk1", "pt1", "job-1", "tshirt-front-12x16", "1", "SUCCEEDED", JSON.stringify([
        { name: "a.png", kind: "PRINT_FILE", storagePath: first, hash: "h1" },
        { name: "b.png", kind: "PRINT_FILE", storagePath: second, hash: "h2" },
      ]), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

    const result = repository.recountStorage(dataDir);

    expect(result.updated).toBe(1);
    const row = database.prepare("SELECT size_bytes FROM print_packs WHERE id=?").get("pk1") as { size_bytes: number };
    expect(row.size_bytes).toBe(350);
  });

  it("layer_exports 把 PSD 与逐层文件累加", () => {
    const psd = writeFile("layers/export.psd", 500);
    const layer = writeFile("layers/00_bg.png", 120);
    database.prepare("INSERT INTO layer_exports (id,project_id,output_id,job_id,status,include_background,psd_storage_path,layer_files_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("le1", "p1", "o1", "job-2", "SUCCEEDED", 1, psd, JSON.stringify([{ name: "00_bg.png", kind: "background", storagePath: layer, hash: "h" }]), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

    repository.recountStorage(dataDir);

    const row = database.prepare("SELECT size_bytes FROM layer_exports WHERE id=?").get("le1") as { size_bytes: number };
    expect(row.size_bytes).toBe(620);
  });

  it("文件缺失时保留原值并计入 missing，而不是清零", () => {
    database.prepare("INSERT INTO assets (id,project_id,role,storage_path,hash,original_name,mime_type,size_bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("a2", "p1", "PRODUCT_TRUTH", "assets/gone.png", "h2", "gone.png", "image/png", 999, "2026-01-01T00:00:00.000Z");

    const result = repository.recountStorage(dataDir);

    // 清零会把"文件丢了"伪装成"空间释放了"，让配额看起来正常而实际已损坏。
    expect(result.missing).toBeGreaterThanOrEqual(1);
    const row = database.prepare("SELECT size_bytes FROM assets WHERE id=?").get("a2") as { size_bytes: number };
    expect(row.size_bytes).toBe(999);
  });

  it("多文件里部分缺失时只累加能 stat 到的", () => {
    const present = writeFile("print-packs/ok.png", 80);
    // 花型行不给 storage_path：recount 会扫全部表，只留这一个变量，missing 计数才是精确的。
    database.prepare("INSERT INTO patterns (id,name,source_type,storage_path,file_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("pt2", "花型2", "UPLOADED", null, null, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    database.prepare("INSERT INTO print_packs (id,pattern_id,job_id,spec_id,spec_version,status,files_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("pk2", "pt2", "job-3", "spec", "1", "SUCCEEDED", JSON.stringify([
        { name: "ok.png", kind: "PRINT_FILE", storagePath: present, hash: "h" },
        { name: "gone.png", kind: "PRINT_FILE", storagePath: "print-packs/gone.png", hash: "h" },
      ]), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

    const result = repository.recountStorage(dataDir);

    expect(result.updated).toBe(1);
    expect(result.missing).toBe(1);
    const row = database.prepare("SELECT size_bytes FROM print_packs WHERE id=?").get("pk2") as { size_bytes: number };
    expect(row.size_bytes).toBe(80);
  });

  it("幂等：重复重算结果不变", () => {
    const path = writeFile("assets/b.png", 64);
    database.prepare("INSERT INTO assets (id,project_id,role,storage_path,hash,original_name,mime_type,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("a3", "p1", "PRODUCT_TRUTH", path, "h3", "b.png", "image/png", "2026-01-01T00:00:00.000Z");

    repository.recountStorage(dataDir);
    repository.recountStorage(dataDir);

    const row = database.prepare("SELECT size_bytes FROM assets WHERE id=?").get("a3") as { size_bytes: number };
    expect(row.size_bytes).toBe(64);
  });
});
