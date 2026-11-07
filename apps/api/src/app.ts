import { randomUUID } from "node:crypto";
import { join } from "node:path";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { fastifySSE } from "@fastify/sse";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { BillingService, EcomRepository, LocalAssetStore, SecretBox, SuiteCatalog, ensureBootstrapOwner, openDatabase, requireActiveScope, type JobRecord } from "@ecomgen/core";
import { createJobQueue, createRedisConnection, enqueue, queueKindForJobType, RedisProjectEventBus, type EcomJobKind } from "@ecomgen/jobs";
import { MAX_SUITE_FORGE_SOURCES, MAX_UPLOAD_FILE_BYTES } from "@ecomgen/contracts";

import { ApiError } from "./errors.js";
import type { ApiContext } from "./context.js";
import { missing } from "./helpers.js";
import { registerAuthGuard } from "./auth-guard.js";
import { configureRateLimit } from "./rate-limit.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAdminOpsRoutes } from "./routes/adminOps.js";
import { registerBillingRoutes } from "./routes/billing.js";
import { registerEditSessionRoutes } from "./routes/editSessions.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { registerMetaRoutes } from "./routes/meta.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerOutputRoutes } from "./routes/outputs.js";
import { registerPatternDraftRoutes } from "./routes/patternDrafts.js";
import { registerPatternPipelineRoutes } from "./routes/patternPipelines.js";
import { registerPatternRoutes } from "./routes/patterns.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerSearchSourceRoutes } from "./routes/searchSources.js";
import { registerSuiteForgeRoutes } from "./routes/suiteForge.js";
import { registerSuiteRoutes } from "./routes/suites.js";
import { registerStoryboardRoutes } from "./routes/storyboard.js";
import { registerUserTemplateRoutes } from "./routes/userTemplates.js";
import { registerWebStatic } from "./web-static.js";

export interface ApiOptions {
  dataDir: string;
  redisUrl: string;
  masterKey: string;
  corsOrigins?: string[];
  /** 生产走 HTTPS 时必须开启，否则会话 cookie 不带 Secure。 */
  secureCookies?: boolean;
  /** 首次启动的引导管理员；未提供密码时生成随机密码并打印到启动日志。 */
  bootstrap?: { email?: string; password?: string };
}

/** 未显式配置时的默认允许来源：本机 web dev server。API 自托管前端时为同源请求，不依赖 CORS。 */
export const DEFAULT_CORS_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

/**
 * 校验 CORS 允许列表：项目没有认证层，允许任意来源等于把读写接口开放给任意站点。
 * 拒绝通配符、空值和非 origin 形态（带路径、查询或非 http/https 协议），让配置错误在启动时暴露。
 */
export function resolveCorsOrigins(configured?: string[]): string[] {
  const origins = configured ?? DEFAULT_CORS_ORIGINS;
  if (origins.length === 0) throw new Error("CORS origins must not be empty");
  for (const origin of origins) {
    if (origin.trim() !== origin || origin === "") throw new Error(`Invalid CORS origin: "${origin}"`);
    if (origin === "*") throw new Error("CORS origin must not be a wildcard; list explicit origins instead");
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw new Error(`Invalid CORS origin: "${origin}"`); }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
      throw new Error(`Invalid CORS origin (must be scheme://host[:port]): "${origin}"`);
    }
  }
  return origins;
}

export async function buildApi(options: ApiOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
    genReqId: () => randomUUID(),
    // 反向代理后的客户端 IP。
    //
    // 默认 false：直接取 socket 地址。部署在 Nginx 之后时必须设置，
    // 否则所有用户共享代理 IP，登录/注册/找回密码的限流会退化成"全站一个桶"——
    // 攻击者只要持续失败就能把所有人锁在门外。
    // 但也**不能**简单设成 true：那会无条件信任 X-Forwarded-For，可被伪造绕过限流。
    // 因此这里只接受"确切跳数"或"受信代理地址列表"。
    trustProxy: readTrustProxy(process.env.ECOMGEN_TRUST_PROXY),
  });
  const database = openDatabase(join(options.dataDir, "ecomgen.sqlite"));
  /**
   * 两个仓储实例，职责不同：
   * - systemRepository：系统作用域，不做归属过滤。只给启动期（引导、套图目录）与需要全局视角的运维路径用。
   * - repository：作用域从当前请求上下文取（见 scope.ts 的 requireActiveScope）。路由拿到的就是它，
   *   因此每个请求的每条查询都自动带归属谓词，路由代码不必逐个传 ownerId。
   *
   * 上下文缺失时 requireActiveScope 直接抛错而不是回退系统作用域——回退等于"上下文丢了就放行全部数据"，
   * 那是最坏的失败方式。
   */
  const systemRepository = new EcomRepository(database);
  const repository = new EcomRepository(database, () => requireActiveScope());
  const allowedOrigins = resolveCorsOrigins(options.corsOrigins);

  /**
   * 首次启动引导：建出唯一的站长账号，并把单用户旧库里 owner_id 为空的历史行划归给它。
   * 幂等——已有用户时只做归属回填，不新建账号、不重复发放额度。
   */
  const bootstrap = ensureBootstrapOwner(systemRepository, {
    email: options.bootstrap?.email,
    password: options.bootstrap?.password,
    signupBonusMicrocredits: Number(systemRepository.getSetting("signup_bonus_microcredits", 0)),
  });
  if (bootstrap.created) {
    // 自动生成的密码只在这里出现一次，不落库、不回显给任何接口。
    if (bootstrap.generatedPassword) {
      app.log.warn(`已创建引导管理员 ${bootstrap.owner.email}，初始密码：${bootstrap.generatedPassword}（登录后请立即修改）`);
    } else {
      app.log.info(`已创建引导管理员 ${bootstrap.owner.email}`);
    }
  }
  const claimed = Object.entries(bootstrap.claimed).filter(([, count]) => count > 0);
  if (claimed.length > 0) app.log.info({ claimed: Object.fromEntries(claimed) }, "历史数据已归入引导管理员");

  const suiteCatalog = new SuiteCatalog({ dataDir: options.dataDir, repository: systemRepository });
  await suiteCatalog.refresh();
  const storage = new LocalAssetStore(options.dataDir); await storage.initialize();
  const secrets = new SecretBox(options.masterKey);
  const redis = createRedisConnection(options.redisUrl);
  // 限流走 Redis：多实例部署时进程内存版本会各算一份，等于把放行量翻倍。
  configureRateLimit(redis);
  const queue = createJobQueue(redis);
  const events = new RedisProjectEventBus(redis.duplicate(), redis.duplicate());
  await app.register(cors, { origin: allowedOrigins });
  // 全局 multipart 上限作用于所有上传路由；files 取套图源图上限，因为它是唯一的批量多文件入口。
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_FILE_BYTES, files: MAX_SUITE_FORGE_SOURCES } });
  await app.register(fastifySSE, { heartbeatInterval: 20_000 });
  // 支付网关的异步通知多为表单或查询串提交。不注册这个解析器时 request.body 为空，
  // 回调会被当成"缺少参数"静默丢弃——网关以为通知成功、我们却没入账。
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    } catch (error) {
      done(error as Error, undefined);
    }
  });
  // 安全响应头。缺了 nosniff 时，浏览器可能把图片响应嗅探成可执行内容，
  // 这是存储型 XSS 的放大器（见审计报告 P0-1）。
  app.addHook("onSend", async (_request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    // CSP 与前端产物匹配：脚本全部是外链（构建产物无内联 script），
    // 样式需要 unsafe-inline（antd 运行时注入 style 标签）。
    reply.header(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    );
  });

  app.addHook("onClose", async () => { await events.close(); await queue.close(); database.close(); });
  /**
   * 入队是持久化之后的第二步：数据库已落 QUEUED 而入队失败时，任务永远不会执行，
   * 且相同指纹会继续复用这个坏状态。这里把尚未入队的任务统一落为 FAILED(QUEUE_UNAVAILABLE)
   * 并发布状态事件；顺序入队保证只回滚真正未入队的任务，已入队的照常执行。
   */
  /**
   * pending 全部尝试入队；失败时只把 markable（默认即 pending，生成批次要传“本次新建”子集）
   * 及其后未入队者统一落为 FAILED(QUEUE_UNAVAILABLE) 并发布事件——按指纹复用的既有任务
   * 不属于本请求的失败面，不能被改写状态。顺序入队保证只回滚真正未入队的任务，已入队的照常执行。
   */
  async function enqueueOrMarkFailed(pending: JobRecord | JobRecord[], kind: EcomJobKind, enqueueOptions: { onFail?: (jobId: string) => void; markable?: JobRecord[] } = {}): Promise<void> {
    const jobs = Array.isArray(pending) ? pending : [pending];
    const markable = new Set((enqueueOptions.markable ?? jobs).map((job) => job.id));
    for (let index = 0; index < jobs.length; index++) {
      const job = jobs[index];
      try {
        await enqueue(queue, { jobId: job.id, kind });
      } catch (error) {
        app.log.error(error, "enqueue failed for job %s", job.id);
        const message = "任务已创建但队列暂不可用，请稍后重试";
        for (const remaining of jobs.slice(index)) {
          if (!markable.has(remaining.id)) continue;
          enqueueOptions.onFail?.(remaining.id);
          // 入队失败意味着任务不会执行，预扣的积分必须退回；否则用户为一次没发生的调用付了钱。
          new BillingService(repository).refund(remaining.id, "任务入队失败，全额退回");
          const failed = repository.updateJob(remaining.id, { status: "FAILED", progress: 100, error: { code: "QUEUE_UNAVAILABLE", message } });
          if (failed && failed.projectId) await events.publish(failed.projectId, "job.updated", failed);
        }
        throw new ApiError(503, "QUEUE_UNAVAILABLE", message);
      }
    }
  }
  /**
   * 请求取消一个任务：已失败任务直接落 CANCELLED（没有可中断的队列工作，但需要关闭失败提示并留审计记录）；
   * 仍在队列中等待的移出队列；已在执行的只置取消标记，由 Worker 断开在途请求。
   * 抽成函数是因为流水线取消也要走同一条路径——两处各写一份必然会丢其中一种情况。
   */
  async function requestJobCancellation(id: string): Promise<JobRecord> {
    const current = repository.getJob(id);
    if (!current) missing("job", id);
    if (current.status === "FAILED") return repository.updateJob(id, { status: "CANCELLED", cancelRequested: true }) ?? current;
    const queued = await queue.getJob(id);
    const state = queued ? await queued.getState() : "unknown";
    if (queued && ["waiting", "delayed", "prioritized"].includes(state)) {
      await queued.remove();
      // 移出队列意味着 Worker 永远不会跑它：预扣的积分必须在这里退回，
      // 否则这笔钱会一直挂在 reserved 上没人处理。
      new BillingService(repository).refund(id, "任务在开始前被取消，全额退回");
      return repository.updateJob(id, { status: "CANCELLED", cancelRequested: true }) ?? current;
    }
    return repository.updateJob(id, { cancelRequested: true }) ?? current;
  }
  app.setErrorHandler((error, request, reply) => {
    const known = error instanceof ApiError;
    // Fastify 自身也会抛 4xx（畸形 JSON、请求体过大、不支持的媒体类型），它们不是 ApiError。
    // 一律当 500 会把"客户端发错了"报成"服务端坏了"，既误导调用方又污染告警。
    const raw = error as { statusCode?: unknown; code?: unknown };
    const frameworkStatus = typeof raw.statusCode === "number" && raw.statusCode >= 400 && raw.statusCode < 500 ? raw.statusCode : 500;
    const status = known ? error.statusCode : frameworkStatus;
    // 4xx 是客户端问题，用 warn；只有 5xx 才值得按 error 级别告警。
    if (status >= 500) request.log.error(error);
    else request.log.warn({ status, code: raw.code }, "request rejected");
    return reply.status(status).send({
      error: {
        code: known ? error.code : status < 500 ? "VALIDATION_ERROR" : "INTERNAL_ERROR",
        message: known ? error.message : status < 500 ? "Request body could not be processed" : "Unexpected server error",
        details: known ? error.details : [],
        requestId: request.id,
      },
    });
  });

  // 领域路由只经 ctx 触达基础设施；入队/取消闭包保证失败回滚顺序只有一份实现。
  // ctx.repository 是请求作用域实例：路由里 repository.xxx 自动按当前登录用户过滤。
  const ctx: ApiContext = { database, repository, systemRepository, storage, suiteCatalog, secrets, events, secureCookies: options.secureCookies ?? false, enqueueOrMarkFailed, requestJobCancellation };
  // 鉴权钩子必须在业务路由之前注册：它拦下 /api/v1/* 的匿名访问，白名单之外一律 401，
  // 并把本次请求的归属作用域写进 AsyncLocalStorage（见 auth-guard 与 scope.ts）。
  registerAuthGuard(app, { repository: systemRepository, allowedOrigins });
  registerAuthRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerAdminOpsRoutes(app, ctx);
  registerBillingRoutes(app, ctx);
  registerMetaRoutes(app, ctx);
  registerUserTemplateRoutes(app, ctx);
  registerSuiteRoutes(app, ctx);
  registerSuiteForgeRoutes(app, ctx);
  registerModelRoutes(app, ctx);
  registerPatternRoutes(app, ctx);
  registerPatternDraftRoutes(app, ctx);
  registerPatternPipelineRoutes(app, ctx);
  registerProviderRoutes(app, ctx);
  registerSearchSourceRoutes(app, ctx);
  registerProjectRoutes(app, ctx);
  registerStoryboardRoutes(app, ctx);
  registerEditSessionRoutes(app, ctx);
  registerJobRoutes(app, ctx);
  registerOutputRoutes(app, ctx);
  registerFileRoutes(app, ctx);
  await registerWebStatic(app);
  return app;
}

/**
 * 解析 ECOMGEN_TRUST_PROXY。
 *
 * 只接受两种写法：
 * - 纯数字：受信代理的跳数（例如 Nginx 单层填 1）；
 * - 逗号分隔的地址/CIDR：显式受信代理列表。
 * 其余（含 "true"）一律按 false 处理——无条件信任 X-Forwarded-For 会让限流可被伪造绕过。
 */
export function readTrustProxy(raw: string | undefined): FastifyServerOptions["trustProxy"] {
  const value = (raw ?? "").trim().toLowerCase();
  // "true" 必须显式拒绝：无条件信任 X-Forwarded-For 等于让限流可被伪造绕过。
  if (value === "" || value === "false" || value === "true") return false;
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    // Fastify 的类型不接受数字跳数，用等价的判定函数表达：
    // 从右往左数，前 hops 跳视为受信代理。
    return hops > 0 ? ((_address: string, hop: number) => hop < hops) : false;
  }
  const entries = (raw ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  return entries.length > 0 ? entries : false;
}

