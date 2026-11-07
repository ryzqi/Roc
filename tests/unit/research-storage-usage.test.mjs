import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, writeFile, readFile, link, symlink, lstat, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createResearchFixture, loadResearchTestApi, figureRequest} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api.dispose());
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function scene() {
  const f = createResearchFixture(api);
  f.directory = await mkdtemp(join(tmpdir(), 'roc-storage-'));
  f.roots = Object.fromEntries(['library', 'index', 'experiment', 'export', 'model', 'resource'].map(kind => [kind, join(f.directory, kind)]));
  for (const root of Object.values(f.roots)) await mkdir(root);
  f.service = new api.ResearchStorageUsageService(f.db, f.repository, f.roots);
  f.put = async (kind, path, bytes) => {
    const target = join(f.roots[kind], path);
    await mkdir(join(target, '..'), {recursive: true}); await writeFile(target, bytes);
    return target;
  };
  f.get = () => f.service.get({projectId: f.project.id});
  f.cleanup = async () => {f.close(); await rm(f.directory, {recursive: true, force: true});};
  return f;
}
function document(f, id, projectId) {
  const bytes = Buffer.from(`source:${id}`), sourcePath = `documents/${id}/source.pdf`;
  return f.repository.documents.import({id, libraryItemId: null, projectId, filename: 'source.pdf',
    mediaType: 'application/pdf', sourcePath, sourceHash: hash(bytes), size: bytes.length,
    entry: {metadata: {id: `literature-${id}`, source: 'local', externalId: id, doi: null, title: id, authors: ['Fixture'],
      abstract: null, publishedYear: 2026, citationCount: null, url: null, openAccessUrl: null,
      importedAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z'},
    bibliography: {citationKey: id, entryType: 'article', fields: {title: id}, preambles: [], csl: null,
      title: id, authors: ['Fixture'], doi: null, publishedYear: 2026, abstract: null, url: null}}
  }, false).document;
}
const group = (usage, type, retention, scope) => usage.groups.find(g => g.type === type && g.retention === retention && g.scope === scope);

test('generated preload method reaches the production storage capability with explicit project scope', async () => {
  const f = await scene();
  try {
    await f.withWorker(async () => {
    const registry = new api.CapabilityRegistry();
    registry.declare('research', api.researchStorageCapability);
    api.registerResearchStorageCapability({pluginId: 'research', capabilities: registry}, f.service);
    const adapter = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => registry.invoke(name, input)});
    const request = {projectId: f.project.id};
    assert.deepEqual(api.parseIpcRequestArgs('roc:research:storage-usage', [request]), [request]);
    const result = await adapter.invoke('research.getStorageUsage', [request], 71);
    assert.equal(result.ok, true); assert.equal(result.data.projectId, f.project.id);
    assert.equal(result.data.deletion, 'none');
    assert.throws(() => api.parseIpcRequestArgs('roc:research:storage-usage', [{}]));
      });
  } finally {await f.cleanup();}
});

test('inventory reads actual managed bytes, deduplicates hardlinks and excludes foreign identities without mutating', async () => {
  const f = await scene();
  try {
    await f.withWorker(async () => {
    const other = f.repository.createProject({title: 'Other', description: '', workspacePath: '/tmp/foreign-storage'});
    const own = document(f, 'own', f.project.id), foreign = document(f, 'foreign', other.id);
    await f.put('library', `documents/${own.id}/source.pdf`, 'source:own');
    await f.put('library', `documents/${own.id}/runs/parse/content.json`, 'ocr');
    await f.put('library', `documents/${foreign.id}/source.pdf`, 'foreign');
    await f.put('index', `sources/${f.project.id}/note.md`, 'index source');
    await f.put('index', `sources/${other.id}/note.md`, 'foreign index');
    const cache = await f.put('model', 'weights.bin', 'model cache');
    await link(cache, join(f.roots.model, 'hardlink.bin'));
    await f.put('resource', `${hash(f.project.id)}/weights.bin`, 'versioned download');
    await f.put('resource', `${hash(other.id)}/weights.bin`, 'foreign download');
    const unknown = await f.put('experiment', 'orphan.bin', 'unclassified');
    const before = f.db.prepare('SELECT total_changes()').pluck().get();
    const agentBefore = f.agentDb.prepare('SELECT total_changes()').pluck().get();
    const info = await lstat(cache), unknownBefore = await readFile(unknown);
    const usage = await f.get();
    assert.equal(group(usage, 'source', 'traceable_source', 'project').bytes, 10 + 12);
    assert.equal(group(usage, 'ocr', 'retained_record', 'project').bytes, 3);
    assert.deepEqual(group(usage, 'model', 'cache', 'shared'), {type: 'model', retention: 'cache', scope: 'shared',
      files: 1, bytes: info.size, allocatedBytes: info.blocks * 512});
    assert.equal(group(usage, 'model', 'traceable_source', 'project').bytes, 18);
    assert.equal(group(usage, 'other', 'unclassified', 'unattributed').bytes, 12);
    assert.equal(usage.deletion, 'none');
    assert.equal(JSON.stringify(usage).includes(f.directory), false);
    assert.equal(JSON.stringify(usage).includes(other.id), false);
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(), before);
    assert.equal(f.agentDb.prepare('SELECT total_changes()').pluck().get(), agentBefore);
    assert.deepEqual(await readFile(unknown), unknownBefore);
      });
  } finally {await f.cleanup();}
});

test('shared document references remain nonadditive, distinct from unclassified files', async () => {
  const f = await scene();
  try {
    await f.withWorker(async () => {
    const other = f.repository.createProject({title: 'Shared owner', description: '', workspacePath: '/tmp/shared-storage'});
    const doc = document(f, 'shared', f.project.id);
    f.db.prepare('INSERT INTO research_library_projects (item_id,project_id) VALUES (?,?)')
      .run(doc.libraryItemId, other.id);
    await f.put('library', `documents/${doc.id}/source.pdf`, 'shared');
    const a = await f.get(), b = await f.service.get({projectId: other.id});
    assert.equal(group(a, 'source', 'traceable_source', 'shared').bytes, 6);
    assert.deepEqual(a.groups, b.groups);
    assert.match(a.accounting, /shared_project_references_are_not_additive/);
      });
  } finally {await f.cleanup();}
});

test('approved run output, source, log and scratch have different retention; index payload counts UTF8 and vectors', async () => {
  const f = await scene();
  try {
    await f.withWorker(async () => {
    const run = f.repository.figureRuns.create(figureRequest(f.project.id, f.run.id),
      f.project.workspacePath, f.project.workspacePath, f.roots.experiment);
    const artifact = f.repository.createArtifact({projectId: f.project.id, stage: 'figure', kind: 'figure', title: 'Approved', path: 'output/figure.svg'});
    f.db.prepare("UPDATE research_artifacts SET status='approved' WHERE id=?").run(artifact.id);
    const stored = {...run, artifactId: artifact.id};
    f.db.prepare('UPDATE research_figure_runs SET snapshot_json=? WHERE run_id=?').run(JSON.stringify(stored), run.id);
    await f.put('experiment', `${run.id}/input/source.csv`, '123');
    await f.put('experiment', `${run.id}/output/figure.svg`, '12345');
    await f.put('experiment', `${run.id}/log/stdout.txt`, '1234567');
    await f.put('experiment', `${run.id}/scratch/cache`, '123456789');
    f.repository.knowledge.upsertFromSource({id: 'storage-note', projectId: f.project.id, sourceType: 'note',
      sourceId: 'storage-note', title: 'Logical', content: '中文abc', chunks: [{content: '中文abc', locator: null}], embeddingPolicy: 'none'});
    const chunkId = f.db.prepare('SELECT id FROM research_knowledge_chunks WHERE document_id=?').pluck().get('storage-note');
    f.db.prepare('INSERT INTO research_knowledge_embeddings (chunk_id,space_key,dimensions,vector_blob,created_at) VALUES (?,?,?,?,?)')
      .run(chunkId, 'fixture', 3, Buffer.alloc(12), '2026-11-04T00:00:00Z');
    const usage = await f.get();
    assert.equal(group(usage, 'source', 'traceable_source', 'project').bytes, 3);
    assert.equal(group(usage, 'figure', 'approved_artifact', 'project').bytes, 5);
    assert.equal(group(usage, 'figure', 'retained_record', 'project').bytes, 7);
    assert.equal(group(usage, 'figure', 'cache', 'project').bytes, 9);
    assert.deepEqual(usage.logicalIndex, {chunks: 1, contentBytes: 9, embeddingBytes: 12});
      });
  } finally {await f.cleanup();}
});

test('missing/unconfigured roots are explicit; invalid project and request fail', async () => {
  const f = await scene();
  try {
    await f.withWorker(async () => {
    const service = new api.ResearchStorageUsageService(f.db, f.repository,
      {...f.roots, library: join(f.directory, 'missing'), index: null});
    const usage = await service.get({projectId: f.project.id});
    assert.equal(usage.roots.find(r => r.kind === 'library').state, 'missing');
    assert.equal(usage.roots.find(r => r.kind === 'index').state, 'unconfigured');
    await assert.rejects(service.get({projectId: 'missing'}), /research_project_not_found/);
    await assert.rejects(service.get({projectId: f.project.id, root: '/private'}));
      });
  } finally {await f.cleanup();}
});

test('symlinks, overlapping roots and invalid entries fail without following targets', async () => {
  const f = await scene();
  try {
    await f.withWorker(async () => {
    const overlap = new api.ResearchStorageUsageService(f.db, f.repository, {...f.roots, index: f.roots.library});
    await assert.rejects(overlap.get({projectId: f.project.id}), /research_storage_roots_overlap/);
    const external = await f.put('model', 'external.bin', 'private');
    await symlink(external, join(f.roots.library, 'linked'));
    await assert.rejects(f.get(), /research_storage_entry_invalid/);
    await rm(join(f.roots.library, 'linked'));
    await symlink(f.roots.library, join(f.directory, 'root-link'));
    const linked = new api.ResearchStorageUsageService(f.db, f.repository, {...f.roots, library: join(f.directory, 'root-link')});
    await assert.rejects(linked.get({projectId: f.project.id}), /research_storage_root_invalid/);
    const invalid = new api.ResearchStorageUsageService(f.db, f.repository, {...f.roots, library: external});
    await assert.rejects(invalid.get({projectId: f.project.id}), /research_storage_root_invalid/);
    assert.equal((await readFile(external)).toString(), 'private');
      });
  } finally {await f.cleanup();}
});
