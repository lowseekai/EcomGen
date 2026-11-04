import type { SqliteDatabase } from "../database.js";
import { newId } from "../ids.js";
import { type Row, json, now, parse } from "./internal.js";
import type { UserRecord } from "./userRepository.js";

export type ImageResolutionCap = "1K" | "2K" | "4K";
export type SubscriptionStatus = "active" | "past_due" | "canceled" | "expired";

export interface PlanRecord {
  id: string;
  code: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  billingPeriod: "none" | "month" | "year";
  active: boolean;
  sortOrder: number;
  entitlements: Partial<Entitlements>;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionRecord {
  id: string;
  userId: string;
  planId: string;
  status: SubscriptionStatus;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * 套餐权益。全部对应产品里已有的能力，不是抽象出来的通用字段——
 * 新增权益时先问"它在哪个接口上生效"，找不到落点的权益不该存在。
 */
export interface Entitlements {
  monthlyCredits: number;
  /** -1 表示不限。 */
  maxProjects: number;
  maxConcurrentJobs: number;
  maxImageResolution: ImageResolutionCap;
  /** -1 表示不限。 */
  maxStorageBytes: number;
  allowPsdExport: boolean;
  allowLayerExport: boolean;
  allowWebResearch: boolean;
  allowSuiteForge: boolean;
  allowModelLibrary: boolean;
  allowPatternStudio: boolean;
  watermarkExports: boolean;
}

/** 权益键名与 Entitlements 字段的映射；存库用 snake_case，代码用 camelCase。 */
const ENTITLEMENT_KEYS: Record<keyof Entitlements, string> = {
  monthlyCredits: "monthly_credits",
  maxProjects: "max_projects",
  maxConcurrentJobs: "max_concurrent_jobs",
  maxImageResolution: "max_image_resolution",
  maxStorageBytes: "max_storage_bytes",
  allowPsdExport: "allow_psd_export",
  allowLayerExport: "allow_layer_export",
  allowWebResearch: "allow_web_research",
  allowSuiteForge: "allow_suite_forge",
  allowModelLibrary: "allow_model_library",
  allowPatternStudio: "allow_pattern_studio",
  watermarkExports: "watermark_exports",
};

/** 无套餐时的兜底：比免费版更保守，避免"没有计划"变成"无限额度"。 */
export const FALLBACK_ENTITLEMENTS: Entitlements = {
  monthlyCredits: 0,
  maxProjects: 1,
  maxConcurrentJobs: 1,
  maxImageResolution: "1K",
  maxStorageBytes: 1_073_741_824,
  allowPsdExport: false,
  allowLayerExport: false,
  allowWebResearch: false,
  allowSuiteForge: false,
  allowModelLibrary: false,
  allowPatternStudio: false,
  watermarkExports: true,
};

/** 管理员与站长不受套餐限制：否则运维自己会被免费版卡住，无法排查问题。 */
export const UNLIMITED_ENTITLEMENTS: Entitlements = {
  monthlyCredits: Number.MAX_SAFE_INTEGER,
  maxProjects: -1,
  maxConcurrentJobs: 16,
  maxImageResolution: "4K",
  maxStorageBytes: -1,
  allowPsdExport: true,
  allowLayerExport: true,
  allowWebResearch: true,
  allowSuiteForge: true,
  allowModelLibrary: true,
  allowPatternStudio: true,
  watermarkExports: false,
};

export class PlanRepository {
  public constructor(private readonly db: SqliteDatabase) { }

  // ---- 套餐 ----

  public listPlans(includeInactive = false): PlanRecord[] {
    const sql = includeInactive
      ? "SELECT * FROM plans ORDER BY sort_order, code"
      : "SELECT * FROM plans WHERE active=1 ORDER BY sort_order, code";
    return (this.db.prepare(sql).all() as Row[]).map((row) => this.mapPlan(row));
  }

  public getPlan(id: string): PlanRecord | undefined {
    const row = this.db.prepare("SELECT * FROM plans WHERE id=?").get(id);
    return row ? this.mapPlan(row as Row) : undefined;
  }

  public getPlanByCode(code: string): PlanRecord | undefined {
    const row = this.db.prepare("SELECT * FROM plans WHERE code=?").get(code);
    return row ? this.mapPlan(row as Row) : undefined;
  }

  public upsertPlan(input: Omit<PlanRecord, "createdAt" | "updatedAt"> & { id?: string }): PlanRecord {
    const existing = input.id ? this.getPlan(input.id) : undefined;
    const timestamp = now();
    const record: PlanRecord = {
      ...input,
      id: input.id ?? newId(),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    const write = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO plans (id,code,name,description,price_cents,currency,billing_period,active,sort_order,created_at,updated_at)
        VALUES (@id,@code,@name,@description,@priceCents,@currency,@billingPeriod,@active,@sortOrder,@createdAt,@updatedAt)
        ON CONFLICT(id) DO UPDATE SET code=excluded.code, name=excluded.name, description=excluded.description,
          price_cents=excluded.price_cents, currency=excluded.currency, billing_period=excluded.billing_period,
          active=excluded.active, sort_order=excluded.sort_order, updated_at=excluded.updated_at`)
        .run({ ...record, active: record.active ? 1 : 0 });
      for (const [field, value] of Object.entries(record.entitlements)) {
        const key = ENTITLEMENT_KEYS[field as keyof Entitlements];
        if (!key) continue;
        this.db.prepare("INSERT INTO plan_entitlements (plan_id,key,value_json) VALUES (?,?,?) ON CONFLICT(plan_id, key) DO UPDATE SET value_json=excluded.value_json").run(record.id, key, json(value));
      }
    });
    write();
    return record;
  }

  // ---- 订阅 ----

  public getActiveSubscription(userId: string): SubscriptionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM subscriptions WHERE user_id=? AND status='active'").get(userId);
    return row ? mapSubscription(row as Row) : undefined;
  }

  public listSubscriptions(limit: number, offset: number): SubscriptionRecord[] {
    return (this.db.prepare("SELECT * FROM subscriptions ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset) as Row[]).map(mapSubscription);
  }

  /** 开通订阅：先撤下同用户的其它 active 订阅，否则部分唯一索引会直接冲突。 */
  public activateSubscription(input: { userId: string; planId: string; periodStart: string; periodEnd: string }): SubscriptionRecord {
    const record: SubscriptionRecord = {
      id: newId(),
      userId: input.userId,
      planId: input.planId,
      status: "active",
      currentPeriodStart: input.periodStart,
      currentPeriodEnd: input.periodEnd,
      cancelAtPeriodEnd: false,
      createdAt: now(),
      updatedAt: now(),
    };
    const write = this.db.transaction(() => {
      this.db.prepare("UPDATE subscriptions SET status='canceled', updated_at=? WHERE user_id=? AND status='active'").run(now(), input.userId);
      this.db.prepare(`INSERT INTO subscriptions (id,user_id,plan_id,status,current_period_start,current_period_end,cancel_at_period_end,created_at,updated_at)
        VALUES (@id,@userId,@planId,@status,@currentPeriodStart,@currentPeriodEnd,@cancelAtPeriodEnd,@createdAt,@updatedAt)`)
        .run({ ...record, cancelAtPeriodEnd: 0 });
    });
    write();
    return record;
  }

  public updateSubscription(id: string, patch: Partial<Pick<SubscriptionRecord, "status" | "currentPeriodStart" | "currentPeriodEnd" | "cancelAtPeriodEnd">>): SubscriptionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM subscriptions WHERE id=?").get(id);
    if (!row) return undefined;
    const next: SubscriptionRecord = { ...mapSubscription(row as Row), ...patch, updatedAt: now() };
    this.db.prepare(`UPDATE subscriptions SET status=@status, current_period_start=@currentPeriodStart,
      current_period_end=@currentPeriodEnd, cancel_at_period_end=@cancelAtPeriodEnd, updated_at=@updatedAt WHERE id=@id`)
      .run({ ...next, cancelAtPeriodEnd: next.cancelAtPeriodEnd ? 1 : 0 });
    return next;
  }

  // ---- 权益解析 ----

  /**
   * 解析用户的生效权益。
   *
   * 解析顺序：管理员/站长 -> 无限；有 active 订阅 -> 该套餐；否则 -> 免费套餐；都没有 -> 兜底。
   * 只读一次套餐表，调用方可以放心在每个请求里调用。
   */
  public resolveEntitlements(user: Pick<UserRecord, "id" | "role">): { entitlements: Entitlements; planCode: string } {
    if (user.role === "owner" || user.role === "admin") {
      return { entitlements: UNLIMITED_ENTITLEMENTS, planCode: "unlimited" };
    }
    const subscription = this.getActiveSubscription(user.id);
    if (subscription) {
      const plan = this.getPlan(subscription.planId);
      if (plan) return { entitlements: mergeEntitlements(plan.entitlements), planCode: plan.code };
    }
    const free = this.getPlanByCode("free");
    if (free) return { entitlements: mergeEntitlements(free.entitlements), planCode: free.code };
    return { entitlements: FALLBACK_ENTITLEMENTS, planCode: "none" };
  }

  private mapPlan(row: Row): PlanRecord {
    const entitlements = this.db.prepare("SELECT key, value_json FROM plan_entitlements WHERE plan_id=?").all(String(row.id)) as Array<{ key: string; value_json: string }>;
    const byKey = new Map(entitlements.map((entry) => [entry.key, parse<unknown>(entry.value_json)]));
    const resolved: Partial<Entitlements> = {};
    for (const [field, key] of Object.entries(ENTITLEMENT_KEYS)) {
      if (!byKey.has(key)) continue;
      (resolved as Record<string, unknown>)[field] = byKey.get(key);
    }
    return {
      id: String(row.id),
      code: String(row.code),
      name: String(row.name),
      description: String(row.description),
      priceCents: Number(row.price_cents),
      currency: String(row.currency),
      billingPeriod: row.billing_period as PlanRecord["billingPeriod"],
      active: Number(row.active) === 1,
      sortOrder: Number(row.sort_order),
      entitlements: resolved,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}

/** 缺失的键回落兜底值：新增权益时老套餐行没有该键，不能让读取方拿到 undefined。 */
export function mergeEntitlements(partial: Partial<Entitlements>): Entitlements {
  return { ...FALLBACK_ENTITLEMENTS, ...stripUndefined(partial) };
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function mapSubscription(row: Row): SubscriptionRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    planId: String(row.plan_id),
    status: row.status as SubscriptionStatus,
    currentPeriodStart: String(row.current_period_start),
    currentPeriodEnd: String(row.current_period_end),
    cancelAtPeriodEnd: Number(row.cancel_at_period_end) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
