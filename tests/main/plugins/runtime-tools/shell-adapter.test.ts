import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import type { RocEventBus, RocPluginContext } from '../../../../src/main/kernel/types';
import { createRuntimeToolsPlugin } from '../../../../src/main/plugins/runtime-tools';
import type { ShellExecutionResult } from '../../../../src/shared/types';

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

  it('rejects agent shell commands that mention the Deep Agents /workspace route', async () => {
    const { capabilities, commandCalls } = await initializePlugin();

    const result = await capabilities.invoke<unknown, ShellExecutionResult>('shell.execute', {
      command: 'copy /workspace/gold_price_scheduler/main.py G:\\杂\\test\\gold_price.py',
      cwd: workspaceRoot,
      source: 'agent'
    });

    expect(result).toMatchObject({
      command: 'copy /workspace/gold_price_scheduler/main.py G:\\杂\\test\\gold_price.py',
      normalizedCommand: 'copy /workspace/gold_price_scheduler/main.py g:\\杂\\test\\gold_price.py',
      cwd: workspaceRoot,
      stdout: '',
      exitCode: 1,
      usedRtk: false,
      bypassReason: 'virtual_workspace_path'
    });
    expect(result.stderr).toContain('/workspace is a Deep Agents file-tool route, not a shell directory.');
    expect(commandCalls).toHaveLength(0);
  });

  it('rejects agent shell commands that pass the Deep Agents route as an option value', async () => {
    const { capabilities, commandCalls } = await initializePlugin();

    const result = await capabilities.invoke<unknown, ShellExecutionResult>('shell.execute', {
      command: 'python .\\main.py --input=/workspace/gold_price_scheduler/main.py',
      cwd: workspaceRoot,
      source: 'agent'
    });

    expect(result).toMatchObject({
      command: 'python .\\main.py --input=/workspace/gold_price_scheduler/main.py',
      cwd: workspaceRoot,
      stdout: '',
      exitCode: 1,
      usedRtk: false,
      bypassReason: 'virtual_workspace_path'
    });
    expect(result.stderr).toContain('/workspace is a Deep Agents file-tool route, not a shell directory.');
    expect(commandCalls).toHaveLength(0);
  });

  it('rejects agent shell cwd that uses the Deep Agents /workspace route', async () => {
    const { capabilities, commandCalls } = await initializePlugin();

    const result = await capabilities.invoke<unknown, ShellExecutionResult>('shell.execute', {
      command: 'python .\\main.py',
      cwd: '/workspace/gold_price_scheduler',
      source: 'agent'
    });

    expect(result).toMatchObject({
      command: 'python .\\main.py',
      cwd: '/workspace/gold_price_scheduler',
      stdout: '',
      exitCode: 1,
      usedRtk: false,
      bypassReason: 'virtual_workspace_path'
    });
    expect(result.stderr).toContain('/workspace is a Deep Agents file-tool route, not a shell directory.');
    expect(commandCalls).toHaveLength(0);
  });

  it('uses raw PowerShell for Windows shell aliases that RTK cannot execute directly', async () => {
    const { capabilities, commandCalls } = await initializePlugin();

    const result = await capabilities.invoke<unknown, ShellExecutionResult>('shell.execute', {
      command: 'ls',
      cwd: workspaceRoot,
      source: 'agent'
    });

    expect(result).toMatchObject({
      command: 'ls',
      normalizedCommand: 'ls',
      cwd: workspaceRoot,
      stdout: 'notes.txt\n',
      stderr: '',
      exitCode: 0,
      usedRtk: false,
      bypassReason: 'windows_shell_alias'
    });
    expect(commandCalls).toHaveLength(1);
    expect(commandCalls[0]).toMatchObject({
      file: 'powershell.exe',
      cwd: workspaceRoot
    });
    expect(commandCalls[0].args.join(' ')).toContain('ls');
  });

  it('routes supported agent commands through the bundled RTK binary', async () => {
    const { capabilities, commandCalls } = await initializePlugin();

    const result = await capabilities.invoke<unknown, ShellExecutionResult>('shell.execute', {
      command: 'git status',
      cwd: workspaceRoot,
      source: 'agent'
    });

    expect(result).toMatchObject({
      command: 'git status',
      normalizedCommand: 'git status',
      cwd: workspaceRoot,
      stdout: 'notes.txt\n',
      stderr: '',
      exitCode: 0,
      usedRtk: true
    });
    expect(result.bypassReason).toBeUndefined();
    expect(commandCalls).toHaveLength(1);
    expect(commandCalls[0]).toMatchObject({
      file: expect.stringContaining('rtk.exe'),
      args: ['git', 'status'],
      cwd: workspaceRoot
    });
  });

  it('keeps the /workspace route rejection scoped to agent shell commands', async () => {
    const { capabilities, commandCalls } = await initializePlugin();

    await capabilities.invoke('shell.execute', {
      command: 'Write-Output /workspace/package.json',
      cwd: workspaceRoot,
      source: 'terminal'
    });

    expect(commandCalls).toHaveLength(1);
    expect(commandCalls[0].args.join(' ')).toContain('Write-Output /workspace/package.json');
  });

  it('executes agent commands with explicit real cwd when no workspace is selected', async () => {
    const { capabilities, commandCalls } = await initializePlugin({ workspacePath: undefined });

    const result = await capabilities.invoke<unknown, ShellExecutionResult>('shell.execute', {
      command: 'Write-Output explicit',
      cwd: workspaceRoot,
      source: 'agent'
    });

    expect(result).toMatchObject({
      command: 'Write-Output explicit',
      cwd: workspaceRoot,
      stdout: 'notes.txt\n',
      exitCode: 0,
      usedRtk: false,
      bypassReason: 'command_not_supported'
    });
    expect(commandCalls).toHaveLength(1);
    expect(commandCalls[0]).toMatchObject({
      file: 'powershell.exe',
      cwd: workspaceRoot
    });
  });

  it('rejects a background command that is not exactly pre-authorized', async () => {
    const { capabilities, commandCalls } = await initializePlugin();

    const result = await capabilities.invoke<unknown, ShellExecutionResult>('shell.execute', {
      command: 'git status',
      cwd: workspaceRoot,
      source: 'agent',
      allowedCommands: []
    });

    expect(result).toMatchObject({
      exitCode: 1,
      stdout: '',
      bypassReason: 'background_shell_command_not_pre_authorized',
      truncated: false
    });
    expect(commandCalls).toHaveLength(0);
  });

  it('caps shell output and records the full output artifact', async () => {
    const fullOutput = 'x'.repeat(70 * 1024);
    const { capabilities } = await initializePlugin({
      commandExecutor: () => ({ stdout: fullOutput, stderr: '', exitCode: 0 })
    });

    const result = await capabilities.invoke<unknown, ShellExecutionResult>('shell.execute', {
      command: 'Write-Output huge',
      cwd: workspaceRoot,
      source: 'agent'
    });

    expect(result.truncated).toBe(true);
    expect(result.stdout).toContain('[truncated; full output: tee artifact]');
    expect(result.teePath).toBeTruthy();
    expect(existsSync(result.teePath as string)).toBe(true);
  });
});

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type CommandCall = {
  file: string;
  args: string[];
  cwd: string;
  extraEnv: Record<string, string>;
};

async function initializePlugin(options: { workspacePath?: string; commandExecutor?: (file: string, args: string[], cwd: string, extraEnv: Record<string, string>, signal?: AbortSignal) => CommandResult } = { workspacePath: workspaceRoot }): Promise<{
  capabilities: CapabilityRegistry;
  commandCalls: CommandCall[];
}> {
  const commandCalls: CommandCall[] = [];
  const plugin = createRuntimeToolsPlugin({
    rootDir: root,
    workspacePath: options.workspacePath,
    commandExecutor: (file, args, cwd, extraEnv) => {
      commandCalls.push({ file, args, cwd, extraEnv });
      return options.commandExecutor === undefined ? {
        stdout: 'notes.txt\n',
        stderr: '',
        exitCode: 0
      } : options.commandExecutor(file, args, cwd, extraEnv);
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
    database: {
      getConnection: () => db,
      getCoreConnection: () => db,
      getAgentConnection: () => db,
      getMemoryConnection: () => db,
      getTaskConnection: () => db
    },
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
