import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { openDatabase, resolveDataDir } from "@ecomgen/core";

/**
 * 一致性备份 CLI。
 *
 * 为什么不能用 `cp ecomgen.sqlite`：WAL 模式下未 checkpoint 的事务在 `-wal` 文件里，
 * 只拷主文件会丢掉最近的写入（实测主库 4KB 时，一致性备份出来 733KB，差的全在 WAL）。
 * 这里用 SQLite 官方的在线备份 API，服务运行中也能安全执行。
 *
 * 用法：
 *   node apps/api/dist/backup-cli.js
 *   ECOMGEN_BACKUP_KEEP=14 node apps/api/dist/backup-cli.js
 */

const KEEP = Number(process.env.ECOMGEN_BACKUP_KEEP ?? 7);

async function main(): Promise<void> {
  const dataDir = resolveDataDir(process.env.ECOMGEN_DATA_DIR, resolve(import.meta.dirname, "../../.."));
  const source = join(dataDir, "ecomgen.sqlite");
  const backupDir = process.env.ECOMGEN_BACKUP_DIR ?? join(dataDir, "backups");
  mkdirSync(backupDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = join(backupDir, `ecomgen-${stamp}.sqlite`);

  const database = openDatabase(source);
  try {
    await database.backup(target);
  } finally {
    database.close();
  }

  const bytes = statSync(target).size;
  console.log(`backup written: ${target} (${(bytes / 1024 / 1024).toFixed(2)} MB)`);

  // 保留最近 KEEP 份；只删本目录内符合命名规则的文件，避免误删。
  const snapshots = readdirSync(backupDir)
    .filter((name) => /^ecomgen-.*\.sqlite$/.test(name))
    .map((name) => ({ name, mtime: statSync(join(backupDir, name)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime);

  const stale = snapshots.slice(Math.max(1, KEEP));
  for (const entry of stale) rmSync(join(backupDir, entry.name), { force: true });
  console.log(`retained ${snapshots.length - stale.length} snapshot(s), removed ${stale.length}`);
}

main().catch((error: unknown) => {
  console.error(`backup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
