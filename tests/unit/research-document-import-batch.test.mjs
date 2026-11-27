import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {access, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api?.dispose());

async function example({withScientificIndex = false} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-batch-')));
  const fixture = createResearchFixture(api, 'reading', root);
  const {db, repository, project} = fixture;
  const parser = async input => api.parseResearchDocument({...input, modelFiles: null, modelManifest: ''});
  const embeddings = withScientificIndex ? new api.ResearchEmbeddingService(repository.knowledge,
    {embed: async ({texts}) => texts.map(() => [1, 0])},
    {secrets: {get: async () => 'fixture-key'}, logger: {info() {}, warn() {}, error() {}}}) : null;
  const scientific = embeddings && new api.ScientificLibraryIndexService(repository, embeddings, root);
  const documents = new api.ResearchDocumentService(repository, {
    defaultParseOptions: () => ({tier: 'compact', device: 'cpu', pageRange: ''}),
    parseDocument: parser,
    normalizeBibliography: async input => (await api.normalizeResearchBibliography(input)).entries
  }, root, null, null, scientific);
  const createQueue = (processor = documents) => new api.ResearchDocumentImportBatches(db, repository, processor, root);
  const source = async (filename, content) => {
    const path = join(root, filename);
    await writeFile(path, content);
    return path;
  };
  return {...fixture, root, documents, createQueue, source, scientific,
    submit: (queue, sourcePaths, libraryItemId = null) => queue.start({
      projectId: project.id, libraryItemId, requestId: randomUUID(), sourcePaths
    }),
    close: async () => {
      await documents.shutdown();
      await fixture.close();
      await embeddings?.shutdown();
      await rm(root, {recursive: true, force: true});
    }
  };
}

test('real mixed batch keeps source bytes, extracts file-backed PDF metadata, and returns every file outcome', async () => {
  const f = await example(), queue = f.createQueue();
  try {
    const pdf = await PDFDocument.create();
    pdf.setTitle('Embedded paper title');
    pdf.addPage().drawText('Real PDF body for the persisted batch.');
    const bytes = Buffer.from(await pdf.save());
    const paths = await Promise.all([
      f.source('first.pdf', bytes), f.source('repeated.pdf', bytes),
      f.source('paper.html', '<h1>Methods</h1><p>Reliable batch parsing uses unchanged source bytes.</p>'),
      f.source('invalid.txt', 'unsupported'), f.source('broken.pdf', 'invalid PDF')
    ]);
    paths.push(join(f.root, 'missing.pdf'));
    const input = {projectId: f.project.id, libraryItemId: null, requestId: randomUUID(), sourcePaths: paths};
    const [{id}, secondReceipt] = await Promise.all([queue.start(input), queue.start(input)]);
    assert.equal(secondReceipt.id, id);
    assert.equal(secondReceipt.entries.length, paths.length);
    await queue.idle();
    const ref = {projectId: f.project.id, batchId: id};
    const receipt = queue.read(ref);
    assert.deepEqual(receipt.entries.map(entry => [entry.filename, entry.status]),
      [['first.pdf','parsed'], ['repeated.pdf','duplicate'], ['paper.html','parsed'], ['invalid.txt','failed'],
        ['broken.pdf','failed'], ['missing.pdf','failed']]);
    assert.equal(receipt.entries[5].error, 'ENOENT');
    assert.equal(receipt.entries[1].documentId, receipt.entries[0].documentId);
    const parsed = f.repository.documents.get(receipt.entries[0].documentId);
    assert.equal(f.repository.library.get(parsed.libraryItemId).metadata.title, 'Embedded paper title');
    assert.deepEqual(await readFile(join(f.root, f.repository.documents.sourcePath(parsed.id))), bytes);
    assert.equal(f.repository.knowledgeJobs.get(`document:${parsed.currentParseId}`).status, 'queued');
    assert.equal(queue.list(f.project.id, 0)[0].failed, 3);
    assert.throws(() => queue.read({projectId: null, batchId: id}), /batch_not_found/u);
    await assert.rejects(queue.start({...input, sourcePaths: paths.slice(1)}), /request_conflict/u);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {await queue.shutdown(); await f.close();}
});

test('restart reconciles a renamed staged file and retries metadata without reading from the original location', async () => {
  const f = await example();
  let queue = f.createQueue();
  try {
    const first = await f.source('first.html', '<p>Original bytes survive the app stop.</p>');
    const second = await f.source('second.html', '<p>An interrupted partial copy is replaced.</p>');
    const receipt = await f.submit(queue, [first, second]);
    // Keep pending roots and simulate restart boundaries with an interrupted claim.
    await queue.shutdown();
    const [firstEntry, secondEntry] = receipt.entries;
    const firstLocation = await api.documentImportLocation(f.root, firstEntry.id, firstEntry.filename);
    const secondLocation = await api.documentImportLocation(f.root, secondEntry.id, secondEntry.filename);
    await api.receiveDocumentImport(first, await api.documentImportStamp(first), firstLocation.sourcePath, new AbortController().signal);
    await writeFile(secondLocation.sourcePath + '.part', 'incomplete');
    await rm(first);
    f.db.prepare("UPDATE research_document_import_entries SET status='receiving' WHERE batch_id=?").run(receipt.id);
    queue = f.createQueue();
    queue.recover();
    await queue.idle();
    const ref = {projectId: f.project.id, batchId: receipt.id};
    const result = queue.read(ref);
    assert.deepEqual(result.entries.map(entry => entry.status), ['parsed', 'parsed']);
    assert.match(await readFile(firstLocation.sourcePath, 'utf8'), /Original bytes/u);
    await assert.rejects(access(secondLocation.sourcePath + '.part'), /ENOENT/u);

    // A crash after parse publication leaves the durable parse ready and the batch claim outstanding.
    const docId = result.entries[0].documentId;
    const runs = f.repository.documents.runs(docId).length;
    await queue.shutdown();
    f.db.prepare("UPDATE research_document_import_entries SET status='parsing' WHERE id=?").run(firstEntry.id);
    queue = f.createQueue();
    queue.recover();
    await queue.idle();
    assert.equal(queue.read(ref).entries[0].status, 'parsed');
    assert.equal(f.repository.documents.runs(docId).length, runs);
  } finally {await queue.shutdown(); await f.close();}
});

test('an interrupted direct parse retains its tier and failed document results are counted separately', async () => {
  const f = await example(), queue = f.createQueue();
  try {
    const source = await f.source('source.html', '<p>Native text after an interrupted direct parse.</p>');
    const batch = await f.submit(queue, [source]);
    await queue.idle();
    const entry = queue.read({projectId: f.project.id, batchId: batch.id}).entries[0];
    f.repository.documents.begin(entry.documentId, 'lost-worker', {tier: 'complete', origin: 'direct'});
    assert.deepEqual(f.repository.documents.recover(), [{id: entry.documentId, tier: 'complete'}]);
    assert.deepEqual(f.repository.documents.recover(), [{id: entry.documentId, tier: 'complete'}]);
    const badSource = await f.source('corrupt.pdf', 'bad data');
    const bad = await f.documents.import({target: 'new-item', projectId: f.project.id, title: 'Bad PDF', citationKey: 'bad',
      sourcePath: badSource});
    const result = await f.documents.parseMany({documentIds: [bad.id, entry.documentId, bad.id], tier: 'compact'});
    assert.deepEqual(result.documents.map(doc => doc.id), [entry.documentId]);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].documentId, bad.id);
    assert.equal(f.repository.documents.recover().length, 0);
  } finally {await queue.shutdown(); await f.close();}
});

for (const total of [10, 50, 100, 500]) {
  test(`capacity fixture accounts for all ${total} inputs and bounds parser fan-out`, async t => {
    const f = await example();
    let active = 0, peak = 0;
    const parser = {
      importStaged: f.documents.importStaged.bind(f.documents),
      parseForBatch: async (id, signal, requireCurrent) => {
        active++;
        peak = Math.max(active, peak);
        try {
          await new Promise(resolve => setTimeout(resolve, 5));
          signal.throwIfAborted(); requireCurrent();
          return {status: 'ready'};
        } finally {active--;}
      }
    };
    const queue = f.createQueue(parser);
    try {
      const initial = await f.source('seed.html', '<p>Seed attachment owner.</p>');
      const owner = await f.documents.import({target: 'new-item', projectId: f.project.id, title: 'Seed', citationKey: 'seed',
        sourcePath: initial});
      const paths = [];
      for (let index = 0; index < total; index++) paths.push(await f.source(`source-${index}.html`, `<p>Document ${index}</p>`));
      const started = performance.now();
      const batch = await f.submit(queue, paths, owner.libraryItemId);
      await queue.idle();
      const done = queue.read({projectId: f.project.id, batchId: batch.id});
      assert.equal(done.entries.length, total);
      assert.equal(done.entries.filter(entry => entry.status === 'parsed').length, total);
      assert.equal(new Set(done.entries.map(entry => entry.documentId)).size, total);
      assert.equal(peak, 2);
      assert.equal(f.repository.documents.list(owner.libraryItemId).length, total + 1);
      assert.equal(f.db.pragma('foreign_key_check').length, 0);
      t.diagnostic(`${total} files in ${Math.round(performance.now() - started)} ms with an injected parser`);
    } finally {await queue.shutdown(); await f.close();}
  });
}

test('metadata failure leaves the staged original available for retry after the selected file is removed', async () => {
  const f = await example();
  let shouldFail = true;
  const queue = f.createQueue({
    importStaged: (...args) => {
      if (shouldFail) throw new Error('research_bibliography_test_failed');
      return f.documents.importStaged(...args);
    },
    parseForBatch: f.documents.parseForBatch.bind(f.documents)
  });
  try {
    const source = await f.source('metadata.html', '<p>Source bytes are retained before metadata registration.</p>');
    const batch = await f.submit(queue, [source]);
    const ref = {projectId: f.project.id, batchId: batch.id};
    await queue.idle();
    const failed = queue.read(ref).entries[0];
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'research_bibliography_test_failed');
    const {sourcePath} = await api.documentImportLocation(f.root, failed.id, failed.filename);
    assert.deepEqual(await readFile(sourcePath), await readFile(source));
    await rm(source);
    shouldFail = false;
    queue.retry(ref);
    await queue.idle();
    assert.equal(queue.read(ref).entries[0].status, 'parsed');
    assert.equal(f.repository.documents.runs(failed.id).length, 1);
  } finally {await queue.shutdown(); await f.close();}
});

test('background index publishes the scientific generation before enqueuing Paper Card and Wiki', async () => {
  const f = await example({withScientificIndex: true}), queue = f.createQueue();
  try {
    f.repository.knowledge.saveEmbeddingConfig({id: 'test', name: 'Test', baseUrl: 'https://fixture.invalid',
      model: 'test', dimensions: 2, enabled: true}, 'fixture-secret');
    const pdf = await PDFDocument.create();
    pdf.addPage().drawText('This source reaches the scientific library without reparsing.');
    const source = await f.source('publication.pdf', Buffer.from(await pdf.save()));
    const batch = await f.submit(queue, [source]);
    await queue.idle();
    const row = queue.read({projectId: f.project.id, batchId: batch.id}).entries[0];
    assert.equal(row.status, 'parsed');
    const document = f.repository.documents.get(row.documentId);
    const knowledgeId = `document:${document.currentParseId}`;
    assert.equal(f.repository.knowledgeJobs.get(knowledgeId).status, 'queued');
    const card = () => f.db.prepare('SELECT knowledge_id FROM research_paper_cards WHERE document_id=?').pluck().get(document.id);
    assert.equal(card(), undefined);
    f.repository.knowledgeJobs.start((id, signal, requireCurrent) =>
      id.startsWith('document:') ? f.scientific.rebuild(id, signal, requireCurrent) : Promise.resolve(null));
    await f.repository.knowledgeJobs.idle();
    assert.equal(f.repository.knowledgeJobs.get(knowledgeId).status, 'ready');
    assert.equal(card(), knowledgeId);
    assert.ok(f.repository.scientificIndex.active(null, document.id));
    assert.equal(f.repository.documents.runs(document.id).length, 1);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_wiki_pages WHERE source_document_id=?').pluck().get(document.id), 1);
  } finally {await queue.shutdown(); await f.close();}
});
