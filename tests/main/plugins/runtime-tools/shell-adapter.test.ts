import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import type { RocEventBus, RocPluginContext } from '../../../../src/main/kernel/types';
import { createRuntimeToolsPlugin } from '../../../../src/main/plugins/runtime-tools';
import { CommandRewriter } from '../../../../src/rtk-integration';
import type { ShellExecutionResult } from '../../../../src/shared/types';

let root: string;
let workspaceRoot: string;
let db: Database.Database;
const systemShell = '/bin/zsh';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-runtime-tools-shell-'));
  workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
  db = new Database(':memory:');
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('runtime tools shell adapter', () => {
  it('keeps user shell execution and confirmation while blocking agent file operations', async () => {
    const { capabilities, commandCalls } = await initializePlugin();

    const result = await capabilities.invoke('shell.execute', {
      command: 'ls',
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
      command: 'ls',
      cwd: workspaceRoot,
      stdout: 'notes.txt\n',
      stderr: '',
      exitCode: 0,
      usedRtk: false,
      bypassReason: 'user_terminal_raw_output'
    });
    expect(confirmation).toEqual({ confirmed: true, response: 0 });
    const highRiskResult = await capabilities.invoke('shell.execute', {
      command: 'rm notes.txt',
      cwd: workspaceRoot,
      source: 'agent'
    });

    expect(highRiskResult).toMatchObject({
      command: 'rm notes.txt',
      normalizedCommand: 'rm notes.txt',
      cwd: workspaceRoot,
      stdout: '',
      exitCode: 1,
      usedRtk: false,
      bypassReason: 'shell_file_operation_forbidden'
    });
    expect(commandCalls).toHaveLength(1);
  });

  it('executes unsupported agent commands through the host shell', async () => {
    const { capabilities, commandCalls } = await initializePlugin();

    const result = await capabilities.invoke('shell.execute', {
      command: 'printf unknown',
      cwd: workspaceRoot,
      source: 'agent'
    });

    expect(result).toMatchObject({
      command: 'printf unknown',
      normalizedCommand: 'printf unknown',
      cwd: workspaceRoot,
      stdout: 'notes.txt\n',
      stderr: '',
      exitCode: 0,
      usedRtk: false,
      bypassReason: 'command_not_supported'
    });
    expect(commandCalls).toHaveLength(1);
    expect(commandCalls[0]).toMatchObject({
      file: systemShell,
      cwd: workspaceRoot
    });
    expect(commandCalls[0].args.join(' ')).toContain('printf unknown');
  });

  it('rejects agent shell commands that mention the Deep Agents /workspace route', async () => {
    const { capabilities, commandCalls } = await initializePlugin();

    const result = await capabilities.invoke<unknown, ShellExecutionResult>('shell.execute', {
      command: 'cp /workspace/gold_price_scheduler/main.py /Users/test/gold_price.py',
      cwd: workspaceRoot,
      source: 'agent'
    });

    expect(result).toMatchObject({
      command: 'cp /workspace/gold_price_scheduler/main.py /Users/test/gold_price.py',
      normalizedCommand: 'cp /workspace/gold_price_scheduler/main.py /Users/test/gold_price.py',
      cwd: workspaceRoot,
      stdout: '',
      exitCode: 1,
      usedRtk: false,
      bypassReason: 'virtual_workspace_path'
    });
    expect(result.stderr).toContain('run_shell_command 使用真实本机 cwd，不接受 DeepAgents 文件工具路由 /workspace/...。');
    expect(commandCalls).toHaveLength(0);
  });

  it('checks POSIX host paths according to the current platform', async () => {
    const { capabilities, commandCalls } = await initializePlugin();

    const result = await capabilities.invoke<unknown, ShellExecutionResult>('shell.execute', {
      command: 'python /home/user/project/main.py',
      cwd: workspaceRoot,
      source: 'agent'
    });

    expect(result.exitCode).toBe(0);
    expect(commandCalls).toHaveLength(1);
  });

  it('blocks agent file listing before invoking the host shell', async () => {
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
      stdout: '',
      exitCode: 1,
      usedRtk: false,
      bypassReason: 'shell_file_operation_forbidden'
    });
    expect(commandCalls).toHaveLength(0);
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
      file: expect.stringContaining('/rtk'),
      args: ['git', 'status'],
      cwd: workspaceRoot
    });
  });

  it('applies shell policy to the final command after RTK rewrite', async () => {
    vi.spyOn(CommandRewriter.prototype, 'rewrite').mockResolvedValue({
      rewritten: 'rtk git /workspace/status.txt',
      rtkArgs: ['git', '/workspace/status.txt'],
      exitCode: 0
    });
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
      stdout: '',
      exitCode: 1,
      usedRtk: false,
      bypassReason: 'virtual_workspace_path'
    });
    expect(commandCalls).toHaveLength(0);
  });

  it('keeps the /workspace route rejection scoped to agent shell commands', async () => {
    const { capabilities, commandCalls } = await initializePlugin();

    await capabilities.invoke('shell.execute', {
      command: 'printf /workspace/package.json',
      cwd: workspaceRoot,
      source: 'terminal'
    });

    expect(commandCalls).toHaveLength(1);
    expect(commandCalls[0].args.join(' ')).toContain('printf /workspace/package.json');
  });

  it('executes agent commands with explicit real cwd when no workspace is selected', async () => {
    const { capabilities, commandCalls } = await initializePlugin({ workspacePath: undefined });

    const result = await capabilities.invoke<unknown, ShellExecutionResult>('shell.execute', {
      command: 'printf explicit',
      cwd: workspaceRoot,
      source: 'agent'
    });

    expect(result).toMatchObject({
      command: 'printf explicit',
      cwd: workspaceRoot,
      stdout: 'notes.txt\n',
      exitCode: 0,
      usedRtk: false,
      bypassReason: 'command_not_supported'
    });
    expect(commandCalls).toHaveLength(1);
    expect(commandCalls[0]).toMatchObject({
      file: systemShell,
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
      command: 'printf huge',
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
