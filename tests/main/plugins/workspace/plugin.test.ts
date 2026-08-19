import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import { applyWorkspaceDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import type { RocEventBus, RocPluginContext } from '../../../../src/main/kernel/types';
import { createWorkspacePlugin } from '../../../../src/main/plugins/workspace';

const workspaceCapabilities = [
  'workspace.getCurrent',
  'workspace.select',
  'files.listTree',
  'files.search',
  'files.preview',
  'files.previewPdf',
  'files.writeText',
  'files.delete',
  'git.status',
  'git.diffStat',
  'git.fileDiff',
  'git.stageFile',
  'git.stageFiles',
  'git.unstageFile',
  'git.discardFile',
  'git.commit',
  'git.push',
  'git.listBranches',
  'git.createBranch',
  'git.checkoutBranch',
  'terminal.createSession',
  'terminal.writeInput',
  'terminal.resize',
  'terminal.closeSession',
  'files.streamPdfPreviewResource'
];

let root: string;
let db: Database.Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-workspace-plugin-contract-'));
  db = new Database(':memory:');
  applyWorkspaceDatabaseSchema(db);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('workspace plugin', () => {
  it('declares the Phase 3 critical workspace plugin contract', () => {
    const plugin = createWorkspacePlugin({ rootDir: root });

    expect(plugin.manifest.id).toBe('@roc/plugin-workspace');
    expect(plugin.manifest.dependencies).toEqual([]);
    expect(plugin.manifest.loadPhase).toBe('critical');
    expect(plugin.manifest.required).toBe(true);
    expect(plugin.manifest.capabilities.map((capability) => capability.name)).toEqual(workspaceCapabilities);
  });

  it('binds manifest capabilities during initialize', async () => {
    const plugin = createWorkspacePlugin({ rootDir: root });
    const capabilities = new CapabilityRegistry();
    for (const descriptor of plugin.manifest.capabilities) {
      capabilities.declare(plugin.manifest.id, descriptor);
    }

    await plugin.initialize(createContext(capabilities));

    await expect(capabilities.invoke('workspace.getCurrent', {})).resolves.toBeNull();
  });
});

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
