import type {
  CompositePolicy,
  EditExecutionMode,
  EditOperation,
  ImageAspectRatio,
  ImageResolution,
  ReferenceSelection,
} from "@ecomgen/contracts";
import type { SqliteDatabase } from "../database.js";
import { newId } from "../ids.js";
import { SYSTEM_SCOPE, ownerClause, type ScopeInput } from "../scope.js";
import { type Row, json, now, parse } from "./internal.js";

export interface GenerationSnapshot {
  providerId: string;
  modelId: string;
  resolution: ImageResolution;
  aspectRatio: ImageAspectRatio;
  size: string;
  candidateIndex: number;
  operation?: EditOperation;
  executionMode?: EditExecutionMode;
  targetDescription?: string;
  targetConfidence?: number;
  sourceOutputId?: string;
  maskHash?: string | null;
  protectMaskHash?: string | null;
  compositePolicy?: CompositePolicy;
  referenceSelections?: ReferenceSelection[];
  referenceHashes?: Record<string, string | null>;
}

export interface OutputRecord {
  id: string;
  projectId: string;
  storyboardItemId: string;
  jobId: string;
  candidateIndex: number;
  generationBatchId?: string | null;
  generationSnapshot: GenerationSnapshot | null;
  storagePath: string;
  hash: string;
  width?: number | null;
  height?: number | null;
  /** 外部生成请求的稳定幂等键；编辑版本和普通候选均可用。 */
  generationKey?: string | null;
  parentOutputId?: string | null;
  rootOutputId?: string | null;
  editSessionId?: string | null;
  editTurnId?: string | null;
  createdAt: string;
}

export class OutputRepository {
  public constructor(private readonly db: SqliteDatabase, private readonly scope: ScopeInput = SYSTEM_SCOPE) { }

  /** 子表没有 owner_id：归属经父项目推导。找不到父项目即视为不可见。 */
  private visibleProject(projectId: string | null | undefined): boolean {
    if (!projectId) return false;
    const owner = ownerClause(this.scope, "owner_id");
    return this.db.prepare(`SELECT 1 FROM projects WHERE id=?${owner.sql}`).get(projectId, ...owner.params) !== undefined;
  }

  public createOutput(input: Omit<OutputRecord, "id" | "createdAt">): OutputRecord {
    const generationKey = input.generationKey ?? null;
    if (generationKey) {
      const existing = this.getOutputByGenerationKey(generationKey);
      if (existing) return existing;
    }
    const record: OutputRecord = { ...input, generationBatchId: input.generationBatchId ?? null, generationKey, parentOutputId: input.parentOutputId ?? null, rootOutputId: input.rootOutputId ?? null, editSessionId: input.editSessionId ?? null, editTurnId: input.editTurnId ?? null, id: newId(), createdAt: now() };
    const result = this.db.prepare("INSERT INTO outputs (id,project_id,storyboard_item_id,job_id,candidate_index,generation_batch_id,generation_key,generation_snapshot_json,storage_path,hash,width,height,created_at,parent_output_id,root_output_id,edit_session_id,edit_turn_id) VALUES (@id,@projectId,@storyboardItemId,@jobId,@candidateIndex,@generationBatchId,@generationKey,@generationSnapshot,@storagePath,@hash,@width,@height,@createdAt,@parentOutputId,@rootOutputId,@editSessionId,@editTurnId) ON CONFLICT(id) DO NOTHING")
      .run({ ...record, width: record.width ?? null, height: record.height ?? null, generationSnapshot: record.generationSnapshot ? json(record.generationSnapshot) : null });
    if (result.changes === 0 && generationKey) {
      const existing = this.getOutputByGenerationKey(generationKey);
      if (existing) return existing;
      throw new Error(`Output generation key was rejected without an existing output: ${generationKey}`);
    }
    return record;
  }
  public getOutputByGenerationKey(generationKey: string): OutputRecord | undefined {
    const row = this.db.prepare("SELECT * FROM outputs WHERE generation_key=?").get(generationKey) as Row | undefined;
    return row && this.visibleProject(row.project_id as string) ? mapOutput(row as Row) : undefined;
  }
  public getOutput(id: string): OutputRecord | undefined { const row = this.db.prepare("SELECT * FROM outputs WHERE id=?").get(id) as Row | undefined; return row && this.visibleProject(row.project_id as string) ? mapOutput(row as Row) : undefined; }
  public listOutputs(projectId: string): OutputRecord[] { if (!this.visibleProject(projectId)) return []; return (this.db.prepare("SELECT * FROM outputs WHERE project_id=? ORDER BY created_at DESC").all(projectId) as Row[]).map(mapOutput); }
  public listEditOutputs(sessionId: string): OutputRecord[] { return (this.db.prepare("SELECT * FROM outputs WHERE edit_session_id=? ORDER BY created_at ASC").all(sessionId) as Row[]).filter((row) => this.visibleProject((row as Row).project_id as string)).map((row) => mapOutput(row as Row)); }
  public isOutputInEditSession(sessionId: string, outputId: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM edit_sessions s WHERE s.id=? AND (s.current_output_id=? OR EXISTS (SELECT 1 FROM outputs o WHERE o.id=? AND o.edit_session_id=s.id) OR EXISTS (SELECT 1 FROM outputs o WHERE o.edit_session_id=s.id AND o.root_output_id=?)) LIMIT 1").get(sessionId, outputId, outputId, outputId);
    return Boolean(row);
  }
}

function mapOutput(row: Row): OutputRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    storyboardItemId: String(row.storyboard_item_id),
    jobId: String(row.job_id),
    candidateIndex: Number(row.candidate_index ?? 1),
    generationBatchId: row.generation_batch_id ? String(row.generation_batch_id) : null,
    generationSnapshot: row.generation_snapshot_json ? parse(row.generation_snapshot_json) : null,
    storagePath: String(row.storage_path),
    hash: String(row.hash),
    width: row.width === null || row.width === undefined ? null : Number(row.width),
    height: row.height === null || row.height === undefined ? null : Number(row.height),
    generationKey: row.generation_key ? String(row.generation_key) : null,
    parentOutputId: row.parent_output_id ? String(row.parent_output_id) : null,
    rootOutputId: row.root_output_id ? String(row.root_output_id) : null,
    editSessionId: row.edit_session_id ? String(row.edit_session_id) : null,
    editTurnId: row.edit_turn_id ? String(row.edit_turn_id) : null,
    createdAt: String(row.created_at)
  };
}
