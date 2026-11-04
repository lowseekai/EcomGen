import { join } from "node:path";
import { statSync } from "node:fs";
import type { SqliteDatabase } from "../database.js";
import { type Row, parse } from "./internal.js";

/** 允许写 size_bytes 的表白名单：表名会拼进 SQL，不能接受外部任意字符串。 */
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
] as const;

export type SizedTable = (typeof SIZED_TABLES)[number];

/**
 * 存储用量统计。
 *
 * 不做 `storage_usage` 计数器表：计数器会漂移——删文件、级联删项目、Worker 崩溃留半成品，
 * 任何一处漏减都会永久错账，而且只能人工排查。这里改成按需聚合查询：
 * 行删了额度自动释放，永远是对的。
 *
 * 上传频率是每分钟个位数，聚合查询走索引完全够用。
 */
export class StorageRepository {
  public constructor(private readonly db: SqliteDatabase) { }

  /**
   * 用户已用字节数。
   *
   * 归属路径分三类：经 project_id（素材/输出/导出/参考图/分层）、
   * 直接 owner_id（花型/模特）、经草稿或花型父表（草稿媒体/候选/规格包）。
   */
  public usedBytes(ownerId: string): number {
    const row = this.db.prepare(`
      SELECT
          (SELECT COALESCE(SUM(a.size_bytes),0) FROM assets a JOIN projects p ON p.id=a.project_id WHERE p.owner_id=?)
        + (SELECT COALESCE(SUM(o.size_bytes),0) FROM outputs o JOIN projects p ON p.id=o.project_id WHERE p.owner_id=?)
        + (SELECT COALESCE(SUM(e.size_bytes),0) FROM exports e JOIN projects p ON p.id=e.project_id WHERE p.owner_id=?)
        + (SELECT COALESCE(SUM(r.size_bytes),0) FROM edit_reference_assets r JOIN projects p ON p.id=r.project_id WHERE p.owner_id=?)
        + (SELECT COALESCE(SUM(l.size_bytes),0) FROM layer_exports l JOIN projects p ON p.id=l.project_id WHERE p.owner_id=?)
        + (SELECT COALESCE(SUM(x.size_bytes),0) FROM patterns x WHERE x.owner_id=?)
        + (SELECT COALESCE(SUM(dm.size_bytes),0) FROM draft_media dm JOIN pattern_drafts d ON d.id=dm.draft_id WHERE d.owner_id=?)
        + (SELECT COALESCE(SUM(dc.size_bytes),0) FROM draft_candidates dc JOIN pattern_drafts d ON d.id=dc.draft_id WHERE d.owner_id=?)
        + (SELECT COALESCE(SUM(mo.size_bytes),0) FROM model_portraits mo JOIN models m ON m.id=mo.model_id WHERE m.owner_id=?)
        + (SELECT COALESCE(SUM(m.size_bytes),0) FROM models m WHERE m.owner_id=?)
        + (SELECT COALESCE(SUM(pp.size_bytes),0) FROM print_packs pp JOIN patterns x ON x.id=pp.pattern_id WHERE x.owner_id=?)
      AS bytes_used`).get(ownerId, ownerId, ownerId, ownerId, ownerId, ownerId, ownerId, ownerId, ownerId, ownerId, ownerId) as { bytes_used: number };
    return Number(row.bytes_used);
  }

  /** 写入单个产物的字节数。表名走白名单，其余一律拒绝。 */
  public recordSize(table: SizedTable, id: string, sizeBytes: number): void {
    if (!SIZED_TABLES.includes(table)) throw new Error(`unsupported table for size accounting: ${table}`);
    this.db.prepare(`UPDATE ${table} SET size_bytes=? WHERE id=?`).run(sizeBytes, id);
  }

  /** 多文件产物（分层导出/规格包）：由写入方把各文件大小累加后一次写入。 */
  public recordSizes(entries: Array<{ table: SizedTable; id: string; sizeBytes: number }>): void {
    const write = this.db.transaction(() => {
      for (const entry of entries) this.recordSize(entry.table, entry.id, entry.sizeBytes);
    });
    write();
  }

  /**
   * 按磁盘实际大小重算 size_bytes，用于修复"磁盘被外部清理"或历史行未记录大小的情况。
   *
   * 只更新能 stat 到的文件；文件不存在时保留原值而不是清零——清零会把"文件丢了"
   * 伪装成"空间释放了"，让配额看起来正常而实际已损坏。
   */
  public recount(dataDir: string): { updated: number; missing: number } {
    let updated = 0;
    let missing = 0;

    const singlePath = (table: SizedTable, pathColumn: string) => {
      const rows = this.db.prepare(`SELECT id, ${pathColumn} AS path FROM ${table} WHERE ${pathColumn} IS NOT NULL`).all() as Row[];
      for (const row of rows) {
        const size = statFile(dataDir, String(row.path));
        if (size === null) { missing++; continue; }
        this.recordSize(table, String(row.id), size);
        updated++;
      }
    };

    singlePath("assets", "storage_path");
    singlePath("outputs", "storage_path");
    singlePath("exports", "storage_path");
    singlePath("edit_reference_assets", "storage_path");
    singlePath("patterns", "storage_path");
    singlePath("draft_media", "storage_path");
    singlePath("draft_candidates", "storage_path");
    singlePath("model_portraits", "storage_path");
    singlePath("models", "reference_face_path");

    // 多文件产物：layer_exports 有独立的 PSD 列，print_packs 没有——
    // 两张表的列不同，必须分别拼 SQL，不能共用一个 SELECT。
    const multiPath: Array<{ table: "layer_exports" | "print_packs"; filesColumn: string; psdColumn: string | null }> = [
      { table: "layer_exports", filesColumn: "layer_files_json", psdColumn: "psd_storage_path" },
      { table: "print_packs", filesColumn: "files_json", psdColumn: null },
    ];
    for (const { table, filesColumn, psdColumn } of multiPath) {
      const psdSelect = psdColumn ? `${psdColumn} AS psd` : "NULL AS psd";
      const rows = this.db.prepare(`SELECT id, ${psdSelect}, ${filesColumn} AS files FROM ${table}`).all() as Row[];
      for (const row of rows) {
        let total = 0;
        let found = false;
        const psd = row.psd === null || row.psd === undefined ? null : statFile(dataDir, String(row.psd));
        if (psd !== null) { total += psd; found = true; }
        if (row.files !== null && row.files !== undefined) {
          for (const path of pathsFromJson(row.files)) {
            const size = statFile(dataDir, path);
            if (size === null) { missing++; continue; }
            total += size;
            found = true;
          }
        }
        if (!found) { missing++; continue; }
        this.recordSize(table, String(row.id), total);
        updated++;
      }
    }

    return { updated, missing };
  }
}

/** storagePath 是相对 dataDir 的路径；绝对路径原样接受（便于迁移与测试）。 */
function statFile(dataDir: string, storagePath: string): number | null {
  const candidates = [storagePath, join(dataDir, storagePath)];
  for (const candidate of candidates) {
    try {
      const stat = statSync(candidate);
      if (stat.isFile()) return stat.size;
    } catch {
      // 继续尝试下一个候选路径
    }
  }
  return null;
}

function pathsFromJson(raw: unknown): string[] {
  try {
    const parsed = parse<unknown>(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (typeof entry === "string") return [entry];
      if (entry && typeof entry === "object" && "storagePath" in entry) {
        const value = (entry as { storagePath: unknown }).storagePath;
        return typeof value === "string" ? [value] : [];
      }
      return [];
    });
  } catch {
    return [];
  }
}
