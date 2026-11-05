import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { loadResearchTestApi, createResearchFixture } from './fixtures/research-test-kit.mjs';

let api, root;
before(async () => { api = await loadResearchTestApi(); root = await realpath(await mkdtemp('/private/tmp/roc-notebook-import-')); });
after(async () => { await rm(root, { recursive: true, force: true }); api.dispose(); });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function notebook(source = 'print(1)\n') {
  return { nbformat: 4, nbformat_minor: 5, metadata: { language_info: { name: 'python' } }, cells: [{
    id: 'code-1', cell_type: 'code', metadata: { trusted: true }, source, execution_count: 9, outputs: [{
      output_type: 'display_data', data: { 'text/html': '<script>throw "UNTRUSTED"</script>', 'text/plain': 'old output' }, metadata: {}
    }]
  }] };
}
async function fixture() {
  const workspace = await mkdtemp(join(root, 'project-'));
  const bytes = Buffer.from(JSON.stringify(notebook(), null, 2) + '\n');
  await writeFile(join(workspace, 'analysis.ipynb'), bytes);
  const f = createResearchFixture(api, 'experiment', workspace);
  const request = { projectId: f.project.id, path: 'analysis.ipynb', requestId: 'import-1', expectedSha256: hash(bytes) };
  const human = (action, projectId = f.project.id, windowId = 72) => api.withResearchHumanContext({
    capability: 'research.notebooks.import', projectId, windowId
  }, action);
  return { ...f, workspace, bytes, request, human, import: input => human(() => f.repository.notebooks.import(input ?? request)),
    reference: value => ({ projectId: f.project.id, notebookId: value.receipt.snapshot.id, expectedHash: value.receipt.snapshotHash }) };
}

test('complete project preview and human import preserve exact original bytes and readonly request replay', async () => {
  const f = await fixture();
  try {
    const large = Buffer.from(JSON.stringify(notebook('print(1)\n'.repeat(10000)), null, 2) + '\n');
    await writeFile(join(f.workspace, f.request.path), large);
    const preview = await f.repository.notebooks.preview({ projectId: f.project.id, path: f.request.path });
    assert.ok(large.length > 65536);
    assert.equal(preview.sha256, hash(large)); assert.equal(preview.cells[0].sourceCharacters, 90000);
    const request = { ...f.request, expectedSha256: hash(large) }, imported = await f.import(request);
    assert.deepEqual(imported.preview, preview);
    assert.deepEqual(imported.receipt.snapshot.actor, { kind: 'user', id: 'window:72' });
    assert.equal(imported.receipt.snapshot.workspacePath, f.workspace);
    assert.equal(imported.preview.outputTrust, 'untrusted');
    assert.equal(imported.preview.cells[0].executionCount, 9);
    assert.equal('data' in imported.preview.cells[0].outputs[0], false);
    const source = f.repository.notebooks.source(f.reference(imported));
    assert.deepEqual(source.bytes, large); assert.deepEqual(source.notebook, notebook('print(1)\n'.repeat(10000)));
    const changes = f.db.prepare('SELECT total_changes()').pluck().get();
    await rm(join(f.workspace, f.request.path));
    assert.deepEqual(await f.import(request), imported);
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(), changes);
    const page = f.repository.notebooks.list({ projectId: f.project.id, offset: 0, limit: 1 });
    assert.deepEqual(page, { items: [imported.receipt], total: 1 });
    assert.deepEqual(f.repository.notebooks.list({ projectId: f.project.id, offset: 1, limit: 1 }), { items: [], total: 1 });
  } finally { f.close(); }
});

test('human authority, project ownership, request identity and reviewed source hash are mandatory', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.repository.notebooks.import(f.request), /research_human_required/u);
    await assert.rejects(f.human(() => f.repository.notebooks.import(f.request), 'foreign'), /research_human_project_mismatch/u);
    await writeFile(join(f.workspace, f.request.path), JSON.stringify(notebook('print(2)\n')));
    await assert.rejects(f.import(), /research_notebook_source_changed/u);
    assert.equal(f.repository.notebooks.list({ projectId: f.project.id, offset: 0, limit: 100 }).total, 0);
    await writeFile(join(f.workspace, f.request.path), f.bytes);
    const imported = await f.import();
    await assert.rejects(f.import({ ...f.request, expectedSha256: 'f'.repeat(64) }), /research_notebook_request_conflict/u);
    await assert.rejects(f.human(() => f.repository.notebooks.import(f.request), f.project.id, 73), /research_notebook_request_conflict/u);
    assert.throws(() => f.repository.notebooks.get({ ...f.reference(imported), expectedHash: 'f'.repeat(64) }), /research_notebook_hash_mismatch/u);
    const foreign = f.repository.createProject({ title: 'Other', description: '', workspacePath: await mkdtemp(join(root, 'foreign-')) });
    assert.throws(() => f.repository.notebooks.get({ ...f.reference(imported), projectId: foreign.id }), /research_notebook_project_mismatch/u);
    await assert.rejects(f.import({ ...f.request, actor: { kind: 'user', id: 'window:72' } }));
  } finally { f.close(); }
});

test('paths, symlinks, malformed formats and oversized sources fail without a frozen record', async () => {
  const f = await fixture();
  try {
    const outside = join(root, 'outside.ipynb');
    await writeFile(outside, f.bytes);
    await symlink(outside, join(f.workspace, 'linked.ipynb'));
    await mkdir(join(f.workspace, '.roc-research'));
    await writeFile(join(f.workspace, '.roc-research/hidden.ipynb'), f.bytes);
    const preview = path => f.repository.notebooks.preview({ projectId: f.project.id, path });
    await assert.rejects(preview('../outside.ipynb'), /research_relative_path_invalid/u);
    await assert.rejects(preview(outside), /research_relative_path_invalid/u);
    await assert.rejects(preview('linked.ipynb'), /research_path_symlink/u);
    await assert.rejects(preview('.roc-research/hidden.ipynb'), /research_notebook_path_excluded/u);
    await writeFile(join(f.workspace, 'large.ipynb'), Buffer.alloc(8 * 1024 * 1024 + 1));
    await assert.rejects(preview('large.ipynb'), /research_file_size_invalid/u);
    await writeFile(join(f.workspace, 'invalid.ipynb'), JSON.stringify({ ...notebook(), nbformat_minor: 4 }));
    await assert.rejects(preview('invalid.ipynb'));
    assert.equal(f.repository.notebooks.list({ projectId: f.project.id, offset: 0, limit: 100 }).total, 0);
  } finally { f.close(); }
});

test('archiving and workspace rebinding preserve old frozen source, and reject new archived imports', async () => {
  const f = await fixture();
  try {
    const imported = await f.import();
    const other = await mkdtemp(join(root, 'rebound-'));
    await writeFile(join(other, f.request.path), JSON.stringify(notebook('print(2)\n')));
    f.db.prepare("UPDATE research_projects SET workspace_path=?,status='archived' WHERE id=?").run(other, f.project.id);
    assert.deepEqual(f.repository.notebooks.get(f.reference(imported)), imported);
    assert.deepEqual(await f.import(), imported);
    await assert.rejects(f.import({ ...f.request, requestId: 'import-2' }), /research_project_archived/u);
    assert.deepEqual(f.repository.notebooks.source(f.reference(imported)).bytes, f.bytes);
  } finally { f.close(); }
});

test('disk reopen retains original cells and outputs and detects byte, receipt and ownership corruption', async () => {
  const f = await fixture();
  let reopened;
  try {
    const imported = await f.import(), reference = f.reference(imported), path = join(f.workspace, 'snapshot.sqlite');
    await f.db.backup(path);
    reopened = new Database(path);
    api.applyResearchDatabaseSchema(reopened);
    const repository = new api.ResearchRepository(reopened, f.tasks);
    await rm(join(f.workspace, f.request.path));
    assert.deepEqual(repository.notebooks.get(reference), imported);
    assert.deepEqual(repository.notebooks.source(reference).bytes, f.bytes);
    reopened.prepare('UPDATE research_notebooks SET source_bytes=? WHERE id=?')
      .run(Buffer.from(JSON.stringify(notebook('print(2)\n'))), reference.notebookId);
    assert.throws(() => repository.notebooks.get(reference), /research_notebook_bytes_invalid/u);
    reopened.prepare('UPDATE research_notebooks SET source_bytes=?,snapshot_hash=? WHERE id=?')
      .run(f.bytes, 'f'.repeat(64), reference.notebookId);
    assert.throws(() => repository.notebooks.get(reference), /research_notebook_snapshot_invalid/u);
    reopened.prepare('UPDATE research_notebooks SET snapshot_hash=?,request_id=? WHERE id=?')
      .run(reference.expectedHash, 'other-request', reference.notebookId);
    assert.throws(() => repository.notebooks.get(reference), /research_notebook_snapshot_invalid/u);
    assert.deepEqual(await readFile(path).then(bytes => bytes.subarray(0, 16).toString()), 'SQLite format 3\u0000');
  } finally { reopened?.close(); f.close(); }
});

test('real plugin adapter binds the validated main sender and wire contracts expose no full rich output', async () => {
  const f = await fixture();
  try {
    const handlers = new Map();
    api.registerResearchNotebookCapabilities({ pluginId: '@roc/plugin-research', capabilities: {
      register(_plugin, descriptor, handler) { handlers.set(descriptor.name, handler); }
    } }, f.repository.notebooks);
    const adapter = api.createPluginCapabilityAdapter({ invokeCapability(name, input) { return handlers.get(name)(input); } });
    const preview = await adapter.invoke('research.previewNotebook', [{ projectId: f.project.id, path: f.request.path }], 72);
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.equal(preview.data.sha256, f.request.expectedSha256);
    assert.equal((await adapter.invoke('research.importNotebook', [f.request])).ok, false);
    const imported = await adapter.invoke('research.importNotebook', [f.request], 72);
    assert.equal(imported.ok, true, JSON.stringify(imported));
    assert.deepEqual(imported.data.receipt.snapshot.actor, { kind: 'user', id: 'window:72' });
    assert.equal('data' in imported.data.preview.cells[0].outputs[0], false);
    assert.deepEqual(await adapter.invoke('research.getNotebook', [f.reference(imported.data)], 72), imported);
    assert.equal((await adapter.invoke('research.importNotebook', [{ ...f.request, ownerRunId: f.run.id }], 72)).ok, false);
  } finally { f.close(); }
});
