import type { Entitlements } from "./repositories/planRepository.js";
import type { EcomRepository } from "./repository.js";

/**
 * 套餐配额的判定逻辑。
 *
 * 这里只做判定、不抛 HTTP 错误：配额是领域规则，`413/402` 是传输层的表达，
 * 让 core 依赖 Fastify 的 ApiError 会把两个层次焊死。
 */

export type QuotaCode = "STORAGE_QUOTA_EXCEEDED" | "PROJECT_QUOTA_EXCEEDED" | "CONCURRENCY_LIMIT_EXCEEDED";

export interface QuotaViolation {
  code: QuotaCode;
  message: string;
  details: Record<string, number>;
}

/**
 * 上传前存储校验。
 *
 * 在落盘之前判断，避免"先写文件再拒绝"——那样磁盘已经占用了，配额却拒绝入库，
 * 留下一个没人认领的孤儿文件。
 */
export function checkStorageQuota(repository: EcomRepository, ownerId: string, entitlements: Entitlements, incomingBytes: number): QuotaViolation | null {
  const limit = entitlements.maxStorageBytes;
  if (limit < 0) return null;
  const used = repository.usedStorageBytes(ownerId);
  if (used + incomingBytes <= limit) return null;
  return {
    code: "STORAGE_QUOTA_EXCEEDED",
    message: `存储空间不足：已用 ${formatBytes(used)}，上限 ${formatBytes(limit)}`,
    details: { usedBytes: used, limitBytes: limit, incomingBytes },
  };
}

/** 建项目前校验项目数上限。-1 表示不限。 */
export function checkProjectQuota(repository: EcomRepository, entitlements: Entitlements, activeProjectCount: number): QuotaViolation | null {
  const limit = entitlements.maxProjects;
  if (limit < 0 || activeProjectCount < limit) return null;
  return {
    code: "PROJECT_QUOTA_EXCEEDED",
    message: `项目数已达上限（${limit} 个），请归档或删除旧项目`,
    details: { activeProjects: activeProjectCount, limit },
  };
}

/**
 * 建任务前校验并发上限。
 *
 * 只数 QUEUED + RUNNING：已结束的任务不占并发额度，否则跑满一次就永久卡死。
 */
export function checkConcurrency(repository: EcomRepository, ownerId: string, entitlements: Entitlements): QuotaViolation | null {
  const limit = entitlements.maxConcurrentJobs;
  if (limit < 0) return null;
  const active = repository.countActiveJobs(ownerId);
  if (active < limit) return null;
  return {
    code: "CONCURRENCY_LIMIT_EXCEEDED",
    message: `同时进行的任务已达上限（${limit} 个），请等待现有任务完成`,
    details: { activeJobs: active, limit },
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}
