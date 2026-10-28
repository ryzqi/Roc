import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import AppDatabase from 'better-sqlite3';
import { importTypeScriptModule } from '../../lib/bundle-ts.mjs';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const rootRequire = createRequire(join(repositoryRoot, 'package.json'));
const CandidateDatabase = AppDatabase;
const RootDatabase = rootRequire('better-sqlite3');
const [backend, phase, databasePath] = process.argv.slice(2);
if (!['roc', 'official'].includes(backend) || !['seed', 'crash', 'verify'].includes(phase) || !databasePath) {
  throw new Error('usage: crash-probe.mjs <roc|official> <seed|crash|verify> <database-path>');
}

const { SqliteSaver } = await import(
  new URL('./node_modules/@langchain/langgraph-checkpoint-sqlite/dist/index.js', import.meta.url)
);
const bundleOptions = {
  platform: 'node',
  external: ['better-sqlite3'],
  tempDir: join(repositoryRoot, '.runtime/tmp')
};
const [{ RocSqliteCheckpointer }, { agentMigrations }, { applyDatabaseMigrations }] = await Promise.all([
  importTypeScriptModule(join(repositoryRoot, 'src/main/services/deep-agent/sqlite-checkpointer.ts'), bundleOptions),
  importTypeScriptModule(join(repositoryRoot, 'src/main/infrastructure/database-schemas.ts'), bundleOptions),
  importTypeScriptModule(join(repositoryRoot, 'src/main/infrastructure/database-migrations.ts'), bundleOptions)
]);
const Database = backend === 'official' ? CandidateDatabase : RootDatabase;
const db = new Database(databasePath);
if (backend === 'roc' && phase === 'seed') {
  applyDatabaseMigrations(db, { dbName: 'agent', migrations: agentMigrations });
}
const saver = backend === 'official' ? new SqliteSaver(db) : new RocSqliteCheckpointer(db);
const config = { configurable: { thread_id: 'phase-7-crash-thread', checkpoint_ns: '' } };

try {
  if (phase === 'seed') {
    await saver.put(config, {
      v: 1,
      id: 'phase-7-crash-checkpoint',
      ts: '2026-10-27T00:00:00.000Z',
      channel_values: {},
      channel_versions: {},
      versions_seen: {},
      updated_channels: []
    }, { source: 'crash-probe' }, {});
    process.stdout.write(`${JSON.stringify({ seeded: true })}\n`);
  } else if (phase === 'crash') {
    const checkpointConfig = {
      configurable: { ...config.configurable, checkpoint_id: 'phase-7-crash-checkpoint' }
    };
    if (!(await saver.getTuple(checkpointConfig))) {
      throw new Error('seed_checkpoint_missing');
    }
    const table = backend === 'official' ? 'writes' : 'langgraph_checkpoint_writes';
    db.function('hard_crash', () => process.kill(process.pid, 'SIGKILL'));
    db.exec(`
      CREATE TRIGGER phase_7_hard_crash
      BEFORE INSERT ON ${table}
      BEGIN SELECT hard_crash(); END;
    `);
    await saver.putWrites(checkpointConfig, [['channel', 'must-rollback']], 'crash-task');
    throw new Error('hard_crash_trigger_did_not_fire');
  } else {
    const checkpointConfig = {
      configurable: { ...config.configurable, checkpoint_id: 'phase-7-crash-checkpoint' }
    };
    const tuple = await saver.getTuple(checkpointConfig);
    process.stdout.write(`${JSON.stringify({
      checkpointExists: tuple !== undefined,
      pendingWrites: tuple?.pendingWrites ?? []
    })}\n`);
  }
} finally {
  db.close();
}
