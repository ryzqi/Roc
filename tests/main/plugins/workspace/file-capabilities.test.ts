import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import { applyWorkspaceDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import type { RocEventBus, RocPluginContext } from '../../../../src/main/kernel/types';
import { createWorkspacePlugin } from '../../../../src/main/plugins/workspace';
import type { FileSearchRequest, FileWriteTextRequest, WorkspaceSelectRequest } from '../../../../src/shared/types';

let root: string;
let workspaceRoot: string;
let db: Database.Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-workspace-plugin-files-'));
  workspaceRoot = join(root, 'workspace');
  mkdirSync(join(workspaceRoot, 'src'), { recursive: true });
  mkdirSync(join(workspaceRoot, 'assets'), { recursive: true });
  writeFileSync(join(workspaceRoot, 'src', 'notes.md'), 'alpha\nphase three boundary\n', 'utf8');
  writeFileSync(join(workspaceRoot, 'guide.pdf'), '%PDF-1.4\nbody\n%%EOF\n', 'utf8');
  writeFileSync(
    join(workspaceRoot, 'assets', 'pixel.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG3sAAAAASUVORK5CYII=',
      'base64'
    )
  );
  db = new Database(':memory:');
  applyWorkspaceDatabaseSchema(db);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('workspace file capabilities', () => {
  it('preserves current file tree, search, preview, write, and recovery behavior', async () => {
    const capabilities = await initializePlugin();
    await capabilities.invoke<WorkspaceSelectRequest, unknown>('workspace.select', { path: workspaceRoot });

    const tree = await capabilities.invoke('files.listTree', { relativePath: '' });
    const search = await capabilities.invoke<FileSearchRequest, unknown>('files.search', { query: 'phase three' });
    const preview = await capabilities.invoke('files.preview', { relativePath: 'src/notes.md' });
    const imagePreview = await capabilities.invoke('files.preview', { relativePath: 'assets/pixel.png' });
    const writeResult = await capabilities.invoke<FileWriteTextRequest, { recoveryPoint: { snapshotPath: string } }>('files.writeText', {
      relativePath: 'src/notes.md',
      content: 'updated phase three boundary\n',
      source: 'test'
    });

    expect(tree).toMatchObject({
      workspacePath: workspaceRoot,
      entries: expect.arrayContaining([
        expect.objectContaining({
          name: 'src',
          relativePath: 'src',
          type: 'directory'
        })
      ])
    });
    expect(search).toMatchObject({
      matches: [
        expect.objectContaining({
          relativePath: 'src/notes.md',
          line: 2,
          preview: 'phase three boundary'
        })
      ]
    });
    expect(preview).toMatchObject({
      relativePath: 'src/notes.md',
      kind: 'text',
      truncated: false,
      content: 'alpha\nphase three boundary\n'
    });
    expect(imagePreview).toMatchObject({
      kind: 'image',
      mediaType: 'image/png'
    });
    expect(readFileSync(writeResult.recoveryPoint.snapshotPath, 'utf8')).toBe('alpha\nphase three boundary\n');
    expect(readFileSync(join(workspaceRoot, 'src', 'notes.md'), 'utf8')).toBe('updated phase three boundary\n');
  });

  it('streams PDF preview resources through the workspace capability', async () => {
    const capabilities = await initializePlugin();
    await capabilities.invoke<WorkspaceSelectRequest, unknown>('workspace.select', { path: workspaceRoot });

    const preview = await capabilities.invoke('files.previewPdf', { relativePath: 'guide.pdf' });
    const response = await capabilities.invoke<{ relativePath: string }, Response>('files.streamPdfPreviewResource', {
      relativePath: 'guide.pdf'
    });

    expect(preview).toMatchObject({
      relativePath: 'guide.pdf',
      resourceUrl: 'roc-preview://workspace/pdf/guide.pdf#toolbar=0&navpanes=0&scrollbar=0',
      mediaType: 'application/pdf'
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.text()).resolves.toBe('%PDF-1.4\nbody\n%%EOF\n');
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
