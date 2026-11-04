import type { SqliteDatabase } from "../database.js";
import { newId } from "../ids.js";
import { type Row, now } from "./internal.js";

/**
 * 积分单位：微积分（microcredits）。1 积分 = 1_000_000 微积分。
 * 全链路整数运算，禁止浮点——一分钱的误差在批量出图里会放大成账目对不上。
 */
export const MICROCREDITS_PER_CREDIT = 1_000_000;

export type CreditLedgerType =
  | "signup_bonus"
  | "plan_grant"
  | "payment_topup"
  | "job_reserve"
  | "job_settle"
  | "job_refund"
  | "admin_grant"
  | "admin_adjust";

export interface CreditEntryInput {
  userId: string;
  type: CreditLedgerType;
  /** 带符号：发放为正，扣费为负。 */
  amountMicrocredits: number;
  jobId?: string | null;
  projectId?: string | null;
  billingOrderId?: string | null;
  paymentOrderId?: string | null;
  note?: string | null;
}

export interface CreditEntryRecord extends CreditEntryInput {
  id: string;
  balanceAfterMicrocredits: number;
  createdAt: string;
}

/**
 * 积分账户与不可变流水。
 *
 * 余额是 `credit_ledger_entries` 的聚合缓存，两者必须在同一事务内更新。
 * 流水只允许 INSERT：写错了用反向流水冲正（`admin_adjust`），不允许 UPDATE/DELETE 历史——
 * 否则任何一次"改一下数字"都会让历史对账失去意义。
 */
export class CreditRepository {
  public constructor(private readonly db: SqliteDatabase) { }

  public getBalance(userId: string): number {
    const row = this.db.prepare("SELECT balance_microcredits FROM credit_accounts WHERE user_id=?").get(userId) as { balance_microcredits: number } | undefined;
    return row?.balance_microcredits ?? 0;
  }

  /** 建账户行。余额为 0 时也要有行，否则后续 UPDATE 会影响 0 行而静默丢失写入。 */
  public ensureAccount(userId: string): void {
    this.db.prepare("INSERT INTO credit_accounts (user_id,balance_microcredits,updated_at) VALUES (?,0,?) ON CONFLICT(user_id) DO NOTHING").run(userId, now());
  }

  /**
   * 写一条流水并同步余额。
   *
   * `allowNegative=false` 时余额不足直接返回 `{ ok: false }`，不做部分扣减——
   * 扣费失败必须整体放弃，不能出现"扣了一半"的中间态。
   */
  public applyEntry(input: CreditEntryInput, options: { allowNegative?: boolean } = {}): { ok: true; entry: CreditEntryRecord } | { ok: false; balanceMicrocredits: number } {
    const allowNegative = options.allowNegative ?? false;
    const apply = this.db.transaction(() => {
      this.ensureAccount(input.userId);
      const current = this.getBalance(input.userId);
      const balanceAfter = current + input.amountMicrocredits;
      if (!allowNegative && balanceAfter < 0) return { ok: false as const, balanceMicrocredits: current };
      this.db.prepare("UPDATE credit_accounts SET balance_microcredits=?, updated_at=? WHERE user_id=?").run(balanceAfter, now(), input.userId);
      const entry: CreditEntryRecord = {
        id: newId(),
        userId: input.userId,
        type: input.type,
        amountMicrocredits: input.amountMicrocredits,
        balanceAfterMicrocredits: balanceAfter,
        jobId: input.jobId ?? null,
        projectId: input.projectId ?? null,
        billingOrderId: input.billingOrderId ?? null,
        paymentOrderId: input.paymentOrderId ?? null,
        note: input.note ?? null,
        createdAt: now(),
      };
      this.db.prepare(`INSERT INTO credit_ledger_entries
        (id,user_id,type,amount_microcredits,balance_after_microcredits,job_id,project_id,billing_order_id,payment_order_id,note,created_at)
        VALUES (@id,@userId,@type,@amountMicrocredits,@balanceAfterMicrocredits,@jobId,@projectId,@billingOrderId,@paymentOrderId,@note,@createdAt)`).run(entry);
      return { ok: true as const, entry };
    });
    return apply();
  }

  public listLedger(userId: string, limit: number, offset: number): CreditEntryRecord[] {
    // 次序兜底用 id：主键是 UUIDv7（时间有序），同一毫秒内也严格递增，因此 ORDER BY id 就是插入序。
    // 账本必须按实际发生顺序回放，否则 balance_after 序列看起来像错账。
    return (this.db.prepare("SELECT * FROM credit_ledger_entries WHERE user_id=? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?")
      .all(userId, limit, offset) as Row[]).map(mapEntry);
  }

  public countLedger(userId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM credit_ledger_entries WHERE user_id=?").get(userId) as { n: number }).n;
  }

  /**
   * 用流水重算余额，用于修复漂移（外部改库、异常中断、历史迁移）。
   * 只返回差异，不直接写；调用方决定是否落库，避免"看一眼"就产生写事务。
   */
  public recomputeBalance(userId: string): { stored: number; computed: number } {
    const row = this.db.prepare("SELECT COALESCE(SUM(amount_microcredits),0) AS total FROM credit_ledger_entries WHERE user_id=?").get(userId) as { total: number };
    return { stored: this.getBalance(userId), computed: row.total };
  }

  public setBalance(userId: string, balanceMicrocredits: number): void {
    this.ensureAccount(userId);
    this.db.prepare("UPDATE credit_accounts SET balance_microcredits=?, updated_at=? WHERE user_id=?").run(balanceMicrocredits, now(), userId);
  }
}

function mapEntry(row: Row): CreditEntryRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    type: row.type as CreditLedgerType,
    amountMicrocredits: Number(row.amount_microcredits),
    balanceAfterMicrocredits: Number(row.balance_after_microcredits),
    jobId: row.job_id === null ? null : String(row.job_id),
    projectId: row.project_id === null ? null : String(row.project_id),
    billingOrderId: row.billing_order_id === null ? null : String(row.billing_order_id),
    paymentOrderId: row.payment_order_id === null ? null : String(row.payment_order_id),
    note: row.note === null ? null : String(row.note),
    createdAt: String(row.created_at),
  };
}
