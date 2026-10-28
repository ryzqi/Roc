import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import PrototypeDatabase from 'better-sqlite3';
import { importTypeScriptModule } from '../../lib/bundle-ts.mjs';

const { SqliteSaver } = await import(
  new URL('./node_modules/@langchain/langgraph-checkpoint-sqlite/dist/index.js', import.meta.url)
);
const CandidateLanggraph = await import(
  new URL('./node_modules/@langchain/langgraph/dist/index.js', import.meta.url)
);

const prototypeDirectory = fileURLToPath(new URL('.', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const rootRequire = createRequire(join(repositoryRoot, 'package.json'));
const AppDatabase = rootRequire('better-sqlite3');
const bundleOptions = {
  platform: 'node',
  external: ['better-sqlite3'],
  tempDir: join(repositoryRoot, '.runtime/tmp')
};
const { RocSqliteCheckpointer } = await importTypeScriptModule(
  join(repositoryRoot, 'src/main/services/deep-agent/sqlite-checkpointer.ts'),
  bundleOptions
);
const { AgentToolEffectStore } = await importTypeScriptModule(
  join(repositoryRoot, 'src/main/services/deep-agent/tool-effect-store.ts'),
  bundleOptions
);
const { agentMigrations } = await importTypeScriptModule(
  join(repositoryRoot, 'src/main/infrastructure/database-schemas.ts'),
  bundleOptions
);
const { applyDatabaseMigrations } = await importTypeScriptModule(
  join(repositoryRoot, 'src/main/infrastructure/database-migrations.ts'),
  bundleOptions
);

const scratchRoot = join(repositoryRoot, '.runtime/phase-7-checkpointer-prototype');
mkdirSync(scratchRoot, { recursive: true });

function createScratchDirectory(prefix) {
  return mkdtempSync(join(scratchRoot, `${prefix}-`));
}

function createAgentDatabase(DatabaseConstructor = AppDatabase, path = ':memory:') {
  const db = new DatabaseConstructor(path);
  applyDatabaseMigrations(db, { dbName: 'agent', migrations: agentMigrations });
  return db;
}

function checkpoint(id) {
  return {
    v: 1,
    id,
    ts: '2026-10-27T00:00:00.000Z',
    channel_values: {},
    channel_versions: {},
    versions_seen: {},
    updated_channels: []
  };
}

async function putCheckpoint(saver, threadId, checkpointId, checkpointMetadata, checkpointNs = '', parentCheckpointId) {
  const config = { configurable: { thread_id: threadId, checkpoint_ns: checkpointNs } };
  if (parentCheckpointId !== undefined) {
    config.configurable.checkpoint_id = parentCheckpointId;
  }
  return await saver.put(config, checkpoint(checkpointId), checkpointMetadata, {});
}

async function collectCheckpointIds(saver, config, options) {
  const ids = [];
  for await (const tuple of saver.list(config, options)) {
    ids.push(tuple.checkpoint.id);
  }
  return ids;
}

function describeSaverPair(db) {
  return {
    roc: new RocSqliteCheckpointer(db),
    official: new SqliteSaver(db)
  };
}

test('candidate package and application load separate pinned better-sqlite3 native drivers', () => {
  const candidateDb = new PrototypeDatabase(':memory:');
  const appDb = new AppDatabase(':memory:');
  try {
    assert.equal(candidateDb.prepare('SELECT sqlite_version() AS version').get().version.length > 0, true);
    assert.equal(appDb.prepare('SELECT sqlite_version() AS version').get().version.length > 0, true);
  } finally {
    candidateDb.close();
    appDb.close();
  }

  const candidateManifest = JSON.parse(
    readFileSync(join(prototypeDirectory, 'node_modules/@langchain/langgraph-checkpoint-sqlite/package.json'), 'utf8')
  );
  assert.equal(candidateManifest.version, '1.1.0');
  assert.equal(candidateManifest.dependencies['better-sqlite3'], '^12.10.0');
  assert.equal(JSON.parse(readFileSync(join(prototypeDirectory, 'node_modules/better-sqlite3/package.json'), 'utf8')).version, '12.10.0');
  assert.equal(JSON.parse(readFileSync(join(repositoryRoot, 'node_modules/better-sqlite3/package.json'), 'utf8')).version, '13.0.3');
});

test('candidate better-sqlite3 native addon fails under Electron 45 ABI with the current no-rebuild packaging', () => {
  const electronPath = join(repositoryRoot, 'node_modules/.bin/electron');
  const candidateDriverPath = join(prototypeDirectory, 'node_modules/better-sqlite3');
  const result = spawnSync(electronPath, [
    '-e',
    `const Database = require(${JSON.stringify(candidateDriverPath)}); new Database(':memory:').close();`
  ], {
    cwd: repositoryRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8'
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /NODE_MODULE_VERSION 147/u);
  assert.match(result.stderr, /requires\s+NODE_MODULE_VERSION 150/u);
});

test('base saver storage, namespace, write ordering/deduplication, filter pagination, and transaction rollback', async () => {
  const db = createAgentDatabase();
  const { roc, official } = describeSaverPair(db);
  try {
    for (const saver of [roc, official]) {
      const alpha = await putCheckpoint(saver, 'namespace-thread', 'same-id', { namespace: 'alpha' }, 'alpha');
      await putCheckpoint(saver, 'namespace-thread', 'same-id', { namespace: 'beta' }, 'beta');
      assert.equal((await saver.getTuple(alpha)).metadata.namespace, 'alpha');

      const config = await putCheckpoint(saver, 'write-thread', 'write-checkpoint', { source: 'loop' });
      await saver.putWrites(config, [['channel', 'late']], 'task-b', 'path-2');
      await saver.putWrites(config, [['channel', 'root']], 'task-c', '');
      await saver.putWrites(config, [['channel', 'early']], 'task-a', 'path-1');
      await Promise.all([
        saver.putWrites(config, [['channel', 'parallel-first']], 'task-d', 'path-1'),
        saver.putWrites(config, [['channel', 'parallel-second']], 'task-e', 'path-2')
      ]);
      await saver.putWrites(config, [['channel', 'ignored-duplicate']], 'task-a', 'path-1');
      await saver.putWrites(config, [['__interrupt__', { id: 'interrupt-1', value: 'first' }]], 'task-c', '');
      await saver.putWrites(config, [['__interrupt__', { id: 'interrupt-1', value: 'replacement' }]], 'task-c', '');
    }

    const rocTuple = await roc.getTuple({ configurable: { thread_id: 'write-thread', checkpoint_ns: '', checkpoint_id: 'write-checkpoint' } });
    const officialTuple = await official.getTuple({ configurable: { thread_id: 'write-thread', checkpoint_ns: '', checkpoint_id: 'write-checkpoint' } });
    assert.deepEqual(officialTuple.pendingWrites, rocTuple.pendingWrites);
    assert.deepEqual(
      officialTuple.pendingWrites.map(([taskId, channel, value]) => `${taskId}:${channel}:${typeof value === 'object' ? value.value : value}`),
      [
        'task-c:__interrupt__:replacement',
        'task-c:channel:root',
        'task-a:channel:early',
        'task-d:channel:parallel-first',
        'task-b:channel:late',
        'task-e:channel:parallel-second'
      ]
    );

    for (const saver of [roc, official]) {
      for (let index = 0; index < 80; index += 1) {
        const checkpointId = `list-${String(index).padStart(3, '0')}`;
        await putCheckpoint(
          saver,
          'list-thread',
          checkpointId,
          { bucket: index % 2 === 0 ? 'keep' : 'skip', ordinal: index }
        );
      }
    }
    const listConfig = { configurable: { thread_id: 'list-thread', checkpoint_ns: '' } };
    const listOptions = { filter: { bucket: 'keep' }, limit: 7 };
    const rocIds = await collectCheckpointIds(roc, listConfig, listOptions);
    const officialIds = await collectCheckpointIds(official, listConfig, listOptions);
    assert.deepEqual(officialIds, rocIds);
    assert.deepEqual(officialIds, ['list-078', 'list-076', 'list-074', 'list-072', 'list-070', 'list-068', 'list-066']);

    db.exec(`
      CREATE TRIGGER force_official_write_failure
      BEFORE INSERT ON writes WHEN NEW.channel = 'boom'
      BEGIN SELECT RAISE(ABORT, 'forced_write_failure'); END;
      CREATE TRIGGER force_roc_write_failure
      BEFORE INSERT ON langgraph_checkpoint_writes WHEN NEW.channel = 'boom'
      BEGIN SELECT RAISE(ABORT, 'forced_write_failure'); END;
    `);
    for (const [saver, config] of [
      [roc, { configurable: { thread_id: 'write-thread', checkpoint_ns: '', checkpoint_id: 'write-checkpoint' } }],
      [official, { configurable: { thread_id: 'write-thread', checkpoint_ns: '', checkpoint_id: 'write-checkpoint' } }]
    ]) {
      await assert.rejects(
        saver.putWrites(config, [['channel', 'written-before-abort'], ['boom', 'abort']], 'atomic-batch'),
        /forced_write_failure/
      );
    }
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM writes WHERE task_id = 'atomic-batch'").get().count,
      0
    );
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM langgraph_checkpoint_writes WHERE task_id = 'atomic-batch'").get().count,
      0
    );
  } finally {
    db.close();
  }
});

test('legacy Roc checkpoints are invisible to the official schema and retention truncation lacks an integrity signal', async () => {
  const db = createAgentDatabase();
  const { roc, official } = describeSaverPair(db);
  try {
    const parent = await putCheckpoint(roc, 'legacy-thread', 'legacy-parent', { source: 'loop' });
    await roc.putWrites(parent, [['__interrupt__', { id: 'approval-1', value: { action: 'write' } }]], 'task-approval');
    assert.equal(roc.hasCheckpoint('legacy-thread'), true);
    assert.deepEqual(roc.readPendingInterrupts('legacy-thread'), [
      { interruptId: 'approval-1', payload: { action: 'write' } }
    ]);
    assert.equal(await official.getTuple(parent), undefined);
    assert.equal(typeof official.restoreFrom, 'undefined');
    assert.equal(typeof official.validateCheckpointIntegrity, 'undefined');
    assert.equal(typeof official.readPendingInterrupts, 'undefined');

    const rocParent = await putCheckpoint(roc, 'retained-thread', '0001-parent', { source: 'loop' });
    await putCheckpoint(roc, 'retained-thread', '0002-child', { source: 'loop' }, '', '0001-parent');
    const officialParent = await putCheckpoint(official, 'retained-thread', '0001-parent', { source: 'loop' });
    await putCheckpoint(official, 'retained-thread', '0002-child', { source: 'loop' }, '', '0001-parent');
    const childConfig = {
      configurable: { thread_id: 'retained-thread', checkpoint_ns: '', checkpoint_id: '0002-child' }
    };
    // Make the existing policy's intended retention order deterministic for this isolated comparison.
    db.prepare("UPDATE langgraph_checkpoints SET created_at = '2026-01-01T00:00:00.000Z' WHERE checkpoint_id = '0001-parent'").run();
    db.prepare("UPDATE langgraph_checkpoints SET created_at = '2026-01-02T00:00:00.000Z' WHERE checkpoint_id = '0002-child'").run();
    assert.equal(roc.deleteExcessCheckpoints({ protectedThreadIds: [], maxCheckpointsPerThread: 1 }).checkpoints, 1);
    assert.equal(roc.validateCheckpointIntegrity('retained-thread').valid, false);

    db.transaction(() => {
      db.prepare("DELETE FROM writes WHERE thread_id = 'retained-thread' AND checkpoint_id = '0001-parent'").run();
      db.prepare("DELETE FROM checkpoints WHERE thread_id = 'retained-thread' AND checkpoint_id = '0001-parent'").run();
    })();
    const childTuple = await official.getTuple(childConfig);
    assert.equal(childTuple.parentConfig.configurable.checkpoint_id, '0001-parent');
    assert.equal(await official.getTuple(childTuple.parentConfig), undefined);
    assert.equal(typeof official.deleteExcessCheckpoints, 'undefined');
    assert.equal(typeof official.validateCheckpointIntegrity, 'undefined');

    // The old Roc backup reader is custom and schema-aware; the official saver only creates its own empty tables.
    const legacyDatabase = createAgentDatabase();
    try {
      const legacySaver = new RocSqliteCheckpointer(legacyDatabase);
      const legacyConfig = await putCheckpoint(legacySaver, 'backup-thread', 'backup-checkpoint', { source: 'backup' });
      const candidateOnBackup = new SqliteSaver(legacyDatabase);
      assert.equal(await candidateOnBackup.getTuple(legacyConfig), undefined);
    } finally {
      legacyDatabase.close();
    }
    assert.equal(officialParent.configurable.checkpoint_id, '0001-parent');
    assert.equal(rocParent.configurable.checkpoint_id, '0001-parent');
  } finally {
    db.close();
  }
});

test('official Saver schema additions violate the current agent database schema contract on next initialization', async () => {
  const db = createAgentDatabase(PrototypeDatabase);
  const saver = new SqliteSaver(db);
  try {
    await saver.getTuple({ configurable: { thread_id: 'schema-thread', checkpoint_ns: '' } });
    assert.throws(
      () => applyDatabaseMigrations(db, { dbName: 'agent', migrations: agentMigrations }),
      /database_schema_rebuild_required/u
    );
  } finally {
    db.close();
  }
});

test('Roc file backups restore through Roc but remain invisible to the official saver', async () => {
  const scratch = createScratchDirectory('backup-restore');
  const sourcePath = join(scratch, 'agent.sqlite');
  const backupPath = join(scratch, 'agent-backup.sqlite');
  const destinationPath = join(scratch, 'restored-agent.sqlite');
  const sourceDb = createAgentDatabase(AppDatabase, sourcePath);
  let restoreSource;
  let destinationDb;
  let candidateDb;
  try {
    const sourceSaver = new RocSqliteCheckpointer(sourceDb);
    const config = await putCheckpoint(sourceSaver, 'backup-thread', 'backup-checkpoint', { source: 'backup' });
    await sourceDb.backup(backupPath);
    sourceDb.close();

    restoreSource = new AppDatabase(backupPath);
    destinationDb = createAgentDatabase(AppDatabase, destinationPath);
    const destinationSaver = new RocSqliteCheckpointer(destinationDb);
    destinationSaver.restoreFrom(restoreSource);
    assert.equal((await destinationSaver.getTuple(config)).checkpoint.id, 'backup-checkpoint');

    candidateDb = new PrototypeDatabase(backupPath);
    const candidateSaver = new SqliteSaver(candidateDb);
    assert.equal(await candidateSaver.getTuple(config), undefined);
    assert.equal(typeof candidateSaver.restoreFrom, 'undefined');
  } finally {
    sourceDb.close();
    restoreSource?.close();
    destinationDb?.close();
    candidateDb?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('interrupt checkpoint survives a true process restart and resumes under either saver', () => {
  const workerPath = join(prototypeDirectory, 'restart-probe.mjs');
  for (const backend of ['roc', 'official']) {
    const scratch = createScratchDirectory(`restart-${backend}`);
    const databasePath = join(scratch, 'agent.sqlite');
    try {
      const paused = runRestartProbe(workerPath, backend, 'pause', databasePath);
      assert.equal(paused.interruptCount, 1);
      const resumed = runRestartProbe(workerPath, backend, 'resume', databasePath);
      assert.equal(resumed.value, 'approved');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
});

test('SIGKILL inside putWrites rolls back the pending write while preserving the prior checkpoint', () => {
  const workerPath = join(prototypeDirectory, 'crash-probe.mjs');
  for (const backend of ['roc', 'official']) {
    const scratch = createScratchDirectory(`crash-${backend}`);
    const databasePath = join(scratch, 'agent.sqlite');
    try {
      const seeded = spawnSync(process.execPath, [workerPath, backend, 'seed', databasePath], {
        cwd: repositoryRoot,
        encoding: 'utf8'
      });
      assert.equal(seeded.error, undefined, seeded.error?.message);
      assert.equal(seeded.status, 0, seeded.stderr);

      const crashed = spawnSync(process.execPath, [workerPath, backend, 'crash', databasePath], {
        cwd: repositoryRoot,
        encoding: 'utf8'
      });
      assert.equal(crashed.error, undefined, crashed.error?.message);
      assert.equal(crashed.signal, 'SIGKILL');

      const verified = spawnSync(process.execPath, [workerPath, backend, 'verify', databasePath], {
        cwd: repositoryRoot,
        encoding: 'utf8'
      });
      assert.equal(verified.error, undefined, verified.error?.message);
      assert.equal(verified.status, 0, verified.stderr);
      const result = JSON.parse(verified.stdout.trim().split(/\\r?\\n/u).at(-1));
      assert.equal(result.checkpointExists, true);
      assert.deepEqual(result.pendingWrites, []);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
});

test('RunControl drains at a checkpoint boundary and resumes with the same thread under both savers', async () => {
  for (const backend of ['roc', 'official']) {
    const Database = backend === 'official' ? PrototypeDatabase : AppDatabase;
    const db = createAgentDatabase(Database);
    const saver = backend === 'official' ? new SqliteSaver(db) : new RocSqliteCheckpointer(db);
    const graphApi = backend === 'official' ? CandidateLanggraph : rootRequire('@langchain/langgraph');
    let markStarted;
    let releaseNode;
    let secondNodeRan = false;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const nodeGate = new Promise((resolve) => { releaseNode = resolve; });
    const State = graphApi.Annotation.Root({
      value: graphApi.Annotation({ reducer: (_left, right) => right, default: () => '' })
    });
    const graph = new graphApi.StateGraph(State)
      .addNode('first', async () => {
        markStarted();
        await nodeGate;
        return { value: 'checkpointed' };
      })
      .addNode('second', () => {
        secondNodeRan = true;
        return { value: 'resumed' };
      })
      .addEdge(graphApi.START, 'first')
      .addEdge('first', 'second')
      .addEdge('second', graphApi.END)
      .compile({ checkpointer: saver });
    const config = { configurable: { thread_id: `phase-7-drain-${backend}` } };
    const control = new graphApi.RunControl();

    try {
      const running = graph.invoke({ value: 'started' }, { ...config, control });
      await started;
      control.requestDrain('prototype-shutdown');
      releaseNode();
      await assert.rejects(running, (error) => error instanceof graphApi.GraphDrained);
      assert.equal(secondNodeRan, false);

      const resumed = await graph.invoke(null, {
        ...config,
        control: new graphApi.RunControl()
      });
      assert.equal(resumed.value, 'resumed');
      assert.equal(secondNodeRan, true);
    } finally {
      releaseNode();
      db.close();
    }
  }
});

test('AbortSignal cancels a running graph node under both savers', async () => {
  for (const backend of ['roc', 'official']) {
    const Database = backend === 'official' ? PrototypeDatabase : AppDatabase;
    const db = createAgentDatabase(Database);
    const saver = backend === 'official' ? new SqliteSaver(db) : new RocSqliteCheckpointer(db);
    const graphApi = backend === 'official' ? CandidateLanggraph : rootRequire('@langchain/langgraph');
    let markStarted;
    let nodeSignal;
    let secondNodeRan = false;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const State = graphApi.Annotation.Root({
      value: graphApi.Annotation({ reducer: (_left, right) => right, default: () => '' })
    });
    const graph = new graphApi.StateGraph(State)
      .addNode('pending', async (_state, config) => {
        nodeSignal = config.signal;
        markStarted();
        await new Promise((_, reject) => {
          if (nodeSignal === undefined) {
            reject(new Error('graph_abort_signal_not_forwarded'));
            return;
          }
          const timer = setTimeout(() => reject(new Error('graph_abort_signal_not_observed')), 1500);
          const onAbort = () => {
            clearTimeout(timer);
            reject(nodeSignal.reason ?? new Error('graph_node_aborted'));
          };
          if (nodeSignal.aborted) onAbort();
          else nodeSignal.addEventListener('abort', onAbort, { once: true });
        });
        return { value: 'must-not-commit' };
      })
      .addNode('after-cancel', () => {
        secondNodeRan = true;
        return { value: 'unexpected' };
      })
      .addEdge(graphApi.START, 'pending')
      .addEdge('pending', 'after-cancel')
      .addEdge('after-cancel', graphApi.END)
      .compile({ checkpointer: saver });
    const controller = new AbortController();
    const config = { configurable: { thread_id: `phase-7-abort-${backend}` } };

    try {
      const running = graph.invoke({ value: 'start' }, { ...config, signal: controller.signal });
      await started;
      assert.ok(nodeSignal instanceof AbortSignal);
      controller.abort(new Error('phase-7-cancelled'));
      await assert.rejects(running, /phase-7-cancelled|aborted/u);
      assert.equal(nodeSignal.aborted, true);
      assert.equal(secondNodeRan, false);
    } finally {
      controller.abort(new Error('phase-7-abort-cleanup'));
      db.close();
    }
  }
});

test('Roc effect store reuses completed results and rejects a duplicate reservation', () => {
  const db = createAgentDatabase();
  const store = new AgentToolEffectStore(db);
  const key = {
    runId: 'effect-run',
    executionPath: 'root',
    checkpointId: 'effect-checkpoint',
    toolCallId: 'effect-call'
  };
  const reserve = {
    ...key,
    threadId: 'effect-thread',
    toolName: 'write_file',
    inputHash: 'sha256:fixed-input',
    effectClass: 'workspace_mutation',
    reconcileStrategy: 'retry_safe'
  };
  try {
    store.reserve(reserve);
    store.markStarted(key);
    store.finishSuccess({ ...key, result: { path: 'output.txt', written: true } });
    assert.deepEqual(store.readReusable({ ...key, inputHash: reserve.inputHash }), {
      status: 'succeeded',
      result: { path: 'output.txt', written: true }
    });
    assert.throws(() => store.reserve(reserve), /agent_tool_effect_already_completed/);
  } finally {
    db.close();
  }
});

test('a completed tool side effect is not repeated when its graph node replays after process restart', () => {
  const workerPath = join(prototypeDirectory, 'effect-restart-probe.mjs');
  for (const backend of ['roc', 'official']) {
    const scratch = createScratchDirectory(`effect-restart-${backend}`);
    const databasePath = join(scratch, 'agent.sqlite');
    const effectLogPath = join(scratch, 'external-effect.log');
    try {
      const crashed = spawnSync(process.execPath, [workerPath, backend, 'crash', databasePath, effectLogPath], {
        cwd: repositoryRoot,
        encoding: 'utf8'
      });
      assert.equal(crashed.error, undefined, crashed.error?.message);
      assert.equal(crashed.signal, 'SIGKILL');
      assert.equal(readFileSync(effectLogPath, 'utf8').trim().split(/\\r?\\n/u).length, 1);

      const resumed = spawnSync(process.execPath, [workerPath, backend, 'resume', databasePath, effectLogPath], {
        cwd: repositoryRoot,
        encoding: 'utf8'
      });
      assert.equal(resumed.error, undefined, resumed.error?.message);
      assert.equal(resumed.status, 0, resumed.stderr);
      assert.equal(JSON.parse(resumed.stdout.trim().split(/\\r?\\n/u).at(-1)).value, 'external effect applied');
      assert.equal(readFileSync(effectLogPath, 'utf8').trim().split(/\\r?\\n/u).length, 1);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
});

function runRestartProbe(workerPath, backend, phase, databasePath) {
  const result = spawnSync(process.execPath, [workerPath, backend, phase, databasePath], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  const output = result.stdout.trim().split(/\r?\n/u).at(-1);
  assert.ok(output, 'restart probe must return a JSON result');
  return JSON.parse(output);
}
