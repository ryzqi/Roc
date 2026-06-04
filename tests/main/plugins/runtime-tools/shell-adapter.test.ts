import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import type { RocEventBus, RocPluginContext } from '../../../../src/main/kernel/types';
import { createRuntimeToolsPlugin } from '../../../../src/main/plugins/runtime-tools';

let root: string;
let workspaceRoot: string;
let db: Database.Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-runtime-tools-shell-'));
  workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
  db = new Database(':memory:');
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('runtime tools shell adapter', () => {
  it('keeps current shell execution, confirmation, and risk behavior', async () => {
    const capabilities = await initializePlugin();

    const result = await capabilities.invoke('shell.execute', {
      command: 'dir',
      cwd: workspaceRoot,
      source: 'terminal'
    });
    const confirmation = await capabilities.invoke('shell.confirm', {
      title: 'Run command?',
      message: 'Allow command',
      confirmLabel: 'Run',
      cancelLabel: 'Cancel'
    });

    expect(result).toMatchObject({
      command: 'dir',
      cwd: workspaceRoot,
      stdout: 'notes.txt\n',
      stderr: '',
      exitCode: 0,
      usedRtk: false,
      bypassReason: 'user_terminal_raw_output'
    });
    expect(confirmation).toEqual({ confirmed: true, response: 0 });
    await expect(
      capabilities.invoke('shell.execute', {
        command: 'Remove-Item notes.txt',
        cwd: workspaceRoot,
        source: 'agent'
      })
    ).rejects.toMatchObject({
      code: 'command_requires_confirmation'
    });
  });
});

async function initializePlugin(): Promise<CapabilityRegistry> {
  const plugin = createRuntimeToolsPlugin({
    rootDir: root,
    workspacePath: workspaceRoot,
    commandExecutor: () => ({
      stdout: 'notes.txt\n',
      stderr: '',
      exitCode: 0
    }),
    confirmShellRequest: async () => ({ confirmed: true, response: 0 })
  });
  const capabilities = new CapabilityRegistry();
  for (const descriptor of plugin.manifest.capabilities) {
    capabilities.declare(plugin.manifest.id, descriptor);
  }
  await plugin.initialize(createContext(capabilities));
  return capabilities;
}

function createContext(capabilities: CapabilityRegistry): RocPluginContext {
  return {
    pluginId: '@roc/plugin-runtime-tools',
    eventBus: createEventBus(),
    capabilities,
    database: { getConnection: () => db },
    config: { get: () => null, set: () => {} },
    secrets: { get: () => null, set: () => {}, clear: () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  };
}

function createEventBus(): RocEventBus {
  return {
    publish: async () => {},
    subscribe: () => () => {}
  };
}
