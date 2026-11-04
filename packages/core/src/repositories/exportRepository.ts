import type { SqliteDatabase } from "../database.js";
import { newId } from "../ids.js";
import { SYSTEM_SCOPE, ownerClause, type ScopeInput } from "../scope.js";
import { type Row, json, now, parse } from "./internal.js";

export interface ExportRecord {
  id: string;
  projectId: string;
  jobId: string;
  status: string;
  storagePath: string | null;
  createdAt: string;
  updatedAt: string;
}

/** AI 分层元素：auto 来自视觉模型识别；manual 来自用户画框（bbox 为归一化坐标）。 */
export interface LayerPlanElementRecord {
  id: string;
  name: string;
  /** 视觉识别产出的英文分割提示，供只接受英文 prompt 的分割渠道（如 Gitee AI SAM 3）使用。 */
  promptEn?: string;
  source: "auto" | "manual";
  bbox: { x: number; y: number; width: number; height: number } | null;
}

export interface LayerPlanRecord {
  id: string;
  projectId: string;
  outputId: string;
  jobId: string;
  /** 创建 plan 时输出图的内容 hash；同 hash 的成功 plan 可直接复用。 */
  outputHash: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  elements: LayerPlanElementRecord[];
  error: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface LayerExportLayerFileRecord {
  name: string;
  kind: "element" | "background" | "composite";
  storagePath: string;
  hash: string;
}

export interface LayerExportRecord {
  id: string;
  projectId: string;
  outputId: string;
  jobId: string;
  /** 识别方案引用；画框/提示词直接分层（无识别方案）时为 null。 */
  planId: string | null;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  includeBackground: boolean;
  psdStoragePath: string | null;
  layerFiles: LayerExportLayerFileRecord[] | null;
  error: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/** 导出域：项目 ZIP 导出与 AI 分层（识别 + 导出）共享"任务伴随记录"的生命周期。 */
export class ExportRepository {
  public constructor(private readonly db: SqliteDatabase, private readonly scope: ScopeInput = SYSTEM_SCOPE) { }

  /** 子表没有 owner_id：归属经父项目推导。找不到父项目即视为不可见。 */
  private visibleProject(projectId: string | null | undefined): boolean {
    if (!projectId) return false;
    const owner = ownerClause(this.scope, "owner_id");
    return this.db.prepare(`SELECT 1 FROM projects WHERE id=?${owner.sql}`).get(projectId, ...owner.params) !== undefined;
  }

  public createExport(input: Omit<ExportRecord, "id" | "createdAt" | "updatedAt">): ExportRecord { const record = { ...input, id: newId(), createdAt: now(), updatedAt: now() }; this.db.prepare("INSERT INTO exports (id,project_id,job_id,status,storage_path,created_at,updated_at) VALUES (@id,@projectId,@jobId,@status,@storagePath,@createdAt,@updatedAt)").run(record); return record; }
  /**
   * 逐层文件同时写行表与 JSON 快照：行表供查询（JOIN/索引），JSON 保留写入时原文。
   * 两者在同一事务里更新，避免出现"查得到但下不了"的半状态。
   */
  private syncLayerFiles(layerExportId: string, files: LayerExportLayerFileRecord[] | null): void {
    this.db.prepare("DELETE FROM layer_export_files WHERE layer_export_id=?").run(layerExportId);
    if (!files || files.length === 0) return;
    const insert = this.db.prepare("INSERT INTO layer_export_files (id,layer_export_id,position,name,kind,storage_path,hash,created_at) VALUES (?,?,?,?,?,?,?,?)");
    const timestamp = now();
    files.forEach((file, index) => {
      insert.run(`${layerExportId}-${index}`, layerExportId, index, file.name, file.kind, file.storagePath, file.hash ?? null, timestamp);
    });
  }

  public getExport(id: string): ExportRecord | undefined { const row = this.db.prepare("SELECT * FROM exports WHERE id=?").get(id) as Row | undefined; return row && this.visibleProject(row.project_id as string) ? mapExport(row as Row) : undefined; }
  public getExportByJobId(jobId: string): ExportRecord | undefined { const row = this.db.prepare("SELECT * FROM exports WHERE job_id=?").get(jobId) as Row | undefined; return row && this.visibleProject(row.project_id as string) ? mapExport(row as Row) : undefined; }
  public updateExport(id: string, patch: Partial<Pick<ExportRecord, "status" | "storagePath">>): ExportRecord | undefined { const current = this.getExport(id); if (!current) return undefined; const next = { ...current, ...patch, updatedAt: now() }; this.db.prepare("UPDATE exports SET status=@status,storage_path=@storagePath,updated_at=@updatedAt WHERE id=@id").run(next); return next; }

  public createLayerPlan(input: Omit<LayerPlanRecord, "id" | "createdAt" | "updatedAt">): LayerPlanRecord {
    const record: LayerPlanRecord = { ...input, id: newId(), createdAt: now(), updatedAt: now() };
    this.db.prepare("INSERT INTO layer_plans (id,project_id,output_id,job_id,output_hash,status,elements_json,error_json,created_at,updated_at) VALUES (@id,@projectId,@outputId,@jobId,@outputHash,@status,@elements,@error,@createdAt,@updatedAt)")
      .run({ ...record, elements: json(record.elements), error: record.error ? json(record.error) : null });
    return record;
  }
  public getLayerPlan(id: string): LayerPlanRecord | undefined { const row = this.db.prepare("SELECT * FROM layer_plans WHERE id=?").get(id) as Row | undefined; return row && this.visibleProject(row.project_id as string) ? mapLayerPlan(row as Row) : undefined; }
  public getLayerPlanByOutput(outputId: string): LayerPlanRecord | undefined { const row = this.db.prepare("SELECT * FROM layer_plans WHERE output_id=? ORDER BY created_at DESC, id DESC LIMIT 1").get(outputId) as Row | undefined; return row && this.visibleProject(row.project_id as string) ? mapLayerPlan(row as Row) : undefined; }
  public getLayerPlanByJobId(jobId: string): LayerPlanRecord | undefined { const row = this.db.prepare("SELECT * FROM layer_plans WHERE job_id=?").get(jobId) as Row | undefined; return row && this.visibleProject(row.project_id as string) ? mapLayerPlan(row as Row) : undefined; }
  public updateLayerPlan(id: string, patch: Partial<Pick<LayerPlanRecord, "status" | "elements" | "error">>): LayerPlanRecord | undefined {
    const current = this.getLayerPlan(id); if (!current) return undefined;
    const next = { ...current, ...patch, updatedAt: now() };
    this.db.prepare("UPDATE layer_plans SET status=@status,elements_json=@elements,error_json=@error,updated_at=@updatedAt WHERE id=@id")
      .run({ ...next, elements: json(next.elements), error: next.error ? json(next.error) : null });
    return next;
  }
  public createLayerExport(input: Omit<LayerExportRecord, "id" | "createdAt" | "updatedAt">): LayerExportRecord {
    const record: LayerExportRecord = { ...input, id: newId(), createdAt: now(), updatedAt: now() };
    const write = this.db.transaction(() => {
      this.db.prepare("INSERT INTO layer_exports (id,project_id,output_id,job_id,plan_id,status,include_background,psd_storage_path,layer_files_json,error_json,created_at,updated_at) VALUES (@id,@projectId,@outputId,@jobId,@planId,@status,@includeBackground,@psdStoragePath,@layerFiles,@error,@createdAt,@updatedAt)")
        .run({ ...record, includeBackground: record.includeBackground ? 1 : 0, layerFiles: record.layerFiles ? json(record.layerFiles) : null, error: record.error ? json(record.error) : null });
      this.syncLayerFiles(record.id, record.layerFiles);
    });
    write();
    return record;
  }
  public getLayerExport(id: string): LayerExportRecord | undefined { const row = this.db.prepare("SELECT * FROM layer_exports WHERE id=?").get(id) as Row | undefined; return row && this.visibleProject(row.project_id as string) ? mapLayerExport(row as Row) : undefined; }
  public getLayerExportByJobId(jobId: string): LayerExportRecord | undefined { const row = this.db.prepare("SELECT * FROM layer_exports WHERE job_id=?").get(jobId) as Row | undefined; return row && this.visibleProject(row.project_id as string) ? mapLayerExport(row as Row) : undefined; }
  public getLayerExportByOutput(outputId: string): LayerExportRecord | undefined { const row = this.db.prepare("SELECT * FROM layer_exports WHERE output_id=? ORDER BY created_at DESC, id DESC LIMIT 1").get(outputId) as Row | undefined; return row && this.visibleProject(row.project_id as string) ? mapLayerExport(row as Row) : undefined; }
  /** 历史导出全集（新→旧）：行级文件与 PSD 均按记录 id 命名空间落盘，重跑不会覆盖，旧记录始终可回看。 */
  public listLayerExportsByOutput(outputId: string): LayerExportRecord[] { const rows = this.db.prepare("SELECT * FROM layer_exports WHERE output_id=? ORDER BY created_at DESC, id DESC").all(outputId) as Row[]; return rows.filter((row) => this.visibleProject(row.project_id as string)).map((row) => mapLayerExport(row as Row)); }
  public updateLayerExport(id: string, patch: Partial<Pick<LayerExportRecord, "status" | "psdStoragePath" | "layerFiles" | "error">>): LayerExportRecord | undefined {
    const current = this.getLayerExport(id); if (!current) return undefined;
    const next = { ...current, ...patch, updatedAt: now() };
    const write = this.db.transaction(() => {
      this.db.prepare("UPDATE layer_exports SET status=@status,psd_storage_path=@psdStoragePath,layer_files_json=@layerFiles,error_json=@error,updated_at=@updatedAt WHERE id=@id")
        .run({ ...next, includeBackground: next.includeBackground ? 1 : 0, layerFiles: next.layerFiles ? json(next.layerFiles) : null, error: next.error ? json(next.error) : null });
      // 只有真正带上了新文件列表才重建行表；状态更新不应清空既有文件。
      if (patch.layerFiles !== undefined) this.syncLayerFiles(id, next.layerFiles);
    });
    write();
    return next;
  }
}

function mapExport(row: Row): ExportRecord { return { id: String(row.id), projectId: String(row.project_id), jobId: String(row.job_id), status: String(row.status), storagePath: row.storage_path ? String(row.storage_path) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
function mapLayerPlan(row: Row): LayerPlanRecord { return { id: String(row.id), projectId: String(row.project_id), outputId: String(row.output_id), jobId: String(row.job_id), outputHash: String(row.output_hash), status: row.status as LayerPlanRecord["status"], elements: parse(row.elements_json ?? "[]"), error: row.error_json ? parse(row.error_json) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
function mapLayerExport(row: Row): LayerExportRecord { return { id: String(row.id), projectId: String(row.project_id), outputId: String(row.output_id), jobId: String(row.job_id), planId: row.plan_id == null ? null : String(row.plan_id), status: row.status as LayerExportRecord["status"], includeBackground: Boolean(row.include_background), psdStoragePath: row.psd_storage_path ? String(row.psd_storage_path) : null, layerFiles: row.layer_files_json ? parse(row.layer_files_json) : null, error: row.error_json ? parse(row.error_json) : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
