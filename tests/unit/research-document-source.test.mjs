import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, readdir, realpath, rename, rm, symlink, utimes, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const signal = () => new AbortController().signal;
before(async () => {api = await loadResearchTestApi();});
after(() => api?.dispose());

async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'resource lifecycle did not settle');
    await delay(5);
  }
}

async function sourceFixture(size = 2 * 1024 * 1024, limits = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-source-contract-')));
  const bytes = Buffer.alloc(size, 0x71);
  bytes.write('%PDF-1.7\n'); bytes.write('\n%%EOF\n', bytes.length - 7);
  await writeFile(join(root, 'source.pdf'), bytes);
  const source = {key: 'project/document/version', size, sha256: digest(bytes)};
  const store = new api.VerifiedDocumentSources({...api.documentSourceLimits, ...limits});
  return {root, bytes, source, store,
    open: () => store.acquire(root, 'source.pdf', source, signal()),
    cleanup: async () => {await store.shutdown(); await rm(root, {recursive: true, force: true});}};
}

async function serviceFixture() {
  const source = await sourceFixture();
  await source.store.shutdown();
  const f = createResearchFixture(api, 'reading');
  Object.assign(f, source);
  f.document = f.repository.documents.import({id: 'source-contract-document', libraryItemId: null, projectId: f.project.id,
    filename: 'source.pdf', mediaType: 'application/pdf', sourcePath: 'source.pdf', sourceHash: source.source.sha256,
    size: source.bytes.length, entry: {
      metadata: {id: 'source-literature', source: 'local', externalId: 'source-contract', doi: null,
        title: 'Synthetic source transport', authors: [], abstract: null, publishedYear: null, citationCount: null,
        url: null, openAccessUrl: null, importedAt: '2026-11-15T00:00:00Z', updatedAt: '2026-11-15T00:00:00Z'},
      bibliography: {citationKey: 'sourceContract', entryType: 'article', fields: {title: 'Synthetic source transport'},
        preambles: [], csl: null, title: 'Synthetic source transport', authors: [], doi: null, publishedYear: null, abstract: null, url: null}
    }}, false).document;
  f.service = new api.ResearchDocumentService(f.repository, {}, source.root);
  f.registry = new api.CapabilityRegistry();
  for (const descriptor of api.researchDocumentCapabilities) f.registry.declare('research', descriptor);
  api.registerResearchDocumentCapabilities({pluginId: 'research', capabilities: f.registry}, f.repository.documents, f.service);
  f.input = {projectId: f.project.id, documentId: f.document.id, sourceHash: f.document.sourceHash};
  f.fetch = ({method = 'GET', range, session, release = false, signal: requestSignal = signal()} = {}, input = f.input) => {
    const url = new URL(`roc-preview://research/projects/${encodeURIComponent(input.projectId)}/documents/${encodeURIComponent(input.documentId)}/source/${input.sourceHash}`);
    if (session !== undefined) url.searchParams.set('session', session);
    if (release) url.searchParams.set('release', '1');
    return api.withDocumentSourceRequest(new Request(url, {method, signal: requestSignal,
      headers: range === undefined ? {} : {range}}), () => f.registry.invoke('research.document.source', input));
  };
  f.cleanup = async () => {await f.service.shutdown(); f.close(); await rm(f.root, {recursive: true, force: true});};
  return f;
}

test('single byte ranges preserve inclusive HTTP boundaries and reject malformed or oversized requests', () => {
  for (const [range, size, expected] of [
    ['bytes=0-0', 100, [0, 1]], ['bytes=95-', 100, [95, 100]], ['bytes=-5', 100, [95, 100]],
    ['bytes=90-200', 100, [90, 100]], ['bytes=-200', 100, [0, 100]],
    ['bytes=0-', 100, [0, 100]], ['bytes=99-99', 100, [99, 100]],
    ['bytes=100-', 100, null], ['bytes=2-1', 100, null], ['bytes=-0', 100, null],
    ['bytes=0-1,3-4', 100, null], ['bytes=-', 100, null], ['bytes=0-0', 0, null],
    ['bytes=0-', 2 * 1024 * 1024, null], ['bytes=0-1048576', 2 * 1024 * 1024, null],
    ['bytes=9007199254740992-', 100, null], ['bytes=1e1-20', 100, null]
  ]) assert.deepEqual(api.documentSourceRange(range, size), expected, range);
});

test('leased reads are bound to fully hashed immutable bytes; every new open rejects same-size source corruption', async () => {
  const f = await sourceFixture();
  try {
    const id = await f.open();
    assert.equal(f.store.metrics().hashBytes, f.bytes.length);
    const changed = Buffer.from(f.bytes); changed[100] ^= 0xff;
    await writeFile(join(f.root, 'source.pdf'), changed);
    await utimes(join(f.root, 'source.pdf'), new Date(0), new Date(0));
    const range = f.store.stream(id, f.source.key, 64, 128, signal(), () => {});
    assert.deepEqual(Buffer.from(await new Response(range).arrayBuffer()), f.bytes.subarray(64, 128));
    await assert.rejects(f.open(), /research_document_source_changed/u);
    assert.equal(f.store.metrics().hashBytes, 2 * f.bytes.length);
    assert.equal(f.store.metrics().sessions, 1);
    await f.store.release(id, f.source.key);
    assert.equal(f.store.metrics().snapshotBytes, 0);
  } finally {await f.cleanup();}
});

test('independent Reader leases survive another Reader closing and source-path replacement', async () => {
  const f = await sourceFixture();
  try {
    const first = await f.open(), second = await f.open();
    assert.notEqual(first, second);
    await f.store.release(first, f.source.key);
    assert.equal(f.store.has(second, f.source.key), true);
    await rename(join(f.root, 'source.pdf'), join(f.root, 'held.pdf'));
    await writeFile(join(f.root, 'source.pdf'), Buffer.alloc(f.bytes.length, 0));
    assert.deepEqual(Buffer.from(await new Response(f.store.stream(second, f.source.key, f.bytes.length - 16,
      f.bytes.length, signal(), () => {})).arrayBuffer()), f.bytes.subarray(-16));
    await assert.rejects(f.open(), /research_document_source_changed/u);
  } finally {await f.cleanup();}
});

test('source verification rejects traversal, symlinks, wrong length and wrong full SHA without retaining snapshots', async () => {
  const f = await sourceFixture();
  try {
    for (const [path, source, error] of [
      ['../source.pdf', f.source, /research_relative_path_invalid/u],
      ['source.pdf', {...f.source, size: f.source.size - 1}, /research_document_source_changed/u],
      ['source.pdf', {...f.source, sha256: 'a'.repeat(64)}, /research_document_source_changed/u]
    ]) await assert.rejects(f.store.acquire(f.root, path, source, signal()), error);
    await symlink(join(f.root, 'source.pdf'), join(f.root, 'linked.pdf'));
    await assert.rejects(f.store.acquire(f.root, 'linked.pdf', f.source, signal()), /research_path_symlink/u);
    assert.equal(f.store.metrics().sessions, 0); assert.equal(f.store.metrics().snapshotBytes, 0);
  } finally {await f.cleanup();}
});

test('creation, descriptors, disk bytes and stream budgets remain bounded through concurrent evictions', async () => {
  const f = await sourceFixture(1024 * 1024, {sessions: 2, creating: 1, snapshotBytes: 2 * 1024 * 1024,
    streams: 2, streamsPerSession: 1});
  try {
    const first = await f.open();
    const a = f.open(), b = f.open();
    const results = await Promise.allSettled([a, b]);
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
    assert.match(results.find(row => row.status === 'rejected').reason.message, /research_document_preview_busy/u);
    const second = results.find(row => row.status === 'fulfilled').value;
    const one = f.store.stream(first, f.source.key, 0, f.bytes.length, signal(), () => {});
    const two = f.store.stream(second, f.source.key, 0, f.bytes.length, signal(), () => {});
    assert.throws(() => f.store.stream(first, f.source.key, 0, 1, signal(), () => {}), /preview_busy/u);
    await assert.rejects(f.open(), /preview_busy/u);
    await Promise.all([one.cancel(), two.cancel()]);
    const evictions = await Promise.allSettled(Array.from({length: 12}, () => f.open()));
    assert.ok(evictions.some(row => row.status === 'fulfilled'));
    const metrics = f.store.metrics();
    assert.ok(metrics.sessions <= 2); assert.ok(metrics.creating <= 1);
    assert.ok(metrics.peakSnapshotBytes <= 2 * f.bytes.length); assert.ok(metrics.peakStreams <= 2);
    await f.store.shutdown();
    assert.equal(f.store.metrics().snapshotBytes, 0); assert.equal(f.store.metrics().streams, 0);
  } finally {await f.cleanup();}
});

test('cancel and shutdown await pending reads and creations and close actual descriptors', async () => {
  const f = await sourceFixture(8 * 1024 * 1024);
  try {
    const before = (await readdir('/dev/fd')).length;
    const id = await f.open(), abort = new AbortController();
    const reader = f.store.stream(id, f.source.key, 0, f.bytes.length, abort.signal, () => {}).getReader();
    await reader.read(); abort.abort(new Error('fixture_cancel'));
    await assert.rejects(reader.read(), /fixture_cancel/u);
    const pending = f.store.acquire(f.root, 'source.pdf', {...f.source, key: 'second'}, signal());
    const failed = assert.rejects(pending);
    await f.store.shutdown(); await failed;
    assert.equal(f.store.metrics().sessions, 0); assert.equal(f.store.metrics().creating, 0);
    assert.equal(f.store.metrics().streams, 0); assert.equal(f.store.metrics().snapshotBytes, 0);
    assert.ok((await readdir('/dev/fd')).length <= before + 1, 'unlinked snapshot descriptors leaked');
    await assert.rejects(f.open(), /research_documents_closed/u);
  } finally {await f.cleanup();}
});

test('idle expiry retires only idle leases and leaves an in-flight stream available until canceled', async () => {
  const f = await sourceFixture(1024 * 1024, {idleMs: 20});
  try {
    const idle = await f.open(), busy = await f.open();
    const stream = f.store.stream(busy, f.source.key, 0, f.bytes.length, signal(), () => {});
    await until(() => !f.store.has(idle, f.source.key));
    assert.equal(f.store.has(busy, f.source.key), true);
    await stream.cancel();
    await until(() => f.store.metrics().sessions === 0);
    assert.equal(f.store.metrics().snapshotBytes, 0);
  } finally {await f.cleanup();}
});

test('production capability implements HEAD, bounded GET/Range, 206/416/410/405 and explicit release', async () => {
  const f = await serviceFixture();
  try {
    const head = await f.fetch({method: 'HEAD'}), id = head.headers.get('x-roc-preview-session');
    assert.equal(head.status, 200); assert.equal(head.body, null); assert.ok(id);
    assert.equal(head.headers.get('accept-ranges'), 'bytes');
    assert.equal(Number(head.headers.get('content-length')), f.bytes.length);
    const hashBytes = f.service.sourceMetrics().hashBytes;
    for (const [range, begin, end] of [['bytes=0-15', 0, 16], ['bytes=-16', f.bytes.length - 16, f.bytes.length]]) {
      const response = await f.fetch({range, session: id});
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-range'), `bytes ${begin}-${end - 1}/${f.bytes.length}`);
      assert.equal(Number(response.headers.get('content-length')), end - begin);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes.subarray(begin, end));
    }
    assert.equal(f.service.sourceMetrics().hashBytes, hashBytes);
    for (const range of ['bytes=0-', 'bytes=0-1,3-4', `bytes=${f.bytes.length}-`]) {
      const invalid = await f.fetch({range, session: id});
      assert.equal(invalid.status, 416); assert.equal(invalid.body, null);
      assert.equal(invalid.headers.get('content-range'), `bytes */${f.bytes.length}`);
    }
    assert.equal((await f.fetch({method: 'POST'})).status, 405);
    assert.equal((await f.fetch({method: 'HEAD', session: id, release: true})).status, 204);
    assert.equal((await f.fetch({session: id, range: 'bytes=0-15'})).status, 410);
    const full = await f.fetch();
    assert.equal(full.status, 200);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), f.bytes);
    await until(() => f.service.sourceMetrics().sessions === 0);
  } finally {await f.cleanup();}
});

test('source leases cannot cross project/version scope or expand the public capability schema', async () => {
  const f = await serviceFixture();
  try {
    const head = await f.fetch({method: 'HEAD'}), session = head.headers.get('x-roc-preview-session');
    const foreign = f.repository.createProject({title: 'Foreign', description: '', workspacePath: '/tmp/foreign-source'});
    await assert.rejects(f.fetch({session}, {...f.input, projectId: foreign.id}), error => error.code === 'research_document_project_mismatch');
    await assert.rejects(f.fetch({session}, {...f.input, sourceHash: 'a'.repeat(64)}), error => error.code === 'research_document_source_changed');
    for (const addition of [{range: 'bytes=0-1'}, {session}, {sourcePath: '/etc/passwd'}]) {
      await assert.rejects(f.registry.invoke('research.document.source', {...f.input, ...addition}));
    }
  } finally {await f.cleanup();}
});

test('diagnostic full-file PDF reads retain bytes and reject project, hash and path violations', async () => {
  const previous = process.env.ROC_PERF_PDF_RANGE_READER;
  process.env.ROC_PERF_PDF_RANGE_READER = '0';
  try {
    const f = await serviceFixture();
    try {
      const response = await f.fetch({range: 'bytes=0-15'});
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
      assert.equal(f.service.sourceMetrics().sessions, 0);
      const foreign = f.repository.createProject({title: 'Foreign', description: '', workspacePath: '/tmp/foreign-diagnostic-source'});
      await assert.rejects(f.fetch({}, {...f.input, projectId: foreign.id}),
        error => error.code === 'research_document_project_mismatch');
      await assert.rejects(f.fetch({}, {...f.input, sourceHash: 'a'.repeat(64)}),
        error => error.code === 'research_document_source_changed');
      const changed = Buffer.from(f.bytes); changed[100] ^= 0xff;
      await writeFile(join(f.root, 'source.pdf'), changed);
      await assert.rejects(f.fetch(), error => error.code === 'research_document_source_changed');
      await writeFile(join(f.root, 'source.pdf'), f.bytes);
      f.db.prepare('UPDATE research_documents SET source_path=? WHERE id=?').run('../source.pdf', f.document.id);
      await assert.rejects(f.fetch(), /research_relative_path_invalid/u);
      f.db.prepare('UPDATE research_documents SET source_path=? WHERE id=?').run('source.pdf', f.document.id);
      await rename(join(f.root, 'source.pdf'), join(f.root, 'held.pdf'));
      await symlink(join(f.root, 'held.pdf'), join(f.root, 'source.pdf'));
      await assert.rejects(f.fetch(), error => error.code === 'research_path_symlink' && error.category === 'permission');
      assert.equal(f.service.sourceMetrics().sessions, 0);
    } finally {await f.cleanup();}
  } finally {
    if (previous === undefined) delete process.env.ROC_PERF_PDF_RANGE_READER;
    else process.env.ROC_PERF_PDF_RANGE_READER = previous;
  }
});

test('production stream rechecks authorization after asynchronous reads and rejects revoked access', async () => {
  const f = await serviceFixture();
  try {
    const head = await f.fetch({method: 'HEAD'}), session = head.headers.get('x-roc-preview-session');
    const response = await f.fetch({session}), reader = response.body.getReader();
    assert.ok((await reader.read()).value.length <= 64 * 1024);
    f.repository.library.link(f.document.libraryItemId, f.project.id, false, {notify: false});
    await assert.rejects(reader.read(), /research_document_project_mismatch/u);
    await assert.rejects(f.fetch({session}), error => error.code === 'research_document_project_mismatch');
  } finally {await f.cleanup();}
});

test('production stream abort releases backpressure and shutdown releases unconsumed response descriptors', async () => {
  const f = await serviceFixture();
  try {
    const abort = new AbortController(), response = await f.fetch({signal: abort.signal});
    const reader = response.body.getReader();
    await reader.read(); abort.abort(new Error('capability_cancel'));
    await assert.rejects(reader.read(), /capability_cancel/u);
    await until(() => f.service.sourceMetrics().sessions === 0);
    const head = await f.fetch({method: 'HEAD'}), id = head.headers.get('x-roc-preview-session');
    await f.fetch({session: id});
    await f.service.shutdown();
    assert.equal(f.service.sourceMetrics().sessions, 0); assert.equal(f.service.sourceMetrics().streams, 0);
    assert.equal(f.service.sourceMetrics().snapshotBytes, 0);
  } finally {await f.cleanup();}
});

test('native request contexts remain isolated across concurrent capability calls', async () => {
  const f = await serviceFixture();
  try {
    const head = await f.fetch({method: 'HEAD'}), session = head.headers.get('x-roc-preview-session');
    const [first, last] = await Promise.all([f.fetch({session, range: 'bytes=0-7'}), f.fetch({session, range: 'bytes=-7'})]);
    assert.equal(first.headers.get('content-range'), `bytes 0-7/${f.bytes.length}`);
    assert.equal(last.headers.get('content-range'), `bytes ${f.bytes.length - 7}-${f.bytes.length - 1}/${f.bytes.length}`);
    assert.deepEqual(Buffer.from(await first.arrayBuffer()), f.bytes.subarray(0, 8));
    assert.deepEqual(Buffer.from(await last.arrayBuffer()), f.bytes.subarray(-7));
  } finally {await f.cleanup();}
});
