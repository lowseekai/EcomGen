import { describe, expect, it } from "vitest";
import { openDatabase, type SqliteDatabase } from "./database.js";
import { EcomRepository } from "./repository.js";
import { MICROCREDITS_PER_CREDIT } from "./repositories/creditRepository.js";

/**
 * SaaS 基础层仓储的行为测试。
 *
 * 覆盖的是"错了会赔钱或漏权限"的规则：余额事务、计费单状态机、回调幂等、存储聚合、存量归属。
 * 这些规则一旦回归不会抛错，只会静默算错账，所以必须有显式断言。
 */

function setup(): { db: SqliteDatabase; repository: EcomRepository } {
  const db = openDatabase(":memory:");
  return { db, repository: new EcomRepository(db) };
}

function makeUser(repository: EcomRepository, email: string, role: "owner" | "admin" | "support" | "user" = "user") {
  return repository.createUser({ email, passwordHash: "scrypt$1$1$1$x$y", displayName: email.split("@")[0], role });
}

describe("积分账户与流水", () => {
  it("写入流水后余额与 balance_after 一致", () => {
    const { repository } = setup();
    const user = makeUser(repository, "a@example.com");

    const first = repository.applyCreditEntry({ userId: user.id, type: "signup_bonus", amountMicrocredits: 2 * MICROCREDITS_PER_CREDIT });
    expect(first.ok).toBe(true);
    expect(repository.getBalance(user.id)).toBe(2 * MICROCREDITS_PER_CREDIT);

    const second = repository.applyCreditEntry({ userId: user.id, type: "job_reserve", amountMicrocredits: -MICROCREDITS_PER_CREDIT });
    expect(second.ok).toBe(true);
    expect(repository.getBalance(user.id)).toBe(MICROCREDITS_PER_CREDIT);

    const ledger = repository.listCreditLedger(user.id, 10, 0);
    expect(ledger.map((entry) => entry.balanceAfterMicrocredits)).toEqual([MICROCREDITS_PER_CREDIT, 2 * MICROCREDITS_PER_CREDIT]);
  });

  it("余额不足时整体拒绝，不做部分扣减", () => {
    const { repository } = setup();
    const user = makeUser(repository, "b@example.com");
    repository.applyCreditEntry({ userId: user.id, type: "signup_bonus", amountMicrocredits: MICROCREDITS_PER_CREDIT });

    const rejected = repository.applyCreditEntry({ userId: user.id, type: "job_reserve", amountMicrocredits: -2 * MICROCREDITS_PER_CREDIT });
    expect(rejected.ok).toBe(false);
    // 关键断言：被拒绝的扣费不能留下任何痕迹。
    expect(repository.getBalance(user.id)).toBe(MICROCREDITS_PER_CREDIT);
    expect(repository.countCreditLedger(user.id)).toBe(1);
  });

  it("allowNegative 供后台冲正使用", () => {
    const { repository } = setup();
    const user = makeUser(repository, "c@example.com");
    const result = repository.applyCreditEntry({ userId: user.id, type: "admin_adjust", amountMicrocredits: -5 }, { allowNegative: true });
    expect(result.ok).toBe(true);
    expect(repository.getBalance(user.id)).toBe(-5);
  });

  it("重算余额能从流水还原出同一个值", () => {
    const { repository } = setup();
    const user = makeUser(repository, "d@example.com");
    repository.applyCreditEntry({ userId: user.id, type: "signup_bonus", amountMicrocredits: 10 });
    repository.applyCreditEntry({ userId: user.id, type: "job_reserve", amountMicrocredits: -3 });
    repository.applyCreditEntry({ userId: user.id, type: "job_refund", amountMicrocredits: 3 });

    expect(repository.recomputeBalance(user.id)).toEqual({ stored: 10, computed: 10 });
  });
});

describe("套餐权益解析", () => {
  it("管理员与站长不受套餐限制", () => {
    const { repository } = setup();
    const admin = makeUser(repository, "admin@example.com", "admin");
    const resolved = repository.resolveEntitlements(admin);
    expect(resolved.planCode).toBe("unlimited");
    expect(resolved.entitlements.maxProjects).toBe(-1);
    expect(resolved.entitlements.allowPsdExport).toBe(true);
  });

  it("普通用户无订阅时回落免费套餐", () => {
    const { repository } = setup();
    const user = makeUser(repository, "e@example.com");
    const resolved = repository.resolveEntitlements(user);
    expect(resolved.planCode).toBe("free");
    expect(resolved.entitlements.maxProjects).toBe(3);
    expect(resolved.entitlements.allowPsdExport).toBe(false);
  });

  it("有 active 订阅时使用该套餐", () => {
    const { repository } = setup();
    const user = makeUser(repository, "f@example.com");
    const pro = repository.getPlanByCode("pro")!;
    repository.activateSubscription({
      userId: user.id,
      planId: pro.id,
      periodStart: "2026-01-01T00:00:00.000Z",
      periodEnd: "2026-02-01T00:00:00.000Z",
    });

    const resolved = repository.resolveEntitlements(user);
    expect(resolved.planCode).toBe("pro");
    expect(resolved.entitlements.maxProjects).toBe(-1);
    expect(resolved.entitlements.allowPsdExport).toBe(true);
  });

  it("重复开通订阅不会违反部分唯一索引", () => {
    const { repository } = setup();
    const user = makeUser(repository, "g@example.com");
    const free = repository.getPlanByCode("free")!;
    const pro = repository.getPlanByCode("pro")!;
    repository.activateSubscription({ userId: user.id, planId: free.id, periodStart: "2026-01-01T00:00:00.000Z", periodEnd: "2026-02-01T00:00:00.000Z" });
    repository.activateSubscription({ userId: user.id, planId: pro.id, periodStart: "2026-02-01T00:00:00.000Z", periodEnd: "2026-03-01T00:00:00.000Z" });

    expect(repository.getActiveSubscription(user.id)?.planId).toBe(pro.id);
  });
});

describe("计费单状态机", () => {
  it("同一任务只能有一条计费单", () => {
    const { repository } = setup();
    const user = makeUser(repository, "h@example.com");
    const input = { userId: user.id, jobId: "job-1", reservedMicrocredits: 100, costSnapshot: { model: "m" } };
    repository.createBillingReservation(input);
    // 重复预扣必须是冲突而不是叠加扣费。
    expect(() => repository.createBillingReservation(input)).toThrow();
  });

  it("结算后不能再次结算或退款", () => {
    const { repository } = setup();
    const user = makeUser(repository, "i@example.com");
    const order = repository.createBillingReservation({ userId: user.id, jobId: "job-2", reservedMicrocredits: 100, costSnapshot: {} });

    expect(repository.transitionBillingOrder(order.id, "settled", 80)?.status).toBe("settled");
    // 第二次转移被 status='reserved' 守卫挡掉，状态与金额都不变。
    const again = repository.transitionBillingOrder(order.id, "refunded");
    expect(again?.status).toBe("settled");
    expect(again?.settledMicrocredits).toBe(80);
  });

  it("外部请求已发出但结果未知时落 uncertain", () => {
    const { repository } = setup();
    const user = makeUser(repository, "j@example.com");
    const order = repository.createBillingReservation({ userId: user.id, jobId: "job-3", reservedMicrocredits: 100, costSnapshot: {} });
    repository.transitionBillingOrder(order.id, "uncertain");

    expect(repository.getBillingOrderByJob("job-3")?.status).toBe("uncertain");
    expect(repository.listUncertainBillingOrders(10, 0).map((item) => item.jobId)).toEqual(["job-3"]);
  });
});

describe("支付回调幂等", () => {
  it("同一事件号重复投递只落一条", () => {
    const { repository } = setup();
    const first = repository.recordPaymentNotification({ provider: "wechat_native", eventId: "evt-1", payload: { a: 1 } });
    const second = repository.recordPaymentNotification({ provider: "wechat_native", eventId: "evt-1", payload: { a: 1 } });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
  });

  it("同一订单无论通知多少次，积分只加一次", () => {
    const { repository } = setup();
    const user = makeUser(repository, "k@example.com");
    const order = repository.createPaymentOrder({
      userId: user.id,
      kind: "credits",
      planId: null,
      creditsMicrocredits: 10 * MICROCREDITS_PER_CREDIT,
      amountCents: 990,
      currency: "CNY",
      provider: "wechat_native",
      providerConfig: { appId: "x" },
      expiresAt: "2026-12-31T00:00:00.000Z",
    });

    const credit = (target: typeof order) =>
      repository.applyCreditEntry({ userId: target.userId, type: "payment_topup", amountMicrocredits: target.creditsMicrocredits, paymentOrderId: target.id });

    expect(repository.creditPaymentOrderOnce(order.id, credit).credited).toBe(true);
    expect(repository.creditPaymentOrderOnce(order.id, credit).credited).toBe(false);
    expect(repository.getBalance(user.id)).toBe(10 * MICROCREDITS_PER_CREDIT);
  });
});

describe("存储用量聚合", () => {
  function seedProject(db: SqliteDatabase, id: string, ownerId: string) {
    db.prepare("INSERT INTO projects (id,name,platform_targets_json,default_mode,owner_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, id, "[]", "CREATIVE", ownerId, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  }

  it("跨项目与跨表汇总，且不串到别的用户", () => {
    const { db, repository } = setup();
    const alice = makeUser(repository, "alice@example.com");
    const bob = makeUser(repository, "bob@example.com");

    seedProject(db, "p1", alice.id);
    seedProject(db, "p2", alice.id);
    seedProject(db, "p3", bob.id);

    db.prepare("INSERT INTO assets (id,project_id,role,storage_path,hash,original_name,mime_type,size_bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("a1", "p1", "PRODUCT_TRUTH", "assets/1.png", "h1", "1.png", "image/png", 1000, "2026-01-01T00:00:00.000Z");
    db.prepare("INSERT INTO assets (id,project_id,role,storage_path,hash,original_name,mime_type,size_bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("a2", "p2", "PRODUCT_TRUTH", "assets/2.png", "h2", "2.png", "image/png", 500, "2026-01-01T00:00:00.000Z");
    db.prepare("INSERT INTO assets (id,project_id,role,storage_path,hash,original_name,mime_type,size_bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("a3", "p3", "PRODUCT_TRUTH", "assets/3.png", "h3", "3.png", "image/png", 9999, "2026-01-01T00:00:00.000Z");

    expect(repository.usedStorageBytes(alice.id)).toBe(1500);
    expect(repository.usedStorageBytes(bob.id)).toBe(9999);
  });

  it("删除项目后已用空间立即下降（无计数器可漂移）", () => {
    const { db, repository } = setup();
    const alice = makeUser(repository, "alice2@example.com");
    seedProject(db, "p9", alice.id);
    db.prepare("INSERT INTO assets (id,project_id,role,storage_path,hash,original_name,mime_type,size_bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("a9", "p9", "PRODUCT_TRUTH", "assets/9.png", "h9", "9.png", "image/png", 700, "2026-01-01T00:00:00.000Z");
    expect(repository.usedStorageBytes(alice.id)).toBe(700);

    db.prepare("DELETE FROM projects WHERE id=?").run("p9");
    expect(repository.usedStorageBytes(alice.id)).toBe(0);
  });

  it("花型与模特按 owner_id 直接归属", () => {
    const { db, repository } = setup();
    const alice = makeUser(repository, "alice3@example.com");
    db.prepare("INSERT INTO patterns (id,name,source_type,owner_id,size_bytes,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("pat1", "花型", "UPLOAD", alice.id, 2048, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    db.prepare("INSERT INTO models (id,name,spec_json,notes,owner_id,size_bytes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("mod1", "模特", "{}", "", alice.id, 512, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

    expect(repository.usedStorageBytes(alice.id)).toBe(2560);
  });
});

describe("存量数据归属", () => {
  it("把 owner_id 为空的历史行归到引导管理员，且可重复调用", () => {
    const { db, repository } = setup();
    const owner = makeUser(repository, "owner@example.com", "owner");
    db.prepare("INSERT INTO projects (id,name,platform_targets_json,default_mode,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run("legacy", "旧项目", "[]", "CREATIVE", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

    const claimed = repository.claimOrphanRows(owner.id);
    expect(claimed.projects).toBe(1);

    const row = db.prepare("SELECT owner_id FROM projects WHERE id=?").get("legacy") as { owner_id: string };
    expect(row.owner_id).toBe(owner.id);

    // 幂等：再跑一次不会重复计数。
    expect(repository.claimOrphanRows(owner.id).projects).toBe(0);
  });
});
