import type {
  EcomRepository,
  JobRecord,
  LocalAssetStore,
  SecretBox,
  SqliteDatabase,
  SuiteCatalog,
} from "@ecomgen/core";
import type { EcomJobKind, RedisProjectEventBus } from "@ecomgen/jobs";

/**
 * 领域路由模块共享的运行时句柄，由 buildApi 组装后传给各 registerXxxRoutes。
 * 入队与取消以闭包注入而不是暴露队列实例：入队失败把任务落为 FAILED(QUEUE_UNAVAILABLE)
 * 的回滚顺序只允许存在一份实现（见 app.ts 的 enqueueOrMarkFailed），路由模块不直接触碰 Redis 队列。
 */
export interface ApiContext {
  readonly database: SqliteDatabase;
  /** 请求作用域仓储：作用域取自当前请求上下文，查询自动按登录用户过滤。业务路由一律用它。 */
  readonly repository: EcomRepository;
  /** 系统作用域仓储：不做归属过滤。只给需要全局视角的运维/管理路径用，禁止在用户路由里读它。 */
  readonly systemRepository: EcomRepository;
  readonly storage: LocalAssetStore;
  readonly suiteCatalog: SuiteCatalog;
  readonly secrets: SecretBox;
  readonly events: RedisProjectEventBus;
  /** 会话 cookie 是否带 Secure：生产 HTTPS 必须为 true，本地 http 调试必须为 false。 */
  readonly secureCookies: boolean;
  readonly enqueueOrMarkFailed: (
    pending: JobRecord | JobRecord[],
    kind: EcomJobKind,
    options?: { onFail?: (jobId: string) => void; markable?: JobRecord[] },
  ) => Promise<void>;
  readonly requestJobCancellation: (id: string) => Promise<JobRecord>;
}
