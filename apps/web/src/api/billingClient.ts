import { queryString, requestJson } from "./restClient";

/**
 * 充值请求层。
 *
 * 金额一律是整数「分」，积分一律是「积分」（不是微积分）——服务端已经换算过，
 * 前端不要再自己乘除，否则两处口径会漂移。
 */

export type PaymentOrderStatus = "created" | "pending" | "paid" | "closed" | "failed";

export interface PaymentOrder {
  id: string;
  kind: string;
  credits: number;
  amountCents: number;
  currency: string;
  status: PaymentOrderStatus;
  provider: string;
  tradeNo: string | null;
  paidAt: string | null;
  creditedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface OrderPage {
  items: PaymentOrder[];
  /** 1 积分 = 多少分钱；前端展示价格用它与服务端保持一致。 */
  pricePerCreditCents: number;
  limit: number;
  offset: number;
}

export const billingApi = {
  listOrders: (params: { limit?: number; offset?: number } = {}) =>
    requestJson<OrderPage>("GET", `/billing/orders${queryString(params)}`),

  createTopup: (credits: number) =>
    requestJson<{ order: PaymentOrder; checkoutUrl: string }>("POST", "/billing/topup-orders", { credits }),

  getOrder: (orderId: string) => requestJson<PaymentOrder>("GET", `/billing/orders/${orderId}`),
};

/** 分 → 元，仅用于展示。 */
export function formatYuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

export const ORDER_STATUS_LABEL: Record<PaymentOrderStatus, string> = {
  created: "待支付",
  pending: "待支付",
  paid: "已支付",
  closed: "已关闭",
  failed: "失败",
};
