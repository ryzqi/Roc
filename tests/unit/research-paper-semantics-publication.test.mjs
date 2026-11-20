import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {PDFDocument, StandardFonts} from 'pdf-lib';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api?.dispose());
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const proposal = rows => ({
  output: {blocks: rows.map(({blockId}) => ({blockId, roles: [{role: 'contribution', confidence: .9}]}))},
  providerId: 'fixture-provider', modelId: 'fixture-model', inputTokens: 300, outputTokens: 80
});
const tools = () => ({
  defaultParseOptions: () => ({tier: 'compact', device: 'cpu', pageRange: ''}),
  identity: async () => 'production-source-parser',
  parseDocument: input => api.parseResearchDocument({...input, modelFiles: null, modelManifest: ''})
});
async function until(check) {
  const deadline = Date.now() + 10_000;
  while (!check()) {assert.ok(Date.now() < deadline, 'publication did not settle'); await delay(10);}
}
function entry() {
  return {
    metadata: {id: 'semantic-literature', source: 'local', externalId: 'semantic-library', doi: null,
      title: 'Semantic source contract', authors: [], abstract: null, publishedYear: null, citationCount: null,
      url: null, openAccessUrl: null, importedAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z'},
    bibliography: {citationKey: 'semanticContract', entryType: 'article', fields: {title: 'Semantic source contract'},
      preambles: [], csl: null, title: 'Semantic source contract', authors: [], doi: null, publishedYear: null, abstract: null, url: null}
  };
}

test('real PDF library publication keeps parser coordinates/artifacts separate and cancellation preserves the current version', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-semantic-library-')));
  const f = createResearchFixture(api, 'reading');
  const parser = tools();
  let calls = 0, mode = 'classify', providerSignal, release, entered;
  const ready = new Promise(resolve => {entered = resolve;});
  const service = new api.ResearchDocumentService(f.repository, parser, root, async (rows, signal) => {
    calls++;
    if (mode === 'cancel') {
      providerSignal = signal; entered();
      return new Promise(resolve => {release = () => resolve(proposal(rows));});
    }
    return proposal(rows);
  });
  try {
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
    for (const text of ['Original scientific passage for a first study.', 'Another exact passage from the second page.']) {
      pdf.addPage([600, 800]).drawText(text, {x: 40, y: 400, size: 12, font});
    }
    const bytes = Buffer.from(await pdf.save());
    await writeFile(join(root, 'source.pdf'), bytes);
    const document = f.repository.documents.import({id: 'semantic-document', libraryItemId: null, projectId: f.project.id,
      filename: 'source.pdf', mediaType: 'application/pdf', sourcePath: 'source.pdf', sourceHash: hash(bytes),
      size: bytes.length, entry: entry()}, false).document;
    const parsed = await service.parse(document.id);
    assert.equal(parsed.status, 'ready', parsed.error ?? undefined);
    assert.equal(calls, 1);
    const {data} = f.repository.documents.parsed(document.id, parsed.currentParseId);
    const coordinates = f.repository.documents.coordinates(document.id, parsed.currentParseId);
    assert.equal(coordinates.snapshot.parseHash, hash(JSON.stringify(data.content)));
    assert.equal(data.semanticEnrichment.observation.status, 'classified');
    assert.ok(data.content.structure.blocks.every(b => b.semantic.roles.every(r => r.source === 'rule')));
    const artifactPath = join(root, data.outputPath, data.content.artifacts.structuredContent);
    const artifactBytes = await readFile(artifactPath);
    const artifact = JSON.parse(artifactBytes);
    assert.deepEqual(artifact.structure, data.content.structure);
    assert.ok(!('semanticEnrichment' in artifact));
    const selectedId = data.semanticEnrichment.observation.selectedBlockIds[0];
    const selectedIndex = data.content.blocks.filter(b => b.text.trim()).findIndex(b => b.id === selectedId);
    const chunkId = `document:${parsed.currentParseId}:chunk:${selectedIndex}`;
    const originalSemantic = f.repository.knowledge.chunkSemantic(chunkId);
    assert.equal(originalSemantic.scientific.roles[0].source, 'model');
    assert.equal(originalSemantic.blockId, selectedId);
    const restarted = new api.ResearchRepository(f.db, f.tasks);
    assert.deepEqual(restarted.knowledge.chunkSemantic(chunkId), originalSemantic);
    assert.deepEqual(restarted.documents.coordinates(document.id, parsed.currentParseId), coordinates);
    assert.deepEqual(restarted.documents.parsed(document.id, parsed.currentParseId).data.semanticEnrichment, data.semanticEnrichment);
    mode = 'cancel';
    const pending = service.parse(document.id);
    await ready;
    service.cancel(document.id, f.repository.documents.get(document.id).activeParseId);
    assert.equal((await pending).status, 'cancelled');
    assert.equal(providerSignal.aborted, true);
    assert.equal(f.repository.documents.get(document.id).currentParseId, parsed.currentParseId);
    release(); await Promise.resolve();
    assert.deepEqual(f.repository.knowledge.chunkSemantic(chunkId), originalSemantic);
    assert.deepEqual(await readFile(artifactPath), artifactBytes);
    assert.equal(f.db.pragma('integrity_check', {simple: true}), 'ok');
  } finally {await service.shutdown(); await f.close(); await rm(root, {recursive: true, force: true});}
});

test('project production index persists source-bound annotations, reuses cache on restart and rejects corrupt snapshots', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-semantic-index-')));
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const f = createResearchFixture(api, 'reading', workspace);
  const logger = {info() {}, warn() {}};
  const embeddings = new api.ResearchEmbeddingService(f.repository.knowledge, {}, {logger});
  let calls = 0;
  const generator = async rows => {calls++; return proposal(rows);};
  let index = new api.ResearchIndexService(f.repository, tools(), embeddings, join(root, 'storage'),
    logger, undefined, undefined, generator);
  try {
    const text = `<html><h1>Results</h1>${Array.from({length: 8}, (_, i) =>
      `<p>Original uncertain scientific passage number ${i}.</p>`).join('')}</html>`;
    await writeFile(join(workspace, 'paper.html'), text);
    const {projectId, revision, ...settings} = f.repository.indexing.settings(f.project.id);
    index.configure({...settings, projectId, expectedRevision: revision, kinds: ['html'], include: ['**/*.html'], watch: false});
    await until(() => index.status(projectId).counts.ready === 1);
    assert.equal(calls, 1);
    const file = f.repository.indexing.listFiles(projectId, '', false, 10)[0];
    const payload = f.repository.indexing.cached(file.id).payload;
    assert.equal(payload.semanticEnrichment.observation.status, 'classified');
    const originalJson = f.db.prepare('SELECT payload_json FROM research_index_files WHERE id=?').get(file.id).payload_json;
    const selectedId = payload.semanticEnrichment.observation.selectedBlockIds[0];
    const chunkIndex = payload.chunks.findIndex(c => c.semantic.blockId === selectedId);
    const chunkId = `project-index:${file.id}:chunk:${chunkIndex}`;
    assert.deepEqual(f.repository.knowledge.chunkSemantic(chunkId), payload.chunks[chunkIndex].semantic);
    const artifactPath = join(root, 'storage', payload.artifactPath, 'artifacts/structured.json');
    const bytes = await readFile(artifactPath);
    assert.ok(JSON.parse(bytes).structure.blocks.every(b => b.semantic.roles.every(r => r.source === 'rule')));
    await index.shutdown();
    index = new api.ResearchIndexService(f.repository, tools(), embeddings, join(root, 'storage'),
      logger, undefined, undefined, generator);
    index.start();
    await until(() => index.status(projectId).phase === 'idle' && index.status(projectId).counts.ready === 1);
    assert.equal(calls, 1);
    assert.deepEqual(f.repository.indexing.cached(file.id).payload, payload);
    for (const mutate of [
      p => p.chunks[chunkIndex].content += ' rewritten',
      p => p.chunks[chunkIndex].semantic.scientific.roles[0].confidence = .8,
      p => p.semanticEnrichment.sourceDigest = 'b'.repeat(64)
    ]) {
      const corrupt = structuredClone(payload); mutate(corrupt);
      f.db.prepare('UPDATE research_index_files SET payload_json=? WHERE id=?').run(JSON.stringify(corrupt), file.id);
      assert.equal(f.repository.indexing.cached(file.id).payload, null);
      assert.deepEqual(f.repository.knowledge.chunkSemantic(chunkId), payload.chunks[chunkIndex].semantic);
    }
    f.db.prepare('UPDATE research_index_files SET payload_json=? WHERE id=?').run(originalJson, file.id);
    index.control({projectId, expectedRevision: f.repository.indexing.settings(projectId).revision, action: 'rebuild', fileId: null});
    await until(() => calls === 2 && index.status(projectId).phase === 'idle');
    assert.equal(index.status(projectId).counts.ready, 1);
    assert.deepEqual(await readFile(artifactPath), bytes);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {await index.shutdown(); await embeddings.shutdown(); await f.close(); await rm(root, {recursive: true, force: true});}
});
