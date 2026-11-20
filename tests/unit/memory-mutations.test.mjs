import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import Database from 'better-sqlite3';
import { StoreBackend } from 'deepagents';

const compiled = await build({
  stdin: { contents: `
    export { RocStoreMemoryBackend } from './src/main/services/deep-agent/store-memory-backend';
    export { MemoryStoreRepository } from './src/main/plugins/memory/memory-store-repository';
    export { AutoMemoryWriter } from './src/main/services/memory/auto-memory-writer';
    export { RocSqliteStore } from './src/main/services/memory/sqlite-store';
    export { withStoreMemoryMutation } from './src/main/services/memory/memory-mutations';
    export { CapacityService } from './src/main/services/memory/capacity';
    export { SecurityScanService } from './src/main/services/memory/security-scan';
    export { defaultSettings } from './src/main/services/config/defaults';
  `, resolveDir: fileURLToPath(new URL('../../', import.meta.url)) },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
  plugins: [{ name: 'absolute-dependencies', setup(builder) {
    builder.onResolve({ filter: /^(deepagents|@langchain\/langgraph)$/ }, args => ({
      path: import.meta.resolve(args.path), external: true
    }));
  } }]
});
const api = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const applicability = 'a'.repeat(64);

function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE langgraph_store_items(namespace_key TEXT, namespace_json TEXT, key TEXT,
    value_json TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY(namespace_key,key))`);
  const stores = [new api.RocSqliteStore(db), new api.RocSqliteStore(db)];
  const settings = structuredClone(api.defaultSettings.memory);
  settings.charLimits.memory = 20000;
  const repositories = stores.map(store => new api.MemoryStoreRepository({ store, getWorkspace: () => null,
    getMemorySettings: () => settings, agentFacts: { readSessionStats: () => ({ totalRows: 0, oldestAt: null }),
      readFullTextIndexHealth: () => ({ healthy: true, status: 'ready' }) } }));
  const audit = [];
  const writers = repositories.map(repository => new api.AutoMemoryWriter({ repository,
    getMemorySettings: () => settings, logger: { warn() {} }, auditRepository: {
      record: entry => audit.push(entry), countWritesForRun: run => audit.filter(entry => entry.sourceRunId === run &&
        ['accepted', 'maintenance_merged'].includes(entry.action)).length
    } }));
  const backends = stores.map(store => new api.RocStoreMemoryBackend(
    new StoreBackend({ store, namespace: ['roc', 'memory', 'global'] }), new Set(['/MEMORY.md']),
    new api.SecurityScanService(settings.securityScan), new api.CapacityService(settings.charLimits),
    new Map([['/MEMORY.md', 'memory']]), applicability, store, () => settings.autoMemory.enabled));
  return { stores, repositories, writers, backends, settings, audit,
    read: () => repositories[0].readFile({ scope: 'global', kind: 'memory' }) };
}
function request(key, overrides = {}) {
  return { applicability, status: 'active', counterexamples: [], executionKind: 'production',
    type: 'workspace_fact', confidence: 'high', key, summary: `Durable fact ${key}`,
    evidence: ['fixture evidence'], sourceRunId: `run-${key}`, workspacePath: null, ...overrides };
}

test('concurrent remember calls across store instances retain every distinct fact', async t => {
  const f = fixture(t);
  const outcomes = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    f.writers[i % 2].recordCandidate(request(`key-${i}`))));
  assert.ok(outcomes.every(outcome => outcome.status === 'accepted'));
  const content = await f.read();
  for (let i = 0; i < 12; i++) assert.ok(content.includes(`summary: Durable fact key-${i}\n`) || content.endsWith(`summary: Durable fact key-${i}`));
  assert.equal(f.audit.length, 12);
});

test('concurrent retries and quotas are checked inside the same mutation', async t => {
  const f = fixture(t);
  const outcomes = await Promise.all(f.writers.map(writer => writer.recordCandidate(request('same'))));
  assert.deepEqual(outcomes.map(outcome => outcome.status), ['accepted', 'duplicate']);
  f.settings.autoMemory.maxCandidatesPerRun = 1;
  const quota = await Promise.all(f.writers.map((writer, i) => writer.recordCandidate(request(`quota-${i}`, { sourceRunId: 'shared-run' }))));
  assert.deepEqual(quota.map(outcome => outcome.status), ['accepted', 'quota_exceeded']);
});

test('file edits and remember share the full read-modify-write boundary', async t => {
  const f = fixture(t);
  await f.backends[0].write('/MEMORY.md', '# Initial');
  const [remembered, edited] = await Promise.all([
    f.writers[0].recordCandidate(request('concurrent')),
    f.backends[1].edit('/MEMORY.md', 'Initial', 'Updated')
  ]);
  assert.equal(remembered.status, 'accepted');
  assert.equal(edited.occurrences, 1);
  const content = await f.read();
  assert.ok(content.startsWith('# Updated'));
  assert.ok(content.includes('summary: Durable fact concurrent'));
});

test('parallel file edits preserve both replacements', async t => {
  const f = fixture(t);
  await f.backends[0].write('/MEMORY.md', 'first second');
  const results = await Promise.all([
    f.backends[0].edit('/MEMORY.md', 'first', 'FIRST'),
    f.backends[1].edit('/MEMORY.md', 'second', 'SECOND')
  ]);
  assert.ok(results.every(result => result.occurrences === 1));
  assert.equal(await f.read(), 'FIRST SECOND');
});

test('concurrent topic creation respects the shared count limit', async t => {
  const f = fixture(t);
  const results = await Promise.all(Array.from({ length: 34 }, (_, i) => i % 2 === 0
    ? f.repositories[0].writeTopicFile({ scope: 'global', slug: `topic-${i}`, content: 'fact' }).then(result => result.ok)
    : f.backends[1].write(`/topics/topic-${i}.md`, 'fact').then(result => result.error === undefined)));
  assert.equal(results.filter(Boolean).length, 32);
  assert.equal((await f.repositories[0].listTopicFiles('global')).length, 32);
});

test('failed mutations release the queue and nested mutations do not deadlock', async t => {
  const f = fixture(t);
  await assert.rejects(api.withStoreMemoryMutation(f.stores[0], async () => { throw new Error('fixture failure'); }), /fixture failure/);
  const result = await api.withStoreMemoryMutation(f.stores[1], () => f.writers[0].recordCandidate(request('after-failure')));
  assert.equal(result.status, 'accepted');
});

test('auto-memory switch blocks model file writes and remember, but allows manual editing and reads', async t => {
  const f = fixture(t);
  await f.backends[0].write('/MEMORY.md', 'original');
  f.settings.autoMemory.enabled = false;
  assert.equal((await f.backends[1].write('/MEMORY.md', 'changed')).error, 'auto_memory_disabled');
  assert.equal((await f.backends[0].edit('/MEMORY.md', 'original', 'changed')).error, 'auto_memory_disabled');
  assert.equal((await f.writers[0].recordCandidate(request('disabled'))).status, 'disabled');
  assert.equal(await f.read(), 'original');
  assert.equal((await f.repositories[0].writeFile({ scope: 'global', kind: 'memory', content: 'manual' })).ok, true);
  assert.equal((await f.backends[0].readRaw('/MEMORY.md')).data.content, 'manual');
});
