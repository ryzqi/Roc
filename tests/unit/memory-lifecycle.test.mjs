import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import Database from 'better-sqlite3';

// Bundle in memory and use SQLite :memory: so failures cannot leave profile or bundle artifacts.
const compiled = await build({
  stdin: { contents: `
    export * from './src/main/services/memory/auto-memory-candidates';
    export { AutoMemoryWriter } from './src/main/services/memory/auto-memory-writer';
    export { MemoryStoreRepository } from './src/main/plugins/memory/memory-store-repository';
    export { RocSqliteStore } from './src/main/services/memory/sqlite-store';
    export { defaultSettings } from './src/main/services/config/defaults';
  `, resolveDir: process.cwd() },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
  plugins: [{ name: 'absolute-dependencies', setup(builder) {
    builder.onResolve({ filter: /^@langchain\/langgraph$/ }, args => ({ path: import.meta.resolve(args.path), external: true }));
  } }]
});
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const A = 'a'.repeat(64), B = 'b'.repeat(64);
const workspacePath = '/synthetic/memory-lifecycle';
const early = '2020-01-01T00:00:00.000Z';
const later = '2020-01-03T00:00:00.000Z';

function request(overrides = {}) {
  return { applicability: A, status: 'active', counterexamples: [], executionKind: 'production',
    type: 'workspace_fact', confidence: 'high', key: 'source-policy', summary: 'Keep source evidence linked.',
    evidence: ['user confirmed source policy'], sourceRunId: 'initial-run', sourceThreadId: null, workspacePath,
    ttlDays: null, revalidate: null, ...overrides };
}

function candidate(overrides = {}, createdAt = early) {
  return api.buildAutoMemoryCandidate(request(overrides), api.defaultSettings.memory.autoMemory, createdAt);
}

function document(overrides = {}, createdAt = early) {
  return api.appendAutoMemoryEntry('', createdAt.slice(0, 10), api.formatAutoMemoryEntry(candidate(overrides, createdAt)));
}

function visible(contents, applicability = A, today = '2020-01-10') {
  return api.projectAutoMemoryScope(contents, applicability, today).flatMap(api.parseAutoMemoryEntries);
}

function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE langgraph_store_items(namespace_key TEXT, namespace_json TEXT, key TEXT,
    value_json TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY(namespace_key,key))`);
  const repository = new api.MemoryStoreRepository({ store: new api.RocSqliteStore(db),
    getWorkspace: () => ({ path: workspacePath, label: 'fixture' }),
    agentFacts: { readSessionStats: () => ({ totalRows: 0, oldestAt: null }),
      readFullTextIndexHealth: () => ({ healthy: true, status: 'ready' }) } });
  const audit = [];
  const writer = new api.AutoMemoryWriter({ repository, logger: { warn() {} },
    auditRepository: { record: value => audit.push(value), countWritesForRun: run => audit.filter(record =>
      record.sourceRunId === run && ['accepted', 'maintenance_merged'].includes(record.action)).length } });
  const read = () => repository.readFile({ scope: 'workspace', kind: 'memory' });
  return { repository, writer, read, audit };
}

test('workspace facts and decisions survive environment changes and supersede across archives', () => {
  for (const type of ['workspace_fact', 'decision']) {
    const old = document({ type });
    const current = document({ type, applicability: B, summary: 'Use corrected source policy.' }, later);
    assert.equal(visible([old], B)[0].summary, 'Keep source evidence linked.');
    for (const contents of [[old, current], [current, old]]) for (const hash of [A, B]) {
      assert.deepEqual(visible(contents, hash).map(entry => entry.summary), ['Use corrected source policy.']);
    }
  }
});

test('revoked, pending and expired stable facts never expose archived predecessors', () => {
  for (const type of ['workspace_fact', 'decision']) for (const state of [
    { status: 'revoked', counterexamples: ['Source withdrawn'], ttlDays: 1 },
    { status: 'needs_revalidation', revalidate: 'Check changed source', ttlDays: 1 },
    { status: 'active', ttlDays: 1 }
  ]) {
    const archive = document({ type });
    const root = document({ type, applicability: B, ...state }, later);
    const maintained = api.pruneExpiredAutoMemoryEntries(root, '2099-01-01');
    assert.equal(maintained.removed.length, 0, 'latest invalid state must remain a tombstone');
    for (const hash of [A, B]) assert.deepEqual(visible([archive, maintained.content], hash), []);
  }
});

test('pitfalls and verifications have independent lifecycle per environment', () => {
  for (const type of ['pitfall', 'verification']) {
    const a = document({ type, summary: 'Environment A observation' });
    const b = document({ type, applicability: B, summary: 'Environment B observation' }, later);
    assert.deepEqual(visible([a, b], A).map(entry => entry.summary), ['Environment A observation']);
    assert.deepEqual(visible([a, b], B).map(entry => entry.summary), ['Environment B observation']);
    const revokedA = document({ type, status: 'revoked', counterexamples: ['A regressed'], ttlDays: 1 }, '2020-01-04T00:00:00.000Z');
    assert.deepEqual(visible([a, b, revokedA], A), []);
    assert.equal(visible([a, b, revokedA], B)[0].summary, 'Environment B observation');
  }
});

test('maintenance does not remove an expired environment state because another environment is newer', () => {
  const archivedA = document({ type: 'pitfall', summary: 'Obsolete A advice' });
  const expiredA = document({ type: 'pitfall', ttlDays: 1 }, later);
  const activeB = document({ type: 'pitfall', applicability: B }, '2020-01-05T00:00:00.000Z');
  const result = api.pruneExpiredAutoMemoryEntries(`${expiredA}\n\n${activeB}`, '2020-01-10');
  assert.equal(result.removed.length, 0);
  assert.deepEqual(visible([archivedA, result.content], A), []);
  assert.equal(visible([result.content], B).length, 1);
  const successorA = document({ type: 'pitfall', summary: 'Rechecked A advice' }, '2020-01-06T00:00:00.000Z');
  assert.equal(api.pruneExpiredAutoMemoryEntries(`${expiredA}\n\n${successorA}`, '2020-01-10').removed.length, 1);
});

test('malformed counterexamples are isolated but retain their supersession identity and line locators', () => {
  for (const invalid of ['not-json', '{}', '[1]', 'null']) {
    const old = document();
    const bad = document({ applicability: B, summary: 'Corrupt replacement' }, later).replace('counterexamples: []', `counterexamples: ${invalid}`);
    const healthy = document({ key: 'healthy', summary: 'Healthy unrelated fact' });
    assert.equal(api.parseAutoMemoryEntries(bad)[0].parseError, 'memory_counterexamples_invalid');
    assert.equal(api.parseAutoMemoryEntries(healthy)[0].parseError, null);
    for (const contents of [[old, bad, healthy], [bad, old, healthy]]) {
      const projected = api.projectAutoMemoryScope(contents, A, '2020-01-10');
      assert.deepEqual(projected.flatMap(api.parseAutoMemoryEntries).map(entry => entry.key), ['healthy']);
      projected.forEach((content, index) => assert.equal(content.split('\n').length, contents[index].split('\n').length));
    }
    const repaired = document({ applicability: B, summary: 'Revalidated replacement' }, '2020-01-04T00:00:00.000Z');
    assert.equal(visible([old, bad, repaired], A)[0].summary, 'Revalidated replacement');
  }
});

test('corrupt experiences cannot shadow other environments, and tied bad entries suppress valid archive copies', () => {
  const a = document({ type: 'verification' });
  const badB = document({ type: 'verification', applicability: B }, later).replace('counterexamples: []', 'counterexamples: invalid');
  assert.equal(visible([a, badB], A).length, 1);
  assert.equal(visible([a, badB], B).length, 0);
  const badA = a.replace('counterexamples: []', 'counterexamples: invalid');
  assert.deepEqual(visible([a, badA]), []);
  assert.deepEqual(visible([badA, a]), []);
});

test('tied expired state suppresses nonexpiring archive copies in either document order', () => {
  const old = document();
  const expired = document({ ttlDays: 1 });
  for (const contents of [[old, expired], [expired, old]]) assert.deepEqual(visible(contents), []);
});

test('expired facts renew only in a new evidenced run; retries leave bytes and accepted-write count unchanged', async t => {
  const f = fixture(t);
  const original = request({ ttlDays: 1 });
  assert.equal((await f.writer.recordCandidate(original, early)).status, 'accepted');
  const before = await f.read();
  assert.deepEqual(visible([before], A, '2099-01-01'), []);
  assert.equal((await f.writer.recordCandidate({ ...original, ttlDays: 30 }, '2099-01-01T00:00:00.000Z')).status, 'duplicate');
  assert.equal(await f.read(), before);
  const renewed = { ...original, sourceRunId: 'confirmation-run', ttlDays: 30, evidence: ['user confirmed source policy again'] };
  assert.equal((await f.writer.recordCandidate(renewed, '2099-01-01T00:00:00.000Z')).status, 'accepted');
  const after = await f.read();
  assert.equal(visible([after], B, '2099-01-15')[0].source, 'confirmation-run');
  assert.equal((await f.writer.recordCandidate(renewed, '2099-01-02T00:00:00.000Z')).status, 'duplicate');
  assert.equal((await f.writer.recordCandidate(original, '2099-01-03T00:00:00.000Z')).status, 'duplicate');
  assert.equal(await f.read(), after);
  assert.equal(f.audit.filter(record => record.action === 'accepted').length, 2);
});

test('an expired decision without fresh evidence cannot be renewed merely by changing run', () => {
  const expired = document({ type: 'decision', evidence: [], ttlDays: 1 });
  assert.equal(api.autoMemoryEntryExists(expired, candidate({ type: 'decision', evidence: [], ttlDays: 30, sourceRunId: 'next' }, later)), true);
  assert.equal(api.autoMemoryEntryExists(expired, candidate({ type: 'decision', ttlDays: 30, sourceRunId: 'next' }, later)), false);
});

test('writer deduplicates archived retries and cannot restore a revoked fact after a stale retry', async t => {
  const f = fixture(t);
  const old = document();
  const revoked = document({ status: 'revoked', counterexamples: ['Contradicted by the source'], sourceRunId: 'revoke-run' }, later);
  assert.equal((await f.repository.writeTopicFile({ scope: 'workspace', slug: 'archive-fixture', content: old })).ok, true);
  assert.equal((await f.repository.writeFile({ scope: 'workspace', kind: 'memory', content: revoked })).ok, true);
  assert.equal((await f.writer.recordCandidate(request(), '2020-01-05T00:00:00.000Z')).status, 'duplicate');
  assert.equal(await f.read(), revoked);
  assert.deepEqual(visible([old, await f.read()], B), []);
});

test('writer deduplicates stable facts across hashes without swallowing independent experiences', async t => {
  const f = fixture(t);
  assert.equal((await f.writer.recordCandidate(request(), early)).status, 'accepted');
  assert.equal((await f.writer.recordCandidate(request({ applicability: B, sourceRunId: 'other' }), later)).status, 'duplicate');
  for (const type of ['pitfall', 'verification']) {
    assert.equal((await f.writer.recordCandidate(request({ type, key: type, sourceRunId: `${type}-a` }), early)).status, 'accepted');
    assert.equal((await f.writer.recordCandidate(request({ type, key: type, applicability: B, sourceRunId: `${type}-b` }), later)).status, 'accepted');
  }
  const docs = (await f.repository.collectSearchDocuments()).map(item => item.content);
  for (const hash of [A, B]) assert.equal(visible(docs, hash).length, 3);
});

test('revalidation with new evidence in the same run remains supported and probe writes stay forbidden', async t => {
  const f = fixture(t);
  const original = request({ type: 'verification' });
  assert.equal((await f.writer.recordCandidate(original, early)).status, 'accepted');
  assert.equal((await f.writer.recordCandidate({ ...original, status: 'needs_revalidation', revalidate: 'Check source' }, later)).status, 'accepted');
  assert.equal((await f.writer.recordCandidate({ ...original, evidence: ['tool observed rechecked source'] }, '2020-01-04T00:00:00.000Z')).status, 'accepted');
  assert.equal(visible([await f.read()])[0].status, 'active');
  const before = await f.read(), auditLength = f.audit.length;
  assert.equal((await f.writer.recordCandidate({ ...original, executionKind: 'probe' })).reason, 'probe_memory_write_forbidden');
  assert.equal(await f.read(), before);
  assert.equal(f.audit.length, auditLength);
});
