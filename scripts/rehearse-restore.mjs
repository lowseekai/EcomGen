/**
 * 备份 → 灾难 → 恢复 的完整演练。
 *
 * 为什么要有这个脚本：没演练过的备份等于没有备份。
 * 它在一个临时数据目录里造数据、备份、删库、恢复、核对，全程不碰任何真实数据。
 *
 * 用法：node scripts/rehearse-restore.mjs
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EcomRepository, openDatabase } from "../packages/core/dist/index.js";

const BACKUP_CLI = "apps/api/dist/backup-cli.js";
const RESTORE_CLI = "apps/api/dist/restore-cli.js";
const MARKER_EMAIL = "rehearsal-owner@example.com";
const MARKER_PROJECT = "演练项目-不可丢失";

let failures = 0;

function step(label) {
  console.log(`\n=== ${label}`);
}

function check(condition, message) {
  if (condition) {
    console.log(`  ok: ${message}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL: ${message}`);
}

/** 执行子命令。expectFailure 的步骤会把 stderr 收起来，避免把"预期拒绝"显示成故障。 */
function run(cli, args, env, expectFailure = false) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, ...env },
    stdio: expectFailure ? ["ignore", "ignore", "pipe"] : "inherit",
    encoding: "utf8",
  });
  if (expectFailure && result.stderr) {
    const first = result.stderr.trim().split("\n")[0];
    console.log(`  （预期的拒绝：${first}）`);
  }
  return result.status ?? 1;
}

function seed(dataDir) {
  const database = openDatabase(join(dataDir, "ecomgen.sqlite"));
  try {
    const repository = new EcomRepository(database);
    const user = repository.createUser({ email: MARKER_EMAIL, passwordHash: "x", displayName: "演练站长", role: "owner" });
    const owned = repository.forOwner(user.id);
    owned.createProject({
      name: MARKER_PROJECT,
      category: null,
      productDescription: null,
      verifiedFacts: [],
      prohibitedClaims: [],
      brandGuidelines: {},
      platformTargets: [],
      targetMarket: null,
      copyLanguage: null,
      reasoningProviderId: null,
      reasoningModelId: null,
      imageProviderId: null,
      imageModelId: null,
      defaultMode: "CREATIVE",
      imageResolution: "1K",
      imageAspectRatio: "AUTO",
      candidatesPerType: 1,
    });
  } finally {
    database.close();
  }
}

function inspect(dataDir) {
  const path = join(dataDir, "ecomgen.sqlite");
  if (!existsSync(path)) return null;
  const database = openDatabase(path);
  try {
    const user = database.prepare("SELECT id FROM users WHERE email = ?").get(MARKER_EMAIL);
    const project = database.prepare("SELECT id FROM projects WHERE name = ?").get(MARKER_PROJECT);
    return { hasUser: Boolean(user), hasProject: Boolean(project) };
  } finally {
    database.close();
  }
}

const root = join(tmpdir(), `ecomgen-rehearsal-${Date.now()}`);
const dataDir = join(root, "data");
mkdirSync(dataDir, { recursive: true });
const env = { ECOMGEN_DATA_DIR: dataDir, ECOMGEN_MASTER_KEY: Buffer.alloc(32, 7).toString("base64") };

try {
  step("1. 造数据");
  seed(dataDir);
  const before = inspect(dataDir);
  check(before?.hasUser === true, "标记用户已写入");
  check(before?.hasProject === true, "标记项目已写入");

  step("2. 备份");
  check(run(BACKUP_CLI, [], env) === 0, "backup-cli 执行成功");
  const backupDir = join(dataDir, "backups");
  const snapshots = readdirSync(backupDir).filter((name) => name.endsWith(".sqlite"));
  check(snapshots.length === 1, `生成 1 份快照（实际 ${snapshots.length}）`);
  const snapshotPath = join(backupDir, snapshots[0]);

  step("3. 模拟灾难：删除主库与 WAL");
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(dataDir, `ecomgen.sqlite${suffix}`), { force: true });
  check(inspect(dataDir) === null, "主库已不存在");

  step("4. 恢复");
  check(run(RESTORE_CLI, [snapshotPath], env) === 0, "restore-cli 执行成功");
  const after = inspect(dataDir);
  check(after?.hasUser === true, "标记用户已恢复");
  check(after?.hasProject === true, "标记项目已恢复");

  step("5. 安全护栏：目标库已存在时默认拒绝覆盖");
  const refused = run(RESTORE_CLI, [snapshotPath], env, true);
  check(refused !== 0, "未加 FORCE 时拒绝覆盖（非 0 退出）");

  step("6. 强制覆盖时先做安全备份");
  const forced = run(RESTORE_CLI, [snapshotPath], { ...env, ECOMGEN_RESTORE_FORCE: "true" });
  check(forced === 0, "加 FORCE 后恢复成功");
  const safety = readdirSync(backupDir).filter((name) => name.startsWith("pre-restore-"));
  check(safety.length >= 1, `生成了安全备份（${safety.length} 份）`);

  step("7. 拒绝损坏的快照");
  const brokenPath = join(backupDir, "broken.sqlite");
  const broken = openDatabase(brokenPath);
  broken.close();
  // 写入垃圾内容，制造一个非 SQLite 文件
  const { writeFileSync } = await import("node:fs");
  writeFileSync(brokenPath, Buffer.from("this is not a sqlite database at all"));
  const rejected = run(RESTORE_CLI, [brokenPath], { ...env, ECOMGEN_RESTORE_FORCE: "true" }, true);
  check(rejected !== 0, "损坏快照被拒绝（非 0 退出）");
  check(inspect(dataDir)?.hasUser === true, "拒绝后当前库未被破坏");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n演练通过：备份可用、恢复可用、护栏生效。" : `\n演练失败：${failures} 项未通过。`);
process.exit(failures === 0 ? 0 : 1);
