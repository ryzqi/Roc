import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import CandidateDatabase from 'better-sqlite3';
import { importTypeScriptModule } from '../../lib/bundle-ts.mjs';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const rootRequire = createRequire(join(repositoryRoot, 'package.json'));
const AppDatabase = rootRequire('better-sqlite3');
const backend = process.argv[2];
const phase = process.argv[3];
const databasePath = process.argv[4];

if ((backend !== 'roc' && backend !== 'official') || (phase !== 'pause' && phase !== 'resume') || !databasePath) {
  throw new Error('usage: restart-probe.mjs <roc|official> <pause|resume> <database-path>');
}

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
const graphApi =
  backend === 'official'
    ? await import('@langchain/langgraph')
    : rootRequire('@langchain/langgraph');
const { SqliteSaver } = await import(
  new URL('./node_modules/@langchain/langgraph-checkpoint-sqlite/dist/index.js', import.meta.url)
);

const Database = backend === 'official' ? CandidateDatabase : AppDatabase;
const db = new Database(databasePath);
if (backend === 'roc') {
  applyDatabaseMigrations(db, { dbName: 'agent', migrations: agentMigrations });
}
const saver = backend === 'official' ? new SqliteSaver(db) : new RocSqliteCheckpointer(db);
const State = graphApi.Annotation.Root({
  value: graphApi.Annotation({
    reducer: (_left, right) => right,
    default: () => ''
  })
});
const graph = new graphApi.StateGraph(State)
  .addNode('approval', () => {
    const approved = graphApi.interrupt({ question: 'Approve the write?' });
    return { value: approved === true ? 'approved' : 'rejected' };
  })
  .addEdge(graphApi.START, 'approval')
  .addEdge('approval', graphApi.END)
  .compile({ checkpointer: saver });

const config = { configurable: { thread_id: 'phase-7-interrupt-restart' } };
try {
  if (phase === 'pause') {
    const result = await graph.invoke({ value: 'waiting' }, config);
    const interrupts = result.__interrupt__ ?? [];
    if (!Array.isArray(interrupts) || interrupts.length !== 1) {
      throw new Error(`expected_one_interrupt:${JSON.stringify(result)}`);
    }
    process.stdout.write(`${JSON.stringify({ interruptCount: interrupts.length })}\n`);
  } else {
    const result = await graph.invoke(new graphApi.Command({ resume: true }), config);
    process.stdout.write(`${JSON.stringify({ value: result.value })}\n`);
  }
} finally {
  db.close();
}
