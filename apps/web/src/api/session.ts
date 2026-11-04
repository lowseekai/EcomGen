import type { components as SchemaComponents } from "./schema";

type SchemaSessionUser = SchemaComponents["schemas"]["SessionUser"];
type SchemaEntitlements = SchemaComponents["schemas"]["Entitlements"];

import { API_BASE_URL } from "../config/env";
import { toApiError } from "./errors";

/**
 * 会话相关接口。
 *
 * 这些端点已并入 OpenAPI 契约（`packages/contracts/src/auth-schemas.ts`），
 * 但客户端仍是手写 fetch。在迁到 openapi-fetch 之前，文件末尾用类型断言把它们钉住：
 * 契约里改了字段而这里没跟上，`tsc` 会直接报错。
 *
 * 会话走 httpOnly Cookie，响应体里不含 token。
 */
export type UserRole = "owner" | "admin" | "support" | "user";
export type UserStatus = "active" | "disabled";

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
}

export interface Entitlements {
  monthlyCredits: number;
  maxProjects: number;
  maxConcurrentJobs: number;
  maxImageResolution: "1K" | "2K" | "4K";
  maxStorageBytes: number;
  allowPsdExport: boolean;
  allowLayerExport: boolean;
  allowWebResearch: boolean;
  allowSuiteForge: boolean;
  allowModelLibrary: boolean;
  allowPatternStudio: boolean;
  watermarkExports: boolean;
}

export interface SessionPayload {
  user: SessionUser | null;
  planCode?: string;
  entitlements?: Entitlements;
  balanceMicrocredits?: number;
  usedStorageBytes?: number;
}

/**
 * 统一请求封装。
 *
 * `credentials: "include"` 是必需的：会话走 httpOnly Cookie，同源时默认就会带，
 * 但前后端分开部署（VITE_API_BASE_URL 指向别的域）时必须显式声明，
 * 否则浏览器不会附带凭证，表现为「登录成功但刷新就掉线」。
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    credentials: "include",
    headers: init.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.clone().json();
    } catch {
      body = undefined;
    }
    throw toApiError(response.status, body);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function fetchSession(): Promise<SessionPayload> {
  return request<SessionPayload>("/auth/me");
}

export function login(input: { email: string; password: string }): Promise<SessionPayload> {
  return request<SessionPayload>("/auth/login", { method: "POST", body: JSON.stringify(input) });
}

export function register(input: { email: string; password: string; displayName?: string }): Promise<SessionPayload> {
  return request<SessionPayload>("/auth/register", { method: "POST", body: JSON.stringify(input) });
}

export function logout(): Promise<void> {
  return request<void>("/auth/logout", { method: "POST" });
}

export function changePassword(input: { currentPassword: string; newPassword: string }): Promise<void> {
  return request<void>("/auth/password", { method: "POST", body: JSON.stringify(input) });
}

export function requestPasswordReset(email: string): Promise<{ accepted: boolean }> {
  return request<{ accepted: boolean }>("/auth/password-reset/request", { method: "POST", body: JSON.stringify({ email }) });
}

export function confirmPasswordReset(input: { token: string; password: string }): Promise<void> {
  return request<void>("/auth/password-reset/confirm", { method: "POST", body: JSON.stringify(input) });
}

/** 微积分 → 积分展示：1 积分 = 1_000_000 微积分，保留两位小数。 */
export function formatCredits(microcredits: number | undefined): string {
  if (microcredits === undefined) return "—";
  return (microcredits / 1_000_000).toFixed(2);
}

/** 字节 → 人类可读；-1 表示不限。 */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "—";
  if (bytes < 0) return "不限";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

// ---------------- 契约漂移守卫 ----------------
//
// 与 `adminClient.ts` 同一套做法：双向 extends 断言手写类型与生成类型结构相等。
// 生成物里多一个可选字段不算漂移，所以用 Equals 而不是单纯 extends。
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

export type _SessionUserInSync = Assert<Equals<SessionUser, SchemaSessionUser>>;
export type _EntitlementsInSync = Assert<Equals<Entitlements, SchemaEntitlements>>;
