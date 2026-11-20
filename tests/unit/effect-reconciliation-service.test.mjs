import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';
import { build } from 'esbuild';

let directory;
let moduleUrl;
let api;

before(async () => {
  await mkdir('.runtime', { recursive: true });
  directory = await mkdtemp(join(process.cwd(), '.runtime', 'effect-reconciliation-'));
  const outfile = join(directory, 'fixture.mjs');
  const modules = {
    'src/main/services/deep-agent/effect-reconciliation-service.ts': ['EffectReconciliationService'],
    'src/main/services/deep-agent/tool-effect-store.ts': ['AgentToolEffectStore', 'hashToolInput'],
    'src/main/services/deep-agent/atomic-filesystem-backend.ts': ['AtomicFilesystemBackend'],
    'src/main/kernel/capability-operation-context.ts': ['createCapabilityOperationContext', 'runWithCapabilityOperationContext'],
    'src/main/infrastructure/database-schemas.ts': ['applyAgentDatabaseSchema']
  };
  await build({stdin: {contents: Object.entries(modules).map(([path, names]) =>
    `export { ${names.join(', ')} } from ${JSON.stringify(join(process.cwd(), path))};`).join('\n'),
  resolveDir: process.cwd(), sourcefile: 'effect-reconciliation-fixture.ts'}, outfile, bundle: true,
  packages: 'external', platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent'});
  moduleUrl = pathToFileURL(outfile).href;
  api = await import(moduleUrl);
});

after(async () => {
  if (directory !== undefined) await rm(directory, {recursive: true, force: true});
});

async function fixture(phase, previous) {
  const root = await mkdtemp(join(directory, 'case-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  if (previous !== undefined) await writeFile(join(workspace, 'notes.md'), previous);
  const value = await stat(workspace);
  const workspaceIdentity = {path: await realpath(workspace), dev: String(value.dev), ino: String(value.ino)};
  const operation = {runId: 'run', threadId: 'thread', executionPath: 'main', checkpointId: 'checkpoint', toolCallId: 'call',
    toolName: 'write_file', canonicalToolIdentity: 'builtin:write_file', toolVersion: 'roc-runtime-tool-v1',
    args: {file_path: '/workspace/notes.md', content: 'durable content'}, effectClass: 'workspace_mutation', reconcileStrategy: 'retry_safe'};
  const dbPath = join(root, 'agent.sqlite');
  let db;
  try {
    const script = `
      import Database from 'better-sqlite3';
      import * as api from ${JSON.stringify(moduleUrl)};
      const operation = ${JSON.stringify(operation)};
      const db = new Database(${JSON.stringify(dbPath)});
      api.applyAgentDatabaseSchema(db);
      const store = new api.AgentToolEffectStore(db);
      const {lease} = store.beginOperation(operation);
      store.markStarted(lease);
      const context = api.createCapabilityOperationContext({...lease, recordReceipt(receipt) {
        store.recordReceipt(lease, receipt);
        if (receipt.phase === ${JSON.stringify(phase)}) process.exit(73);
      }});
      const backend = new api.AtomicFilesystemBackend({rootDir: ${JSON.stringify(workspace)}, virtualMode: true});
      await api.runWithCapabilityOperationContext(context, () => backend.write('/notes.md', 'durable content'));
      process.exit(74);
    `;
    const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', script], {cwd: process.cwd(), encoding: 'utf8', timeout: 15000});
    assert.equal(crashed.status, 73, crashed.stderr);
    db = new Database(dbPath);
    api.applyAgentDatabaseSchema(db);
    const store = new api.AgentToolEffectStore(db);
    store.markRestartedUnknown(operation.runId);
    const input = {runId: operation.runId, threadId: operation.threadId, workspaceIdentity};
    return {root, workspace, db, store, operation, input, service: new api.EffectReconciliationService(store),
      async dispose() { db.close(); await rm(root, {recursive: true, force: true}); }};
  } catch (error) {
    db?.close();
    await rm(root, {recursive: true, force: true});
    throw error;
  }
}

test('published write survives process crash, SQLite reopen and reconciles to replay without another write', async () => {
  const f = await fixture('published', 'before');
  try {
    const before = await stat(join(f.workspace, 'notes.md'));
    const result = await f.service.reconcileRun(f.input);
    assert.equal(result.resolved[0]?.outcome, 'applied');
    assert.deepEqual(result.unresolved, []);
    const replay = f.store.beginOperation(f.operation);
    assert.equal(replay.kind, 'replay');
    assert.equal(replay.result.kind, 'tool_message');
    assert.equal(replay.result.status, 'success');
    assert.equal(replay.result.toolCallId, f.operation.toolCallId);
    assert.match(replay.result.content, /Verified completed write/);
    assert.equal((await stat(join(f.workspace, 'notes.md'))).ino, before.ino);
    assert.equal(await readFile(join(f.workspace, 'notes.md'), 'utf8'), 'durable content');
    assert.deepEqual(await f.service.reconcileRun(f.input), {resolved: [], unresolved: []});
    assert.equal(f.db.prepare('SELECT count(*) FROM agent_tool_effect_reconciliations').pluck().get(), 1);
  } finally { await f.dispose(); }
});

for (const previous of [undefined, 'before']) {
  test(`prepared write with ${previous === undefined ? 'absent' : 'existing'} pre-image needs intact staging proof before retry`, async () => {
    const f = await fixture('prepared', previous);
    try {
      const result = await f.service.reconcileRun(f.input);
      assert.equal(result.resolved[0]?.outcome, 'not_applied');
      assert.deepEqual(result.unresolved, []);
      assert.equal((await readdir(f.workspace)).some(name => name.startsWith('.roc-')), false);
      const retry = f.store.beginOperation(f.operation);
      assert.equal(retry.kind, 'execute');
      f.store.markStarted(retry.lease);
      const context = api.createCapabilityOperationContext({...retry.lease, recordReceipt: receipt => f.store.recordReceipt(retry.lease, receipt)});
      const backend = new api.AtomicFilesystemBackend({rootDir: f.workspace, virtualMode: true});
      const written = await api.runWithCapabilityOperationContext(context, () => backend.write('/notes.md', 'durable content'));
      assert.equal(written.error, undefined);
      f.store.finishSuccess(retry.lease, {kind: 'tool_message', name: 'write_file', toolCallId: 'call', content: 'written', status: 'success'});
      assert.equal(f.store.beginOperation(f.operation).kind, 'replay');
      assert.equal(await readFile(join(f.workspace, 'notes.md'), 'utf8'), 'durable content');
    } finally { await f.dispose(); }
  });
}

test('unchanged pre-image alone cannot prove not-applied when staging evidence is missing', async () => {
  const f = await fixture('prepared', 'before');
  try {
    const receipt = f.store.readState(f.operation).receipt;
    await unlink(join(f.workspace, receipt.recovery.stagingPath));
    const result = await f.service.reconcileRun(f.input);
    assert.equal(result.resolved.length, 0);
    assert.equal(result.unresolved.length, 1);
    assert.equal(f.store.readState(f.operation).status, 'unknown');
  } finally { await f.dispose(); }
});

for (const mutation of ['content', 'root', 'symlink', 'generation', 'legacy-proof']) {
  test(`reconciliation refuses ${mutation} drift without changing unknown state or outside files`, async () => {
    const f = await fixture('published', 'before');
    try {
      const target = join(f.workspace, 'notes.md');
      if (mutation === 'content') await writeFile(target, 'external edit');
      if (mutation === 'root') {
        await rename(f.workspace, join(f.root, 'original'));
        await mkdir(f.workspace);
        await writeFile(target, 'durable content');
      }
      if (mutation === 'symlink') {
        await writeFile(join(f.root, 'outside'), 'durable content');
        await unlink(target);
        await symlink(join(f.root, 'outside'), target);
      }
      if (mutation === 'legacy-proof') {
        const receipt = f.store.readState(f.operation).receipt;
        delete receipt.recovery;
        f.db.prepare('UPDATE agent_tool_effects SET receipt_json=?, receipt_hash=?').run(JSON.stringify(receipt), api.hashToolInput(receipt));
      }
      if (mutation === 'generation') {
        const read = f.store.readUnresolvedOperations.bind(f.store);
        f.store.readUnresolvedOperations = (...args) => {
          const rows = read(...args);
          f.db.prepare('UPDATE agent_tool_effects SET lease_generation=lease_generation+1').run();
          return rows;
        };
      }
      const result = await f.service.reconcileRun(f.input);
      assert.equal(result.resolved.length, 0);
      assert.equal(result.unresolved.length, 1);
      assert.equal(f.store.readState(f.operation).status, 'unknown');
      assert.equal(f.db.prepare('SELECT count(*) FROM agent_tool_effect_reconciliations').pluck().get(), 0);
      if (mutation === 'symlink') assert.equal(await readFile(join(f.root, 'outside'), 'utf8'), 'durable content');
    } finally { await f.dispose(); }
  });
}

test('wrong thread and corrupted persisted identity cannot bypass original reconciliation checks', async () => {
  const f = await fixture('published');
  try {
    await assert.rejects(f.service.reconcileRun({...f.input, threadId: 'other'}), /input_drift/);
    f.db.prepare('UPDATE agent_tool_effects SET input_hash=?').run('0'.repeat(64));
    const result = await f.service.reconcileRun(f.input);
    assert.equal(result.resolved.length, 0);
    assert.equal(result.unresolved.length, 1);
    assert.equal(f.store.readState(f.operation).status, 'unknown');
  } finally { await f.dispose(); }
});
