import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let api, parseResearchDocument, collectDocumentContent;
const hash = text => createHash('sha256').update(text).digest('hex');
before(async () => {
  api = await loadResearchTestApi();
  ({parseResearchDocument} = await importTypeScriptModule('src/main/plugins/research/document-parser.ts', {
    platform: 'node', external: ['@napi-rs/canvas', 'onnxruntime-node', 'paddleocr', 'pdfjs-dist/legacy/build/pdf.mjs'], tempDir: '.runtime/tmp'
  }));
  ({collectDocumentContent} = await importTypeScriptModule('src/main/plugins/research/document-files.ts', {
    platform: 'node', external: ['zod'], tempDir: '.runtime/tmp'
  }));
});
after(() => api?.dispose());
async function scene({databaseVersion = 25} = {}) {
  const fixtureApi = databaseVersion === 25 ? api : {...api, applyResearchDatabaseSchema(db) {
    api.applyDatabaseMigrations(db, {dbName: 'plugin:@roc/plugin-research', migrations: api.researchMigrations.filter(migration => migration.version <= databaseVersion)});
  }};
  const f = createResearchFixture(fixtureApi, 'reading');
  f.directory = await mkdtemp(join(tmpdir(), 'roc-coordinate-publication-'));
  f.root = await realpath(f.directory);
  const bytes = await readFile('tests/fixtures/research-workflow/source.pdf');
  const sourcePath = join(f.root, 'source.pdf'); await writeFile(sourcePath, bytes);
  const parsed = await parseResearchDocument({projectRoot: f.root, sourcePath, outputDir: join(f.root, 'output'),
    options: {tier: 'compact', device: 'cpu', pageRange: '1'}, modelFiles: null, modelManifest: ''});
  f.parsed = parsed;
  f.collected = await collectDocumentContent(f.root, join(f.root, 'output'), parsed);
  f.document = f.repository.documents.import({id: 'coordinate-document', libraryItemId: null, projectId: f.project.id,
    filename: 'source.pdf', mediaType: 'application/pdf', sourcePath: 'source.pdf', sourceHash: hash(bytes), size: bytes.length,
    entry: {metadata: {id: 'coordinate-literature', source: 'local', externalId: 'coordinate-fixture', doi: null,
      title: 'Synthetic coordinate publication', authors: ['Synthetic Author'], abstract: null, publishedYear: 2026, citationCount: null,
      url: null, openAccessUrl: null, importedAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z'},
      bibliography: {citationKey: 'coordinate2026', entryType: 'article', fields: {title: 'Synthetic coordinate publication'}, preambles: [],
        csl: null, title: 'Synthetic coordinate publication', authors: ['Synthetic Author'], doi: null, publishedYear: 2026, abstract: null, url: null}}
  }, false).document;
  f.changes = () => f.db.prepare('SELECT total_changes()').pluck().get();
  f.cleanup = async () => {f.close(); await rm(f.directory, {recursive: true, force: true});};
  return f;
}

test('actual parser coordinate collection publishes the exact file/source/parse seal atomically with the parse', async () => {
  const f = await scene();
  try {
    const {data, coordinates} = f.collected;
    assert.ok(coordinates);
    f.repository.documents.begin(f.document.id, 'coordinate-parse');
    f.repository.documents.complete(f.document.id, 'coordinate-parse', data, coordinates);
    const before = f.changes();
    const saved = f.repository.documents.coordinates(f.document.id, 'coordinate-parse');
    assert.deepEqual(saved.snapshot, coordinates);
    assert.equal(saved.snapshotHash, hash(JSON.stringify(saved.snapshot)));
    assert.equal(saved.snapshot.sourceHash, f.document.sourceHash);
    assert.equal(saved.snapshot.parseHash, hash(JSON.stringify(f.repository.documents.parsed(f.document.id, 'coordinate-parse').data.content)));
    const bytes = await readFile(join(f.root, data.outputPath, coordinates.artifact.path));
    assert.equal(saved.snapshot.artifact.sha256, hash(bytes)); assert.equal(saved.snapshot.artifact.size, bytes.length);
    assert.equal(saved.snapshot.pages[0].frame.page, 1);
    assert.equal(f.changes(), before);
  } finally {await f.cleanup();}
});

test('coordinate snapshot insertion failure rolls back parse publication and retains the old source and index', async () => {
  const f = await scene();
  try {
    const {data, coordinates} = f.collected;
    f.repository.documents.begin(f.document.id, 'old-coordinate-parse');
    f.repository.documents.complete(f.document.id, 'old-coordinate-parse', data, coordinates);
    const evidence = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'document:old-coordinate-parse:chunk:0'});
    const source = f.repository.evidence.inspectEvidence(evidence.id, f.project.id);
    const original = f.repository.documents.coordinates(f.document.id, 'old-coordinate-parse');
    f.repository.documents.begin(f.document.id, 'failed-coordinate-parse');
    const index = f.db.prepare('SELECT * FROM research_knowledge_documents').all();
    f.db.exec("CREATE TRIGGER fail_coordinate_snapshot BEFORE INSERT ON research_document_parse_coordinates BEGIN SELECT RAISE(ABORT,'synthetic_coordinate_insert_failure'); END");
    assert.throws(() => f.repository.documents.complete(f.document.id, 'failed-coordinate-parse', data, coordinates), /synthetic_coordinate_insert_failure/u);
    assert.equal(f.repository.documents.get(f.document.id).currentParseId, 'old-coordinate-parse');
    assert.equal(f.repository.documents.get(f.document.id).activeParseId, 'failed-coordinate-parse');
    assert.equal(f.repository.documents.runs(f.document.id)[0].status, 'running');
    assert.deepEqual(f.repository.evidence.inspectEvidence(evidence.id, f.project.id), source);
    assert.deepEqual(f.db.prepare('SELECT * FROM research_knowledge_documents').all(), index);
    assert.deepEqual(f.repository.documents.coordinates(f.document.id, 'old-coordinate-parse'), original);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_document_parse_coordinates').pluck().get(), 1);
    f.db.exec('DROP TRIGGER fail_coordinate_snapshot');
    f.repository.documents.complete(f.document.id, 'failed-coordinate-parse', data, coordinates);
    assert.equal(f.repository.evidence.inspectEvidence(evidence.id, f.project.id).referenceStatus, 'superseded');
    assert.deepEqual(f.repository.documents.coordinates(f.document.id, 'old-coordinate-parse'), original);
  } finally {await f.cleanup();}
});

test('coordinate source parse page and region binding rejects corruption without writes or guessed geometry', async () => {
  const f = await scene();
  try {
    const {data, coordinates} = f.collected;
    f.repository.documents.begin(f.document.id, 'bound-coordinate-parse');
    const before = f.changes();
    for (const malformed of [
      {...coordinates, sourceHash: 'a'.repeat(64)}, {...coordinates, parseHash: 'a'.repeat(64)},
      {...coordinates, artifact: {...coordinates.artifact, path: 'other.json'}}, {...coordinates, pages: []},
      {...coordinates, pages: [{page: 1, frame: null}]},
      {...coordinates, pages: [{page: 1, frame: {...coordinates.pages[0].frame, width: 1, height: 1,
        viewport: {...coordinates.pages[0].frame.viewport, width: 1, height: 1}}}]}
    ]) assert.throws(() => f.repository.documents.complete(f.document.id, 'bound-coordinate-parse', data, malformed),
      /research_document_coordinate_|matching page|Raster/u);
    assert.equal(f.changes(), before);
    assert.throws(() => f.repository.documents.complete(f.document.id, 'bound-coordinate-parse', data), /Invalid/u,
      'coordinate input is explicit; old three-argument writes are not supported');
    assert.equal(f.changes(), before);
    f.repository.documents.complete(f.document.id, 'bound-coordinate-parse', data, coordinates);
    const saved = f.db.prepare('SELECT * FROM research_document_parse_coordinates').get();
    f.db.prepare("UPDATE research_document_parse_coordinates SET snapshot_json=json_set(snapshot_json,'$.pages[0].frame.width',1)").run();
    const damaged = f.changes();
    assert.throws(() => f.repository.documents.coordinates(f.document.id, 'bound-coordinate-parse'), /research_document_coordinate_snapshot_invalid/u);
    assert.equal(f.changes(), damaged);
    f.db.prepare('UPDATE research_document_parse_coordinates SET snapshot_json=?').run(saved.snapshot_json);
    const originalData = f.db.prepare('SELECT data_json FROM research_document_parses WHERE id=?').pluck().get('bound-coordinate-parse');
    f.db.prepare("UPDATE research_document_parses SET data_json=json_set(data_json,'$.content.parserFingerprint',?) WHERE id=?")
      .run('a'.repeat(64), 'bound-coordinate-parse');
    const changed = f.changes();
    assert.throws(() => f.repository.documents.coordinates(f.document.id, 'bound-coordinate-parse'), /research_document_coordinate_binding_changed/u);
    assert.equal(f.changes(), changed);
    f.db.prepare('UPDATE research_document_parses SET data_json=? WHERE id=?').run(originalData, 'bound-coordinate-parse');
    assert.deepEqual(f.repository.documents.coordinates(f.document.id, 'bound-coordinate-parse').snapshot, coordinates);
    f.db.prepare('DELETE FROM research_document_parse_coordinates WHERE parse_id=?').run('bound-coordinate-parse');
    const missing = f.changes();
    assert.throws(() => f.repository.documents.coordinates(f.document.id, 'bound-coordinate-parse'), /research_document_coordinate_snapshot_missing/u);
    assert.equal(f.changes(), missing);
    f.db.prepare(`INSERT INTO research_document_parse_coordinates
      (parse_id,document_id,snapshot_json,snapshot_hash,created_at) VALUES (@parse_id,@document_id,@snapshot_json,@snapshot_hash,@created_at)`).run(saved);
    assert.deepEqual(f.repository.documents.coordinates(f.document.id, 'bound-coordinate-parse').snapshot, coordinates);
    assert.throws(() => f.repository.documents.coordinates('missing-document', 'bound-coordinate-parse'), /research_document_not_found/u);
  } finally {await f.cleanup();}
});

test('marked coordinate artifacts must match actual returned blocks and cannot silently lose measured pages', async () => {
  const f = await scene();
  try {
    const {data} = f.collected;
    const artifactPath = join(f.root, data.outputPath, data.content.artifacts.structuredContent);
    const original = await readFile(artifactPath);
    const structured = JSON.parse(original);
    for (const mutation of [
      {...structured, coordinateFrameContractVersion: 2},
      {...structured, pages: structured.pages.map(page => ({...page, coordinateFrame: null}))},
      {...structured, blocks: structured.blocks.map(block => ({...block, text: 'Forged structured text.'}))}
    ]) {
      await writeFile(artifactPath, JSON.stringify(mutation));
      await assert.rejects(collectDocumentContent(f.root, join(f.root, data.outputPath), f.parsed));
    }
    await writeFile(artifactPath, original);
    const restored = await collectDocumentContent(f.root, join(f.root, data.outputPath), f.parsed);
    assert.deepEqual(restored, f.collected);
  } finally {await f.cleanup();}
});

test('DB24 to25 preserves actual parse and user replacement snapshots without fabricating coordinate history', async () => {
  const f = await scene({databaseVersion: 24});
  try {
    f.repository.documents.begin(f.document.id, 'historical-coordinate-parse');
    f.repository.documents.complete(f.document.id, 'historical-coordinate-parse', f.collected.data, null);
    const evidence = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'document:historical-coordinate-parse:chunk:0'});
    const nextBytes = Buffer.concat([await readFile(join(f.root, 'source.pdf')), Buffer.from('\n% Explicit task-owned version successor\n')]);
    const sourcePath = join(f.root, 'source-next.pdf'), outputDir = join(f.root, 'next-output');
    await writeFile(sourcePath, nextBytes);
    const parsed = await parseResearchDocument({projectRoot: f.root, sourcePath, outputDir,
      options: {tier: 'compact', device: 'cpu', pageRange: '1'}, modelFiles: null, modelManifest: ''});
    const collected = await collectDocumentContent(f.root, outputDir, parsed);
    const targetDocument = f.repository.documents.import({id: 'historical-coordinate-successor', libraryItemId: f.document.libraryItemId,
      projectId: f.project.id, filename: 'source-next.pdf', mediaType: 'application/pdf', sourcePath: 'source-next.pdf',
      sourceHash: hash(nextBytes), size: nextBytes.length, entry: null}, false).document;
    f.repository.documents.begin(targetDocument.id, 'historical-coordinate-successor-parse');
    f.repository.documents.complete(targetDocument.id, 'historical-coordinate-successor-parse', collected.data, null);
    const target = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'document:historical-coordinate-successor-parse:chunk:0'});
    f.repository.evidence.sourceReplacements.replace({projectId: f.project.id, requestId: 'historical-coordinate-replacement', kind: 'document_replacement',
      evidenceId: evidence.id, targetEvidenceId: target.id,
      expectedSourceDigest: api.relationSourceDigest(f.repository.evidence.inspectEvidence(evidence.id, f.project.id)),
      expectedTargetDigest: api.relationSourceDigest(f.repository.evidence.inspectEvidence(target.id, f.project.id)), note: null},
      {kind: 'user', id: 'synthetic-historical-frame-user'});
    const tables = ['research_documents', 'research_document_parses', 'research_evidence', 'research_evidence_source_locators',
      'research_source_replacements', 'research_evidence_relations', 'research_evidence_relation_revisions'];
    const originals = tables.map(table => f.db.prepare(`SELECT * FROM ${table}`).all());
    api.applyResearchDatabaseSchema(f.db);
    assert.equal(f.db.prepare('SELECT current_version FROM schema_metadata').pluck().get(), 25);
    tables.forEach((table, index) => {
      const rows = f.db.prepare(`SELECT * FROM ${table}`).all();
      if (table === 'research_document_parses') {
        assert.ok(rows.every(row => row.coordinate_snapshot_hash === null));
        assert.deepEqual(rows.map(({coordinate_snapshot_hash, ...row}) => row), originals[index]);
      } else assert.deepEqual(rows, originals[index]);
    });
    assert.equal(f.db.prepare('SELECT count(*) FROM research_document_parse_coordinates').pluck().get(), 0);
    const before = f.changes();
    assert.equal(f.repository.documents.coordinates(f.document.id, 'historical-coordinate-parse'), null);
    assert.equal(f.repository.documents.coordinates(targetDocument.id, 'historical-coordinate-successor-parse'), null);
    api.applyResearchDatabaseSchema(f.db);
    assert.equal(f.changes(), before);
  } finally {await f.cleanup();}
});
