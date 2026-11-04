import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

import { MODEL_SPEC_DEFAULTS } from "@ecomgen/contracts";

export type SqliteDatabase = Database.Database;

export function openDatabase(filename: string): SqliteDatabase {
  mkdirSync(dirname(filename), { recursive: true });
  const database = new Database(filename);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  try {
    migrate(database);
  } catch (error) {
    // 迁移失败必须释放文件句柄，否则 Windows 上后续清理临时库会 EBUSY
    database.close();
    throw error;
  }
  return database;
}

function tableNames(database: SqliteDatabase): Set<string> {
  const rows = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function columnNames(database: SqliteDatabase, table: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/** 一次性清理审核字段，保留已有输出及编辑版本血缘。 */
function removeLegacyOutputReviewColumns(database: SqliteDatabase): void {
  const tables = tableNames(database);
  if (!tables.has("outputs") || !columnNames(database, "outputs").has("review_decision")) return;
  database.pragma("foreign_keys = OFF");
  try {
    database.exec(`
      CREATE TABLE outputs_without_review (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        storyboard_item_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        candidate_index INTEGER NOT NULL DEFAULT 1,
        generation_key TEXT,
        generation_snapshot_json TEXT,
        storage_path TEXT NOT NULL,
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        parent_output_id TEXT,
        root_output_id TEXT,
        edit_session_id TEXT,
        edit_turn_id TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (storyboard_item_id) REFERENCES storyboard_items(id) ON DELETE CASCADE,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );
      INSERT INTO outputs_without_review (
        id,project_id,storyboard_item_id,job_id,candidate_index,generation_key,generation_snapshot_json,storage_path,hash,created_at,parent_output_id,root_output_id,edit_session_id,edit_turn_id
      )
      SELECT
        id,project_id,storyboard_item_id,job_id,candidate_index,NULL,generation_snapshot_json,storage_path,hash,created_at,parent_output_id,root_output_id,edit_session_id,edit_turn_id
      FROM outputs;
      DROP TABLE outputs;
      ALTER TABLE outputs_without_review RENAME TO outputs;
    `);
  } finally {
    database.pragma("foreign_keys = ON");
  }
}

/** 旧库补齐 shot_role 列；历史行保持 NULL，由上层按"未标注"处理。 */
function addStoryboardItemShotRole(database: SqliteDatabase): void {
  const tables = tableNames(database);
  if (!tables.has("storyboard_items") || columnNames(database, "storyboard_items").has("shot_role")) return;
  database.exec("ALTER TABLE storyboard_items ADD COLUMN shot_role TEXT");
}

/** 旧库补齐 jobs.progress_detail_json 列；历史行保持 NULL，由上层按"没有进度明细"处理。 */
function addJobProgressDetail(database: SqliteDatabase): void {
  const tables = tableNames(database);
  if (!tables.has("jobs") || columnNames(database, "jobs").has("progress_detail_json")) return;
  database.exec("ALTER TABLE jobs ADD COLUMN progress_detail_json TEXT");
}

/** 旧库补齐 projects.prompt_language 列；存量项目落产品默认值（中文提示词）。 */
function addProjectPromptLanguage(database: SqliteDatabase): void {
  const tables = tableNames(database);
  if (!tables.has("projects") || columnNames(database, "projects").has("prompt_language")) return;
  database.exec("ALTER TABLE projects ADD COLUMN prompt_language TEXT NOT NULL DEFAULT 'CHINESE'");
}

/** Provider 可随时删除：旧库的 projects.provider 引用列为 NOT NULL，重建表放宽为可空（删除 Provider 时级联置空）。 */
function makeProjectProviderReferencesNullable(database: SqliteDatabase): void {
  const columns = database.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string; notnull: number }>;
  if (columns.length === 0 || !columns.some((column) => (column.name === "reasoning_provider_id" || column.name === "image_provider_id") && column.notnull !== 0)) return;
  // 重建 SELECT 依赖这些后补列；更早版本的旧库可能一个都还没有
  for (const column of ["archived_at", "target_market", "copy_language"]) {
    if (!columns.some((existing) => existing.name === column)) database.exec(`ALTER TABLE projects ADD COLUMN ${column} TEXT`);
  }
  database.exec("DROP TABLE IF EXISTS projects_nullable_providers");
  database.pragma("foreign_keys = OFF");
  try {
    const rebuild = database.transaction(() => database.exec(`
      CREATE TABLE projects_nullable_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT,
        product_description TEXT,
        verified_facts_json TEXT NOT NULL DEFAULT '[]',
        prohibited_claims_json TEXT NOT NULL DEFAULT '[]',
        brand_guidelines_json TEXT NOT NULL DEFAULT '{}',
        platform_targets_json TEXT NOT NULL,
        target_market TEXT,
        copy_language TEXT,
        reasoning_provider_id TEXT,
        reasoning_model_id TEXT,
        image_provider_id TEXT,
        image_model_id TEXT,
        default_mode TEXT NOT NULL,
        image_resolution TEXT NOT NULL DEFAULT '1K',
        image_aspect_ratio TEXT NOT NULL DEFAULT 'AUTO',
        candidates_per_type INTEGER NOT NULL DEFAULT 1,
        web_research_enabled INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (reasoning_provider_id) REFERENCES providers(id),
        FOREIGN KEY (image_provider_id) REFERENCES providers(id)
      );
      INSERT INTO projects_nullable_providers (
        id,name,category,product_description,verified_facts_json,prohibited_claims_json,brand_guidelines_json,platform_targets_json,target_market,copy_language,reasoning_provider_id,reasoning_model_id,image_provider_id,image_model_id,default_mode,image_resolution,image_aspect_ratio,candidates_per_type,web_research_enabled,archived_at,created_at,updated_at
      )
      SELECT
        id,name,category,product_description,verified_facts_json,prohibited_claims_json,brand_guidelines_json,platform_targets_json,target_market,copy_language,reasoning_provider_id,reasoning_model_id,image_provider_id,image_model_id,default_mode,image_resolution,image_aspect_ratio,candidates_per_type,web_research_enabled,archived_at,created_at,updated_at
      FROM projects;
      DROP TABLE projects;
      ALTER TABLE projects_nullable_providers RENAME TO projects;
    `));
    rebuild();
  } finally {
    database.pragma("foreign_keys = ON");
  }
}

/**
 * 分层导出支持无识别方案（画框/提示词直接分层）：旧库 layer_exports.plan_id 为 NOT NULL，重建表放宽为可空。
 */
function makeLayerExportPlanReferenceNullable(database: SqliteDatabase): void {
  const columns = database.prepare("PRAGMA table_info(layer_exports)").all() as Array<{ name: string; notnull: number }>;
  if (columns.length === 0 || !columns.some((column) => column.name === "plan_id" && column.notnull !== 0)) return;
  database.exec("DROP TABLE IF EXISTS layer_exports_nullable_plan");
  database.pragma("foreign_keys = OFF");
  try {
    const rebuild = database.transaction(() => database.exec(`
      CREATE TABLE layer_exports_nullable_plan (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        output_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        plan_id TEXT,
        status TEXT NOT NULL,
        include_background INTEGER NOT NULL DEFAULT 0,
        psd_storage_path TEXT,
        layer_files_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      INSERT INTO layer_exports_nullable_plan (id,project_id,output_id,job_id,plan_id,status,include_background,psd_storage_path,layer_files_json,error_json,created_at,updated_at)
      SELECT id,project_id,output_id,job_id,plan_id,status,include_background,psd_storage_path,layer_files_json,error_json,created_at,updated_at FROM layer_exports;
      DROP TABLE layer_exports;
      ALTER TABLE layer_exports_nullable_plan RENAME TO layer_exports;
    `));
    rebuild();
  } finally {
    database.pragma("foreign_keys = ON");
  }
}

/**
 * 全局套图反推任务不绑定项目：旧库 jobs.project_id 为 NOT NULL，重建表放宽为可空。
 * 项目任务的级联删除语义保持不变（project_id 为空的行不受影响）。
 */
function makeJobsProjectNullable(database: SqliteDatabase): void {
  const columns = database.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string; notnull: number }>;
  if (columns.length === 0 || !columns.some((column) => column.name === "project_id" && column.notnull !== 0)) return;
  database.exec("DROP TABLE IF EXISTS jobs_nullable_project");
  database.pragma("foreign_keys = OFF");
  try {
    const rebuild = database.transaction(() => database.exec(`
      CREATE TABLE jobs_nullable_project (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        storyboard_item_id TEXT,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        progress INTEGER NOT NULL,
        retryable INTEGER NOT NULL,
        input_json TEXT NOT NULL,
        request_fingerprint TEXT,
        provider_id TEXT,
        model_id TEXT,
        estimated_cost_json TEXT,
        actual_cost_json TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        provider_task_id TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (storyboard_item_id) REFERENCES storyboard_items(id) ON DELETE SET NULL
      );
      INSERT INTO jobs_nullable_project (
        id,project_id,storyboard_item_id,type,status,progress,retryable,input_json,request_fingerprint,provider_id,model_id,estimated_cost_json,actual_cost_json,cancel_requested,provider_task_id,error_json,created_at,updated_at
      )
      SELECT
        id,project_id,storyboard_item_id,type,status,progress,retryable,input_json,request_fingerprint,provider_id,model_id,estimated_cost_json,actual_cost_json,cancel_requested,provider_task_id,error_json,created_at,updated_at
      FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_nullable_project RENAME TO jobs;
    `));
    rebuild();
  } finally {
    database.pragma("foreign_keys = ON");
  }
}

/**
 * 开发初期以本 schema 为唯一规范，不保留历史状态；
 * 新增可空列走一次性 ALTER，旧行保持 NULL 由上层按"未标注"处理。
 */
function migrate(database: SqliteDatabase): void {
  removeLegacyOutputReviewColumns(database);
  makeProjectProviderReferencesNullable(database);
  makeLayerExportPlanReferenceNullable(database);
  makeJobsProjectNullable(database);
  addStoryboardItemShotRole(database);
  addJobProgressDetail(database);
  addProjectPromptLanguage(database);
  database.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      product_description TEXT,
      verified_facts_json TEXT NOT NULL DEFAULT '[]',
      prohibited_claims_json TEXT NOT NULL DEFAULT '[]',
      brand_guidelines_json TEXT NOT NULL DEFAULT '{}',
      base_url TEXT NOT NULL,
      reasoning_protocol TEXT NOT NULL DEFAULT 'openai',
      encrypted_api_key TEXT NOT NULL,
      models_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS search_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      base_url TEXT NOT NULL,
      encrypted_api_key TEXT,
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      product_description TEXT,
      verified_facts_json TEXT NOT NULL DEFAULT '[]',
      prohibited_claims_json TEXT NOT NULL DEFAULT '[]',
      brand_guidelines_json TEXT NOT NULL DEFAULT '{}',
      platform_targets_json TEXT NOT NULL,
      target_market TEXT,
      copy_language TEXT,
      prompt_language TEXT NOT NULL DEFAULT 'CHINESE',
      reasoning_provider_id TEXT,
      reasoning_model_id TEXT,
      image_provider_id TEXT,
      image_model_id TEXT,
      default_mode TEXT NOT NULL,
      image_resolution TEXT NOT NULL DEFAULT '1K',
      image_aspect_ratio TEXT NOT NULL DEFAULT 'AUTO',
      candidates_per_type INTEGER NOT NULL DEFAULT 1,
      web_research_enabled INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      planning_revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (reasoning_provider_id) REFERENCES providers(id),
      FOREIGN KEY (image_provider_id) REFERENCES providers(id)
    );
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      role TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      hash TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS storyboards (
      project_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      campaign_style_lock TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS storyboard_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      storyboard_version INTEGER NOT NULL,
      asset_type TEXT NOT NULL,
      display_name TEXT NOT NULL,
      shot_role TEXT,
      template_variant TEXT,
      candidate_count INTEGER NOT NULL DEFAULT 1,
      image_provider_id TEXT,
      image_model_id TEXT,
      image_resolution TEXT,
      image_aspect_ratio TEXT,
      referenced_assets_json TEXT NOT NULL DEFAULT '[]',
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      prompt_instruction TEXT NOT NULL,
      compiled_prompt TEXT,
      fact_claims_json TEXT NOT NULL,
      risk_flags_json TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      storyboard_item_id TEXT,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      progress INTEGER NOT NULL,
      retryable INTEGER NOT NULL,
      input_json TEXT NOT NULL,
      request_fingerprint TEXT,
      provider_id TEXT,
      model_id TEXT,
      estimated_cost_json TEXT,
      actual_cost_json TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      provider_task_id TEXT,
      error_json TEXT,
      progress_detail_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (storyboard_item_id) REFERENCES storyboard_items(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS copywriting_results (
      job_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      target TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS web_research_audits (
      job_id TEXT PRIMARY KEY,
      availability TEXT NOT NULL,
      invocation_count INTEGER NOT NULL DEFAULT 0,
      successful_attempt_count INTEGER NOT NULL DEFAULT 0,
      failed_attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS web_research_attempts (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      query TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      result_count INTEGER NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS outputs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      storyboard_item_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      candidate_index INTEGER NOT NULL DEFAULT 1,
      generation_batch_id TEXT,
      generation_key TEXT,
      generation_snapshot_json TEXT,
      storage_path TEXT NOT NULL,
      hash TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      created_at TEXT NOT NULL,
      parent_output_id TEXT,
      root_output_id TEXT,
      edit_session_id TEXT,
      edit_turn_id TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (storyboard_item_id) REFERENCES storyboard_items(id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS planning_config_snapshots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_job_id TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (source_job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS exports (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      status TEXT NOT NULL,
      storage_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS edit_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      current_output_id TEXT NOT NULL,
      status TEXT NOT NULL,
      memory_summary_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (current_output_id) REFERENCES outputs(id)
    );
    CREATE TABLE IF NOT EXISTS edit_turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      base_output_id TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT NOT NULL,
      annotations_json TEXT NOT NULL DEFAULT '{}',
      edit_mask_path TEXT,
      edit_mask_hash TEXT,
      protect_mask_path TEXT,
      protect_mask_hash TEXT,
      reference_asset_ids_json TEXT NOT NULL DEFAULT '[]',
      reference_selections_json TEXT NOT NULL DEFAULT '[]',
      plan_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES edit_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (base_output_id) REFERENCES outputs(id)
    );
    CREATE TABLE IF NOT EXISTS edit_reference_assets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_id TEXT,
      storage_path TEXT NOT NULL,
      hash TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      purpose TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES edit_sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_assets_project_created ON assets(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_storyboard_items_project_sort ON storyboard_items(project_id, storyboard_version, sort_order);
    CREATE INDEX IF NOT EXISTS idx_jobs_project_status_updated ON jobs(project_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_outputs_project_created ON outputs(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_outputs_root_created ON outputs(root_output_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_exports_project_updated ON exports(project_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_edit_turns_project_updated ON edit_turns(project_id, updated_at);
    CREATE TABLE IF NOT EXISTS user_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      default_size TEXT NOT NULL DEFAULT '1024x1024',
      supports_image_reference INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_suites (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      l1 TEXT NOT NULL,
      l2 TEXT NOT NULL,
      leaf TEXT NOT NULL,
      product_family TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS suite_forge_results (
      job_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      suite_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      reference_face_path TEXT,
      reference_face_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_portraits (
      id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      hash TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      provider_id TEXT NOT NULL,
      image_model_id TEXT NOT NULL,
      aspect_ratio TEXT NOT NULL,
      selected INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_model_portraits_model_created ON model_portraits(model_id, created_at DESC);
  `);
  if (!columnNames(database, "projects").has("archived_at")) {
    database.exec("ALTER TABLE projects ADD COLUMN archived_at TEXT");
  }
  if (!columnNames(database, "projects").has("segmentation_provider_id")) {
    database.exec("ALTER TABLE projects ADD COLUMN segmentation_provider_id TEXT");
  }
  if (!columnNames(database, "projects").has("segmentation_model_id")) {
    database.exec("ALTER TABLE projects ADD COLUMN segmentation_model_id TEXT");
  }
  if (!columnNames(database, "projects").has("segmentation_protocol")) {
    database.exec("ALTER TABLE projects ADD COLUMN segmentation_protocol TEXT");
  }
  // 规划修订号：项目规划相关事实变化时单调递增，旧规划任务按指纹失效；旧行从 0 起算
  if (!columnNames(database, "projects").has("planning_revision")) {
    database.exec("ALTER TABLE projects ADD COLUMN planning_revision INTEGER NOT NULL DEFAULT 0");
  }
  if (!columnNames(database, "outputs").has("generation_key")) {
    database.exec("ALTER TABLE outputs ADD COLUMN generation_key TEXT");
  }
  if (!columnNames(database, "outputs").has("generation_batch_id")) {
    database.exec("ALTER TABLE outputs ADD COLUMN generation_batch_id TEXT");
    database.exec("UPDATE outputs SET generation_batch_id=job_id WHERE edit_session_id IS NULL AND generation_batch_id IS NULL");
  }
  // 验缝判定（本地确定性接缝比较，常量见 contracts/pod-tileability.ts）：判定的唯一写入方是
  // PATTERN_TILE_CHECK 任务。这段守卫必须放在 CREATE TABLE patterns 之前，所以要先判定表是否存在
  // ——columnNames 对不存在的表返回空集，只有 size > 0 才说明是历史库、才需要补列；
  // 新库由下面的建表语句直接带上这三列。
  const patternColumns = columnNames(database, "patterns");
  if (patternColumns.size > 0) {
    if (!patternColumns.has("tileable_status")) {
      database.exec("ALTER TABLE patterns ADD COLUMN tileable_status TEXT NOT NULL DEFAULT 'NONE'");
    }
    if (!patternColumns.has("tileable_score")) {
      database.exec("ALTER TABLE patterns ADD COLUMN tileable_score REAL");
    }
    // 写入该判定时的算法版本：与当前版本不一致即判定过期，需要重算（花型像素不可变，判定只在算法变更时失效）。
    if (!patternColumns.has("tileable_checked_with")) {
      database.exec("ALTER TABLE patterns ADD COLUMN tileable_checked_with TEXT");
    }
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS edit_reference_assets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_id TEXT,
      storage_path TEXT NOT NULL,
      hash TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      purpose TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES edit_sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_edit_reference_assets_session ON edit_reference_assets(session_id, created_at);
  `);
  if (!columnNames(database, "edit_turns").has("reference_selections_json")) {
    database.exec("ALTER TABLE edit_turns ADD COLUMN reference_selections_json TEXT NOT NULL DEFAULT '[]'");
    const rows = database.prepare("SELECT id, reference_asset_ids_json FROM edit_turns WHERE reference_asset_ids_json <> '[]'").all() as Array<{ id: string; reference_asset_ids_json: string }>;
    const update = database.prepare("UPDATE edit_turns SET reference_selections_json=? WHERE id=?");
    const migrateSelections = database.transaction(() => { for (const row of rows) { const ids = JSON.parse(row.reference_asset_ids_json) as string[]; update.run(JSON.stringify(ids.map((id, order) => ({ id, source: "PROJECT", purpose: "PRODUCT_APPEARANCE", order }))), row.id); } });
    migrateSelections();
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS layer_plans (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      output_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      output_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      elements_json TEXT NOT NULL DEFAULT '[]',
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS layer_exports (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      output_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      plan_id TEXT,
      status TEXT NOT NULL,
      include_background INTEGER NOT NULL DEFAULT 0,
      psd_storage_path TEXT,
      layer_files_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_layer_plans_job ON layer_plans(job_id);
    CREATE INDEX IF NOT EXISTS idx_layer_plans_output ON layer_plans(output_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_layer_exports_job ON layer_exports(job_id);
    CREATE INDEX IF NOT EXISTS idx_layer_exports_output ON layer_exports(output_id, created_at DESC);
  `);
  // 花型工坊：patterns 是全局实体（无项目外键，同 models）；print_packs 是「一任务一记录」的领域记录（同 layer_exports）。
  // Listing 文案结果独立成表而不是复用 copywriting_results：后者 project_id NOT NULL 且外键到 projects，
  // 而 Listing 由花型发起、归属花型域，硬塞进项目域需要把列约束改可空（SQLite 只能重建表）。
  database.exec(`
    CREATE TABLE IF NOT EXISTS patterns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_job_id TEXT,
      source_asset_hash TEXT,
      parent_pattern_id TEXT,
      storage_path TEXT,
      file_hash TEXT,
      width INTEGER,
      height INTEGER,
      tags_json TEXT NOT NULL DEFAULT '[]',
      tileable_status TEXT NOT NULL DEFAULT 'NONE',
      tileable_score REAL,
      tileable_checked_with TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (parent_pattern_id) REFERENCES patterns(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_patterns_created ON patterns(created_at DESC);
    -- source_job_id：每个花型任务的指纹复用判定与断点续跑都按它查；file_hash：资产库缩略图按 hash 找回花型。
    CREATE INDEX IF NOT EXISTS idx_patterns_source_job ON patterns(source_job_id);
    CREATE INDEX IF NOT EXISTS idx_patterns_file_hash ON patterns(file_hash);
    CREATE TABLE IF NOT EXISTS print_packs (
      id TEXT PRIMARY KEY,
      pattern_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      spec_id TEXT NOT NULL,
      spec_version TEXT NOT NULL,
      status TEXT NOT NULL,
      files_json TEXT,
      manifest_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (pattern_id) REFERENCES patterns(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_print_packs_job ON print_packs(job_id);
    CREATE INDEX IF NOT EXISTS idx_print_packs_pattern ON print_packs(pattern_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS pattern_listing_results (
      job_id TEXT PRIMARY KEY,
      pattern_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (pattern_id) REFERENCES patterns(id) ON DELETE CASCADE
    );
    -- 成包流水线：一条流水线是「图案 × 品类规格 × 平台」的一次串联执行，步骤各自对应一个任务行。
    -- pattern_id 可空：从花型墙的来源动作（提取/起稿/上传）起链时，花型要等 SOURCE 步骤完成才存在；
    -- 因此外键用 SET NULL 而不是 CASCADE——删花型不该连流水线历史一起抹掉（用户仍要看到它产过什么）。
    CREATE TABLE IF NOT EXISTS pattern_pipelines (
      id TEXT PRIMARY KEY,
      pattern_id TEXT,
      spec_id TEXT NOT NULL,
      spec_version TEXT NOT NULL,
      layout TEXT NOT NULL,
      repeat_layout TEXT NOT NULL,
      listing_platform TEXT NOT NULL,
      listing_provider_id TEXT NOT NULL,
      listing_model_id TEXT NOT NULL,
      listing_hints_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      block_reason TEXT,
      request_fingerprint TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (pattern_id) REFERENCES patterns(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pattern_pipelines_pattern ON pattern_pipelines(pattern_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pattern_pipelines_fingerprint ON pattern_pipelines(request_fingerprint);
    -- 步骤表：position 决定推进顺序，不依赖枚举顺序；job_id 是唯一反查键（worker 靠它从完成的任务找回流水线）。
    CREATE TABLE IF NOT EXISTS pattern_pipeline_steps (
      id TEXT PRIMARY KEY,
      pipeline_id TEXT NOT NULL,
      step TEXT NOT NULL,
      position INTEGER NOT NULL,
      status TEXT NOT NULL,
      job_id TEXT,
      detail_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (pipeline_id) REFERENCES pattern_pipelines(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pattern_pipeline_steps_job ON pattern_pipeline_steps(job_id) WHERE job_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_pattern_pipeline_steps_pipeline ON pattern_pipeline_steps(pipeline_id, position);
  `);
  // AI 起稿工作台：创作草稿及其批次/槽位/候选，与正式 patterns 严格分离。
  // 候选只有经显式定稿才写成 patterns 行；草稿删除级联清空草稿域数据，不触及正式花型。
  database.exec(`
    CREATE TABLE IF NOT EXISTS pattern_drafts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      compose_type TEXT NOT NULL,
      conditions_json TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1,
      selected_candidate_id TEXT,
      compare_candidate_id TEXT,
      archived_at TEXT,
      -- 参考图编号的发号器：只增不减，删除参考图不回收编号，因此编号允许出现空档。
      next_media_ordinal INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pattern_drafts_updated ON pattern_drafts(archived_at, updated_at DESC);
    CREATE TABLE IF NOT EXISTS draft_media (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      role TEXT NOT NULL,
      source TEXT NOT NULL,
      source_pattern_id TEXT,
      storage_path TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      original_name TEXT NOT NULL,
      notes TEXT,
      -- 仅参考图有编号；蒙版为 NULL，不占用编号。
      ordinal INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (draft_id) REFERENCES pattern_drafts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_draft_media_draft ON draft_media(draft_id, created_at);
    CREATE TABLE IF NOT EXISTS draft_batches (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      parent_candidate_id TEXT,
      provider_id TEXT,
      image_model_id TEXT,
      candidate_count INTEGER NOT NULL DEFAULT 1,
      instruction TEXT,
      snapshot_json TEXT NOT NULL,
      client_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (draft_id) REFERENCES pattern_drafts(id) ON DELETE CASCADE
    );
    -- 同 key 且同 payload 复用批次；同 key 异 payload 由 API 判定为冲突。唯一约束是这条规则的持久化兜底。
    CREATE UNIQUE INDEX IF NOT EXISTS idx_draft_batches_client_key ON draft_batches(draft_id, client_key);
    CREATE INDEX IF NOT EXISTS idx_draft_batches_draft ON draft_batches(draft_id, created_at);
    CREATE TABLE IF NOT EXISTS draft_slots (
      batch_id TEXT NOT NULL,
      slot_index INTEGER NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      job_id TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (batch_id, slot_index),
      FOREIGN KEY (batch_id) REFERENCES draft_batches(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_draft_slots_job ON draft_slots(job_id);
    CREATE TABLE IF NOT EXISTS draft_candidates (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      slot_index INTEGER NOT NULL,
      parent_candidate_id TEXT,
      storage_path TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      transform TEXT NOT NULL,
      has_alpha INTEGER NOT NULL DEFAULT 0,
      tileable_status TEXT NOT NULL DEFAULT 'NONE',
      tileable_score REAL,
      tileable_checked_with TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (draft_id) REFERENCES pattern_drafts(id) ON DELETE CASCADE,
      FOREIGN KEY (batch_id) REFERENCES draft_batches(id) ON DELETE CASCADE
    );
    -- 一个槽位成功产物至多一份：迟到产物或并发写入触发唯一冲突而不是产生第二份候选。
    CREATE UNIQUE INDEX IF NOT EXISTS idx_draft_candidates_slot ON draft_candidates(batch_id, slot_index);
    CREATE INDEX IF NOT EXISTS idx_draft_candidates_draft ON draft_candidates(draft_id, created_at);
  `);
  // 候选验缝证据：逐轴得分让界面能指出是哪条边接不上；判定仍由 PATTERN_DRAFT_PROCESS 唯一写入。
  if (!columnNames(database, "draft_candidates").has("tileable_horizontal")) {
    database.exec("ALTER TABLE draft_candidates ADD COLUMN tileable_horizontal REAL");
  }
  if (!columnNames(database, "draft_candidates").has("tileable_vertical")) {
    database.exec("ALTER TABLE draft_candidates ADD COLUMN tileable_vertical REAL");
  }
  // 参考图不再按用途分类：旧库的 usages_json 一次性移除，避免留下永不读写的列。
  if (columnNames(database, "draft_media").has("usages_json")) {
    database.exec("ALTER TABLE draft_media DROP COLUMN usages_json");
  }
  // 引用编号：只在参考图上分配，旧库按 created_at 一次性回填，之后删除不回填也不重排。
  // 发号器单独存 next_media_ordinal，不用 MAX(ordinal)+1 现算——删掉最大号再上传会回收该号，
  // 已经写进主题框的「@图N」就会被重新解释成另一张图。
  if (!columnNames(database, "draft_media").has("ordinal")) {
    database.exec("ALTER TABLE draft_media ADD COLUMN ordinal INTEGER");
    database.exec(`
      UPDATE draft_media SET ordinal = (
        SELECT COUNT(*) FROM draft_media AS earlier
        WHERE earlier.draft_id = draft_media.draft_id
          AND earlier.role = 'REFERENCE'
          AND (earlier.created_at < draft_media.created_at OR (earlier.created_at = draft_media.created_at AND earlier.id <= draft_media.id))
      ) WHERE role = 'REFERENCE'
    `);
  }
  if (!columnNames(database, "pattern_drafts").has("next_media_ordinal")) {
    database.exec("ALTER TABLE pattern_drafts ADD COLUMN next_media_ordinal INTEGER NOT NULL DEFAULT 1");
    database.exec("UPDATE pattern_drafts SET next_media_ordinal = 1 + COALESCE((SELECT MAX(ordinal) FROM draft_media WHERE draft_media.draft_id = pattern_drafts.id), 0)");
  }
  // 定稿来源：同候选重复定稿必须复用同一 Pattern，唯一索引是幂等的最终防线。
  if (!columnNames(database, "patterns").has("source_draft_candidate_id")) {
    database.exec("ALTER TABLE patterns ADD COLUMN source_draft_candidate_id TEXT");
  }
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_patterns_source_draft_candidate ON patterns(source_draft_candidate_id) WHERE source_draft_candidate_id IS NOT NULL");
  // 资产库视图：生成结果此前未记录尺寸，旧行保持 NULL，由前端按占位比例兜底。
  if (!columnNames(database, "outputs").has("width")) {
    database.exec("ALTER TABLE outputs ADD COLUMN width INTEGER");
  }
  if (!columnNames(database, "outputs").has("height")) {
    database.exec("ALTER TABLE outputs ADD COLUMN height INTEGER");
  }
  database.exec("CREATE INDEX IF NOT EXISTS idx_outputs_generation_key ON outputs(generation_key)");
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_outputs_generation_key_unique ON outputs(generation_key) WHERE generation_key IS NOT NULL");
  database.exec("CREATE INDEX IF NOT EXISTS idx_outputs_generation_batch ON outputs(project_id, generation_batch_id, created_at)");
  database.exec("CREATE INDEX IF NOT EXISTS idx_planning_config_snapshots_project_created ON planning_config_snapshots(project_id, created_at DESC)");
  database.exec("CREATE INDEX IF NOT EXISTS idx_assets_created ON assets(created_at DESC)");
  database.exec("CREATE INDEX IF NOT EXISTS idx_outputs_created ON outputs(created_at DESC)");
  // 资产库按内容 hash 去重取最新一条，索引让去重扫描不必全表排序
  database.exec("CREATE INDEX IF NOT EXISTS idx_assets_hash ON assets(hash)");
  database.exec("CREATE INDEX IF NOT EXISTS idx_outputs_hash ON outputs(hash)");
  // 每个模特至多一张选定定妆照：先清后设的切换写法在事务内满足该唯一约束。
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_model_portraits_selected ON model_portraits(model_id) WHERE selected = 1");
  backfillModelSpecDimensions(database);
  migrateSaasFoundation(database);
}

/** 补列工具：SQLite 的 ADD COLUMN 不支持 IF NOT EXISTS，统一靠 PRAGMA 判重。 */
function addColumnIfMissing(database: SqliteDatabase, table: string, column: string, definition: string): void {
  if (columnNames(database, table).has(column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * SaaS 基础层：身份、归属、套餐权益、积分账本、计费、支付、存储统计。
 *
 * 只建 schema，不建数据：
 * - 引导管理员（bootstrap owner）由 API 启动期创建，因为需要密码哈希，属于应用层职责；
 * - 存量行的 owner_id 回填也在启动期由 claimOrphanRows 完成，见 packages/core/src/repositories/userRepository.ts。
 *
 * 所有新表使用可移植 SQL（无 SQLite 专有语法），为后续 PostgreSQL 迁移留门。
 */
function migrateSaasFoundation(database: SqliteDatabase): void {
  database.exec(`
    -- ---- 身份与会话 ----
    CREATE TABLE IF NOT EXISTS users (
      id                TEXT PRIMARY KEY,
      email             TEXT NOT NULL UNIQUE,
      password_hash     TEXT NOT NULL,
      display_name      TEXT NOT NULL,
      role              TEXT NOT NULL DEFAULT 'user',
      status            TEXT NOT NULL DEFAULT 'active',
      email_verified_at TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_role_status ON users(role, status);

    CREATE TABLE IF NOT EXISTS user_sessions (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      token_hash   TEXT NOT NULL UNIQUE,
      user_agent   TEXT,
      ip           TEXT,
      created_at   TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at   TEXT NOT NULL,
      revoked_at   TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id, expires_at);

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at    TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id, expires_at);

    -- 登录审计：失败行 user_id 为空（此时还不知道是谁）。
    CREATE TABLE IF NOT EXISTS login_events (
      id         TEXT PRIMARY KEY,
      user_id    TEXT,
      email      TEXT NOT NULL,
      ip         TEXT,
      user_agent TEXT,
      outcome    TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_login_events_created ON login_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_login_events_email ON login_events(email, created_at DESC);

    CREATE TABLE IF NOT EXISTS admin_audit_events (
      id            TEXT PRIMARY KEY,
      actor_user_id TEXT NOT NULL,
      action        TEXT NOT NULL,
      target_type   TEXT NOT NULL,
      target_id     TEXT,
      summary       TEXT NOT NULL,
      data_json     TEXT NOT NULL DEFAULT '{}',
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit_events(target_type, target_id);

    -- 全局开关与站点配置，值一律 JSON。
    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- ---- 套餐与权益 ----
    CREATE TABLE IF NOT EXISTS plans (
      id             TEXT PRIMARY KEY,
      code           TEXT NOT NULL UNIQUE,
      name           TEXT NOT NULL,
      description    TEXT NOT NULL DEFAULT '',
      price_cents    INTEGER NOT NULL DEFAULT 0,
      currency       TEXT NOT NULL DEFAULT 'CNY',
      billing_period TEXT NOT NULL DEFAULT 'none',
      active         INTEGER NOT NULL DEFAULT 1,
      sort_order     INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );

    -- 权益键值：value_json 存标量，避免为每个权益加一列。
    CREATE TABLE IF NOT EXISTS plan_entitlements (
      plan_id    TEXT NOT NULL,
      key        TEXT NOT NULL,
      value_json TEXT NOT NULL,
      PRIMARY KEY (plan_id, key),
      FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id                   TEXT PRIMARY KEY,
      user_id              TEXT NOT NULL,
      plan_id              TEXT NOT NULL,
      status               TEXT NOT NULL,
      current_period_start TEXT NOT NULL,
      current_period_end   TEXT NOT NULL,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      created_at           TEXT NOT NULL,
      updated_at           TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (plan_id) REFERENCES plans(id)
    );
    -- 每个用户至多一个生效订阅；部分唯一索引直接兜住并发开通。
    CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_active_user ON subscriptions(user_id) WHERE status = 'active';

    -- ---- 积分账本 ----
    -- 余额是派生缓存，真相是不可变的 credit_ledger_entries；任何写入都必须在同一事务内同时落两者。
    CREATE TABLE IF NOT EXISTS credit_accounts (
      user_id              TEXT PRIMARY KEY,
      balance_microcredits INTEGER NOT NULL DEFAULT 0,
      updated_at           TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 只允许 INSERT：改错用反向流水冲正，不允许 UPDATE/DELETE 历史。
    CREATE TABLE IF NOT EXISTS credit_ledger_entries (
      id                         TEXT PRIMARY KEY,
      user_id                    TEXT NOT NULL,
      type                       TEXT NOT NULL,
      amount_microcredits        INTEGER NOT NULL,
      balance_after_microcredits INTEGER NOT NULL,
      job_id                     TEXT,
      project_id                 TEXT,
      billing_order_id           TEXT,
      payment_order_id           TEXT,
      note                       TEXT,
      created_at                 TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_user_created ON credit_ledger_entries(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ledger_job ON credit_ledger_entries(job_id);

    -- ---- 任务计费 ----
    -- 状态机：reserved -> settled | refunded | uncertain（外部请求已发出但结果未知，不自动退款）
    CREATE TABLE IF NOT EXISTS billing_orders (
      id                    TEXT PRIMARY KEY,
      user_id               TEXT NOT NULL,
      job_id                TEXT NOT NULL UNIQUE,
      status                TEXT NOT NULL,
      reserved_microcredits INTEGER NOT NULL,
      settled_microcredits  INTEGER,
      cost_snapshot_json    TEXT NOT NULL,
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_billing_orders_user_created ON billing_orders(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_billing_orders_status ON billing_orders(status, updated_at);

    -- 平台代付：成本与售价分开记录，否则算不出毛利，也发现不了定价倒挂的模型。
    CREATE TABLE IF NOT EXISTS provider_model_prices (
      id                 TEXT PRIMARY KEY,
      provider_id        TEXT NOT NULL,
      model_id           TEXT NOT NULL,
      kind               TEXT NOT NULL,
      pricing_mode       TEXT NOT NULL,
      price_microcredits INTEGER NOT NULL,
      cost_microcredits  INTEGER NOT NULL DEFAULT 0,
      tiers_json         TEXT NOT NULL DEFAULT '{}',
      active             INTEGER NOT NULL DEFAULT 1,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL,
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_model_prices_key ON provider_model_prices(provider_id, model_id, kind);

    -- ---- 充值订单与支付 ----
    CREATE TABLE IF NOT EXISTS payment_orders (
      id                   TEXT PRIMARY KEY,
      user_id              TEXT NOT NULL,
      kind                 TEXT NOT NULL,
      plan_id              TEXT,
      credits_microcredits INTEGER NOT NULL DEFAULT 0,
      amount_cents         INTEGER NOT NULL,
      currency             TEXT NOT NULL DEFAULT 'CNY',
      status               TEXT NOT NULL,
      provider             TEXT NOT NULL,
      provider_config_json TEXT NOT NULL,
      provider_order_no    TEXT,
      provider_trade_no    TEXT,
      paid_at              TEXT,
      credited_at          TEXT,
      expires_at           TEXT NOT NULL,
      created_at           TEXT NOT NULL,
      updated_at           TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_payment_orders_user ON payment_orders(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_payment_orders_status ON payment_orders(status, expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_provider_no ON payment_orders(provider, provider_order_no) WHERE provider_order_no IS NOT NULL;

    -- 回调收件箱：先落库再处理，保证回调不丢；(provider,event_id) 唯一即幂等第一道防线。
    CREATE TABLE IF NOT EXISTS payment_notifications (
      id           TEXT PRIMARY KEY,
      provider     TEXT NOT NULL,
      event_id     TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status       TEXT NOT NULL,
      error_json   TEXT,
      created_at   TEXT NOT NULL,
      processed_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_notifications_event ON payment_notifications(provider, event_id);
    CREATE INDEX IF NOT EXISTS idx_payment_notifications_status ON payment_notifications(status, created_at);
  `);

  // ---- 资源归属 ----
  // 只给"不属于项目"的实体加 owner_id；assets/outputs 等始终挂在 project_id 下，归属经项目推导，不冗余存储。
  addColumnIfMissing(database, "projects", "owner_id", "TEXT");
  addColumnIfMissing(database, "models", "owner_id", "TEXT");
  addColumnIfMissing(database, "patterns", "owner_id", "TEXT");
  addColumnIfMissing(database, "pattern_drafts", "owner_id", "TEXT");
  addColumnIfMissing(database, "user_templates", "owner_id", "TEXT");
  addColumnIfMissing(database, "user_suites", "owner_id", "TEXT");
  addColumnIfMissing(database, "jobs", "owner_id", "TEXT");
  // 流水线的 pattern_id 可空（从来源动作起链时花型尚未生成），无法经花型推导归属，必须自带 owner_id。
  addColumnIfMissing(database, "pattern_pipelines", "owner_id", "TEXT");
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_projects_owner_updated ON projects(owner_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_owner_status ON jobs(owner_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_models_owner ON models(owner_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_patterns_owner ON patterns(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pattern_drafts_owner ON pattern_drafts(owner_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_templates_owner ON user_templates(owner_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pattern_pipelines_owner ON pattern_pipelines(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_suites_owner ON user_suites(owner_id, updated_at DESC);
  `);

  // 模特身份维度落成真实列：资产库按身份筛选原先用 json_extract(spec_json,'$.gender') 之类，
  // 那是 SQLite 专有写法。这几个维度是稳定枚举，做列比查 JSON 更快也更可移植。
  for (const dimension of ["gender", "age", "heritage", "stature", "build"] as const) {
    addColumnIfMissing(database, "models", dimension, "TEXT");
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_models_identity ON models(gender, age, heritage, stature, build);
  `);

  backfillModelIdentity(database);

  // ---- 存储统计 ----
  // 文件落在 11 处，全部要计入配额；多文件表（layer_exports / print_packs）存总和。
  addColumnIfMissing(database, "assets", "size_bytes", "INTEGER");
  addColumnIfMissing(database, "outputs", "size_bytes", "INTEGER");
  addColumnIfMissing(database, "exports", "size_bytes", "INTEGER");
  addColumnIfMissing(database, "edit_reference_assets", "size_bytes", "INTEGER");
  addColumnIfMissing(database, "patterns", "size_bytes", "INTEGER");
  addColumnIfMissing(database, "draft_media", "size_bytes", "INTEGER");
  addColumnIfMissing(database, "draft_candidates", "size_bytes", "INTEGER");
  addColumnIfMissing(database, "model_portraits", "size_bytes", "INTEGER");
  addColumnIfMissing(database, "models", "size_bytes", "INTEGER");
  addColumnIfMissing(database, "layer_exports", "size_bytes", "INTEGER");
  addColumnIfMissing(database, "print_packs", "size_bytes", "INTEGER");

  seedDefaultPlans(database);
  seedDefaultSettings(database);
  migrateJsonArraysToRows(database);
}

/**
 * 把两个"被查询的 JSON 数组"物化成行表。
 *
 * 保留原 JSON 列不动：它是写入时的快照，回滚与排查都要能看原文。
 * 行表是查询用的投影，写入方在同一次事务里同步维护（见 exportRepository / patternRepository）。
 */
function migrateJsonArraysToRows(database: SqliteDatabase): void {
  database.exec(`
    -- 分层导出的逐层文件：name/kind/storagePath/hash 来自 layer_files_json 的元素。
    CREATE TABLE IF NOT EXISTS layer_export_files (
      id                TEXT PRIMARY KEY,
      layer_export_id   TEXT NOT NULL,
      position          INTEGER NOT NULL,
      name              TEXT NOT NULL,
      kind              TEXT NOT NULL,
      storage_path      TEXT NOT NULL,
      hash              TEXT,
      created_at        TEXT NOT NULL,
      FOREIGN KEY (layer_export_id) REFERENCES layer_exports(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_layer_export_files_export ON layer_export_files(layer_export_id, position);
    CREATE INDEX IF NOT EXISTS idx_layer_export_files_hash ON layer_export_files(hash);

    -- 规格包逐文件：只有 kind='PRINT_FILE' 的条目进资产库，但全部落表以便下载与删除。
    CREATE TABLE IF NOT EXISTS print_pack_files (
      id                TEXT PRIMARY KEY,
      print_pack_id     TEXT NOT NULL,
      position          INTEGER NOT NULL,
      name              TEXT NOT NULL,
      kind              TEXT NOT NULL,
      storage_path      TEXT NOT NULL,
      hash              TEXT,
      created_at        TEXT NOT NULL,
      FOREIGN KEY (print_pack_id) REFERENCES print_packs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_print_pack_files_pack ON print_pack_files(print_pack_id, position);
    CREATE INDEX IF NOT EXISTS idx_print_pack_files_hash ON print_pack_files(hash);
  `);

  // 一次性回填：用设置里的标记守住，避免每次启动都扫两张表。
  if (database.prepare("SELECT 1 FROM app_settings WHERE key='migration.json_arrays_expanded'").get() !== undefined) return;

  const now = new Date().toISOString();
  const backfill = database.transaction(() => {
    expandInto(database, "layer_exports", "layer_files_json", "layer_export_files", "layer_export_id", now);
    expandInto(database, "print_packs", "files_json", "print_pack_files", "print_pack_id", now);
    database.prepare("INSERT INTO app_settings (key,value_json,updated_at) VALUES ('migration.json_arrays_expanded','true',?)").run(now);
  });
  backfill();
}

/** 把某张表的 JSON 数组列展开进目标行表；无法解析的行跳过而不是让迁移失败。 */
function expandInto(
  database: SqliteDatabase,
  sourceTable: string,
  jsonColumn: string,
  targetTable: string,
  foreignKey: string,
  timestamp: string,
): void {
  const rows = database.prepare(`SELECT id, ${jsonColumn} AS payload FROM ${sourceTable} WHERE ${jsonColumn} IS NOT NULL`).all() as Array<{ id: string; payload: string }>;
  const insert = database.prepare(`INSERT INTO ${targetTable} (id,${foreignKey},position,name,kind,storage_path,hash,created_at) VALUES (?,?,?,?,?,?,?,?)`);
  for (const row of rows) {
    let entries: unknown;
    try {
      entries = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry, index) => {
      if (!entry || typeof entry !== "object") return;
      const record = entry as Record<string, unknown>;
      const storagePath = typeof record.storagePath === "string" ? record.storagePath : null;
      if (!storagePath) return;
      insert.run(
        `${row.id}-${index}`,
        row.id,
        index,
        typeof record.name === "string" ? record.name : `layer-${index}`,
        typeof record.kind === "string" ? record.kind : "element",
        storagePath,
        typeof record.hash === "string" ? record.hash : null,
        timestamp,
      );
    });
  }
}

/** 默认套餐。免费计划必须存在，否则新用户没有可用权益。数值是起步值，后台可改。 */
/**
 * 把已有模特的 spec_json 展开进身份列。
 *
 * 在应用层解析而不是用 json_extract：迁移代码也不该新增 SQLite 专有写法，
 * 否则阶段 C 换驱动时这里还得再改一遍。
 */
function backfillModelIdentity(database: SqliteDatabase): void {
  const rows = database.prepare('SELECT id, spec_json FROM models WHERE gender IS NULL').all() as Array<{ id: string; spec_json: string }>;
  if (rows.length === 0) return;
  const update = database.prepare('UPDATE models SET gender=?, age=?, heritage=?, stature=?, build=? WHERE id=?');
  const backfill = database.transaction(() => {
    for (const row of rows) {
      let spec: Record<string, unknown>;
      try {
        spec = JSON.parse(row.spec_json) as Record<string, unknown>;
      } catch {
        continue;
      }
      const pick = (key: string): string | null => (typeof spec[key] === 'string' ? (spec[key] as string) : null);
      update.run(pick('gender'), pick('age'), pick('heritage'), pick('stature'), pick('build'), row.id);
    }
  });
  backfill();
}

function seedDefaultPlans(database: SqliteDatabase): void {
  const now = new Date().toISOString();
  const free = {
    id: "plan-free",
    code: "free",
    name: "免费版",
    description: "试用全部核心能力，有项目数与并发限制。",
    priceCents: 0,
    entitlements: {
      monthly_credits: 0,
      max_projects: 3,
      max_concurrent_jobs: 1,
      max_image_resolution: "2K",
      max_storage_bytes: 5_368_709_120,
      allow_psd_export: false,
      allow_layer_export: true,
      allow_web_research: false,
      allow_suite_forge: false,
      allow_model_library: true,
      allow_pattern_studio: true,
      watermark_exports: false,
    },
  };
  const pro = {
    id: "plan-pro",
    code: "pro",
    name: "专业版",
    description: "解除项目数与并发限制，开放分层导出与联网研究。",
    priceCents: 9900,
    entitlements: {
      monthly_credits: 50_000_000,
      max_projects: -1,
      max_concurrent_jobs: 4,
      max_image_resolution: "4K",
      max_storage_bytes: 107_374_182_400,
      allow_psd_export: true,
      allow_layer_export: true,
      allow_web_research: true,
      allow_suite_forge: true,
      allow_model_library: true,
      allow_pattern_studio: true,
      watermark_exports: false,
    },
  };
  const insertPlan = database.prepare(
    "INSERT INTO plans (id,code,name,description,price_cents,currency,billing_period,active,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
  );
  const insertEntitlement = database.prepare("INSERT INTO plan_entitlements (plan_id,key,value_json) VALUES (?,?,?) ON CONFLICT(plan_id, key) DO NOTHING");
  const seed = database.transaction(() => {
    for (const [index, plan] of [free, pro].entries()) {
      insertPlan.run(plan.id, plan.code, plan.name, plan.description, plan.priceCents, "CNY", plan.priceCents > 0 ? "month" : "none", 1, index, now, now);
      for (const [key, value] of Object.entries(plan.entitlements)) insertEntitlement.run(plan.id, key, JSON.stringify(value));
    }
  });
  seed();
}

/** 默认站点设置。注册默认关闭：公网开放由管理员显式打开。 */
function seedDefaultSettings(database: SqliteDatabase): void {
  const now = new Date().toISOString();
  const insert = database.prepare("INSERT INTO app_settings (key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO NOTHING");
  const seed = database.transaction(() => {
    insert.run("registration_enabled", "false", now);
    insert.run("signup_bonus_microcredits", String(2_000_000), now); // 2 积分试用额度
    insert.run("site_name", JSON.stringify("EcomGen"), now);
    // 免费套餐导出时叠加的水印文案；套餐开关 watermarkExports 打开后才会用到。
    insert.run("export_watermark_text", JSON.stringify("仅供预览"), now);
  });
  seed();
}

/**
 * 补齐存量模特规格里缺失的维度。
 *
 * spec_json 是 JSON blob，契约新增维度后旧行缺键；编译层按契约直接取键
 * （`FACIAL_HAIR.options[spec.facialHair].prompt`），缺键会抛 TypeError 而不是校验错误，
 * 且会同时打崩 Worker 与前端预览。这里在开库时一次性补齐，读路径保持不做兜底分支。
 *
 * 幂等：只有真正缺键的行才会被写回；已对齐的行在内存里过滤掉，不产生写事务。
 */
function backfillModelSpecDimensions(database: SqliteDatabase): void {
  const requiredKeys = Object.keys(MODEL_SPEC_DEFAULTS);
  const rows = database.prepare("SELECT id, spec_json FROM models").all() as Array<{ id: string; spec_json: string }>;
  const pending = rows.flatMap((row) => {
    const spec = JSON.parse(row.spec_json) as Record<string, unknown>;
    return requiredKeys.every((key) => key in spec) ? [] : [{ id: row.id, spec }];
  });
  if (pending.length === 0) return;
  const update = database.prepare("UPDATE models SET spec_json=? WHERE id=?");
  const backfill = database.transaction(() => {
    // 缺失维度取基准值；已有取值原样保留，用户显式选择不会被迁移改写。
    for (const row of pending) update.run(JSON.stringify({ ...MODEL_SPEC_DEFAULTS, ...row.spec }), row.id);
  });
  backfill();
}
