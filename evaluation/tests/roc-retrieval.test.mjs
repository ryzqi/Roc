import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createInterface} from 'node:readline';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import electron from 'electron';
import {build} from 'esbuild';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {directory, EVAL_ROOT, fileInventory} from '../lib/common.mjs';
import {BudgetController} from '../lib/budget.mjs';
import {connectRocRetrieval, openRocRetrieval} from '../lib/roc-retrieval.mjs';
import {testArtifacts} from './test-artifacts.mjs';

const artifacts = testArtifacts('retrieval');
// Load both seams in one graph so their fixed error classes are shared, as in
// the real bundled host. This temporary entry belongs to this test's lifetime.
const entry = join(artifacts, 'entry.ts');
writeFileSync(entry, [
  `export * from ${JSON.stringify(join(EVAL_ROOT, 'runtime/configured-retrieval.ts'))};`,
  `export {serveRetrievalHost, configureRetrievalApplication} from ${JSON.stringify(join(EVAL_ROOT, 'runtime/retrieval-host.ts'))};`
].join('\n'));
const {openConfiguredRetrieval, serveRetrievalHost, configureRetrievalApplication, retrievalError, retrievalCorrelation} =
  await importTypeScriptModule(entry, {platform: 'node', external: ['better-sqlite3', 'zod', 'electron'],
    tempDir: join(artifacts, 'imports')});
const {terminateProcessTreeWithRetry} = await importTypeScriptModule('src/main/services/process-tree.ts', {platform: 'node'});

const originalFetch = globalThis.fetch;
let unexpectedNetworkCalls = 0;
const noNetwork = async () => { unexpectedNetworkCalls++; throw new Error('retrieval_test_network_forbidden'); };
globalThis.fetch = noNetwork;
after(() => {
  globalThis.fetch = originalFetch;
  assert.equal(unexpectedNetworkCalls, 0, 'all model transport in these tests must use fake fetch');
});
const plugin = '@roc/plugin-research', embeddingSecret = 'embedding-reference-sentinel', rerankerSecret = 'reranker-reference-sentinel';
const embeddingCredential = 'embedding-credential-sentinel', rerankerCredential = 'reranker-credential-sentinel';
const embeddingEndpoint = 'https://embedding-endpoint-sentinel.invalid/v1';
const rerankerEndpoint = 'https://reranker-endpoint-sentinel.invalid/rank';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const code = expected => error => {
  assert.equal(error.message, expected);
  assert.equal(error.code, expected);
  assert.equal(error.cause, undefined);
  return true;
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}});
}
function vectors(count) {
  return Array.from({length: count}, (_, index) => [index + 0.25, index + 0.5]);
}
function embeddingReply(texts) {
  return json({data: vectors(texts.length).map((embedding, index) => ({index, embedding})).reverse()});
}
function untilAbort(signal) {
  return new Promise((_, reject) => {
    // A referenced guard keeps the loop alive for AbortSignal.timeout's unref
    // timer; it is always cleared by cancellation, never a blocking wait.
    const guard = setTimeout(() => reject(new Error('fixture_abort_not_received')), 2000);
    const abort = () => {clearTimeout(guard); reject(signal.reason);};
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, {once: true});
  });
}
function fixture(name) {
  const rocRoot = directory(artifacts, name), snapshotParent = directory(artifacts, 'snapshots');
  mkdirSync(join(rocRoot, 'data/plugins/@roc'), {recursive: true});
  const corePath = join(rocRoot, 'data/core.db'), researchPath = join(rocRoot, 'data/plugins/@roc/plugin-research.db');
  const core = new Database(corePath);
  try {
    core.exec(`CREATE TABLE plugin_config (
      plugin_id TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(plugin_id,key));
      CREATE TABLE plugin_secrets (
      plugin_id TEXT NOT NULL, key TEXT NOT NULL, ciphertext_base64 TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(plugin_id,key));`);
    for (const key of [embeddingSecret, rerankerSecret]) {
      core.prepare('INSERT INTO plugin_secrets VALUES (?,?,?,?)')
        .run(plugin, key, Buffer.from(`ciphertext:${key}`).toString('base64'), 'fixture');
    }
    // Deliberately use a different insertion order from the production schema.
    core.prepare('INSERT INTO plugin_config VALUES (?,?,?,?)').run(plugin, 'research.reranker',
      JSON.stringify({secretKey: rerankerSecret, timeoutMs: 100, enabled: true, model: 'fixture-reranker', endpoint: rerankerEndpoint}), 'fixture');
  } finally {core.close();}
  const research = new Database(researchPath);
  try {
    research.exec(`CREATE TABLE research_embedding_configs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, model TEXT NOT NULL, dimensions INTEGER NOT NULL,
      api_key_secret_key TEXT NOT NULL, enabled INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1);`);
    const insert = research.prepare('INSERT INTO research_embedding_configs VALUES (?,?,?,?,?,?,?,?,?,?)');
    insert.run('older', 'Older', embeddingEndpoint, 'fixture-embedding-old', 2, embeddingSecret, 1, 'fixture', '2026-01-01', 1);
    insert.run('selected', 'Current', embeddingEndpoint, 'fixture-embedding', 2, embeddingSecret, 1, 'fixture', '2026-02-01', 3);
    insert.run('disabled', 'Disabled', embeddingEndpoint, 'fixture-embedding-disabled', 2, embeddingSecret, 0, 'fixture', '2026-03-01', 4);
  } finally {research.close();}
  return {rocRoot, snapshotParent, corePath, researchPath};
}
function update(path, sql, ...args) {
  const db = new Database(path);
  try { db.prepare(sql).run(...args); } finally { db.close(); }
}
function storage(overrides = {}) {
  const calls = {available: 0, decrypt: [], encrypt: 0};
  const backend = {
    isEncryptionAvailable: async () => {calls.available++; return true;},
    decryptString: async bytes => {
      calls.decrypt.push(bytes.toString());
      return {plaintext: bytes.toString() === `ciphertext:${embeddingSecret}` ? embeddingCredential : rerankerCredential,
        shouldReEncrypt: true};
    },
    encryptString: async () => {calls.encrypt++; throw new Error('credential_write_forbidden');},
    ...overrides
  };
  return {backend, calls};
}
async function open(t, source, selection = {mode: 'hybrid', rerank: 'semantic'}, dependencies = {}, backend = storage().backend) {
  const transport = await openConfiguredRetrieval(source.rocRoot, backend, selection, {
    snapshotParent: source.snapshotParent, embeddingFetch: noNetwork, rerankerFetch: noNetwork, ...dependencies
  });
  t.after(() => transport.close());
  return transport;
}
const stubIdentity = Object.freeze({
  embedding: {id: 'fixture', model: 'fixture-embedding', dimensions: 2, revision: 1, configurationHash: 'e'.repeat(64)},
  reranker: null
});
function stub(overrides = {}) {
  return {identity: stubIdentity, embed: async texts => vectors(texts.length), rerank: async () => ({
    scores: null, receipt: {status: 'not_requested', model: null, configHash: null, elapsedMs: 0}
  }), close: async () => {}, ...overrides};
}
async function harness(t, openFactory, options = {rocRoot: artifacts, mode: 'hybrid'}, transform = value => value) {
  const child = new EventEmitter(), sent = [], received = [];
  child.stdin = new PassThrough(); child.stdout = new PassThrough();
  child.stdin.on('data', bytes => {
    for (const line of bytes.toString().trimEnd().split('\n')) received.push(JSON.parse(line));
  });
  const lines = createInterface({input: child.stdin});
  const done = serveRetrievalHost(lines, value => {
    sent.push(structuredClone(value));
    child.stdout.write(`${JSON.stringify(transform(structuredClone(value)))}\n`);
  }, openFactory).finally(() => {child.stdout.end(); lines.close(); child.emit('close', 0);});
  let closes = 0;
  const closeHost = async () => {closes++; child.stdin.end(); await done;};
  t.after(async () => {child.stdin.end(); await done; child.stdout.destroy();});
  const transport = await connectRocRetrieval(child, options, closeHost);
  t.after(() => transport.close());
  return {transport, sent, received, child, get closes() {return closes;}};
}

test('bm25/none opens without databases, safeStorage or transport and keeps unavailable identity explicit', async t => {
  const rocRoot = join(artifacts, 'absent-roc-root'), keys = storage({
    isEncryptionAvailable: async () => {throw new Error('must_not_touch_safe_storage');}
  });
  const transport = await openConfiguredRetrieval(rocRoot, keys.backend);
  t.after(() => transport.close());
  assert.deepEqual(transport.identity, {embedding: null, reranker: null});
  assert.deepEqual(await transport.rerank('query', ['document']), {
    scores: null, receipt: {status: 'not_requested', model: null, configHash: null, elapsedMs: 0}
  });
  await assert.rejects(transport.embed(['text']), code('roc_retrieval_embedding_unavailable'));
  assert.equal(existsSync(rocRoot), false);
  assert.equal(keys.calls.decrypt.length, 0);
});

test('configured retrieval uses real production clients, sanitized frozen identities and no configuration/credential writes', async t => {
  const source = fixture('readonly'), before = fileInventory(source.rocRoot), keys = storage(), requests = [];
  const transport = await open(t, source, undefined, {
    embeddingFetch: async (url, init) => {
      requests.push({kind: 'embedding', url, init, body: JSON.parse(init.body)});
      return embeddingReply(JSON.parse(init.body).input);
    },
    rerankerFetch: async (url, init) => {
      requests.push({kind: 'rerank', url, init, body: JSON.parse(init.body)});
      return json({results: [{index: 1, relevance_score: 0.2}, {index: 0, relevance_score: 0.9}]});
    }
  }, keys.backend);
  assert.equal(requests.length, 0, 'opening must not probe dimensions or make model requests');
  assert.deepEqual(Object.keys(transport.identity.embedding).sort(), ['configurationHash', 'dimensions', 'id', 'model', 'revision']);
  assert.deepEqual(Object.keys(transport.identity.reranker).sort(), ['configurationHash', 'model', 'timeoutMs']);
  assert.equal(transport.identity.embedding.id, 'selected');
  assert.equal(transport.identity.embedding.revision, 3);
  assert.equal(transport.identity.embedding.dimensions, 2);
  assert.equal(transport.identity.embedding.model, 'fixture-embedding');
  assert.equal(transport.identity.reranker.model, 'fixture-reranker');
  assert.ok(Object.isFrozen(transport.identity) && Object.isFrozen(transport.identity.embedding) && Object.isFrozen(transport.identity.reranker));
  assert.deepEqual(await transport.embed(['first', 'second']), vectors(2));
  const ranked = await transport.rerank('query', ['first', 'second']);
  assert.deepEqual(ranked.scores, [0.9, 0.2]);
  assert.equal(ranked.receipt.status, 'succeeded');
  assert.equal(ranked.receipt.configHash, transport.identity.reranker.configurationHash);
  assert.equal(ranked.receipt.model, transport.identity.reranker.model);
  assert.ok(Number.isFinite(ranked.receipt.elapsedMs) && ranked.receipt.elapsedMs >= 0);
  assert.equal(requests[0].url, `${embeddingEndpoint}/embeddings`);
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers.authorization, `Bearer ${embeddingCredential}`);
  assert.deepEqual(requests[0].body, {model: 'fixture-embedding', input: ['first', 'second'], encoding_format: 'float'});
  assert.equal(requests[1].url, rerankerEndpoint);
  assert.equal(requests[1].init.headers.authorization, `Bearer ${rerankerCredential}`);
  assert.deepEqual(requests[1].body, {model: 'fixture-reranker', query: 'query', documents: ['first', 'second'], top_n: 2});
  assert.equal(keys.calls.available, 2);
  assert.deepEqual(keys.calls.decrypt, [`ciphertext:${embeddingSecret}`, `ciphertext:${rerankerSecret}`]);
  assert.equal(keys.calls.encrypt, 0, 'rotation hints must never trigger credential writes');
  assert.deepEqual(fileInventory(source.rocRoot), before);
  assert.deepEqual(readdirSync(source.snapshotParent), []);
  for (const hidden of [embeddingEndpoint, rerankerEndpoint, embeddingSecret, rerankerSecret, embeddingCredential, rerankerCredential]) {
    assert.equal(JSON.stringify(transport.identity).includes(hidden), false);
  }
});

test('explicit embedding selection and revisions are pinned; disabled/missing selections fail before any request', async t => {
  const source = fixture('selection');
  const older = await open(t, source, {mode: 'hybrid', embeddingConfigId: 'older'});
  const selected = await open(t, source, {mode: 'hybrid'});
  assert.equal(older.identity.embedding.model, 'fixture-embedding-old');
  assert.equal(older.identity.embedding.revision, 1);
  assert.notEqual(older.identity.embedding.configurationHash, selected.identity.embedding.configurationHash);
  update(source.researchPath, 'UPDATE research_embedding_configs SET revision=revision+1 WHERE id=?', 'selected');
  const revised = await open(t, source, {mode: 'hybrid'});
  assert.equal(revised.identity.embedding.revision, 4);
  assert.notEqual(selected.identity.embedding.configurationHash, revised.identity.embedding.configurationHash);
  assert.equal(selected.identity.embedding.revision, 3, 'an opened transport must retain its original configuration');
  for (const [embeddingConfigId, expected] of [['absent', 'roc_retrieval_embedding_unavailable'], ['disabled', 'roc_retrieval_embedding_disabled']]) {
    await assert.rejects(openConfiguredRetrieval(source.rocRoot, storage().backend, {mode: 'hybrid', embeddingConfigId},
      {snapshotParent: source.snapshotParent}), code(expected));
  }
  assert.deepEqual(readdirSync(source.snapshotParent), []);
});

test('missing/malformed/disabled reranker and invalid embedding settings are hard redacted configuration errors', async () => {
  const cases = [
    ['embedding-dimensions', 'researchPath', 'UPDATE research_embedding_configs SET dimensions=-1 WHERE id=?', ['selected'],
      {mode: 'hybrid'}, 'roc_retrieval_configuration_invalid'],
    ['embedding-url', 'researchPath', 'UPDATE research_embedding_configs SET base_url=? WHERE id=?',
      ['https://userinfo@endpoint.invalid', 'selected'], {mode: 'hybrid'}, 'roc_retrieval_configuration_invalid'],
    ['reranker-json', 'corePath', 'UPDATE plugin_config SET value_json=?', ['invalid-json-credential-sentinel'],
      {rerank: 'semantic'}, 'roc_retrieval_configuration_invalid'],
    ['reranker-missing', 'corePath', 'DELETE FROM plugin_config', [], {rerank: 'semantic'}, 'roc_retrieval_reranker_unavailable'],
    ['reranker-model', 'corePath', 'UPDATE plugin_config SET value_json=?',
      [JSON.stringify({endpoint: rerankerEndpoint, model: 'fixture\nmodel', enabled: true, timeoutMs: 100, secretKey: rerankerSecret})],
      {rerank: 'semantic'}, 'roc_retrieval_configuration_invalid'],
    ['reranker-disabled', 'corePath', 'UPDATE plugin_config SET value_json=?',
      [JSON.stringify({endpoint: rerankerEndpoint, model: 'fixture-reranker', enabled: false, timeoutMs: 100, secretKey: rerankerSecret})],
      {rerank: 'semantic'}, 'roc_retrieval_reranker_disabled']
  ];
  for (const [name, database, sql, args, selection, expected] of cases) {
    const source = fixture(name); update(source[database], sql, ...args);
    const before = fileInventory(source.rocRoot), keys = storage();
    await assert.rejects(openConfiguredRetrieval(source.rocRoot, keys.backend, selection,
      {snapshotParent: source.snapshotParent}), code(expected));
    assert.equal(keys.calls.decrypt.length, 0);
    assert.deepEqual(fileInventory(source.rocRoot), before);
    assert.deepEqual(readdirSync(source.snapshotParent), []);
  }
});

test('plugin credentials use the research namespace and all storage failures remain fixed and redacted', async () => {
  const missing = fixture('missing-credentials');
  update(missing.corePath, 'UPDATE plugin_secrets SET plugin_id=?', '@roc/other-plugin');
  await assert.rejects(openConfiguredRetrieval(missing.rocRoot, storage().backend, {mode: 'hybrid'},
    {snapshotParent: missing.snapshotParent}), code('roc_retrieval_credential_missing'));
  for (const [name, overrides, expected] of [
    ['storage-disabled', {isEncryptionAvailable: async () => false}, 'roc_retrieval_secret_storage_unavailable'],
    ['storage-error', {isEncryptionAvailable: async () => {throw new Error('native-credential-sentinel');}}, 'roc_retrieval_credential_unavailable'],
    ['decrypt-error', {decryptString: async () => {throw new Error('native-endpoint-credential-sentinel');}}, 'roc_retrieval_credential_unavailable'],
    ['empty-credential', {decryptString: async () => ({plaintext: ' ', shouldReEncrypt: true})}, 'roc_retrieval_credential_missing']
  ]) {
    const source = fixture(name), before = fileInventory(source.rocRoot), keys = storage(overrides);
    await assert.rejects(openConfiguredRetrieval(source.rocRoot, keys.backend, {mode: 'hybrid'},
      {snapshotParent: source.snapshotParent}), code(expected));
    assert.equal(keys.calls.encrypt, 0);
    assert.deepEqual(fileInventory(source.rocRoot), before);
    assert.deepEqual(readdirSync(source.snapshotParent), []);
  }
});

test('a cold production WAL without -shm supplies current configuration without mutating any source file', async t => {
  const source = fixture('cold-wal'), writerRoot = directory(artifacts, 'wal-writer'), writerPath = join(writerRoot, 'research.db');
  copyFileSync(source.researchPath, writerPath);
  const writer = new Database(writerPath);
  try {
    writer.pragma('journal_mode = WAL'); writer.pragma('wal_autocheckpoint = 0');
    writer.prepare('UPDATE research_embedding_configs SET model=?, revision=revision+1 WHERE id=?')
      .run('fixture-embedding-from-wal', 'selected');
    copyFileSync(writerPath, source.researchPath);
    copyFileSync(`${writerPath}-wal`, `${source.researchPath}-wal`);
  } finally {writer.close();}
  chmodSync(source.researchPath, 0o400); chmodSync(`${source.researchPath}-wal`, 0o400);
  const before = fileInventory(source.rocRoot);
  const statsBefore = before.map(file => {
    const stat = lstatSync(join(source.rocRoot, file.path), {bigint: true});
    return [file.path, stat.mtimeNs, stat.ctimeNs];
  });
  assert.equal(existsSync(`${source.researchPath}-shm`), false);
  const transport = await open(t, source, {mode: 'hybrid'});
  assert.equal(transport.identity.embedding.model, 'fixture-embedding-from-wal');
  assert.equal(transport.identity.embedding.revision, 4);
  assert.deepEqual(fileInventory(source.rocRoot), before);
  assert.deepEqual(before.map(file => {
    const stat = lstatSync(join(source.rocRoot, file.path), {bigint: true});
    return [file.path, stat.mtimeNs, stat.ctimeNs];
  }), statsBefore);
  assert.equal(existsSync(`${source.researchPath}-shm`), false);
  assert.deepEqual(readdirSync(source.snapshotParent), []);
});

test('symlinked databases/ancestors, hot journals and snapshot paths within production are refused and cleaned', async () => {
  const linked = fixture('linked-db'), target = join(artifacts, 'linked-research.db');
  copyFileSync(linked.researchPath, target); rmSync(linked.researchPath); symlinkSync(target, linked.researchPath);
  const ancestor = fixture('linked-ancestor'), actualPlugins = directory(artifacts, 'actual-plugins');
  mkdirSync(join(actualPlugins, '@roc')); copyFileSync(ancestor.researchPath, join(actualPlugins, '@roc/plugin-research.db'));
  rmSync(join(ancestor.rocRoot, 'data/plugins'), {recursive: true}); symlinkSync(actualPlugins, join(ancestor.rocRoot, 'data/plugins'));
  const hot = fixture('hot-journal'); writeFileSync(`${hot.researchPath}-journal`, 'hot-journal-sentinel');
  const within = fixture('within'); within.snapshotParent = within.rocRoot;
  for (const [source, expected] of [[linked, 'roc_retrieval_database_unavailable'], [ancestor, 'roc_retrieval_database_unavailable'],
    [hot, 'roc_retrieval_database_busy'], [within, 'roc_retrieval_options_invalid']]) {
    await assert.rejects(openConfiguredRetrieval(source.rocRoot, storage().backend, {mode: 'hybrid'},
      {snapshotParent: source.snapshotParent}), code(expected));
    if (source !== within) assert.deepEqual(readdirSync(source.snapshotParent), []);
  }
  assert.equal(lstatSync(linked.researchPath).isSymbolicLink(), true);
  assert.equal(lstatSync(join(ancestor.rocRoot, 'data/plugins')).isSymbolicLink(), true);
  assert.deepEqual(readdirSync(within.rocRoot), ['data']);
});

test('factory errors never retry a failed or malformed production embedding request', async t => {
  for (const [name, reply] of [
    ['failed', async () => {throw new Error(`${embeddingEndpoint}/${embeddingCredential}`);}],
    ['wrong-dimensions', async () => json({data: [{index: 0, embedding: [1]}]})],
    ['duplicate-index', async () => json({data: [{index: 0, embedding: [1, 2]}, {index: 0, embedding: [3, 4]}]})]
  ]) {
    const source = fixture(name); let calls = 0;
    const transport = await open(t, source, {mode: 'hybrid'}, {embeddingFetch: async () => {calls++; return await reply();}});
    await assert.rejects(transport.embed(name === 'duplicate-index' ? ['one', 'two'] : ['one']), code('roc_retrieval_embedding_failed'));
    assert.equal(calls, 1);
  }
});

test('production reranker retains failed and timeout receipts without retrying or substituting scores', async t => {
  const source = fixture('reranker-failure');
  for (const status of ['failed', 'timeout']) {
    let calls = 0;
    const transport = await open(t, source, {rerank: 'semantic'}, {
      rerankerFetch: async (_url, init) => {
        calls++;
        if (status === 'timeout') return await untilAbort(init.signal);
        throw new Error(`${rerankerEndpoint}/${rerankerCredential}`);
      }
    });
    const ranked = await transport.rerank('query', ['document']);
    assert.equal(ranked.scores, null);
    assert.equal(ranked.receipt.status, status);
    assert.equal(ranked.receipt.configHash, transport.identity.reranker.configurationHash);
    assert.equal(calls, 1);
  }
});

test('factory cancellation and close settle late operations as errors, including operations without network work', async t => {
  const source = fixture('cancellation'), started = deferred();
  const transport = await open(t, source, {mode: 'hybrid'}, {
    embeddingFetch: async (_url, init) => {started.resolve(); return await untilAbort(init.signal);}
  });
  const signal = new AbortController(), pending = transport.embed(['document'], signal.signal);
  const rejected = assert.rejects(pending, code('roc_retrieval_cancelled'));
  await started.promise; signal.abort(new Error('credential-reason-sentinel')); await rejected;
  const second = transport.embed(['document']);
  const closedRequest = assert.rejects(second, code('roc_retrieval_closed'));
  await transport.close(); await closedRequest;
  await assert.rejects(transport.embed(['new']), code('roc_retrieval_closed'));
  const none = await open(t, source, {}), late = new AbortController();
  const noNetworkOperation = none.rerank('query', [], late.signal);
  const lateRejection = assert.rejects(noNetworkOperation, code('roc_retrieval_cancelled'));
  late.abort(); await lateRejection;
});

test('two simultaneous proxy callers serialize safely and preserve exact correlation and queued input copies', async t => {
  const source = fixture('concurrent'), firstStarted = deferred(), firstRelease = deferred(), requests = [];
  let inflight = 0, maximum = 0;
  const bridge = await harness(t, async (rocRoot, selected) => openConfiguredRetrieval(rocRoot, storage().backend, selected, {
    snapshotParent: source.snapshotParent, rerankerFetch: noNetwork,
    embeddingFetch: async (url, init) => {
      inflight++; maximum = Math.max(maximum, inflight);
      const body = JSON.parse(init.body); requests.push({url, body});
      if (body.input[0] === 'first') {firstStarted.resolve(); await firstRelease.promise;}
      inflight--; return embeddingReply(body.input);
    }
  }), {rocRoot: source.rocRoot, mode: 'hybrid'});
  const firstCorrelation = {trialId: ' trial-1 ', requestId: ` request-${'1'.repeat(240)} `, requestHash: digest(['first'])};
  const first = bridge.transport.embed(['first'], undefined, firstCorrelation);
  await firstStarted.promise;
  const texts = ['second'], secondCorrelation = {trialId: 'trial-2', requestId: 'request-2', requestHash: digest(texts)};
  const frozenCorrelation = {...secondCorrelation}, second = bridge.transport.embed(texts, undefined, secondCorrelation);
  texts[0] = 'mutation-sentinel'; secondCorrelation.requestId = 'mutation-sentinel';
  assert.equal(requests.length, 1);
  firstRelease.resolve();
  assert.deepEqual(await Promise.all([first, second]), [vectors(1), vectors(1)]);
  assert.equal(requests.length, 2); assert.equal(maximum, 1);
  assert.deepEqual(requests[1].body.input, ['second']);
  const replies = bridge.sent.filter(message => message.type === 'response');
  assert.deepEqual(replies.map(message => message.correlation), [firstCorrelation, frozenCorrelation]);
  assert.ok(replies.every(message => message.usage === null));
  assert.ok(requests.every(request => !JSON.stringify(request.body).includes('request-')));
  assert.deepEqual(retrievalCorrelation(firstCorrelation), firstCorrelation);
});

test('cancelling a queued proxy operation never sends it and leaves the active caller intact', async t => {
  const started = deferred(), release = deferred(); let calls = 0;
  const bridge = await harness(t, async () => stub({
    embed: async texts => {calls++; started.resolve(); await release.promise; return vectors(texts.length);}
  }));
  const active = bridge.transport.embed(['active']); await started.promise;
  const abort = new AbortController(), queued = bridge.transport.embed(['queued'], abort.signal);
  const rejected = assert.rejects(queued, code('roc_retrieval_cancelled'));
  abort.abort(); await rejected; release.resolve();
  assert.deepEqual(await active, vectors(1));
  assert.equal(calls, 1);
  assert.equal(bridge.received.filter(message => message.type === 'embed').length, 1);
});

test('active cancellation waits for its terminal IPC reply before admitting another operation', async t => {
  const started = deferred(), retire = deferred(), seen = [];
  const bridge = await harness(t, async () => stub({
    embed: async (texts, signal, correlation) => {
      seen.push(correlation);
      if (texts[0] === 'first') {
        started.resolve();
        await new Promise(resolve => signal.addEventListener('abort', resolve, {once: true}));
        await retire.promise;
        signal.throwIfAborted();
      }
      return vectors(texts.length);
    }
  }));
  const abort = new AbortController(), active = bridge.transport.embed(['first'], abort.signal, {requestId: 'first'});
  const rejected = assert.rejects(active, code('roc_retrieval_cancelled'));
  await started.promise;
  const queued = bridge.transport.embed(['second'], undefined, {requestId: 'second'});
  abort.abort(); await rejected;
  assert.equal(seen.length, 1);
  assert.equal(bridge.received.filter(message => message.type === 'cancel').length, 1);
  retire.resolve();
  assert.deepEqual(await queued, vectors(1));
  assert.equal(seen.length, 2);
  assert.deepEqual(bridge.sent.find(message => message.operation === 'embed' && message.type === 'error').correlation,
    {trialId: null, requestId: 'first', requestHash: null});
});

test('proxy close is idempotent and cancels both active and queued callers without replay', async t => {
  const started = deferred(); let calls = 0, factoryCloses = 0;
  const bridge = await harness(t, async () => stub({
    embed: async (_texts, signal) => {calls++; started.resolve(); return await untilAbort(signal);},
    close: async () => {factoryCloses++;}
  }));
  const active = bridge.transport.embed(['active']), activeRejection = assert.rejects(active, code('roc_retrieval_closed'));
  await started.promise;
  const queued = bridge.transport.embed(['queued']), queuedRejection = assert.rejects(queued, code('roc_retrieval_closed'));
  const closing = bridge.transport.close(); assert.equal(bridge.transport.close(), closing);
  await closing; await Promise.all([activeRejection, queuedRejection]);
  assert.equal(calls, 1); assert.equal(factoryCloses, 1); assert.equal(bridge.closes, 1);
  await assert.rejects(bridge.transport.embed(['after-close']), code('roc_retrieval_closed'));
});

test('hard operation errors are redacted, preserve null usage/correlation and never automatically replay', async t => {
  let calls = 0;
  const bridge = await harness(t, async () => stub({
    embed: async () => {calls++; throw new Error(`${embeddingEndpoint}/${embeddingCredential}`);}
  }));
  const correlation = {trialId: 'trial', requestId: 'request', requestHash: digest(['document'])};
  await assert.rejects(bridge.transport.embed(['document'], undefined, correlation), code('roc_retrieval_host_failed'));
  assert.equal(calls, 1);
  const error = bridge.sent.find(message => message.type === 'error');
  assert.deepEqual(error.correlation, correlation); assert.equal(error.usage, null);
  assert.equal(JSON.stringify(error).includes('sentinel'), false);
  assert.equal(bridge.received.filter(message => message.type === 'embed').length, 1);
});

test('host loss rejects active and queued requests once and cannot replay either request', async t => {
  const started = deferred();
  const bridge = await harness(t, async () => stub({
    embed: async (_texts, signal) => {started.resolve(); return await untilAbort(signal);}
  }));
  const active = bridge.transport.embed(['active']), activeRejection = assert.rejects(active, code('roc_retrieval_host_unavailable'));
  await started.promise;
  const queued = bridge.transport.embed(['queued']), queuedRejection = assert.rejects(queued, code('roc_retrieval_host_unavailable'));
  bridge.child.emit('error', new Error(`${embeddingCredential}/${embeddingEndpoint}`));
  await Promise.all([activeRejection, queuedRejection]);
  await bridge.transport.close();
  assert.equal(bridge.closes, 1);
  assert.equal(bridge.received.filter(message => message.type === 'embed').length, 1);
});

test('proxy rejects unsanitized/mismatched replies and retains fixed startup failure codes', async t => {
  for (const mutate of [
    message => message.type === 'response' ? {...message, correlation: {...message.correlation, requestId: 'wrong'}} : message,
    message => message.type === 'response' ? {...message, usage: {input_tokens: 0}} : message,
    message => message.type === 'response' ? {...message, body: [[1]]} : message,
    message => message.type === 'response' ? {...message, credential: embeddingCredential} : message
  ]) {
    const bridge = await harness(t, async () => stub(), undefined, mutate);
    await assert.rejects(bridge.transport.embed(['one'], undefined, {requestId: 'bound'}), code('roc_retrieval_protocol_invalid'));
    await bridge.transport.close();
    assert.equal(bridge.received.filter(message => message.type === 'embed').length, 1);
  }
  for (const [startupCode, expected] of [['roc_retrieval_secret_storage_unavailable', 'roc_retrieval_secret_storage_unavailable'],
    [`${embeddingCredential}/${embeddingEndpoint}`, 'roc_retrieval_host_failed']]) {
    await assert.rejects(harness(t, async () => stub(), undefined, () => ({
      type: 'error', id: null, usage: null, code: startupCode
    })), code(expected));
  }
});

test('invalid options/correlation/inputs and pre-aborted calls fail before any model dispatch', async t => {
  for (const options of [null, {mode: 'dense'}, {appName: ' '}, {signal: {}}, {endpoint: embeddingEndpoint}]) {
    await assert.rejects(openRocRetrieval(options), code('roc_retrieval_options_invalid'));
  }
  const abort = new AbortController(); abort.abort();
  await assert.rejects(openRocRetrieval({signal: abort.signal}), code('roc_retrieval_cancelled'));
  const bridge = await harness(t, async () => stub());
  for (const operation of [
    () => bridge.transport.embed([null]),
    () => bridge.transport.embed(['one'], undefined, {requestHash: 'invalid'}),
    () => bridge.transport.embed(['one'], undefined, {requestId: ' '}),
    () => bridge.transport.embed(['one'], undefined, {apiKey: embeddingCredential}),
    () => bridge.transport.rerank('query', [null]),
    () => bridge.transport.embed(['one'], {})
  ]) await assert.rejects(operation(), code('roc_retrieval_input_invalid'));
  await assert.rejects(bridge.transport.embed(['one'], abort.signal), code('roc_retrieval_cancelled'));
  assert.equal(bridge.received.filter(message => ['embed', 'rerank'].includes(message.type)).length, 0);
});

test('host-owned generic reservations cover embedding and rerank aggregates and retain unknown usage across resume', async t => {
  const source = fixture('budget'), events = [], requests = [];
  const bridge = await harness(t, async (rocRoot, selected) => openConfiguredRetrieval(rocRoot, storage().backend, selected, {
    snapshotParent: source.snapshotParent,
    embeddingFetch: async (_url, init) => {requests.push(JSON.parse(init.body)); return embeddingReply(JSON.parse(init.body).input);},
    rerankerFetch: async (_url, init) => {requests.push(JSON.parse(init.body)); return json({results: [{index: 0, relevance_score: 0.5}]});}
  }), {rocRoot: source.rocRoot, mode: 'hybrid', rerank: 'semantic'});
  const options = {maxModelRequests: 2, maxOutputTokens: 0}, budget = new BudgetController(options, event => events.push(event));
  const texts = ['first', '第二段'], query = 'query', documents = ['document'];
  for (const [kind, payload, call] of [
    ['embedding', texts, correlation => bridge.transport.embed(texts, undefined, correlation)],
    ['rerank', {query, documents}, correlation => bridge.transport.rerank(query, documents, undefined, correlation)]
  ]) {
    const correlation = {trialId: 'trial', requestId: kind, requestHash: digest(payload)};
    const model = bridge.transport.identity[kind === 'embedding' ? 'embedding' : 'reranker'].model;
    const inputTokens = Buffer.byteLength(JSON.stringify(payload));
    budget.reserve({...correlation, kind, providerId: 'fixture-retrieval', model, inputTokens, outputTokens: 0});
    budget.dispatch(kind, correlation);
    await call(correlation);
    budget.unknown(kind, `${kind}_usage_missing`);
  }
  const snapshot = budget.snapshot({trialId: 'trial'});
  assert.equal(requests.length, 2); assert.equal(snapshot.requests, 2);
  assert.equal(snapshot.inputTokens, null); assert.equal(snapshot.outputTokens, null); assert.equal(snapshot.costUsd, null);
  assert.equal(snapshot.usageState, 'unknown'); assert.equal(snapshot.unknownUsageRequests, 2);
  assert.equal(snapshot.accounted.outputTokens, 0);
  assert.equal(snapshot.accounted.inputTokens, Buffer.byteLength(JSON.stringify(texts)) + Buffer.byteLength(JSON.stringify({query, documents})));
  assert.deepEqual(snapshot.reservations.map(value => value.kind), ['embedding', 'rerank']);
  assert.deepEqual(events.map(value => value.type), [
    'budget_reserved', 'budget_dispatched', 'budget_unknown', 'budget_reserved', 'budget_dispatched', 'budget_unknown'
  ]);
  assert.ok(bridge.sent.filter(message => message.type === 'response').every(message => message.usage === null));
  const restored = new BudgetController(options); restored.restore(JSON.parse(JSON.stringify(budget.snapshot())));
  assert.equal(restored.snapshot().accounted.inputTokens, snapshot.accounted.inputTokens);
  assert.equal(restored.snapshot().inputTokens, null);
  assert.throws(() => restored.dispatch('embedding', {trialId: 'trial', requestId: 'embedding', requestHash: digest(texts)}),
    /budget_request_replay_blocked/u);
});

test('application namespace is set before readiness and all runtime paths stay in the owned scratch directory', () => {
  const scratch = directory(artifacts, 'application'), actions = [];
  const application = {
    setName: name => actions.push(['name', name]),
    setPath: (name, path) => actions.push(['path', name, path]),
    disableHardwareAcceleration: () => actions.push(['hardware'])
  };
  configureRetrievalApplication(application, scratch, 'roc');
  actions.push(['ready']);
  assert.deepEqual(actions[0], ['name', 'roc']);
  assert.deepEqual(actions.filter(action => action[0] === 'path'), ['userData', 'sessionData', 'logs', 'crashDumps']
    .map(name => ['path', name, join(scratch, name)]));
  assert.equal(actions.at(-1)[0], 'ready');
  assert.throws(() => configureRetrievalApplication(application, scratch, 'invalid\nname'), code('roc_retrieval_options_invalid'));
  assert.throws(() => configureRetrievalApplication({...application, setName: () => {throw new Error(embeddingCredential);}},
    scratch, 'roc'), code('roc_retrieval_host_failed'));
});

test('bundled Electron host starts and reads disabled fixture configuration without network or safeStorage calls', {timeout: 20000}, async t => {
  const source = fixture('electron'), before = fileInventory(source.rocRoot), bundle = join(artifacts, 'native-host.mjs');
  await build({entryPoints: [join(EVAL_ROOT, 'runtime/retrieval-host.ts')], outfile: bundle,
    bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent',
    banner: {js: 'globalThis.fetch = async () => { throw new Error("retrieval_test_network_forbidden"); };'}});
  for (const selected of [{mode: 'bm25'}, {mode: 'hybrid', embeddingConfigId: 'disabled'}]) {
    const scratch = directory(artifacts, 'native-scratch');
    const child = spawn(electron, [bundle, scratch, 'Electron'], {cwd: scratch, detached: true, stdio: ['pipe', 'pipe', 'ignore'],
      env: {PATH: '/usr/bin:/bin', HOME: homedir(), TMPDIR: scratch, LANG: 'en_US.UTF-8',
        LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false'}});
    t.after(() => terminateProcessTreeWithRetry(child));
    const result = connectRocRetrieval(child, {rocRoot: source.rocRoot, ...selected}, () => terminateProcessTreeWithRetry(child));
    if (selected.mode === 'hybrid') await assert.rejects(result, code('roc_retrieval_embedding_disabled'));
    else {
      const transport = await result;
      assert.deepEqual(transport.identity, {embedding: null, reranker: null});
      assert.equal((await transport.rerank('query', ['document'])).receipt.status, 'not_requested');
      await transport.close();
    }
  }
  assert.deepEqual(fileInventory(source.rocRoot), before);
});
