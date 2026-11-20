import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, realpath, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {PDFDocument, StandardFonts} from 'pdf-lib';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api?.dispose());
const hash = value => createHash('sha256').update(value).digest('hex');
const xml = '<TEI><teiHeader><fileDesc><titleStmt><title>Original Source</title></titleStmt></fileDesc></teiHeader><text><body><div><head>Results</head><p>A precise original finding.</p></div></body></text></TEI>';
const tools = () => ({defaultParseOptions: () => ({tier: 'compact', device: 'cpu', pageRange: ''}),
  identity: async () => 'grobid-publication-native',
  parseDocument: input => api.parseResearchDocument({...input, modelFiles: null, modelManifest: ''})});
async function bytes() {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica), page = pdf.addPage([600, 800]);
  page.drawText('Original Source', {x: 40, y: 700, font, size: 16});
  page.drawText('Results', {x: 40, y: 650, font, size: 14});
  page.drawText('A precise original finding.', {x: 40, y: 600, font, size: 12});
  return Buffer.from(await pdf.save());
}
const entry = () => ({metadata: {id: 'grobid', source: 'local', externalId: 'grobid', doi: null, title: 'Original Source',
  authors: [], abstract: null, publishedYear: null, citationCount: null, url: null, openAccessUrl: null,
  importedAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z'},
  bibliography: {citationKey: 'original', entryType: 'article', fields: {title: 'Original Source'}, preambles: [], csl: null,
    title: 'Original Source', authors: [], doi: null, publishedYear: null, abstract: null, url: null}});
async function until(check) {
  const deadline = Date.now() + 10_000;
  while (!check()) {assert.ok(Date.now() < deadline, 'publication did not settle'); await delay(10);}
}

test('real PDF library persists supplementary TEI, verifies restart/tampering and keeps original artifacts on cancellation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-grobid-library-'))), f = createResearchFixture(api, 'reading');
  let mode = 'parsed', entered, release;
  const ready = new Promise(resolve => {entered = resolve;});
  const adapter = {identity: 'controlled-grobid-v1', parse: async () => {
    if (mode === 'cancel') {entered(); return new Promise(resolve => {release = resolve;});}
    if (mode === 'unavailable') throw new Error('research_grobid_unavailable');
    return xml;
  }};
  const service = new api.ResearchDocumentService(f.repository, tools(), root, null, adapter);
  try {
    const source = await bytes(); await writeFile(join(root, 'source.pdf'), source);
    const document = f.repository.documents.import({id: 'grobid-document', libraryItemId: null, projectId: f.project.id,
      filename: 'source.pdf', mediaType: 'application/pdf', sourcePath: 'source.pdf', sourceHash: hash(source),
      size: source.length, entry: entry()}, false).document;
    const parsed = await service.parse(document.id);
    assert.equal(parsed.status, 'ready', parsed.error ?? undefined);
    const {data} = f.repository.documents.parsed(document.id, parsed.currentParseId);
    assert.equal(data.scholarlyEnrichment.status, 'parsed');
    assert.equal(data.scholarlyEnrichment.rawTei, xml);
    assert.ok(data.scholarlyEnrichment.resolutions.some(r => r.status === 'matched'));
    const coordinates = f.repository.documents.coordinates(document.id, parsed.currentParseId);
    assert.equal(coordinates.snapshot.parseHash, hash(JSON.stringify(data.content)));
    const ir = await service.paperIR(document.id, parsed.currentParseId);
    assert.equal(ir.schemaVersion, 2);
    assert.equal(ir.identity.parseHash, coordinates.snapshot.parseHash);
    assert.equal(ir.metadata.title, 'Original Source');
    assert.equal(ir.metadata.origin, 'library');
    assert.ok(ir.blocks.every(b => b.sourceLocator.documentId === document.id));
    const artifactPath = join(root, data.outputPath, data.content.artifacts.structuredContent), original = await readFile(artifactPath);
    assert.ok(!('scholarlyEnrichment' in JSON.parse(original)));
    const restarted = new api.ResearchRepository(f.db, f.tasks);
    assert.deepEqual(restarted.documents.parsed(document.id, parsed.currentParseId).data.scholarlyEnrichment, data.scholarlyEnrichment);
    assert.deepEqual(restarted.documents.parsed(document.id, parsed.currentParseId).data.paperIR, data.paperIR);
    const row = f.db.prepare('SELECT data_json FROM research_document_parses WHERE id=?').get(parsed.currentParseId);
    const altered = JSON.parse(row.data_json); altered.scholarlyEnrichment.fields.metadata.title = 'invented';
    f.db.prepare('UPDATE research_document_parses SET data_json=? WHERE id=?').run(JSON.stringify(altered), parsed.currentParseId);
    assert.throws(() => restarted.documents.parsed(document.id, parsed.currentParseId), /source_changed/);
    const missingIR = JSON.parse(row.data_json); delete missingIR.paperIR;
    f.db.prepare('UPDATE research_document_parses SET data_json=? WHERE id=?').run(JSON.stringify(missingIR), parsed.currentParseId);
    assert.throws(() => restarted.documents.parsed(document.id, parsed.currentParseId));
    f.db.prepare('UPDATE research_document_parses SET data_json=? WHERE id=?').run(row.data_json, parsed.currentParseId);
    mode = 'cancel'; const pending = service.parse(document.id); await ready;
    service.cancel(document.id, f.repository.documents.get(document.id).activeParseId);
    assert.equal((await pending).status, 'cancelled');
    release(xml); await Promise.resolve();
    assert.equal(f.repository.documents.get(document.id).currentParseId, parsed.currentParseId);
    assert.deepEqual(await readFile(artifactPath), original);
    mode = 'unavailable';
    const fallback = await service.parse(document.id);
    assert.equal(fallback.status, 'ready');
    assert.equal(f.repository.documents.parsed(document.id, fallback.currentParseId).data.scholarlyEnrichment.status, 'unavailable');
    assert.notEqual((await service.paperIR(document.id, fallback.currentParseId)).blocks[0].id, ir.blocks[0].id);
    assert.deepEqual(await service.paperIR(document.id, parsed.currentParseId), ir);
    assert.equal(f.db.pragma('integrity_check', {simple: true}), 'ok');
  } finally {await service.shutdown(); await f.close(); await rm(root, {recursive: true, force: true});}
});

test('actual PDF project index preserves source-bound TEI and rejects corrupted caches; default-disabled snapshot is explicit', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-grobid-index-'))), workspace = join(root, 'workspace');
  await mkdir(workspace);
  const f = createResearchFixture(api, 'reading', workspace), logger = {info() {}, warn() {}};
  let tick = 0;
  const repository = new api.ResearchRepository(f.db, f.tasks, () => new Date(1_700_000_000_000 + tick++).toISOString());
  const embeddings = new api.ResearchEmbeddingService(f.repository.knowledge, {}, {logger});
  let calls = 0;
  const adapter = {identity: 'controlled-grobid-v1', parse: async () => {calls++; return xml;}};
  let service = new api.ResearchIndexService(repository, tools(), embeddings, join(root, 'storage'), logger, undefined, undefined, null, adapter);
  try {
    await writeFile(join(workspace, 'paper.pdf'), await bytes());
    const {projectId, revision, ...settings} = f.repository.indexing.settings(f.project.id);
    service.configure({...settings, projectId, expectedRevision: revision, kinds: ['pdf'], include: ['**/*.pdf'], watch: false});
    await until(() => service.status(projectId).counts.ready === 1);
    assert.equal(calls, 1);
    const file = f.repository.indexing.listFiles(projectId, '', false, 10)[0], payload = f.repository.indexing.cached(file.id).payload;
    assert.equal(payload.scholarlyEnrichment.status, 'parsed');
    const ir = await service.paperIR(projectId, file.id);
    assert.equal(ir.schemaVersion, 2);
    assert.equal(ir.identity.parseId, payload.parseArtifactId);
    assert.equal(ir.metadata.origin, 'unknown');
    const artifact = join(root, 'storage', payload.artifactPath, 'artifacts/structured.json'), original = await readFile(artifact);
    const row = f.db.prepare('SELECT payload_json FROM research_index_files WHERE id=?').get(file.id);
    for (const mutate of [p => {p.scholarlyEnrichment.teiHash = 'a'.repeat(64);},
      p => {p.chunks[0].content += ' altered';}, p => {p.scholarlyEnrichment.resolutions[0].start++;},
      p => {p.paperIR.identity.parseId = 'foreign';}, p => {p.paperIR.indexedBlocksHash = 'a'.repeat(64);},
      p => {delete p.paperIR;}]) {
      const bad = JSON.parse(row.payload_json); mutate(bad);
      f.db.prepare('UPDATE research_index_files SET payload_json=? WHERE id=?').run(JSON.stringify(bad), file.id);
      assert.equal(f.repository.indexing.cached(file.id).payload, null);
    }
    f.db.prepare('UPDATE research_index_files SET payload_json=? WHERE id=?').run(row.payload_json, file.id);
    await service.shutdown();
    service = new api.ResearchIndexService(repository, tools(), embeddings, join(root, 'storage'), logger, undefined, undefined, null, adapter);
    const lastScan = service.status(projectId).lastScanAt;
    service.start();
    service.control({projectId, expectedRevision: service.status(projectId).settings.revision, action: 'scan'});
    await until(() => service.status(projectId).lastScanAt !== lastScan && service.status(projectId).phase === 'idle');
    assert.equal(calls, 1);
    assert.deepEqual(f.repository.indexing.cached(file.id).payload.scholarlyEnrichment, payload.scholarlyEnrichment);
    assert.deepEqual(await service.paperIR(projectId, file.id), ir);
    await service.shutdown();
    service = new api.ResearchIndexService(repository, tools(), embeddings, join(root, 'storage'), logger);
    service.start();
    service.control({projectId, expectedRevision: service.status(projectId).settings.revision, action: 'scan'});
    await until(() => service.status(projectId).phase === 'idle' &&
      f.repository.indexing.cached(file.id).payload?.scholarlyEnrichment?.status === 'disabled');
    assert.equal(calls, 1); assert.equal(f.repository.indexing.cached(file.id).payload.scholarlyEnrichment.missingFields.length, 5);
    assert.deepEqual(await readFile(artifact), original);
    assert.equal(f.db.pragma('integrity_check', {simple: true}), 'ok');
  } finally {await service.shutdown(); await f.close(); await rm(root, {recursive: true, force: true});}
});
