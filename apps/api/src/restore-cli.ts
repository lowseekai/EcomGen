import { copyFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { openDatabase, resolveDataDir } from "@ecomgen/core";

/**
 * 备份恢复 CLI。
 *
 * 用法：
 *   node apps/api/dist/restore-cli.js /app/data/backups/ecomgen-<时间戳>.sqlite
 *   ECOMGEN_RESTORE_FORCE=true node apps/api/dist/restore-cli.js <快照路径>
 *
 * 安全约束（都是踩过的坑）：
 * 1. **必须先停掉 API 与 Worker**：运行中的进程持有连接，替换主库会导致它继续写旧文件。
 * 2. **覆盖前自动给当前库做一次安全备份**：误恢复是常见事故，留一条回退路径。
 * 3. **必须同时删除 `-wal` / `-shm`**：残留的 WAL 属于旧库，配上新主库会直接损坏数据。
 * 4. **恢复前校验快照完整性**：损坏的快照宁可不恢复，也不要覆盖掉还有救的当前库。
 */

const KEEP_SAFETY_PREFIX = "pre-restore-";

function fail(message: string): never {
  console.error(`restore failed: ${message}`);
  process.exit(1);
}

function integrityOk(path: string): boolean {
  const database = openDatabase(path);
  try {
    const rows = database.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
    return rows.length === 1 && Object.values(rows[0])[0] === "ok";
  } finally {
    database.close();
  }
}

function summarize(path: string): string {
  const database = openDatabase(path);
  try {
    const count = (table: string): number => {
      try {
        return (database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      } catch {
        return -1;
      }
    };
    return `users=${count("users")} projects=${count("projects")} jobs=${count("jobs")} assets=${count("assets")}`;
  } finally {
    database.close();
  }
}

async function main(): Promise<void> {
  const dataDir = resolveDataDir(process.env.ECOMGEN_DATA_DIR, resolve(import.meta.dirname, "../../.."));
  const target = join(dataDir, "ecomgen.sqlite");
  const snapshot = process.env.ECOMGEN_RESTORE_FROM ?? process.argv[2];

  if (!snapshot) fail("请提供快照路径：node restore-cli.js <快照路径>（或设置 ECOMGEN_RESTORE_FROM）");
  const snapshotPath = resolve(snapshot);
  if (!existsSync(snapshotPath)) fail(`快照不存在：${snapshotPath}`);
  if (!statSync(snapshotPath).isFile()) fail(`快照不是文件：${snapshotPath}`);

  // 先校验快照，再决定要不要动当前库。
  if (!integrityOk(snapshotPath)) fail(`快照完整性校验未通过，已放弃恢复：${snapshotPath}`);
  console.log(`snapshot ok: ${snapshotPath} (${(statSync(snapshotPath).size / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`snapshot contents: ${summarize(snapshotPath)}`);

  const force = (process.env.ECOMGEN_RESTORE_FORCE ?? "").trim().toLowerCase() === "true";
  if (existsSync(target) && !force) {
    fail(
      `目标库已存在：${target}\n` +
        "确认要覆盖请加 ECOMGEN_RESTORE_FORCE=true。覆盖前会自动备份当前库到 backups/pre-restore-<时间戳>.sqlite。",
    );
  }

  // 覆盖前先给当前库留一份安全备份。
  if (existsSync(target)) {
    const backupDir = process.env.ECOMGEN_BACKUP_DIR ?? join(dataDir, "backups");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safety = join(backupDir, `${KEEP_SAFETY_PREFIX}${stamp}.sqlite`);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(backupDir, { recursive: true });
    const current = openDatabase(target);
    try {
      await current.backup(safety);
    } finally {
      current.close();
    }
    console.log(`safety backup: ${safety}`);
  }

  // 主库与 WAL/SHM 必须一起换：残留的 WAL 属于旧库，配新主库会损坏数据。
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${target}${suffix}`, { force: true });
  }
  copyFileSync(snapshotPath, target);
  console.log(`restored: ${snapshotPath} -> ${target}`);

  if (!integrityOk(target)) fail("恢复后完整性校验未通过，请改用安全备份回滚");
  console.log(`restored contents: ${summarize(target)}`);

  console.log(
    [
      "",
      "下一步：",
      "  1) 重新启动 API 与 Worker；",
      "  2) 确认素材目录（assets/ outputs/ layers/ exports/ patterns/）也已一并恢复——",
      "     数据库只记录路径，只恢复库会得到「记录都在、图全打不开」；",
      "  3) 登录并打开一个项目做抽查。",
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
