import {applyOfflineResearchSchema} from './fixtures/offline-migration.mjs';
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let api, parseResearchDocument, collectDocumentContent, projectParsedRegionToPdf;
const hash = value => createHash('sha256').update(value).digest('hex');
before(async () => {
  api = await loadResearchTestApi();
  ({parseResearchDocument} = await importTypeScriptModule('src/main/plugins/research/document-parser.ts', {
    platform: 'node', external: ['@napi-rs/canvas', 'onnxruntime-node', 'paddleocr', 'pdfjs-dist/legacy/build/pdf.mjs'], tempDir: '.runtime/tmp'
  }));
  ({collectDocumentContent} = await importTypeScriptModule('src/main/plugins/research/document-files.ts', {
    platform: 'node', external: ['zod'], tempDir: '.runtime/tmp'
  }));
  ({projectParsedRegionToPdf} = await importTypeScriptModule('src/shared/research-document-coordinates.ts', {
    platform: 'node', external: ['zod'], tempDir: '.runtime/tmp'
  }));
});
after(() => api?.dispose());

async function scene({basis = true, databaseVersion = 26} = {}) {
  const fixtureApi = databaseVersion === 26 ? api : {...api, applyResearchDatabaseSchema(db) {
    api.applyDatabaseMigrations(db, {dbName: 'plugin:@roc/plugin-research',
      migrations: api.researchMigrations.filter(migration => migration.version <= databaseVersion)});
  }};
  const f = createResearchFixture(fixtureApi, 'reading');
  // Seed historical schemas before the durable outbox existed.
  if (databaseVersion !== 26) f.repository.queueKnowledgeFromSource = () => {};
  f.directory = await mkdtemp(join(tmpdir(), 'roc-document-annotations-'));
  f.root = await realpath(f.directory);
  f.original = await readFile('tests/fixtures/research-workflow/source.pdf');
  await writeFile(join(f.root, 'source.pdf'), f.original);
  const parsed = await parseResearchDocument({projectRoot: f.root, sourcePath: join(f.root, 'source.pdf'),
    outputDir: join(f.root, 'parsed'), options: {tier: 'compact', device: 'cpu', pageRange: '1'}, modelFiles: null, modelManifest: ''});
  f.collected = await collectDocumentContent(f.root, join(f.root, 'parsed'), parsed);
  f.document = f.repository.documents.import({id: 'annotation-document', libraryItemId: null, projectId: f.project.id,
    filename: 'source.pdf', mediaType: 'application/pdf', sourcePath: 'source.pdf', sourceHash: hash(f.original), size: f.original.length,
    entry: {metadata: {id: 'annotation-literature', source: 'local', externalId: 'annotation-fixture', doi: null,
      title: 'Explicit annotation fixture', authors: ['Synthetic Author'], abstract: null, publishedYear: 2026, citationCount: null,
      url: null, openAccessUrl: null, importedAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z'},
      bibliography: {citationKey: 'annotation2026', entryType: 'article', fields: {title: 'Explicit annotation fixture'}, preambles: [],
        csl: null, title: 'Explicit annotation fixture', authors: ['Synthetic Author'], doi: null, publishedYear: 2026, abstract: null, url: null}}
  }, false).document;
  f.repository.documents.begin(f.document.id, 'annotation-parse');
  f.repository.documents.complete(f.document.id, 'annotation-parse', f.collected.data, basis ? f.collected.coordinates : null);
  f.service = new api.ResearchDocumentService(f.repository, {}, f.root);
  f.registry = new api.CapabilityRegistry();
  for (const descriptor of api.researchDocumentCapabilities) f.registry.declare('research', descriptor);
  api.registerResearchDocumentCapabilities({pluginId: 'research', capabilities: f.registry}, f.repository.documents, f.service);
  f.adapter = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => f.registry.invoke(name, input)});
  const coordinates = f.repository.documents.coordinates(f.document.id, 'annotation-parse');
  const frame = coordinates?.snapshot.pages[0].frame;
  f.target = {projectId: f.project.id, documentId: f.document.id, parseId: 'annotation-parse',
    sourceHash: f.document.sourceHash, parseHash: hash(JSON.stringify(f.collected.data.content)),
    parserFingerprint: f.collected.data.content.parserFingerprint, page: 1, blockId: f.collected.data.content.blocks[0].id,
    coordinateBasis: coordinates === null ? null : {snapshotHash: coordinates.snapshotHash, frame},
    location: coordinates === null ? {kind: 'page'} : {kind: 'pdf-region', unit: 'pdf-user-space',
      bbox: projectParsedRegionToPdf({frame, bbox: [frame.width * .1, frame.height * .2, frame.width * .4, frame.height * .6], coordinateOrigin: 'TOPLEFT'})}};
  f.request = {requestId: 'annotate-source', target: f.target, issue: 'number', note: 'Read the source value before accepting the parsed number.'};
  f.create = (request = f.request, windowId = 72) => f.adapter.invoke('research.createDocumentAnnotation', [request], windowId);
  f.get = annotationId => f.adapter.invoke('research.getDocumentAnnotation', [{projectId: f.project.id, annotationId}], 72);
  f.list = () => f.adapter.invoke('research.listDocumentAnnotations', [{projectId: f.project.id, documentId: f.document.id, parseId: 'annotation-parse'}], 72);
  f.captureRequest = inspection => ({projectId: f.project.id, annotationId: inspection.annotation.id,
    requestId: `capture:${inspection.annotation.id}`, expectedAnnotationHash: inspection.annotationHash});
  f.capture = (request, windowId = 72) => f.adapter.invoke('research.captureDocumentAnnotation', [request], windowId);
  f.changes = () => f.db.prepare('SELECT total_changes()').pluck().get();
  f.science = () => ['research_claims', 'research_evidence_relations', 'research_evidence_relation_revisions']
    .map(table => f.db.prepare(`SELECT * FROM ${table}`).all());
  f.cleanup = async () => {f.close(); await rm(f.directory, {recursive: true, force: true});};
  return f;
}

test('actual document annotation saves a sealed exact user note and block; generated reads and identical replay are readonly', async () => {
  const f = await scene();
  try {
    assert.deepEqual(api.parseIpcRequestArgs('roc:research:annotations-create', [f.request]), [f.request]);
    const science = f.science();
    const result = await f.create();
    assert.equal(result.ok, true);
    const inspection = result.data, annotation = inspection.annotation;
    assert.deepEqual(annotation.request, f.request);
    assert.deepEqual(annotation.actor, {kind: 'user', id: 'window:72'});
    assert.deepEqual(annotation.block, f.collected.data.content.blocks[0]);
    assert.equal(annotation.requestHash, hash(JSON.stringify(f.request)));
    assert.equal(inspection.annotationHash, hash(JSON.stringify(annotation)));
    assert.equal(inspection.capture, null); assert.equal(inspection.capturedReferenceStatus, null);
    assert.equal(f.repository.evidence.list(f.project.id).length, 0);
    const before = f.changes();
    assert.deepEqual((await f.create()).data, inspection);
    assert.deepEqual((await f.get(annotation.id)).data, inspection);
    assert.deepEqual((await f.list()).data, [inspection]);
    assert.equal(f.changes(), before);
    assert.deepEqual(f.science(), science);
    const conflict = await f.create({...f.request, note: 'A different note.'});
    assert.equal(conflict.error.code, 'research_annotation_request_conflict');
    assert.equal((await f.create(f.request, 73)).error.code, 'research_annotation_request_conflict');
    assert.equal(f.changes(), before);
    assert.equal(JSON.stringify(inspection).includes(f.root), false);
  } finally {await f.cleanup();}
});

test('annotation writes require trusted main actor and scope; wire actor and missing sender never reach storage', async () => {
  const f = await scene();
  try {
    const before = f.changes();
    assert.throws(() => api.parseIpcRequestArgs('roc:research:annotations-create', [{...f.request, actor: {kind: 'user', id: 'window:72'}}]));
    assert.equal((await f.create(f.request, 0)).error.code, 'research_sender_required');
    await assert.rejects(f.registry.invoke('research.annotations.create', f.request), error => error.code === 'research_human_required');
    await assert.rejects(api.withResearchHumanContext({capability: 'research.annotations.create', projectId: 'other', windowId: 72},
      () => f.registry.invoke('research.annotations.create', f.request)), error => error.code === 'research_human_project_mismatch');
    assert.equal(f.changes(), before);
    const other = f.repository.createProject({title: 'Unlinked note project', description: '', workspacePath: '/tmp/annotation-other'});
    const after = f.changes();
    const denied = await f.create({...f.request, target: {...f.target, projectId: other.id}});
    assert.equal(denied.error.code, 'research_document_project_mismatch');
    assert.equal(f.changes(), after);
    const saved = (await f.create()).data;
    const foreign = await f.adapter.invoke('research.getDocumentAnnotation', [{projectId: other.id, annotationId: saved.annotation.id}], 72);
    assert.equal(foreign.error.code, 'research_annotation_project_mismatch');
    const captureBefore = f.changes();
    assert.equal((await f.capture(f.captureRequest(saved), 0)).error.code, 'research_sender_required');
    await assert.rejects(f.registry.invoke('research.annotations.capture', f.captureRequest(saved)), error => error.code === 'research_human_required');
    assert.equal(f.changes(), captureBefore);
  } finally {await f.cleanup();}
});

test('wrong exact identities and altered original or coordinate bytes refuse annotation with zero writes', async () => {
  const f = await scene();
  try {
    const frame = f.target.coordinateBasis.frame;
    const before = f.changes();
    for (const target of [
      {...f.target, sourceHash: 'a'.repeat(64)}, {...f.target, parseHash: 'a'.repeat(64)},
      {...f.target, parserFingerprint: 'a'.repeat(64)}, {...f.target, page: 99, coordinateBasis: null, location: {kind: 'page'}},
      {...f.target, blockId: 'missing-block'}, {...f.target, coordinateBasis: null, location: {kind: 'page'}},
      {...f.target, coordinateBasis: {...f.target.coordinateBasis, snapshotHash: 'a'.repeat(64)}},
      {...f.target, coordinateBasis: {...f.target.coordinateBasis, frame: {...frame, viewport: {...frame.viewport, scale: 3}}}}
    ]) {
      const result = await f.create({...f.request, target});
      assert.equal(result.ok, false);
      assert.equal(f.changes(), before);
    }
    await writeFile(join(f.root, 'source.pdf'), Buffer.concat([f.original, Buffer.from('\n% Altered task-owned source\n')]));
    assert.equal((await f.create()).error.code, 'research_document_source_changed');
    assert.equal(f.changes(), before);
    await writeFile(join(f.root, 'source.pdf'), f.original);
    const artifactPath = join(f.root, f.collected.data.outputPath, f.collected.coordinates.artifact.path);
    const artifact = await readFile(artifactPath);
    await writeFile(artifactPath, Buffer.concat([artifact, Buffer.from(' ')]));
    assert.equal((await f.create()).error.code, 'research_document_coordinate_artifact_changed');
    assert.equal(f.changes(), before);
    await writeFile(artifactPath, artifact);
    const originalPath = f.repository.documents.sourcePath.bind(f.repository.documents);
    f.repository.documents.sourcePath = id => {
      f.repository.library.link(f.document.libraryItemId, f.project.id, false, {notify: false});
      return originalPath(id);
    };
    assert.equal((await f.create()).error.code, 'research_document_project_mismatch');
    assert.equal(f.db.prepare('SELECT count(*) FROM research_document_annotations').pluck().get(), 0);
    f.repository.documents.sourcePath = originalPath;
  } finally {await f.cleanup();}
});

test('historical notes keep their old page region and text after reparse; stale block capture never fabricates an index', async () => {
  const f = await scene();
  try {
    const saved = (await f.create()).data;
    f.repository.documents.begin(f.document.id, 'new-annotation-parse');
    f.repository.documents.complete(f.document.id, 'new-annotation-parse', f.collected.data, f.collected.coordinates);
    const before = f.changes();
    assert.deepEqual((await f.get(saved.annotation.id)).data, saved);
    assert.deepEqual((await f.list()).data, [saved]);
    assert.equal((await f.capture(f.captureRequest(saved))).error.code, 'research_annotation_parse_stale');
    assert.equal(f.changes(), before);
    assert.equal(f.db.prepare("SELECT count(*) FROM research_knowledge_chunks WHERE document_id='document:annotation-parse'").pluck().get(), 0);
    assert.equal(f.repository.evidence.list(f.project.id).length, 0);
    const nextNote = (await f.create({...f.request, requestId: 'historical-note', issue: 'formula', note: 'Check this original formula.'})).data;
    assert.deepEqual(nextNote.annotation.block, saved.annotation.block);
    assert.deepEqual(nextNote.annotation.request.target, saved.annotation.request.target);
    assert.equal(nextNote.capture, null);
  } finally {await f.cleanup();}
});

test('current block conversion reuses actual Evidence and preserves annotation region without scientific writes; history and replay stay fixed', async () => {
  const f = await scene();
  try {
    const saved = (await f.create()).data, science = f.science();
    const captured = await f.capture(f.captureRequest(saved));
    assert.equal(captured.ok, true);
    const {capture, annotation} = captured.data;
    assert.deepEqual(annotation, saved.annotation);
    assert.equal(capture.actor.id, 'window:72');
    assert.equal(captured.data.capturedReferenceStatus, 'recorded');
    assert.equal(capture.source.evidence.chunkId, 'document:annotation-parse:chunk:0');
    assert.deepEqual(capture.source.sourceLocator.locations, f.collected.data.content.blocks[0].locations);
    assert.equal(capture.source.sourceLocator.parseHash, f.target.parseHash);
    assert.equal(capture.source.sourceLocator.blockId, f.target.blockId);
    assert.equal(capture.sourceDigest, api.relationSourceDigest(capture.source));
    assert.deepEqual(f.repository.evidence.inspectEvidence(capture.source.evidence.id, f.project.id), capture.source);
    const before = f.changes();
    assert.deepEqual((await f.capture(f.captureRequest(saved))).data, captured.data);
    assert.deepEqual((await f.get(annotation.id)).data, captured.data);
    assert.equal(f.changes(), before);
    assert.equal((await f.capture({...f.captureRequest(saved), expectedAnnotationHash: 'a'.repeat(64)})).error.code, 'research_annotation_changed');
    assert.equal((await f.capture({...f.captureRequest(saved), requestId: 'another-capture'})).error.code, 'research_annotation_already_captured');
    assert.equal((await f.capture(f.captureRequest(saved), 73)).error.code, 'research_annotation_request_conflict');
    assert.deepEqual(f.science(), science);
    f.repository.documents.begin(f.document.id, 'reparsed-capture-source');
    f.repository.documents.complete(f.document.id, 'reparsed-capture-source', f.collected.data, f.collected.coordinates);
    const after = f.changes(), historical = (await f.get(annotation.id)).data;
    assert.deepEqual(historical.annotation, annotation);
    assert.deepEqual(historical.capture, capture);
    assert.equal(historical.capturedReferenceStatus, 'superseded');
    assert.deepEqual((await f.capture(f.captureRequest(saved))).data, historical);
    assert.equal(f.changes(), after);
    assert.deepEqual(f.science(), science);
  } finally {await f.cleanup();}
});

test('actual current-index corruption refuses before Evidence writes; receipt failure rolls back Evidence and can retry exact request', async () => {
  const f = await scene();
  try {
    const saved = (await f.create()).data;
    const chunk = f.db.prepare("SELECT * FROM research_knowledge_chunks WHERE id='document:annotation-parse:chunk:0'").get();
    f.db.prepare("UPDATE research_knowledge_chunks SET content='altered chunk' WHERE id=?").run(chunk.id);
    const before = f.changes();
    assert.equal((await f.capture(f.captureRequest(saved))).error.code, 'research_annotation_index_changed');
    assert.equal(f.changes(), before);
    assert.equal(f.repository.evidence.list(f.project.id).length, 0);
    f.db.prepare('UPDATE research_knowledge_chunks SET content=? WHERE id=?').run(chunk.content, chunk.id);
    f.db.exec("CREATE TRIGGER fail_annotation_capture BEFORE INSERT ON research_document_annotation_captures BEGIN SELECT RAISE(ABORT,'synthetic_annotation_receipt_failure'); END");
    assert.equal((await f.capture(f.captureRequest(saved))).ok, false);
    assert.equal(f.repository.evidence.list(f.project.id).length, 0);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_evidence_source_locators').pluck().get(), 0);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_document_annotation_captures').pluck().get(), 0);
    assert.deepEqual((await f.get(saved.annotation.id)).data, saved);
    f.db.exec('DROP TRIGGER fail_annotation_capture');
    assert.equal((await f.capture(f.captureRequest(saved))).ok, true);
  } finally {await f.cleanup();}
});

test('uncaptured coordinate history requires explicit page-only notes and a block-free note cannot be captured', async () => {
  const f = await scene({basis: false});
  try {
    const result = await f.create({...f.request, target: {...f.target, blockId: null}});
    assert.equal(result.ok, true);
    assert.equal(result.data.annotation.block, null);
    assert.equal(result.data.annotation.request.target.coordinateBasis, null);
    assert.deepEqual(result.data.annotation.request.target.location, {kind: 'page'});
    const before = f.changes();
    assert.equal((await f.capture(f.captureRequest(result.data))).error.code, 'research_annotation_block_required');
    assert.equal(f.changes(), before);
    const withBlock = await f.create({...f.request, requestId: 'explicit-page-block'});
    assert.equal((await f.capture(f.captureRequest(withBlock.data))).ok, true);
  } finally {await f.cleanup();}
});

test('annotation and capture snapshot tampering is a read failure with no repair writes', async () => {
  const f = await scene();
  try {
    const saved = (await f.create()).data;
    const row = f.db.prepare('SELECT * FROM research_document_annotations').get();
    f.db.prepare("UPDATE research_document_annotations SET snapshot_json=json_set(snapshot_json,'$.request.note','Changed note')").run();
    let before = f.changes();
    assert.equal((await f.get(saved.annotation.id)).error.code, 'research_annotation_snapshot_invalid');
    assert.equal(f.changes(), before);
    f.db.prepare('UPDATE research_document_annotations SET snapshot_json=? WHERE id=?').run(row.snapshot_json, row.id);
    await f.capture(f.captureRequest(saved));
    f.db.prepare("UPDATE research_document_annotation_captures SET snapshot_json=json_set(snapshot_json,'$.source.sourceLocator.blockId','forged')").run();
    before = f.changes();
    assert.equal((await f.get(saved.annotation.id)).error.code, 'research_annotation_snapshot_invalid');
    assert.equal(f.changes(), before);
  } finally {await f.cleanup();}
});

test('DB25 to26 preserves actual parse/index/coordinate and Evidence snapshots without inventing user annotations', async () => {
  const f = await scene({databaseVersion: 25});
  try {
    const evidence = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'document:annotation-parse:chunk:0'});
    const source = f.repository.evidence.inspectEvidence(evidence.id, f.project.id);
    const tables = ['research_documents', 'research_document_parses', 'research_document_parse_coordinates',
      'research_knowledge_documents', 'research_knowledge_chunks', 'research_evidence', 'research_evidence_source_locators'];
    const originals = tables.map(table => f.db.prepare(`SELECT * FROM ${table}`).all());
    applyOfflineResearchSchema(api, f.db);
    assert.equal(f.db.prepare('SELECT current_version FROM schema_metadata').pluck().get(), api.researchMigrations.at(-1).version);
    tables.forEach((table, index) => assert.deepEqual(f.db.prepare(`SELECT * FROM ${table}`).all(), originals[index]));
    assert.equal(f.db.prepare('SELECT count(*) FROM research_document_annotations').pluck().get(), 0);
    assert.equal(f.db.prepare('SELECT count(*) FROM research_document_annotation_captures').pluck().get(), 0);
    assert.deepEqual(f.repository.evidence.inspectEvidence(evidence.id, f.project.id), source);
    const before = f.changes();
    applyOfflineResearchSchema(api, f.db);
    assert.equal(f.changes(), before);
  } finally {await f.cleanup();}
});
