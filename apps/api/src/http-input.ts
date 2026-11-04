import { FormatRegistry, type TSchema, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { API_SCHEMA_REGISTRY } from "@ecomgen/contracts";
import { ApiError } from "./errors.js";

const schemaReferences = Object.values(API_SCHEMA_REGISTRY);

FormatRegistry.Set("uri", (value) => { try { new URL(value); return true; } catch { return false; } });
// 版本位接受 1–8：RFC 9562 定义了 v1–v8，本项目主键已改为 v7（时间有序）。
// 只认 [1-5] 会把 v6/v7/v8 一律判为非法——v7 上线时正是踩在这里。
FormatRegistry.Set("uuid", (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
FormatRegistry.Set("date-time", (value) => !Number.isNaN(Date.parse(value)));

function pointerToPath(pointer: string, prefix: string): string {
  if (!pointer) return prefix;
  const segments = pointer.slice(1).split("/").map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  let path = prefix;
  for (const segment of segments) path += /^\d+$/.test(segment) ? `[${segment}]` : `.${segment}`;
  return path;
}

export function parseBody<TSchemaType extends TSchema>(schema: TSchemaType, value: unknown, options: { pathPrefix?: string } = {}): Static<TSchemaType> {
  const pathPrefix = options.pathPrefix ?? "body";
  if (Value.Check(schema, schemaReferences, value)) return value as Static<TSchemaType>;
  const details = [...Value.Errors(schema, schemaReferences, value)].map((error) => ({
    path: pointerToPath(error.path, pathPrefix),
    reason: error.message,
  }));
  throw new ApiError(400, "VALIDATION_ERROR", "Request body does not match the expected schema", details);
}
