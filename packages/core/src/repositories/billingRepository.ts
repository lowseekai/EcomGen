import type { SqliteDatabase } from "../database.js";
import { newId } from "../ids.js";
import { type Row, json, now, parse } from "./internal.js";

/**
 * 计费单状态机：
 *   reserved  -> settled   实际用量确定，差额已通过 job_settle 找平
 *   reserved  -> refunded  明确失败且未发出外部请求，全额退回
 *   reserved  -> uncertain 外部请求已发出但结果未知，不自动退款，等人工核对
 *
 * `uncertain` 不能省。Provider 侧可能已经计费，自动退款等于平台白贴成本；
 * 这条分支对应 Worker 里已有的 EXTERNAL_REQUEST_STARTED 标记。
 */
export type BillingStatus = "reserved" | "settled" | "refunded" | "uncertain";

export type PricingMode = "fixed_request" | "per_image" | "per_resolution" | "token";

export interface BillingOrderRecord {
  id: string;
  userId: string;
  jobId: string;
  status: BillingStatus;
  reservedMicrocredits: number;
  settledMicrocredits: number | null;
  costSnapshot: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderModelPriceRecord {
  id: string;
  providerId: string;
  modelId: string;
  kind: string;
  pricingMode: PricingMode;
  priceMicrocredits: number;
  /** 平台成本，仅后台可见；与售价分开记录才能算毛利、发现定价倒挂。 */
  costMicrocredits: number;
  tiers: Record<string, number>;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export class BillingRepository {
  public constructor(private readonly db: SqliteDatabase) { }

  // ---- 计费单 ----

  /** 一个任务只能有一条计费单（job_id 唯一），重复预扣会直接冲突而不是叠加扣费。 */
  public createReservation(input: { userId: string; jobId: string; reservedMicrocredits: number; costSnapshot: unknown }): BillingOrderRecord {
    const timestamp = now();
    const record: BillingOrderRecord = {
      id: newId(),
      userId: input.userId,
      jobId: input.jobId,
      status: "reserved",
      reservedMicrocredits: input.reservedMicrocredits,
      settledMicrocredits: null,
      costSnapshot: input.costSnapshot,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db.prepare(`INSERT INTO billing_orders (id,user_id,job_id,status,reserved_microcredits,settled_microcredits,cost_snapshot_json,created_at,updated_at)
      VALUES (@id,@userId,@jobId,@status,@reservedMicrocredits,@settledMicrocredits,@costSnapshot,@createdAt,@updatedAt)`)
      .run({ ...record, costSnapshot: json(record.costSnapshot) });
    return record;
  }

  public getByJobId(jobId: string): BillingOrderRecord | undefined {
    const row = this.db.prepare("SELECT * FROM billing_orders WHERE job_id=?").get(jobId);
    return row ? mapBilling(row as Row) : undefined;
  }

  public getBillingOrder(id: string): BillingOrderRecord | undefined {
    const row = this.db.prepare("SELECT * FROM billing_orders WHERE id=?").get(id);
    return row ? mapBilling(row as Row) : undefined;
  }

  /**
   * 状态转移。默认只允许从 reserved 出发；`from` 用于人工裁决 uncertain 单。
   *
   * 守卫写在 SQL 的 WHERE 里而不是先读后写：并发下先读后写会两边都通过检查。
   */
  public transition(id: string, status: Exclude<BillingStatus, "reserved">, settledMicrocredits?: number, from: BillingStatus = "reserved"): BillingOrderRecord | undefined {
    this.db.prepare(`UPDATE billing_orders SET status=?, settled_microcredits=COALESCE(?, settled_microcredits), updated_at=?
      WHERE id=? AND status=?`).run(status, settledMicrocredits ?? null, now(), id, from);
    return this.getBillingOrder(id);
  }

  public listByUser(userId: string, limit: number, offset: number): BillingOrderRecord[] {
    return (this.db.prepare("SELECT * FROM billing_orders WHERE user_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(userId, limit, offset) as Row[]).map(mapBilling);
  }

  /**
   * 僵尸预扣：订单仍是 reserved，但对应任务已经是终态、或者任务行已经不在了。
   *
   * 正常路径不会产生这种数据——任务结束时 Worker 一定会结算。出现即意味着
   * 进程在结算前被杀，钱被占着但没人会再来释放。
   */
  public listStaleReservations(): BillingOrderRecord[] {
    return (this.db.prepare(`
      SELECT o.* FROM billing_orders o
      LEFT JOIN jobs j ON j.id = o.job_id
      WHERE o.status='reserved'
        AND (j.id IS NULL OR j.status IN ('SUCCEEDED','FAILED','CANCELLED'))
    `).all() as Row[]).map((row) => mapBilling(row));
  }

  public listUncertain(limit: number, offset: number): BillingOrderRecord[] {
    return (this.db.prepare("SELECT * FROM billing_orders WHERE status='uncertain' ORDER BY updated_at DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as Row[]).map(mapBilling);
  }

  // ---- 价目 ----

  public getPrice(providerId: string, modelId: string, kind: string): ProviderModelPriceRecord | undefined {
    const row = this.db.prepare("SELECT * FROM provider_model_prices WHERE provider_id=? AND model_id=? AND kind=? AND active=1")
      .get(providerId, modelId, kind);
    return row ? mapPrice(row as Row) : undefined;
  }

  public listPrices(): ProviderModelPriceRecord[] {
    return (this.db.prepare("SELECT * FROM provider_model_prices ORDER BY provider_id, model_id, kind").all() as Row[]).map(mapPrice);
  }

  public upsertPrice(input: Omit<ProviderModelPriceRecord, "id" | "createdAt" | "updatedAt"> & { id?: string }): ProviderModelPriceRecord {
    const existing = input.id
      ? (this.db.prepare("SELECT * FROM provider_model_prices WHERE id=?").get(input.id) as Row | undefined)
      : undefined;
    const timestamp = now();
    const record: ProviderModelPriceRecord = {
      ...input,
      id: input.id ?? newId(),
      createdAt: existing ? String(existing.created_at) : timestamp,
      updatedAt: timestamp,
    };
    this.db.prepare(`INSERT INTO provider_model_prices (id,provider_id,model_id,kind,pricing_mode,price_microcredits,cost_microcredits,tiers_json,active,created_at,updated_at)
      VALUES (@id,@providerId,@modelId,@kind,@pricingMode,@priceMicrocredits,@costMicrocredits,@tiers,@active,@createdAt,@updatedAt)
      ON CONFLICT(provider_id, model_id, kind) DO UPDATE SET pricing_mode=excluded.pricing_mode,
        price_microcredits=excluded.price_microcredits, cost_microcredits=excluded.cost_microcredits,
        tiers_json=excluded.tiers_json, active=excluded.active, updated_at=excluded.updated_at`)
      .run({ ...record, tiers: json(record.tiers), active: record.active ? 1 : 0 });
    return record;
  }

  public deletePrice(id: string): boolean {
    return this.db.prepare("DELETE FROM provider_model_prices WHERE id=?").run(id).changes > 0;
  }
}

function mapBilling(row: Row): BillingOrderRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    jobId: String(row.job_id),
    status: row.status as BillingStatus,
    reservedMicrocredits: Number(row.reserved_microcredits),
    settledMicrocredits: row.settled_microcredits === null ? null : Number(row.settled_microcredits),
    costSnapshot: parse<unknown>(row.cost_snapshot_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapPrice(row: Row): ProviderModelPriceRecord {
  return {
    id: String(row.id),
    providerId: String(row.provider_id),
    modelId: String(row.model_id),
    kind: String(row.kind),
    pricingMode: row.pricing_mode as PricingMode,
    priceMicrocredits: Number(row.price_microcredits),
    costMicrocredits: Number(row.cost_microcredits),
    tiers: parse<Record<string, number>>(row.tiers_json),
    active: Number(row.active) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
