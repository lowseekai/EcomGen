import type { AssetRole } from "@ecomgen/contracts";
import type { SqliteDatabase } from "../database.js";
import { newId } from "../ids.js";
import { SYSTEM_SCOPE, ownerClause, type ScopeInput } from "../scope.js";
import { type Row, now } from "./internal.js";

export interface AssetRecord {
  id: string;
  projectId: string;
  role: AssetRole;
  storagePath: string;
  hash: string;
  originalName: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  createdAt: string;
}

export class AssetRepository {
  public constructor(private readonly db: SqliteDatabase, private readonly scope: ScopeInput = SYSTEM_SCOPE) { }

  public listAssets(projectId: string): AssetRecord[] {
    const owner = ownerClause(this.scope, "p.owner_id");
    return (this.db.prepare(`SELECT a.* FROM assets a JOIN projects p ON p.id=a.project_id WHERE a.project_id=?${owner.sql} ORDER BY a.created_at`)
      .all(projectId, ...owner.params) as Row[]).map(mapAsset);
  }
  public getAsset(id: string): AssetRecord | undefined {
    const owner = ownerClause(this.scope, "p.owner_id");
    const row = this.db.prepare(`SELECT a.* FROM assets a JOIN projects p ON p.id=a.project_id WHERE a.id=?${owner.sql}`).get(id, ...owner.params);
    return row ? mapAsset(row as Row) : undefined;
  }
  public createAsset(input: Omit<AssetRecord, "id" | "createdAt"> & { sizeBytes?: number | null }): AssetRecord {
    const record: AssetRecord = { ...input, id: newId(), createdAt: now() };
    this.db.prepare(`INSERT INTO assets (id,project_id,role,storage_path,hash,original_name,mime_type,width,height,size_bytes,created_at)
      VALUES (@id,@projectId,@role,@storagePath,@hash,@originalName,@mimeType,@width,@height,@sizeBytes,@createdAt)`)
      .run({ ...record, sizeBytes: input.sizeBytes ?? null });
    return record;
  }

  /** 先查后删：返回被删记录供 API 删除存储文件；不存在返回 undefined。 */
  public deleteAsset(id: string): AssetRecord | undefined {
    const existing = this.getAsset(id);
    if (!existing) return undefined;
    this.db.prepare("DELETE FROM assets WHERE id=?").run(id);
    return existing;
  }
}

function mapAsset(row: Row): AssetRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    role: row.role as AssetRole,
    storagePath: String(row.storage_path),
    hash: String(row.hash),
    originalName: String(row.original_name),
    mimeType: String(row.mime_type),
    width: row.width === null || row.width === undefined ? null : Number(row.width),
    height: row.height === null || row.height === undefined ? null : Number(row.height),
    createdAt: String(row.created_at)
  };
}
