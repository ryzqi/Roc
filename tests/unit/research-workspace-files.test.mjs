import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

let tempDir;
let ResearchWorkspaceFileService;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'roc-research-workspace-files-'));
  const outfile = join(tempDir, 'workspace-files.mjs');
  await esbuild.build({ entryPoints: ['src/main/plugins/research/workspace-files.ts'], outfile, bundle: true,
    format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent' });
  ({ ResearchWorkspaceFileService } = await import(outfile));
});

after(() => rmSync(tempDir, { recursive: true, force: true }));

function createDatabase() {
  const rows = new Map();
  return {
    transaction: (operation) => (...args) => operation(...args),
    prepare: (sql) => {
      if (sql.startsWith('SELECT')) {
        return { get: (projectId, path) => rows.get(`${projectId}:${path}`) };
      }
      return {
        run: (projectId, path, sha256, size, revision, ownerRunId, updatedAt) => {
          rows.set(`${projectId}:${path}`, { path, sha256, size, revision, owner_run_id: ownerRunId, updated_at: updatedAt });
        }
      };
    }
  };
}

test('research workspace atomic saves notify after creation and same-path update', async () => {
  const workspacePath = join(tempDir, 'project-workspace');
  mkdirSync(workspacePath);
  const changes = [];
  const service = new ResearchWorkspaceFileService(
    createDatabase(),
    { getProject: (id) => ({ id, status: 'active', workspacePath }) },
    () => '2026-10-27T00:00:00.000Z',
    (path, reason) => changes.push({ path, reason })
  );

  const created = await service.save({ projectId: 'project-1', path: 'notes.md', content: 'first', expectedHash: null });
  await service.save({ projectId: 'project-1', path: 'notes.md', content: 'updated', expectedHash: created.sha256 });

  assert.deepEqual(changes, [
    { path: workspacePath, reason: 'research.workspace-file.created' },
    { path: workspacePath, reason: 'research.workspace-file.atomic-save' }
  ]);
});

test('TypeScript experiment sources support save and read without bypassing workspace guards', async () => {
  const workspacePath = join(tempDir, 'typescript-workspace');
  mkdirSync(workspacePath);
  const service = new ResearchWorkspaceFileService(
    createDatabase(), { getProject: (id) => ({ id, status: 'active', workspacePath }) },
    () => '2026-11-10T00:00:00.000Z'
  );
  const request = { projectId: 'project-1', path: 'fixture/safety-pipeline.mts',
    content: 'export async function run(context) { await context.files.writeText("result.txt", "fixture"); }', expectedHash: null };
  const saved = await service.save(request);
  assert.equal((await service.read(request.projectId, request.path)).content, request.content);
  await assert.rejects(service.save(request), /research_workspace_file_exists/);
  await assert.rejects(service.save({ ...request, expectedHash: '0'.repeat(64) }), /research_workspace_file_conflict/);
  const updated = await service.save({ ...request, content: request.content + '\n', expectedHash: saved.sha256 });
  assert.equal(updated.revision, 2);
  for (const path of ['.roc-research/run.mts', 'node_modules/run.mts', 'fixture/.hidden/run.mts', 'fixture/run.exe']) {
    await assert.rejects(service.save({ ...request, path }), /research_workspace_file_not_editable/);
  }
});
