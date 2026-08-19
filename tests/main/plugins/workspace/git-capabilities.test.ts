import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import { applyWorkspaceDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import type { RocEventBus, RocPluginContext } from '../../../../src/main/kernel/types';
import { createWorkspacePlugin } from '../../../../src/main/plugins/workspace';
import type { GitFileOperationRequest, GitStatusResult, WorkspaceSelectRequest } from '../../../../src/shared/types';

let root: string;
let workspaceRoot: string;
let db: Database.Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-workspace-plugin-git-'));
  workspaceRoot = join(root, 'repo');
  mkdirSync(workspaceRoot, { recursive: true });
  db = new Database(':memory:');
  applyWorkspaceDatabaseSchema(db);
  runGit(['init'], workspaceRoot);
  runGit(['config', 'user.email', 'roc-test@example.test'], workspaceRoot);
  runGit(['config', 'user.name', 'Roc Test'], workspaceRoot);
  writeFileSync(join(workspaceRoot, 'notes.txt'), 'initial\n', 'utf8');
  runGit(['add', 'notes.txt'], workspaceRoot);
  runGit(['commit', '-m', 'initial'], workspaceRoot);
  writeFileSync(join(workspaceRoot, 'notes.txt'), 'changed\n', 'utf8');
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('workspace git capabilities', () => {
  it('preserves current git status, diff, stage, and unstage behavior', async () => {
    const capabilities = await initializePlugin();
    await capabilities.invoke<WorkspaceSelectRequest, unknown>('workspace.select', { path: workspaceRoot });

    const before = await capabilities.invoke<unknown, GitStatusResult>('git.status', {});
    const diff = await capabilities.invoke<GitFileOperationRequest, { patch: string }>('git.fileDiff', { relativePath: 'notes.txt' });
    const staged = await capabilities.invoke<GitFileOperationRequest, GitStatusResult>('git.stageFile', { relativePath: 'notes.txt' });
    const unstaged = await capabilities.invoke<GitFileOperationRequest, GitStatusResult>('git.unstageFile', { relativePath: 'notes.txt' });

    expect(before).toMatchObject({
      workspacePath: workspaceRoot,
      isRepository: true,
      changedFiles: 1
    });
    expect(before.porcelain).toContain(' M notes.txt');
    expect(diff.patch.replaceAll('\r\n', '\n')).toContain('diff --git a/notes.txt b/notes.txt');
    expect(staged.porcelain).toContain('M  notes.txt');
    expect(unstaged.porcelain).toContain(' M notes.txt');
  });
});

async function initializePlugin(): Promise<CapabilityRegistry> {
  const plugin = createWorkspacePlugin({ rootDir: root });
  const capabilities = new CapabilityRegistry();
  for (const descriptor of plugin.manifest.capabilities) {
    capabilities.declare(plugin.manifest.id, descriptor);
  }
  await plugin.initialize(createContext(capabilities));
  return capabilities;
}

function createContext(capabilities: CapabilityRegistry): RocPluginContext {
  const config = new Map<string, unknown>();
  return {
    pluginId: '@roc/plugin-workspace',
    eventBus: createEventBus(),
    capabilities,
    database: {
      getConnection: () => db,
    },
    config: {
      get: <T>(key: string) => (config.has(key) ? (config.get(key) as T) : null),
      set: <T>(key: string, value: T) => {
        config.set(key, value);
      }
    },
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

function runGit(args: string[], cwd: string): void {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}
