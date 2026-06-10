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
  it('keeps current shell execution and confirmation behavior while executing high-risk agent commands', async () => {
    const { capabilities, commandCalls } = await initializePlugin();

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
    const highRiskResult = await capabilities.invoke('shell.execute', {
      command: 'Remove-Item notes.txt',
      cwd: workspaceRoot,
      source: 'agent'
    });

    expect(highRiskResult).toMatchObject({
      command: 'Remove-Item notes.txt',
      normalizedCommand: 'remove-item notes.txt',
      cwd: workspaceRoot,
      stdout: 'notes.txt\n',
      stderr: '',
      exitCode: 0,
      usedRtk: false,
      bypassReason: 'command_not_supported'
    });
    expect(commandCalls).toHaveLength(2);
    expect(commandCalls[1]).toMatchObject({
      file: 'powershell.exe',
      cwd: workspaceRoot
    });
    expect(commandCalls[1].args.join(' ')).toContain('Remove-Item notes.txt');
  });

  it('executes unsupported agent commands through raw PowerShell fallback', async () => {
    const { capabilities, commandCalls } = await initializePlugin();

    const result = await capabilities.invoke('shell.execute', {
      command: 'Write-Output unknown',
      cwd: workspaceRoot,
      source: 'agent'
    });

    expect(result).toMatchObject({
      command: 'Write-Output unknown',
      normalizedCommand: 'write-output unknown',
      cwd: workspaceRoot,
      stdout: 'notes.txt\n',
      stderr: '',
      exitCode: 0,
      usedRtk: false,
      bypassReason: 'command_not_supported'
    });
    expect(commandCalls).toHaveLength(1);
    expect(commandCalls[0]).toMatchObject({
      file: 'powershell.exe',
      cwd: workspaceRoot
    });
    expect(commandCalls[0].args.join(' ')).toContain('Write-Output unknown');
  });
});

type CommandCall = {
  file: string;
  args: string[];
  cwd: string;
  extraEnv: Record<string, string>;
};

async function initializePlugin(): Promise<{ capabilities: CapabilityRegistry; commandCalls: CommandCall[] }> {
  const commandCalls: CommandCall[] = [];
  const plugin = createRuntimeToolsPlugin({
    rootDir: root,
    workspacePath: workspaceRoot,
    commandExecutor: (file, args, cwd, extraEnv) => {
      commandCalls.push({ file, args, cwd, extraEnv });
      return {
        stdout: 'notes.txt\n',
        stderr: '',
        exitCode: 0
      };
    },
    confirmShellRequest: async () => ({ confirmed: true, response: 0 })
  });
  const capabilities = new CapabilityRegistry();
  for (const descriptor of plugin.manifest.capabilities) {
    capabilities.declare(plugin.manifest.id, descriptor);
  }
  await plugin.initialize(createContext(capabilities));
  return { capabilities, commandCalls };
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
