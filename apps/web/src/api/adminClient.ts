import type { components as SchemaComponents } from "./schema";

type SchemaAdminUser = SchemaComponents["schemas"]["AdminUser"];
type SchemaProviderModelPrice = SchemaComponents["schemas"]["ProviderModelPrice"];
type SchemaPaymentConfig = SchemaComponents["schemas"]["PaymentConfig"];
// 概览直接复用生成类型：结构复杂（六个维度嵌套），手写一份必然漂移。
export type AdminDashboard = SchemaComponents["schemas"]["AdminDashboard"];
import { API_BASE_URL } from "../config/env";
import { toApiError } from "./errors";

/**
 * 管理后台请求层。
 *
 * 为什么不用 `api`（openapi-fetch 生成的类型客户端）：`/admin/*` 还没有进 OpenAPI 契约
 * （契约以 TypeBox 为真相源，新增端点要跑 gen:openapi 与 gen:api 两条生成链）。
 * 这里用普通 fetch + 手写类型，等契约补齐后再迁移。
 *
 * 所有请求带 `credentials: "include"`：会话是 httpOnly Cookie，前端拿不到 token。
 */

async function request<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    credentials: "include",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
    throw toApiError(response.status, parsed);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export type AdminRole = "owner" | "admin" | "support" | "user";
export type AdminUserStatus = "active" | "disabled";

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: AdminRole;
  status: AdminUserStatus;
  emailVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  balanceMicrocredits: number;
}

export interface Page<T> {
  items: T[];
  total?: number;
  limit: number;
  offset: number;
}

export interface CreditEntry {
  id: string;
  userId: string;
  type: string;
  amountMicrocredits: number;
  balanceAfterMicrocredits: number;
  jobId: string | null;
  note: string | null;
  createdAt: string;
}

export interface LedgerPage {
  items: CreditEntry[];
  total: number;
  /** stored 与 computed 不一致就是账目漂移，管理端要能一眼看出来。 */
  balance: { stored: number; computed: number };
  limit: number;
  offset: number;
}

export interface UncertainOrder {
  id: string;
  userId: string;
  jobId: string;
  status: string;
  reservedMicrocredits: number;
  settledMicrocredits: number | null;
  createdAt: string;
  updatedAt: string;
  user: AdminUser | null;
}

export interface PriceRecord {
  id: string;
  providerId: string;
  modelId: string;
  kind: string;
  pricingMode: "fixed_request" | "per_image" | "per_resolution" | "token";
  priceMicrocredits: number;
  costMicrocredits: number;
  tiers: Record<string, number>;
  active: boolean;
}

/** 审计行来自原始数据库行，列名是 snake_case。 */
export interface AuditEvent {
  id: string;
  actor_user_id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  summary: string;
  created_at: string;
}

export interface PaymentConfig {
  provider: string | null;
  /** 密钥不回显，只告诉管理员"已配置"。 */
  hasKey: boolean;
  gateway: string | null;
  pid: string | null;
  payType: string;
  pricePerCreditCents: number;
  publicBaseUrl: string;
}

export interface PaymentConfigInput {
  gateway?: string;
  pid?: string;
  /** 只在轮换密钥时传；不传则保留原值。 */
  key?: string;
  payType?: string;
  pricePerCreditCents?: number;
  publicBaseUrl?: string;
}

export interface MailSettings {
  configured: boolean;
  host: string | null;
  port: number;
  secure: boolean;
  requireStartTls: boolean;
  user: string | null;
  from: string | null;
  fromName: string | null;
  /** 口令永不回显，只表示是否已配置。 */
  hasPass: boolean;
}

export interface MailSettingsInput {
  host?: string;
  port?: number;
  secure?: boolean;
  requireStartTls?: boolean;
  user?: string;
  /** 只在轮换口令时传；不传则保留原值。 */
  pass?: string;
  from?: string;
  fromName?: string;
}

export const adminApi = {

  dashboard: () => request<AdminDashboard>("GET", "/admin/dashboard"),
  listUsers: (params: { keyword?: string; role?: string; status?: string; limit?: number; offset?: number } = {}) =>
    request<Page<AdminUser>>("GET", `/admin/users${query(params)}`),

  patchUser: (userId: string, body: { displayName?: string; role?: AdminRole; status?: AdminUserStatus }) =>
    request<AdminUser>("PATCH", `/admin/users/${userId}`, body),

  adjustCredits: (userId: string, body: { credits: number; note?: string }) =>
    request<{ balanceMicrocredits: number }>("POST", `/admin/users/${userId}/credits`, body),

  ledger: (userId: string, params: { limit?: number; offset?: number } = {}) =>
    request<LedgerPage>("GET", `/admin/users/${userId}/ledger${query(params)}`),

  uncertainOrders: (params: { limit?: number; offset?: number } = {}) =>
    request<Page<UncertainOrder>>("GET", `/admin/billing/uncertain${query(params)}`),

  resolveOrder: (jobId: string, body: { action: "settle" | "refund"; settledMicrocredits?: number; note?: string }) =>
    request<UncertainOrder>("POST", `/admin/billing/${jobId}/resolve`, body),

  /** 开户。未传 password 时服务端生成一次性密码，只在本次响应返回。 */
  createUser: (body: { email: string; displayName?: string; role?: AdminRole; password?: string; credits?: number }) =>
    request<AdminUser & { generatedPassword?: string }>("POST", "/admin/users", body),

  resetPassword: (userId: string, body: { password?: string } = {}) =>
    request<{ revokedSessions: number; generatedPassword?: string }>("POST", `/admin/users/${userId}/password`, body),

  mailSettings: () => request<MailSettings>("GET", "/admin/settings/mail"),

  updateMailSettings: (body: MailSettingsInput) => request<{ ok: boolean; hasPass: boolean }>("PATCH", "/admin/settings/mail", body),

  /** 只做连通性与认证检查，不发信。 */
  testMailSettings: () => request<{ ok: boolean }>("POST", "/admin/settings/mail/test"),

  paymentConfig: () => request<PaymentConfig>("GET", "/admin/payments/config"),

  updatePaymentConfig: (body: PaymentConfigInput) => request<{ ok: boolean; hasKey: boolean }>("PATCH", "/admin/payments/config", body),

  listPrices: () => request<{ items: PriceRecord[] }>("GET", "/admin/prices"),

  upsertPrice: (body: {
    providerId: string;
    modelId: string;
    kind: string;
    pricingMode: string;
    priceMicrocredits: number;
    costMicrocredits: number;
    tiers?: Record<string, number>;
    active?: boolean;
  }) => request<PriceRecord>("POST", "/admin/prices", body),

  deletePrice: (priceId: string) => request<void>("DELETE", `/admin/prices/${priceId}`),

  audit: (params: { limit?: number; offset?: number } = {}) =>
    request<Page<AuditEvent>>("GET", `/admin/audit${query(params)}`),
};

function query(params: Record<string, unknown>): string {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== "" && value !== null);
  if (entries.length === 0) return "";
  return `?${entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join("&")}`;
}

/** 微积分 → 积分展示，保留两位小数。 */
export function formatCredits(microcredits: number | null | undefined): string {
  if (microcredits === null || microcredits === undefined) return "—";
  return (microcredits / 1_000_000).toFixed(2);
}

// ---------------- 契约漂移守卫 ----------------
//
// 这些类型是手写的（`/admin/*` 早期没有契约）。契约现在已经生成到 `schema.d.ts`，
// 但客户端还没迁到 openapi-fetch；在迁移之前，用双向 extends 断言把它们钉住：
// 后端字段改了却没同步这里，`tsc` 会直接报错，而不是等到运行时才发现。
//
// 注意：这里的比较是「结构相等」而非「完全相同」——生成物里多一个可选字段不算漂移。
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

export type _AdminUserInSync = Assert<Equals<AdminUser, SchemaAdminUser>>;
export type _PriceRecordInSync = Assert<Equals<PriceRecord, SchemaProviderModelPrice>>;
export type _PaymentConfigInSync = Assert<Equals<PaymentConfig, SchemaPaymentConfig>>;
