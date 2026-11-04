import { API_BASE_URL } from "../config/env";
import { toApiError } from "./errors";

/**
 * 普通 JSON 请求。
 *
 * 与 `adminClient` 里的同名逻辑刻意分开：那边是管理端专用，这里的充值接口面向所有登录用户。
 * 等 `/billing/*` 进 OpenAPI 契约后再统一迁移到 openapi-fetch。
 *
 * 所有请求带 `credentials: "include"`：会话是 httpOnly Cookie，前端拿不到 token。
 */
export async function requestJson<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
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

export function queryString(params: Record<string, unknown>): string {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== "" && value !== null);
  if (entries.length === 0) return "";
  return `?${entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join("&")}`;
}
