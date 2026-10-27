import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import * as esbuild from 'esbuild';

let tempDir;
let AtomicFilesystemBackend;

before(async () => {
  await mkdir(join(process.cwd(), '.runtime'), { recursive: true });
  tempDir = await mkdtemp(join(process.cwd(), '.runtime', 'atomic-filesystem-path-invalidation-'));
  const outfile = join(tempDir, 'atomic-filesystem-backend.mjs');
  await esbuild.build({
    entryPoints: ['src/main/services/deep-agent/atomic-filesystem-backend.ts'],
    outfile,
    bundle: true,
    packages: 'external',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent'
  });
  ({ AtomicFilesystemBackend } = await import(outfile));
});

after(async () => {
  if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true });
});

test('agent atomic file publication notifies the selected workspace path snapshot', async () => {
  const workspacePath = join(tempDir, 'workspace');
  await mkdir(workspacePath);
  const notifications = [];
  const backend = new AtomicFilesystemBackend(
    { rootDir: workspacePath, virtualMode: true },
    (path, reason) => notifications.push({ path, reason })
  );

  const created = await backend.write('/notes.md', 'first');
  assert.equal(created.error, undefined);
  const updated = await backend.edit('/notes.md', 'first', 'updated');
  assert.equal(updated.error, undefined);
  assert.equal(await readFile(join(workspacePath, 'notes.md'), 'utf8'), 'updated');
  assert.deepEqual(notifications, [
    { path: workspacePath, reason: 'agent.atomic-write-published' },
    { path: workspacePath, reason: 'agent.atomic-write-published' }
  ]);
});
