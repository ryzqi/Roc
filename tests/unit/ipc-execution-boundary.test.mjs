import assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, test } from 'node:test';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

let chatStartRunIpcRequestSchema;
let shellExecutionIpcRequestSchema;
before(async () => {
  const options = { platform: 'node', external: [], tempDir: join(process.cwd(), '.runtime/tmp') };
  ({ chatStartRunIpcRequestSchema } = await importTypeScriptModule('src/shared/schemas/chat.ts', options));
  ({ shellExecutionIpcRequestSchema } = await importTypeScriptModule('src/shared/schemas/ipc-workspace.ts', options));
});

test('renderer run-start cannot select task source, workspace or shell allowlist', () => {
  const base = { input: 'inspect this', mode: 'chat', enabledCapabilities: { mcpServers: [], skills: [] } };
  assert.equal(chatStartRunIpcRequestSchema.safeParse(base).success, true);
  for (const field of ['taskSource', 'workspacePath', 'shellAllowedCommands']) {
    assert.equal(chatStartRunIpcRequestSchema.safeParse({ ...base, [field]: 'renderer-controlled' }).success, false, field);
  }
});

test('renderer shell IPC is terminal-scoped and cannot provide run identity', () => {
  const base = { command: 'pwd', cwd: '/tmp' };
  assert.equal(shellExecutionIpcRequestSchema.safeParse(base).success, true);
  for (const [field, value] of Object.entries({
    source: 'agent',
    runId: 'run-1',
    threadId: 'thread-1',
    signal: {},
    allowedCommands: ['pwd']
  })) {
    assert.equal(shellExecutionIpcRequestSchema.safeParse({ ...base, [field]: value }).success, false, field);
  }
});
