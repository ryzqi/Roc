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
