import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import type { RocEventBus, RocPluginContext } from '../../../../src/main/kernel/types';
import { createWorkspacePlugin } from '../../../../src/main/plugins/workspace';
import type { TerminalSessionCreateRequest, TerminalSessionSnapshot, WorkspaceSelectRequest } from '../../../../src/shared/types';

let root: string;
let workspaceRoot: string;
let outsideRoot: string;
let db: Database.Database;
let plugin: ReturnType<typeof createWorkspacePlugin> | null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-workspace-plugin-terminal-'));
  workspaceRoot = join(root, 'workspace');
  outsideRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-plugin-terminal-outside-'));
  mkdirSync(workspaceRoot, { recursive: true });
  db = new Database(':memory:');
  plugin = null;
});

afterEach(async () => {
  if (plugin !== null) {
    await plugin.shutdown();
  }
  await new Promise((resolve) => setTimeout(resolve, 120));
  db.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
});

describe('workspace terminal capabilities', () => {
  it('preserves current terminal create, resize, close, and workspace boundary behavior', async () => {
    const capabilities = await initializePlugin();
    await capabilities.invoke<WorkspaceSelectRequest, unknown>('workspace.select', { path: workspaceRoot });

    const snapshot = await capabilities.invoke<TerminalSessionCreateRequest, TerminalSessionSnapshot>('terminal.createSession', {
      cwd: workspaceRoot,
      cols: 100,
      rows: 30
    });
    const resized = await capabilities.invoke('terminal.resize', {
      sessionId: snapshot.id,
      cols: 120,
      rows: 40
    });
    const closed = await capabilities.invoke('terminal.closeSession', { sessionId: snapshot.id });

    expect(snapshot).toMatchObject({
      cwd: workspaceRoot,
      status: 'ready',
      cols: 100,
      rows: 30
    });
    expect(resized).toMatchObject({
      id: snapshot.id,
      cols: 120,
      rows: 40
    });
    expect(closed).toEqual({ closed: true });
    await expect(
      capabilities.invoke('terminal.createSession', {
        cwd: outsideRoot,
        cols: 80,
        rows: 24
      })
    ).rejects.toMatchObject({
      code: 'terminal_session_outside_workspace'
    });
  });
});

async function initializePlugin(): Promise<CapabilityRegistry> {
  plugin = createWorkspacePlugin({ rootDir: root });
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
      getCoreConnection: () => db,
      getAgentConnection: () => db,
      getMemoryConnection: () => db,
      getTaskConnection: () => db
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
