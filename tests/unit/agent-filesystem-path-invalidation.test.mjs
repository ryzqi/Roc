import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import * as esbuild from 'esbuild';

let tempDir;
let AtomicFilesystemBackend;
let createCapabilityOperationContext;
let runWithCapabilityOperationContext;

before(async () => {
  await mkdir(join(process.cwd(), '.runtime'), { recursive: true });
  tempDir = await mkdtemp(join(process.cwd(), '.runtime', 'atomic-filesystem-path-invalidation-'));
  const outfile = join(tempDir, 'atomic-filesystem-backend.mjs');
  const entry = [
    `export { AtomicFilesystemBackend } from ${JSON.stringify(join(process.cwd(), 'src/main/services/deep-agent/atomic-filesystem-backend.ts'))};`,
    `export { createCapabilityOperationContext, runWithCapabilityOperationContext } from ${JSON.stringify(join(process.cwd(), 'src/main/kernel/capability-operation-context.ts'))};`
  ].join('\n');
  await esbuild.build({
    stdin: { contents: entry, resolveDir: process.cwd(), sourcefile: 'atomic-filesystem-test-entry.ts' },
    outfile,
    bundle: true,
    packages: 'external',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent'
  });
  ({ AtomicFilesystemBackend, createCapabilityOperationContext, runWithCapabilityOperationContext } = await import(outfile));
});

after(async () => {
  if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true });
});

test('agent atomic file publication notifies the selected workspace path snapshot', async () => {
  const workspacePath = join(tempDir, 'workspace-notifications');
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

test('agent atomic writes serialize same-path edits and record prepared, published and durable receipts', async () => {
  const workspacePath = join(tempDir, 'workspace-receipts');
  await mkdir(workspacePath);
  const backend = new AtomicFilesystemBackend({ rootDir: workspacePath, virtualMode: true });
  const receipts = [];
  const operation = createCapabilityOperationContext({
    operationId: 'operation-1',
    idempotencyKey: 'idempotency-1',
    toolCallId: 'tool-call-1',
    toolName: 'write_file',
    canonicalToolIdentity: 'workspace.write_file',
    toolVersion: 'roc-agent-tool-v1',
    attemptId: 'attempt-1',
    leaseGeneration: 1,
    recordReceipt: receipt => receipts.push(receipt)
  });

  const first = await runWithCapabilityOperationContext(operation, () => backend.write('/notes.md', 'first'));
  assert.equal(first.error, undefined);
  assert.equal(operation.hasPublishedSideEffect(), true);
  assert.deepEqual(receipts.map(receipt => receipt.phase), ['prepared', 'published', 'durable']);
  assert.equal(receipts[0].expectedVersion, null);
  assert.equal(receipts[2].resultHash, createHash('sha256').update('first').digest('hex'));

  const [editOne, editTwo] = await Promise.all([
    backend.edit('/notes.md', 'first', 'second'),
    backend.edit('/notes.md', 'second', 'third')
  ]);
  assert.equal(editOne.error, undefined);
  assert.equal(editTwo.error, undefined);
  assert.equal(await readFile(join(workspacePath, 'notes.md'), 'utf8'), 'third');
});

test('agent atomic writes reject a target version change before rename', async () => {
  const workspacePath = join(tempDir, 'workspace-race');
  await mkdir(workspacePath);
  const target = join(workspacePath, 'notes.md');
  await writeFile(target, 'initial', 'utf8');

  class RacingBackend extends AtomicFilesystemBackend {
    snapshotReads = 0;

    async readTargetSnapshot(path) {
      this.snapshotReads += 1;
      if (this.snapshotReads === 2) await writeFile(path, 'external', 'utf8');
      return await super.readTargetSnapshot(path);
    }
  }

  const backend = new RacingBackend({ rootDir: workspacePath, virtualMode: true });
  const result = await backend.write('/notes.md', 'agent update');
  assert.equal(result.error, 'atomic_write_failed:atomic_write_version_conflict');
  assert.equal(await readFile(target, 'utf8'), 'external');
});

test('agent atomic writes retain published state when durable receipt persistence fails', async () => {
  const workspacePath = join(tempDir, 'workspace-post-publish');
  await mkdir(workspacePath);
  const backend = new AtomicFilesystemBackend({ rootDir: workspacePath, virtualMode: true });
  const receipts = [];
  const operation = createCapabilityOperationContext({
    operationId: 'operation-2',
    idempotencyKey: 'idempotency-2',
    toolCallId: 'tool-call-2',
    toolName: 'write_file',
    canonicalToolIdentity: 'workspace.write_file',
    toolVersion: 'roc-agent-tool-v1',
    attemptId: 'attempt-2',
    leaseGeneration: 1,
    recordReceipt: receipt => {
      if (receipt.phase === 'durable') throw new Error('receipt_persist_failed');
      receipts.push(receipt);
    }
  });

  const result = await runWithCapabilityOperationContext(operation, () => backend.write('/notes.md', 'published'));
  assert.equal(result.error, 'atomic_write_failed:receipt_persist_failed');
  assert.equal(operation.hasPublishedSideEffect(), true);
  assert.deepEqual(receipts.map(receipt => receipt.phase), ['prepared', 'published']);
  assert.equal(await readFile(join(workspacePath, 'notes.md'), 'utf8'), 'published');
});
