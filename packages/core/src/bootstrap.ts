import { randomBytes } from "node:crypto";
import type { EcomRepository, UserRecord } from "./repository.js";
import { hashPassword, isAcceptablePassword, MIN_PASSWORD_LENGTH } from "./auth.js";

export interface BootstrapOptions {
  /** 引导管理员邮箱。未设置时用 `owner@localhost`。 */
  email?: string;
  /** 引导管理员密码。未设置时随机生成并只返回一次，由调用方打印到启动日志。 */
  password?: string;
  /** 新用户赠送积分（微积分）。为 0 表示不赠送。 */
  signupBonusMicrocredits?: number;
}

export interface BootstrapResult {
  /** 本次是否新建了引导管理员。 */
  created: boolean;
  owner: UserRecord;
  /** 仅在自动生成密码时存在；调用方必须提示用户立即修改。 */
  generatedPassword?: string;
  /** 本次回填到引导管理员名下的历史行数。 */
  claimed: Record<string, number>;
}

/**
 * 首次启动引导。
 *
 * 单用户旧库升级到多用户时，数据库层无法知道既有数据该归谁，所以归属在应用启动期补齐：
 * 建出唯一的 owner，再把所有 `owner_id IS NULL` 的历史行划给它。之后再无孤儿行。
 *
 * 幂等：已有用户时只做归属回填，不新建账号，也不重复发放赠送积分。
 */
export function ensureBootstrapOwner(repository: EcomRepository, options: BootstrapOptions = {}): BootstrapResult {
  const existing = repository.countUsers();
  if (existing > 0) {
    const owner = pickExistingOwner(repository);
    // 孤儿行回填只做一次。
    //
    // 它原本是为"单用户旧库升级到多用户"准备的；如果每次启动都跑，
    // 任何 owner_id 为空的行（历史数据、或某个系统作用域写入的漏网记录）
    // 都会被悄悄划给站长——在多租户下这是把别人的数据判给自己。
    const alreadyClaimed = repository.getSetting("migration.orphans_claimed", false);
    const claimed = alreadyClaimed ? {} : repository.claimOrphanRows(owner.id);
    if (!alreadyClaimed) repository.setSetting("migration.orphans_claimed", true);
    return { created: false, owner, claimed };
  }

  const email = (options.email?.trim() || "owner@localhost").toLowerCase();
  const provided = options.password?.trim();
  if (provided !== undefined && provided !== "" && !isAcceptablePassword(provided)) {
    throw new Error(`ECOMGEN_BOOTSTRAP_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  // 未提供密码时生成 24 字节随机串：宁可让运维从日志里抄一次，也不要留一个已知默认口令。
  const generatedPassword = provided ? undefined : randomBytes(18).toString("base64url");
  const password = provided ?? generatedPassword!;

  const owner = repository.createUser({
    email,
    passwordHash: hashPassword(password),
    displayName: "站长",
    role: "owner",
    status: "active",
  });

  const bonus = options.signupBonusMicrocredits ?? 0;
  if (bonus > 0) {
    repository.applyCreditEntry({ userId: owner.id, type: "signup_bonus", amountMicrocredits: bonus, note: "引导管理员初始额度" });
  } else {
    // 即使不赠送也要建出账户行，否则后续首次扣费的 UPDATE 会影响 0 行而静默丢失写入。
    repository.applyCreditEntry({ userId: owner.id, type: "admin_grant", amountMicrocredits: 0, note: "初始化账户" });
  }

  // 首次初始化时把旧库的孤儿行归给站长，并立刻打标记，避免下次启动重复认领。
  const claimed = repository.claimOrphanRows(owner.id);
  repository.setSetting("migration.orphans_claimed", true);
  return { created: true, owner, generatedPassword, claimed };
}

/** 已有用户时挑一个 owner：优先 owner 角色，其次 admin，最后最早创建的用户。 */
function pickExistingOwner(repository: EcomRepository): UserRecord {
  const owners = repository.listUsers({ role: "owner", limit: 1, offset: 0 }).items;
  if (owners[0]) return owners[0];
  const admins = repository.listUsers({ role: "admin", limit: 1, offset: 0 }).items;
  if (admins[0]) return admins[0];
  const any = repository.listUsers({ limit: 1, offset: 0 }).items;
  if (!any[0]) throw new Error("bootstrap failed: user table is empty after creation");
  return any[0];
}
