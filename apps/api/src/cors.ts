/**
 * ECOMGEN_CORS_ORIGINS 的解析。
 *
 * 逗号分隔的来源白名单。显式配错（例如 `a,,b`）要在启动时报错，
 * 但空串必须按"未配置"处理——Compose 里 `${ECOMGEN_CORS_ORIGINS:-}` 在未设置时就是空串，
 * 若把它当成"显式配置了一个空来源"，容器会启动即崩。
 */
export function corsOriginsFromEnv(raw: string | undefined): string[] | undefined {
  // 空串按未配置处理：Compose 里 `${ECOMGEN_CORS_ORIGINS:-}` 在未设置时就是空串，
  // 若把它当成"显式配置了一个空来源"就会在启动时抛错，容器起不来。
  if (raw === undefined || raw.trim() === "") return undefined;
  const entries = raw.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => entry === "")) throw new Error("ECOMGEN_CORS_ORIGINS must not contain empty origins");
  return entries;
}
