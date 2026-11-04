/**
 * 仓储归属作用域。
 *
 * 机制选择说明（相对于"每个方法加 ownerId 参数"）：
 *
 * 本项目有 163 个仓储方法、131 个路由处理器。逐个改签名会让 526 个既有用例全部需要调整，
 * 而收益只是"调用方必须传 owner"——它挡不住传错 owner，也挡不住子表查询（`listAssets(projectId)`
 * 依然能在校验缺失时返回别人的素材）。
 *
 * 这里改为**实例级作用域 + 查询级谓词**：作用域绑定在仓储实例上，每个能触达用户数据的查询
 * 都注入 `owner_id = ?`（子表则 join 父表取归属）。这样：
 * - 覆盖更深：根查询和子查询都受保护，不依赖调用方记得先校验父实体；
 * - 改动集中：作用域只有两处产生（启动期 SYSTEM、请求期 ownerScope），编译器只需盯这两处；
 * - 行为中立：SYSTEM 作用域注入空片段，SQL 与改造前逐字相同，旧测试无需改动。
 *
 * 类型系统无法证明"某个查询忘了加谓词"，所以真正的守卫是跨租户探针测试
 * （见 apps/api/src/crossTenant.test.ts）：它动态枚举全部注册路由，用 B 的身份访问 A 的资源，
 * 新接口会自动被覆盖。
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type RepositoryScope =
  | { readonly kind: "system" }
  | { readonly kind: "owner"; readonly ownerId: string };

/** 系统作用域：不做归属过滤，写入时归属列留空。仅供启动期与单用户本地模式使用。 */
export const SYSTEM_SCOPE: RepositoryScope = { kind: "system" };

/**
 * 仓储持有的作用域形态：固定值，或每次求值的提供者。
 *
 * 用提供者是为了让同一个仓储实例服务所有请求（见下方 runWithScope）：
 * 查询发生时才解析当前请求的作用域，而不是在构造时固定。
 */
export type ScopeInput = RepositoryScope | (() => RepositoryScope);

export function resolveScope(scope: ScopeInput): RepositoryScope {
  return typeof scope === "function" ? scope() : scope;
}

export function ownerScope(ownerId: string): RepositoryScope {
  return { kind: "owner", ownerId };
}

export function isSystemScope(scope: ScopeInput): boolean {
  return resolveScope(scope).kind === "system";
}

/** 查询谓词片段。system 作用域返回空串，因此 SQL 与改造前完全一致。 */
export interface OwnerClause {
  readonly sql: string;
  readonly params: readonly string[];
}

/**
 * 生成 ` AND <column> = ?` 片段。
 * `column` 必须由调用方硬编码（如 `p.owner_id`），不接受外部输入——它会直接拼进 SQL。
 */
export function ownerClause(scope: ScopeInput, column = "owner_id"): OwnerClause {
  const resolved = resolveScope(scope);
  return resolved.kind === "system" ? { sql: "", params: [] } : { sql: ` AND ${column} = ?`, params: [resolved.ownerId] };
}

/** 子表查询用：把归属判断下沉到父表 join，避免"调用方忘了先校验父实体"就漏数据。 */
export function ownerJoinClause(scope: RepositoryScope, parentAlias = "p"): OwnerClause {
  return ownerClause(scope, `${parentAlias}.owner_id`);
}

/** 写入时的归属值。system 作用域写 NULL，与迁移前的历史行语义一致。 */
export function ownerValue(scope: ScopeInput): string | null {
  const resolved = resolveScope(scope);
  return resolved.kind === "system" ? null : resolved.ownerId;
}

/** 内存侧复核：从库里读出的记录若归属不符，直接判为不可见（防御 SQL 谓词被误删）。 */
export function isVisible(scope: ScopeInput, recordOwnerId: string | null | undefined): boolean {
  const resolved = resolveScope(scope);
  if (resolved.kind === "system") return true;
  return recordOwnerId === resolved.ownerId;
}

// ---- 请求级作用域上下文 ----
//
// 为什么用 AsyncLocalStorage 而不是把 ownerId 逐层传参：
// 路由层有 333 处 `repository.xxx` 调用，逐个改成 `repository(request).xxx` 既不安全
// （漏一处就是数据泄露）也无法靠编译器兜住。作用域放进请求上下文后，路由代码一行不改，
// 而 13 个仓储模块的每条查询都自动带上归属谓词。
//
// 关键设计：**取不到作用域时抛错，不回退 SYSTEM_SCOPE**。
// 回退等于"上下文丢失 = 放行全部数据"，那是最坏的失败方式；抛错至少是 500，不会泄露。

const scopeStorage = new AsyncLocalStorage<RepositoryScope>();

/** 在指定作用域内执行；API 鉴权钩子用它包住请求续延。 */
export function runWithScope<T>(scope: RepositoryScope, run: () => T): T {
  return scopeStorage.run(scope, run);
}

/** 当前上下文的作用域；不在上下文中返回 undefined（供系统路径判断）。 */
export function activeScope(): RepositoryScope | undefined {
  return scopeStorage.getStore();
}

/**
 * 取当前作用域，缺失即抛错。
 *
 * 只给"必须受归属保护"的仓储实例使用。Worker、启动期、单用户本地模式
 * 显式构造 SYSTEM_SCOPE 实例，不会走到这里。
 */
export function requireActiveScope(): RepositoryScope {
  const scope = scopeStorage.getStore();
  if (!scope) {
    throw new Error("repository scope is not active: 受归属保护的查询必须在 runWithScope() 内执行");
  }
  return scope;
}
