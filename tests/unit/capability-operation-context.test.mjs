import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { z } from 'zod';
import { build } from 'esbuild';

let directory;
let api;
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-capability-operation-context-'));
  symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
  const outfile = join(directory, 'registry.mjs');
  await build({
    stdin: {
      contents: `
        export { CapabilityRegistry } from './src/main/kernel/capability-registry';
        export { createCapabilityOperationContext, runWithCapabilityOperationContext } from './src/main/kernel/capability-operation-context';
      `,
      resolveDir: process.cwd()
    },
    outfile,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  });
  api = await import(outfile);
});
after(() => rmSync(directory, { recursive: true, force: true }));

function createRegistry(handler) {
  const registry = new api.CapabilityRegistry();
  const descriptor = {
    name: 'workspace.write',
    version: '2.1.0',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    outputSchema: z.object({ written: z.boolean() })
  };
  registry.declare('workspace-plugin', descriptor);
  registry.register('workspace-plugin', descriptor, handler);
  return registry;
}

test('effectful capability gets trusted operation context after request receipt is persisted', async () => {
  const receipts = [];
  const input = { path: '/workspace/notes.md', content: 'text' };
  const context = api.createCapabilityOperationContext({
    operationId: 'a'.repeat(64),
    idempotencyKey: 'roc-op-v1:fixture',
    toolCallId: 'tool-call-1',
    toolName: 'write_file',
    canonicalToolIdentity: 'workspace.write_file',
    toolVersion: 'workspace-write-v1',
    attemptId: 'attempt-1',
    leaseGeneration: 3,
    recordReceipt: (receipt) => receipts.push(receipt)
  });
  const registry = createRegistry(async (parsedInput, operationContext) => {
    assert.deepEqual(parsedInput, input);
    assert.equal(operationContext?.operationId, context.operationId);
    assert.equal(operationContext?.capabilityName, 'workspace.write');
    assert.equal(operationContext?.capabilityVersion, '2.1.0');
    assert.equal(operationContext?.leaseGeneration, 3);
    assert.deepEqual(receipts.map((receipt) => receipt.phase), ['request_sent']);
    assert.equal(operationContext?.hasPublishedSideEffect(), true);
    operationContext?.recordReceipt({
      schemaVersion: 1,
      kind: 'capability',
      phase: 'provider_confirmed',
      capabilityName: 'workspace.write',
      capabilityVersion: '2.1.0',
      idempotencyKey: context.idempotencyKey,
      providerReceiptId: 'provider-receipt-7',
      evidenceHash: 'b'.repeat(64)
    });
    return { written: true };
  });

  const result = await api.runWithCapabilityOperationContext(context, () =>
    registry.invoke('workspace.write', input)
  );

  assert.deepEqual(result, { written: true });
  assert.deepEqual(receipts.map((receipt) => receipt.phase), ['request_sent', 'provider_confirmed']);
});

test('public capability invocation stays unchanged when no internal operation is active', async () => {
  let receivedContext = 'not-called';
  const registry = createRegistry(async (_input, context) => {
    receivedContext = context;
    return { written: true };
  });

  assert.deepEqual(await registry.invoke('workspace.write', { path: '/workspace/notes.md', content: 'text' }), {
    written: true
  });
  assert.equal(receivedContext, undefined);
});
