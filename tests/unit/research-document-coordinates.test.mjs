import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile, realpath, rename, symlink} from 'node:fs/promises';
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

function previewScene(f) {
  f.repository.documents.begin(f.document.id, 'preview-coordinate-parse');
  f.repository.documents.complete(f.document.id, 'preview-coordinate-parse', f.collected.data, f.collected.coordinates);
  f.service = new api.ResearchDocumentService(f.repository, {}, f.root);
  const registry = new api.CapabilityRegistry();
  for (const descriptor of api.researchDocumentCapabilities) registry.declare('research', descriptor);
  api.registerResearchDocumentCapabilities({pluginId: 'research', capabilities: registry}, f.repository.documents, f.service);
  f.registry = registry;
  f.adapter = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => registry.invoke(name, input)});
  f.previewRequest = {projectId: f.project.id, documentId: f.document.id, parseId: 'preview-coordinate-parse',
    sourceHash: f.document.sourceHash, parseHash: hash(JSON.stringify(f.collected.data.content))};
  f.sourceRequest = {projectId: f.project.id, documentId: f.document.id, sourceHash: f.document.sourceHash};
  f.assetRequest = {projectId: f.project.id, documentId: f.document.id, parseId: 'preview-coordinate-parse',
    assetId: f.collected.data.content.assets[0].id, sha256: f.collected.data.content.assets[0].sha256};
}

test('generated document preview publishes only verified project-scoped metadata and byte capabilities remain readonly', async () => {
  const f = await scene();
  try {
    previewScene(f);
    const before = f.changes();
    assert.deepEqual(api.parseIpcRequestArgs('roc:research:document-preview', [f.previewRequest]), [f.previewRequest]);
    assert.throws(() => api.parseIpcRequestArgs('roc:research:document-preview', [{...f.previewRequest, sourcePath: '/private/file.pdf'}]));
    assert.throws(() => api.parseIpcRequestArgs('roc:research:document-preview', [{...f.previewRequest, parseHash: undefined}]));
    const result = await f.adapter.invoke('research.previewDocument', [f.previewRequest], 71);
    assert.equal(result.ok, true);
    assert.equal(result.data.parseHash, f.previewRequest.parseHash);
    assert.equal(result.data.sourceHash, f.document.sourceHash);
    assert.equal(result.data.parseId, f.previewRequest.parseId);
    assert.equal(result.data.coordinates.snapshotHash, f.repository.documents.coordinates(f.document.id, f.previewRequest.parseId).snapshotHash);
    assert.deepEqual(result.data.coordinates.pages, f.collected.coordinates.pages);
    assert.equal(result.data.coordinates.pages[0].frame.kind, 'pdf');
    assert.equal(result.data.sourceUrl, `roc-preview://research/projects/${f.project.id}/documents/${f.document.id}/source/${f.document.sourceHash}`);
    assert.ok(result.data.assets[0].resourceUrl.includes(`/parses/${f.previewRequest.parseId}/${f.assetRequest.assetId}/`));
    assert.equal(JSON.stringify(result.data).includes(f.root), false);
    assert.equal('artifact' in result.data.coordinates, false);
    const source = await f.registry.invoke('research.document.source', f.sourceRequest);
    assert.equal(source.headers.get('content-type'), 'application/pdf');
    assert.equal(source.headers.get('cache-control'), 'no-store');
    assert.equal(source.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await source.arrayBuffer()), await readFile(join(f.root, 'source.pdf')));
    const image = await f.registry.invoke('research.document.asset', f.assetRequest);
    assert.equal(image.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await image.arrayBuffer());
    assert.equal(hash(bytes), f.assetRequest.sha256);
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    assert.equal(f.changes(), before);
    const discovered = await f.adapter.invoke('research.previewDocument', [{...f.previewRequest, parseHash: null}], 71);
    assert.deepEqual(discovered.data, result.data);
    assert.equal(f.changes(), before);
  } finally {await f.cleanup();}
});

test('preview and bytes refuse foreign projects and changed exact versions before exposing resource metadata', async () => {
  const f = await scene();
  try {
    previewScene(f);
    const other = f.repository.createProject({title: 'Unlinked project', description: '', workspacePath: '/tmp/coordinate-other'});
    const before = f.changes();
    const denied = await f.adapter.invoke('research.previewDocument', [{...f.previewRequest, projectId: other.id}], 71);
    assert.equal(denied.ok, false); assert.equal(denied.error.code, 'research_document_project_mismatch');
    assert.equal(denied.error.category, 'permission');
    for (const [name, request] of [['research.document.source', f.sourceRequest], ['research.document.asset', f.assetRequest]]) {
      await assert.rejects(f.registry.invoke(name, {...request, projectId: other.id}), error => error.code === 'research_document_project_mismatch');
      const {projectId, ...unscoped} = request;
      await assert.rejects(f.registry.invoke(name, unscoped));
    }
    for (const [override, code] of [
      [{sourceHash: 'a'.repeat(64)}, 'research_document_source_changed'],
      [{parseHash: 'a'.repeat(64)}, 'research_document_preview_parse_changed'],
      [{parseId: 'missing-parse'}, 'research_document_parse_not_found'],
      [{documentId: 'missing-document'}, 'research_document_not_found']
    ]) {
      const result = await f.adapter.invoke('research.previewDocument', [{...f.previewRequest, ...override}], 71);
      assert.equal(result.ok, false); assert.equal(result.error.code, code);
    }
    assert.equal(f.changes(), before);
  } finally {await f.cleanup();}
});

test('preview refuses missing or tampered original, coordinate artifact and snapshot; assets verify actual bytes', async () => {
  const f = await scene();
  try {
    previewScene(f);
    const sourcePath = join(f.root, 'source.pdf'), source = await readFile(sourcePath);
    const artifactPath = join(f.root, f.collected.data.outputPath, f.collected.coordinates.artifact.path);
    const artifact = await readFile(artifactPath);
    const imagePath = join(f.root, f.collected.data.outputPath, f.collected.data.files[f.assetRequest.assetId]);
    const image = await readFile(imagePath);
    const before = f.changes();
    await writeFile(sourcePath, Buffer.concat([source, Buffer.from('\n% Task-owned corruption\n')]));
    let result = await f.adapter.invoke('research.previewDocument', [f.previewRequest], 71);
    assert.equal(result.error.code, 'research_document_source_changed');
    await assert.rejects(f.registry.invoke('research.document.source', f.sourceRequest), error => error.code === 'research_document_source_changed');
    await writeFile(sourcePath, source);
    await writeFile(artifactPath, Buffer.concat([artifact, Buffer.from('\n ')]));
    result = await f.adapter.invoke('research.previewDocument', [f.previewRequest], 71);
    assert.equal(result.error.code, 'research_document_coordinate_artifact_changed');
    await writeFile(artifactPath, artifact);
    await rename(sourcePath, `${sourcePath}.held`);
    result = await f.adapter.invoke('research.previewDocument', [f.previewRequest], 71);
    assert.equal(result.error.code, 'research_document_file_missing');
    await symlink(`${sourcePath}.held`, sourcePath);
    result = await f.adapter.invoke('research.previewDocument', [f.previewRequest], 71);
    assert.equal(result.error.code, 'research_path_symlink'); assert.equal(result.error.category, 'permission');
    await rm(sourcePath); await rename(`${sourcePath}.held`, sourcePath);
    await writeFile(imagePath, Buffer.concat([image, Buffer.from('changed')]));
    await assert.rejects(f.registry.invoke('research.document.asset', f.assetRequest), error => error.code === 'research_document_asset_changed');
    await writeFile(imagePath, image);
    assert.equal((await f.adapter.invoke('research.previewDocument', [f.previewRequest], 71)).ok, true);
    assert.equal(f.changes(), before);
    const original = f.db.prepare('SELECT * FROM research_document_parse_coordinates').get();
    f.db.prepare('DELETE FROM research_document_parse_coordinates').run();
    const missing = f.changes();
    result = await f.adapter.invoke('research.previewDocument', [f.previewRequest], 71);
    assert.equal(result.error.code, 'research_document_coordinate_snapshot_missing');
    assert.equal(f.changes(), missing);
    f.db.prepare(`INSERT INTO research_document_parse_coordinates
      (parse_id,document_id,snapshot_json,snapshot_hash,created_at) VALUES (@parse_id,@document_id,@snapshot_json,@snapshot_hash,@created_at)`).run(original);
    assert.equal((await f.adapter.invoke('research.previewDocument', [f.previewRequest], 71)).ok, true);
  } finally {await f.cleanup();}
});

test('fixed historical parses keep their captured basis while uncaptured history explicitly has no measured frame', async () => {
  const f = await scene();
  try {
    previewScene(f);
    const original = (await f.adapter.invoke('research.previewDocument', [f.previewRequest], 71)).data;
    f.repository.documents.begin(f.document.id, 'new-preview-parse');
    f.repository.documents.complete(f.document.id, 'new-preview-parse', f.collected.data, f.collected.coordinates);
    const before = f.changes();
    assert.deepEqual((await f.adapter.invoke('research.previewDocument', [f.previewRequest], 71)).data, original);
    assert.equal(f.changes(), before);
    f.repository.documents.begin(f.document.id, 'uncaptured-preview-parse');
    f.repository.documents.complete(f.document.id, 'uncaptured-preview-parse', f.collected.data, null);
    const after = f.changes();
    const historical = await f.adapter.invoke('research.previewDocument', [{...f.previewRequest, parseId: 'uncaptured-preview-parse'}], 71);
    assert.equal(historical.ok, true); assert.equal(historical.data.coordinates, null);
    assert.equal(historical.data.sourceHash, original.sourceHash);
    assert.equal(f.changes(), after);
    f.db.prepare("UPDATE research_document_parses SET status='failed',error='research_document_parse_superseded' WHERE id=?").run(f.previewRequest.parseId);
    const invalid = f.changes();
    const superseded = await f.adapter.invoke('research.previewDocument', [f.previewRequest], 71);
    assert.equal(superseded.error.code, 'research_document_parse_superseded');
    assert.equal(f.changes(), invalid);
  } finally {await f.cleanup();}
});

test('scope removal during asynchronous original read refuses both preview metadata and source bytes', async () => {
  const f = await scene();
  try {
    previewScene(f);
    const originalPath = f.repository.documents.sourcePath.bind(f.repository.documents);
    f.repository.documents.sourcePath = id => {
      f.repository.library.link(f.document.libraryItemId, f.project.id, false, {notify: false});
      return originalPath(id);
    };
    const result = await f.adapter.invoke('research.previewDocument', [f.previewRequest], 71);
    assert.equal(result.error.code, 'research_document_project_mismatch');
    f.repository.library.link(f.document.libraryItemId, f.project.id, true, {notify: false});
    await assert.rejects(f.registry.invoke('research.document.source', f.sourceRequest), error => error.code === 'research_document_project_mismatch');
    f.repository.documents.sourcePath = originalPath;
  } finally {await f.cleanup();}
});

test('generated resolver and content bridge read the exact historical parse with project and source authority', async () => {
  const f = await scene();
  try {
    previewScene(f);
    const old = f.service.content(f.previewRequest);
    f.repository.documents.begin(f.document.id, 'current-reader-parse');
    f.repository.documents.complete(f.document.id, 'current-reader-parse', f.collected.data, f.collected.coordinates);
    assert.equal(f.repository.documents.runs(f.document.id)[0].id, 'current-reader-parse');
    const before = f.changes();
    const resolved = await f.adapter.invoke('research.resolveDocumentParse', [{
      projectId: f.project.id, parseId: f.previewRequest.parseId
    }], 71);
    assert.equal(resolved.ok, true); assert.equal(resolved.data.id, f.document.id);
    assert.equal(resolved.data.currentParseId, 'current-reader-parse');
    const historical = await f.adapter.invoke('research.getDocumentContent', [f.previewRequest], 71);
    assert.equal(historical.ok, true); assert.deepEqual(historical.data, old);
    assert.equal(historical.data.run.id, f.previewRequest.parseId);
    const current = await f.adapter.invoke('research.getDocumentContent', [{...f.previewRequest, parseId: 'current-reader-parse'}], 71);
    assert.equal(current.data.run.id, 'current-reader-parse');
    assert.equal(f.changes(), before);
    assert.throws(() => api.parseIpcRequestArgs('roc:research:document-content', [{
      documentId: f.document.id, parseId: f.previewRequest.parseId
    }]), 'old unscoped content contract is removed');
    const wrong = await f.adapter.invoke('research.getDocumentContent', [{...f.previewRequest, parseHash: 'a'.repeat(64)}], 71);
    assert.equal(wrong.error.code, 'research_document_preview_parse_changed');
    const other = f.repository.createProject({title: 'Unlinked reader project', description: '', workspacePath: '/tmp/reader-other'});
    const after = f.changes();
    for (const [method, request] of [
      ['research.resolveDocumentParse', {projectId: other.id, parseId: f.previewRequest.parseId}],
      ['research.getDocumentContent', {...f.previewRequest, projectId: other.id}]
    ]) {
      const denied = await f.adapter.invoke(method, [request], 71);
      assert.equal(denied.error.code, 'research_document_project_mismatch'); assert.equal(denied.error.category, 'permission');
    }
    const missing = await f.adapter.invoke('research.resolveDocumentParse', [{projectId: f.project.id, parseId: 'missing'}], 71);
    assert.equal(missing.error.code, 'research_document_parse_not_found');
    assert.equal(f.changes(), after);
  } finally {await f.cleanup();}
});

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
