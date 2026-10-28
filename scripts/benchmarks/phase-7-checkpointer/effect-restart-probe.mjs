import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import CandidateDatabase from 'better-sqlite3';
import { importTypeScriptModule } from '../../lib/bundle-ts.mjs';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const prototypeDirectory = fileURLToPath(new URL('.', import.meta.url));
const rootRequire = createRequire(join(repositoryRoot, 'package.json'));
const RootDatabase = rootRequire('better-sqlite3');
const ToolMessage = rootRequire('@langchain/core/messages').ToolMessage;
const [backend, phase, databasePath, effectLogPath] = process.argv.slice(2);
if (!['roc', 'official'].includes(backend) || !['crash', 'resume'].includes(phase) || !databasePath || !effectLogPath) {
  throw new Error('usage: effect-restart-probe.mjs <roc|official> <crash|resume> <database-path> <effect-log-path>');
}

const graphApi = backend === 'official'
  ? await import(new URL('./node_modules/@langchain/langgraph/dist/index.js', import.meta.url))
  : rootRequire('@langchain/langgraph');
const { SqliteSaver } = await import(
  new URL('./node_modules/@langchain/langgraph-checkpoint-sqlite/dist/index.js', import.meta.url)
);
const bundleOptions = {
  platform: 'node',
  external: ['better-sqlite3'],
  tempDir: join(repositoryRoot, '.runtime/tmp')
};
const [{ RocSqliteCheckpointer }, { agentMigrations }, { applyDatabaseMigrations }, { AgentToolEffectStore }, { createToolEffectIdempotencyMiddleware }] = await Promise.all([
  importTypeScriptModule(join(repositoryRoot, 'src/main/services/deep-agent/sqlite-checkpointer.ts'), bundleOptions),
  importTypeScriptModule(join(repositoryRoot, 'src/main/infrastructure/database-schemas.ts'), bundleOptions),
  importTypeScriptModule(join(repositoryRoot, 'src/main/infrastructure/database-migrations.ts'), bundleOptions),
  importTypeScriptModule(join(repositoryRoot, 'src/main/services/deep-agent/tool-effect-store.ts'), bundleOptions),
  importTypeScriptModule(join(repositoryRoot, 'src/main/services/deep-agent/tool-effect-idempotency.ts'), bundleOptions)
]);

const Database = backend === 'official' ? CandidateDatabase : RootDatabase;
const db = new Database(databasePath);
// Candidate-owned tables are outside Roc's exact agent schema. Skip the application schema
// validator only on candidate replay so this probe isolates effect idempotency; a separate
// contract test proves that normal startup rejects those extra tables.
if (backend === 'roc' || phase === 'crash') {
  applyDatabaseMigrations(db, { dbName: 'agent', migrations: agentMigrations });
}
const saver = backend === 'official' ? new SqliteSaver(db) : new RocSqliteCheckpointer(db);
const effectStore = new AgentToolEffectStore(db);
const middleware = createToolEffectIdempotencyMiddleware({
  runId: 'phase-7-effect-run',
  threadId: 'phase-7-effect-thread',
  store: effectStore,
  capabilityManifest: {
    tools: [{
      modelVisibleName: 'write_file',
      idempotencyStrategy: 'tool_call',
      effectClass: 'workspace_mutation',
      reconcileStrategy: 'retry_safe'
    }]
  }
});
const State = graphApi.Annotation.Root({
  value: graphApi.Annotation({ reducer: (_left, right) => right, default: () => '' })
});
const graph = new graphApi.StateGraph(State)
  .addNode('side-effect-tool', async () => {
    const toolCallId = 'phase-7-effect-call';
    const message = await middleware.wrapToolCall({
      toolCall: {
        id: toolCallId,
        name: 'write_file',
        args: { path: 'output.txt', content: 'exactly once' }
      },
      runtime: {
        configurable: {
          checkpoint_ns: 'tools:write_file',
          checkpoint_map: { '': 'phase-7-stable-effect-checkpoint' },
          ls_agent_type: 'root'
        }
      }
    }, async () => {
      appendFileSync(effectLogPath, 'executed\n', 'utf8');
      return new ToolMessage({
        tool_call_id: toolCallId,
        name: 'write_file',
        content: 'external effect applied'
      });
    });
    if (phase === 'crash') {
      process.kill(process.pid, 'SIGKILL');
    }
    return { value: message.content };
  })
  .addEdge(graphApi.START, 'side-effect-tool')
  .addEdge('side-effect-tool', graphApi.END)
  .compile({ checkpointer: saver });

try {
  const config = { configurable: { thread_id: 'phase-7-effect-thread' } };
  const result = phase === 'crash'
    ? await graph.invoke({ value: 'start' }, config)
    : await graph.invoke(null, config);
  process.stdout.write(`${JSON.stringify({ value: result.value })}\n`);
} finally {
  db.close();
}
