import type { SqliteDatabase } from "../database.js";
import { newId } from "../ids.js";
import { type Row, json, now, parse } from "./internal.js";

export type PaymentOrderStatus = "created" | "pending" | "paid" | "closed" | "failed";
export type PaymentNotificationStatus = "pending" | "processed" | "failed" | "ignored";

export interface PaymentOrderRecord {
  id: string;
  userId: string;
  kind: "credits" | "subscription";
  planId: string | null;
  creditsMicrocredits: number;
  amountCents: number;
  currency: string;
  status: PaymentOrderStatus;
  provider: string;
  /** 下单时的渠道配置快照：改配置不影响已创建订单的验签。 */
  providerConfig: unknown;
  providerOrderNo: string | null;
  providerTradeNo: string | null;
  paidAt: string | null;
  creditedAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 充值订单与支付回调。
 *
 * 幂等由两层保证，缺一不可：
 * 1. `payment_notifications(provider,event_id)` 唯一索引 —— 重复回调在落库时就冲突；
 * 2. `payment_orders.credited_at` 为空才允许加积分 —— 即使两个事件号不同（渠道重复通知），
 *    同一订单也只加一次。
 */
export class PaymentRepository {
  public constructor(private readonly db: SqliteDatabase) { }

  public createOrder(input: Omit<PaymentOrderRecord, "id" | "createdAt" | "updatedAt" | "status" | "paidAt" | "creditedAt" | "providerOrderNo" | "providerTradeNo"> & { status?: PaymentOrderStatus }): PaymentOrderRecord {
    const timestamp = now();
    const record: PaymentOrderRecord = {
      ...input,
      id: newId(),
      status: input.status ?? "created",
      providerOrderNo: null,
      providerTradeNo: null,
      paidAt: null,
      creditedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db.prepare(`INSERT INTO payment_orders
      (id,user_id,kind,plan_id,credits_microcredits,amount_cents,currency,status,provider,provider_config_json,
       provider_order_no,provider_trade_no,paid_at,credited_at,expires_at,created_at,updated_at)
      VALUES (@id,@userId,@kind,@planId,@creditsMicrocredits,@amountCents,@currency,@status,@provider,@providerConfig,
       @providerOrderNo,@providerTradeNo,@paidAt,@creditedAt,@expiresAt,@createdAt,@updatedAt)`)
      .run({ ...record, providerConfig: json(record.providerConfig) });
    return record;
  }

  public getOrder(id: string): PaymentOrderRecord | undefined {
    const row = this.db.prepare("SELECT * FROM payment_orders WHERE id=?").get(id);
    return row ? mapOrder(row as Row) : undefined;
  }

  public getOrderByProviderNo(provider: string, providerOrderNo: string): PaymentOrderRecord | undefined {
    const row = this.db.prepare("SELECT * FROM payment_orders WHERE provider=? AND provider_order_no=?").get(provider, providerOrderNo);
    return row ? mapOrder(row as Row) : undefined;
  }

  public updateOrder(id: string, patch: Partial<Pick<PaymentOrderRecord, "status" | "providerOrderNo" | "providerTradeNo" | "paidAt" | "creditedAt">>): PaymentOrderRecord | undefined {
    const existing = this.getOrder(id);
    if (!existing) return undefined;
    const next: PaymentOrderRecord = { ...existing, ...patch, updatedAt: now() };
    this.db.prepare(`UPDATE payment_orders SET status=@status, provider_order_no=@providerOrderNo, provider_trade_no=@providerTradeNo,
      paid_at=@paidAt, credited_at=@creditedAt, updated_at=@updatedAt WHERE id=@id`).run(next);
    return next;
  }

  public listByUser(userId: string, limit: number, offset: number): PaymentOrderRecord[] {
    return (this.db.prepare("SELECT * FROM payment_orders WHERE user_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(userId, limit, offset) as Row[]).map(mapOrder);
  }

  public listOrders(limit: number, offset: number, status?: string): PaymentOrderRecord[] {
    return status
      ? (this.db.prepare("SELECT * FROM payment_orders WHERE status=? ORDER BY created_at DESC LIMIT ? OFFSET ?").all(status, limit, offset) as Row[]).map(mapOrder)
      : (this.db.prepare("SELECT * FROM payment_orders ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset) as Row[]).map(mapOrder);
  }

  /**
   * 落一条回调。重复事件返回 `{ duplicate: true }` 而不是抛错——
   * 渠道重投是正常行为，调用方应回 204 而不是 500。
   */
  public recordNotification(input: { provider: string; eventId: string; payload: unknown }): { duplicate: boolean; id: string } {
    const id = newId();
    const result = this.db.prepare(`INSERT INTO payment_notifications
      (id,provider,event_id,payload_json,status,error_json,created_at,processed_at) VALUES (?,?,?,?,'pending',NULL,?,NULL)
      ON CONFLICT(provider, event_id) DO NOTHING`)
      .run(id, input.provider, input.eventId, json(input.payload), now());
    if (result.changes === 0) {
      const existing = this.db.prepare("SELECT id FROM payment_notifications WHERE provider=? AND event_id=?").get(input.provider, input.eventId) as { id: string };
      return { duplicate: true, id: existing.id };
    }
    return { duplicate: false, id };
  }

  public markNotification(id: string, status: PaymentNotificationStatus, error?: unknown): void {
    this.db.prepare("UPDATE payment_notifications SET status=?, error_json=?, processed_at=? WHERE id=?")
      .run(status, error === undefined ? null : json(error), now(), id);
  }

  public listNotifications(limit: number, offset: number): Row[] {
    return this.db.prepare("SELECT * FROM payment_notifications ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset) as Row[];
  }

  /**
   * 加积分并置 credited_at。整个动作在一个事务里，且以 `credited_at IS NULL` 为条件，
   * 因此同一订单无论收到多少次通知都只加一次。
   */
  public creditOrderOnce(orderId: string, credit: (order: PaymentOrderRecord) => void): { credited: boolean; order?: PaymentOrderRecord } {
    const run = this.db.transaction(() => {
      const order = this.getOrder(orderId);
      if (!order || order.creditedAt !== null) return { credited: false, order };
      credit(order);
      this.db.prepare("UPDATE payment_orders SET credited_at=?, updated_at=? WHERE id=? AND credited_at IS NULL").run(now(), now(), orderId);
      return { credited: true, order: this.getOrder(orderId) };
    });
    return run();
  }
}

function mapOrder(row: Row): PaymentOrderRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    kind: row.kind as PaymentOrderRecord["kind"],
    planId: row.plan_id === null ? null : String(row.plan_id),
    creditsMicrocredits: Number(row.credits_microcredits),
    amountCents: Number(row.amount_cents),
    currency: String(row.currency),
    status: row.status as PaymentOrderStatus,
    provider: String(row.provider),
    providerConfig: parse<unknown>(row.provider_config_json),
    providerOrderNo: row.provider_order_no === null ? null : String(row.provider_order_no),
    providerTradeNo: row.provider_trade_no === null ? null : String(row.provider_trade_no),
    paidAt: row.paid_at === null ? null : String(row.paid_at),
    creditedAt: row.credited_at === null ? null : String(row.credited_at),
    expiresAt: String(row.expires_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
