import type { SqliteDatabase } from "../database.js";
import type { Row } from "./internal.js";

/**
 * 管理端只读统计。
 *
 * 单独成一个仓库而不是塞进现有聚合：这些查询是**跨用户**的全表聚合，
 * 与业务查询的访问模式完全不同（管理端偶尔点一次，业务端每请求都跑），
 * 混在一起会让业务仓库的职责变模糊，也容易被人误用到用户路径上。
 *
 * 所有语句都是 COUNT/SUM，不带 ORDER BY 大表扫描；数据量上来后按需加索引即可。
 */

export interface AdminOverview {
  users: { total: number; active: number; disabled: number };
  projects: { total: number; active: number };
  jobs: { total: number; queued: number; running: number; succeeded: number; failed: number; cancelled: number };
  billing: { reserved: number; uncertain: number; settled: number; refunded: number; settledMicrocredits: number };
  credits: { issuedMicrocredits: number; spentMicrocredits: number; toppedUpMicrocredits: number };
  payments: { pending: number; paid: number; creditedMicrocredits: number };
  storage: { patterns: number; models: number; assets: number; outputs: number };
}

export class AdminRepository {
  public constructor(private readonly db: SqliteDatabase) { }

  public overview(): AdminOverview {
    const count = (sql: string, ...params: unknown[]): number => (this.db.prepare(sql).get(...params) as { n: number }).n;
    const sum = (sql: string, ...params: unknown[]): number => (this.db.prepare(sql).get(...params) as { s: number | null }).s ?? 0;

    return {
      users: {
        total: count("SELECT COUNT(*) AS n FROM users"),
        active: count("SELECT COUNT(*) AS n FROM users WHERE status='active'"),
        disabled: count("SELECT COUNT(*) AS n FROM users WHERE status='disabled'"),
      },
      projects: {
        total: count("SELECT COUNT(*) AS n FROM projects"),
        active: count("SELECT COUNT(*) AS n FROM projects WHERE archived_at IS NULL"),
      },
      jobs: {
        total: count("SELECT COUNT(*) AS n FROM jobs"),
        queued: count("SELECT COUNT(*) AS n FROM jobs WHERE status='QUEUED'"),
        running: count("SELECT COUNT(*) AS n FROM jobs WHERE status='RUNNING'"),
        succeeded: count("SELECT COUNT(*) AS n FROM jobs WHERE status='SUCCEEDED'"),
        failed: count("SELECT COUNT(*) AS n FROM jobs WHERE status='FAILED'"),
        cancelled: count("SELECT COUNT(*) AS n FROM jobs WHERE status='CANCELLED'"),
      },
      billing: {
        reserved: count("SELECT COUNT(*) AS n FROM billing_orders WHERE status='reserved'"),
        uncertain: count("SELECT COUNT(*) AS n FROM billing_orders WHERE status='uncertain'"),
        settled: count("SELECT COUNT(*) AS n FROM billing_orders WHERE status='settled'"),
        refunded: count("SELECT COUNT(*) AS n FROM billing_orders WHERE status='refunded'"),
        // 实际确认的收入口径：只算已结算的金额，不含仍挂起的预扣。
        settledMicrocredits: sum("SELECT SUM(settled_microcredits) AS s FROM billing_orders WHERE status='settled'"),
      },
      credits: {
        issuedMicrocredits: sum("SELECT SUM(amount_microcredits) AS s FROM credit_ledger_entries WHERE amount_microcredits > 0"),
        // 取绝对值：流水里扣费是负数，直接求和会得到负数指标，读起来反直觉。
        spentMicrocredits: Math.abs(sum("SELECT SUM(amount_microcredits) AS s FROM credit_ledger_entries WHERE type='job_reserve'")),
        toppedUpMicrocredits: sum("SELECT SUM(amount_microcredits) AS s FROM credit_ledger_entries WHERE type='payment_topup'"),
      },
      payments: {
        pending: count("SELECT COUNT(*) AS n FROM payment_orders WHERE status IN ('created','pending')"),
        paid: count("SELECT COUNT(*) AS n FROM payment_orders WHERE status='paid'"),
        creditedMicrocredits: sum("SELECT SUM(credits_microcredits) AS s FROM payment_orders WHERE credited_at IS NOT NULL"),
      },
      storage: {
        patterns: count("SELECT COUNT(*) AS n FROM patterns"),
        models: count("SELECT COUNT(*) AS n FROM models"),
        assets: count("SELECT COUNT(*) AS n FROM assets"),
        outputs: count("SELECT COUNT(*) AS n FROM outputs"),
      },
    };
  }

  /** 支付对账：已付款但没加积分的订单——钱收了、货没给，是最需要立刻处理的一类。 */
  public paidButNotCredited(limit: number, offset: number): Row[] {
    return this.db.prepare(
      `SELECT * FROM payment_orders WHERE status='paid' AND credited_at IS NULL ORDER BY paid_at ASC LIMIT ? OFFSET ?`,
    ).all(limit, offset) as Row[];
  }

  /** 支付对账：超过有效期仍未付款的订单，应关闭而不是无限挂着。 */
  public expiredUnpaid(now: string, limit: number, offset: number): Row[] {
    return this.db.prepare(
      `SELECT * FROM payment_orders WHERE status IN ('created','pending') AND expires_at <= ? ORDER BY expires_at ASC LIMIT ? OFFSET ?`,
    ).all(now, limit, offset) as Row[];
  }
}
