import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {PDFDocument, StandardFonts} from 'pdf-lib';
import {load} from 'sqlite-vec';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {
  const [base, ...modules] = await Promise.all([loadResearchTestApi(),
    ...['ovis-document-parser', 'ovis-source-artifact', 'ovis-document-adapter', 'ovis-parsed-document',
      'scientific-retrieval-router', 'paper-ir-repository'].map(name =>
      importTypeScriptModule(`src/main/plugins/research/${name}.ts`, {platform: 'node',
        external: ['@napi-rs/canvas', 'pdfjs-dist/legacy/build/pdf.mjs'], tempDir: '.runtime/tmp'}))]);
  api = Object.assign(base, ...modules);
});
after(() => api?.dispose());
const hash = value => createHash('sha256').update(value).digest('hex');
const model = {engine: 'ovisocr3-mlx', revision: '5b252386ba615bd464a5a26597560eaba87dae5c', quantization: '8bit',
  groupSize: 64, visionPrecision: 'bfloat16', device: 'metal', installationReceiptSha256: 'a'.repeat(64),
  inferenceSha256: 'b'.repeat(64), promptSha256: '1b6139ec72888e087c8af75f2e2dfb78b425e15ae1c1529940b96137613d1db1'};
const html = '<table><tr><th>Method</th><th>F1</th></tr><tr><td>Original</td><td>91</td></tr></table>';
const latex = '$$x = y \\tag{1}$$';

// Actual source raster, Ovis adapter, index service, SQLite and native vector store; controlled OCR and vectors.
async function fixture(operation) {
  const root = await realpath(await mkdtemp('/private/tmp/roc-ovis-project-'));
  const workspace = join(root, 'workspace'), storage = join(root, 'storage'); await mkdir(workspace);
  const f = createResearchFixture(api, 'reading', workspace); let indexer, embeddings;
  try {
    load(f.db);
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage([400, 600]).drawText('Original source text', {x: 30, y: 550, size: 10, font});
    const bytes = Buffer.from(await pdf.save()); await writeFile(join(workspace, 'paper.pdf'), bytes);
    const {projectId, revision, ...settings} = f.repository.indexing.settings(f.project.id);
    f.repository.indexing.saveSettings(projectId, revision, {...settings, kinds: ['pdf'], watch: false});
    f.repository.knowledge.saveEmbeddingConfig({id: 'fixture', name: 'Fixture', enabled: true,
      baseUrl: 'https://fixture.invalid', model: 'fixture', dimensions: 3}, 'fixture-secret');
    embeddings = new api.ResearchEmbeddingService(f.repository.knowledge,
      {embed: async ({texts}) => texts.map(() => [3, 4, 0])},
      {secrets: {get: async () => 'fixture-key'}, logger: {info() {}, warn() {}, error() {}}});
    let label = 'first', hook = async () => {}, parses = 0;
    const outputs = [], leases = {acquired: 0, released: 0};
    indexer = new api.ResearchIndexService(f.repository, {
      identity: async () => JSON.stringify(model),
      defaultParseOptions: () => ({tier: 'complete', device: 'auto', pageRange: ''}),
      parseDocument: async input => {
        parses++; outputs.push(input.outputDir);
        const parsed = await api.parseOvisDocument({...input, sourceKind: 'pdf', pages: null, timeoutMs: 60000,
          admission: {...input.admission, resourceClass: 'parse'}}, {acquire: async () => {
          leases.acquired++; return {installation: {identity: model}, release: () => {leases.released++;}};
        }}, {capture: capture => api.createOvisSourceArtifact(capture, async worker => ({
          process: {exitCode: 0}, pages: worker.pages.map(({binding}) => {
            const raw = JSON.stringify([
              {category: 'text', content: `Projectovissentinel ${label} method. See Eq. (1).`, bbox: [50, 50, 900, 180]},
              {category: 'display_formula', content: latex, bbox: [50, 200, 900, 300]},
              {category: 'table', content: html, bbox: [50, 320, 900, 650]},
              {category: 'image', content: '<img src="untrusted.png">', bbox: [50, 680, 900, 900]}
            ]);
            return api.adaptOvisPage(Buffer.from(raw), {protocolVersion: 1, sourceHash: binding.sourceHash,
              inputImageSha256: binding.inputImageSha256, model, page: binding.frame.page,
              width: binding.frame.width, height: binding.frame.height, rawSha256: hash(raw),
              generation: {finishReason: 'stop', generationTokens: 2, tokenIds: [17, 248046]}}, binding);
          })})), write: api.writeOvisParsedDocument});
        await hook(input, parsed); return parsed;
      }
    }, embeddings, storage, {info() {}, warn() {}, error() {}});
    const run = async (force = true) => {
      f.repository.indexing.requestScan(projectId, force);
      await indexer.scan(projectId, new AbortController().signal);
      const queued = f.repository.indexing.nextJob(); assert.ok(queued);
      const job = f.repository.indexing.beginJob(queued.id);
      await indexer.process(job, new AbortController().signal);
      return {job: f.repository.indexing.job(job.id), payload: f.repository.indexing.cached(job.fileId).payload};
    };
    const router = new api.ScientificRetrievalRouter(f.repository, embeddings, {library: null, index: storage},
      new api.ScholarlyRelationsRepository(f.db, f.repository));
    await operation({...f, storage, bytes, indexer, router, run, outputs, leases, parses: () => parses,
      label: value => {label = value;}, hook: value => {hook = value;}});
    assert.equal(hash(await readFile(join(workspace, 'paper.pdf'))), hash(bytes));
    assert.deepEqual(leases, {acquired: parses, released: parses});
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {await indexer?.shutdown(); await embeddings?.shutdown(); await f.close(); await rm(root, {recursive: true, force: true});}
}
const search = f => f.router.search({projectId: f.project.id, query: 'Projectovissentinel Original F1 equation table',
  documentIds: [], embeddingConfigId: null, candidateLimit: 100, limit: 20, rerank: 'none'});
const snapshot = f => ({
  generic: f.db.prepare('SELECT * FROM research_knowledge_chunks ORDER BY id').all(),
  vectors: f.db.prepare('SELECT * FROM research_knowledge_embeddings ORDER BY chunk_id,space_key').all(),
  active: f.db.prepare("SELECT * FROM research_scientific_index_generations WHERE status='active' ORDER BY id").all()
});

test('Ovis project index publishes immutable source-bound objects and distinct reparse generations', async () => {
  await fixture(async f => {
    const first = await f.run(); assert.equal(first.job.status, 'ready', first.job.error);
    const original = await f.indexer.paperIR(f.project.id, first.job.fileId);
    assert.equal(original.tables[0].data.rawHtml, html); assert.equal(original.equations[0].data.rawLatex, latex);
    assert.equal(original.figures.length, 1);
    const old = await search(f); await f.router.assertCurrent(old);
    assert.ok(old.candidates.some(c => c.signals.some(s => s.method === 'fts')));
    assert.ok(old.candidates.some(c => c.signals.some(s => s.method === 'dense')));
    for (const candidate of old.candidates) if (candidate.sourceLocator) {
      assert.equal(candidate.sourceLocator.sourceHash, hash(f.bytes));
      assert.equal(candidate.sourceLocator.parseId, first.payload.parseArtifactId);
      assert.ok(candidate.sourceLocator.locations.every(l => l.page === 1 && l.bbox === null));
    }
    const context = await f.router.readContext({search: old,
      candidateIds: old.candidates.filter(c => ['table', 'equation'].includes(c.object.kind)).map(c => c.id)});
    assert.equal(context.evidence.length, 2);
    f.label('second');
    const second = await f.run(); assert.equal(second.job.status, 'ready', second.job.error);
    assert.notEqual(second.payload.parseArtifactId, first.payload.parseArtifactId);
    const current = await f.indexer.paperIR(f.project.id, second.job.fileId);
    assert.ok(current.blocks.some(b => b.text.includes('second')));
    assert.deepEqual(await new api.PaperIRRepository(f.storage).read(first.payload.paperIR), original);
    await assert.rejects(f.router.assertCurrent(old), /source_changed/);
    await f.router.assertCurrent(await search(f));
    const saved = JSON.parse(await readFile(join(f.storage, second.payload.artifactPath, 'result.json')));
    assert.deepEqual(saved.modelIdentity, model);
    await api.verifyOvisParsedDocument(join(f.storage, second.payload.artifactPath), saved, new AbortController().signal);
    for (const output of f.outputs) await assert.rejects(access(output), {code: 'ENOENT'});
  });
});

test('project Ovis publication refuses changed raw captures without replacing earlier indexes or artifacts', async () => {
  await fixture(async f => {
    const first = await f.run(); assert.equal(first.job.status, 'ready', first.job.error);
    const original = snapshot(f), artifacts = await readdir(join(f.storage, 'artifacts'));
    f.label('second');
    f.hook(async input => {await writeFile(join(input.outputDir, 'evidence/page-1.json'), '{}');});
    const failed = await f.run(); assert.equal(failed.job.status, 'failed');
    assert.match(failed.job.error, /research_ovis_artifact_changed/);
    assert.deepEqual(snapshot(f), original); assert.deepEqual(failed.payload, first.payload);
    assert.deepEqual(await readdir(join(f.storage, 'artifacts')), artifacts);
    await f.router.assertCurrent(await search(f));
    await assert.rejects(access(f.outputs.at(-1)), {code: 'ENOENT'});
  });
});

test('Ovis project artifact reuse and cached IR reads reject changed stored evidence', async () => {
  await fixture(async f => {
    const work = join(f.storage, 'retained-fixture'); let parsed;
    f.hook(async (input, result) => {parsed = result; await cp(input.jobDir, work, {recursive: true});});
    const first = await f.run(); assert.equal(first.job.status, 'ready', first.job.error);
    const original = snapshot(f), target = join(f.storage, first.payload.artifactPath, 'evidence/page-1.json');
    const bytes = await readFile(target); await writeFile(target, '{}');
    await assert.rejects(f.indexer.paperIR(f.project.id, first.job.fileId), /research_ovis_artifact_changed/);
    const reuse = () => f.indexer.publishArtifact(f.storage, hash(f.bytes), parsed, work, new AbortController().signal);
    await assert.rejects(reuse(), /research_ovis_artifact_changed/);
    assert.deepEqual(snapshot(f), original);
    await writeFile(target, bytes);
    assert.equal((await reuse()).parseArtifactId, first.payload.parseArtifactId);
    const restored = await f.indexer.paperIR(f.project.id, first.job.fileId);
    assert.equal(restored.tables[0].data.rawHtml, html);
  });
});
