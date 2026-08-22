/**
 * 把本机 Roc 数据库迁移到代码里的最新 schema 版本。
 *
 * 迁移逻辑本身在 src/main/infrastructure/database-schemas.ts,这里只负责用 esbuild 把它
 * 打成一个临时 ESM 入口再执行,避免把 SQL 复制一份出来形成第二个真源。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const repoRoot = join(import.meta.dirname, '..');
const dataRoot = join(homedir(), '.roc', 'plugin-data');

const entrySource = `
import { DatabasePool } from '${posix(join(repoRoot, 'src/main/infrastructure/database-pool.ts'))}';
import { acquireDatabaseMaintenanceLease } from '${posix(join(repoRoot, 'src/main/infrastructure/database-maintenance-lease.ts'))}';
import {
  applyCoreDatabaseSchema,
  applyAgentDatabaseSchema,
  applyMemoryDatabaseSchema,
  applyTaskDatabaseSchema,
  applyWorkspaceDatabaseSchema,
  applyDiagnosticsDatabaseSchema
} from '${posix(join(repoRoot, 'src/main/infrastructure/database-schemas.ts'))}';
import { readSchemaMetadata } from '${posix(join(repoRoot, 'src/main/infrastructure/database-migrations.ts'))}';

const rootDir = ${JSON.stringify(dataRoot)};
const lease = acquireDatabaseMaintenanceLease({ rootDir, owner: { kind: 'cli', pid: process.pid } });
const pool = new DatabasePool(rootDir);
const targets = [
  { dbName: 'core', open: () => pool.getCoreConnection(), apply: applyCoreDatabaseSchema },
  { dbName: 'agent', open: () => pool.getConnection('@roc/plugin-agent'), apply: applyAgentDatabaseSchema },
  { dbName: 'memory', open: () => pool.getConnection('@roc/plugin-memory'), apply: applyMemoryDatabaseSchema },
  { dbName: 'task', open: () => pool.getConnection('@roc/plugin-task'), apply: applyTaskDatabaseSchema },
  { dbName: 'plugin:@roc/plugin-workspace', open: () => pool.getConnection('@roc/plugin-workspace'), apply: applyWorkspaceDatabaseSchema },
  { dbName: 'plugin:@roc/plugin-diagnostics', open: () => pool.getConnection('@roc/plugin-diagnostics'), apply: applyDiagnosticsDatabaseSchema }
];

try {
  for (const target of targets) {
    const db = target.open();
    const before = readSchemaMetadata(db, target.dbName);
    const startedAt = Date.now();
    target.apply(db);
    const after = readSchemaMetadata(db, target.dbName);
    console.log(JSON.stringify({
      dbName: target.dbName,
      from: before === null ? null : before.currentVersion,
      to: after === null ? null : after.currentVersion,
      elapsedMs: Date.now() - startedAt
    }));
  }
} finally {
  pool.closeAll();
  lease.release();
}
`;

// 产物放在仓库的 node_modules/.cache 下,external 的 better-sqlite3 才能按常规规则解析到本机原生模块。
const workDir = mkdtempSync(join(repoRoot, 'node_modules', '.cache', 'roc-migrate-'));
const entryPath = join(workDir, 'entry.ts');
const outPath = join(workDir, 'entry.mjs');
writeFileSync(entryPath, entrySource, 'utf8');

try {
  await build({
    entryPoints: [entryPath],
    outfile: outPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['better-sqlite3']
  });
  await import(pathToFileURL(outPath).href);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

function posix(value) {
  return value.replaceAll('\\', '/');
}
