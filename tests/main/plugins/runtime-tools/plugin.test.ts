import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import type { RocEventBus, RocPluginContext } from '../../../../src/main/kernel/types';
import { createRuntimeToolsPlugin } from '../../../../src/main/plugins/runtime-tools';

const runtimeToolCapabilities = ['rtk.status', 'shell.execute', 'shell.confirm', 'web.read'];

let root: string;
let workspaceRoot: string;
let db: Database.Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-runtime-tools-plugin-'));
  workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
  db = new Database(':memory:');
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('runtime tools plugin', () => {
  it('declares the Phase 3 runtime tools plugin contract', () => {
    const plugin = createRuntimeToolsPlugin({ rootDir: root, workspacePath: workspaceRoot });

    expect(plugin.manifest.id).toBe('@roc/plugin-runtime-tools');
    expect(plugin.manifest.dependencies).toEqual([]);
    expect(plugin.manifest.loadPhase).toBe('critical');
    expect(plugin.manifest.required).toBe(true);
    expect(plugin.manifest.capabilities.map((capability) => capability.name)).toEqual(runtimeToolCapabilities);
  });

  it('preserves web.read validation and response mapping through capabilities', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('Reader output body', { status: 200 }));
    const capabilities = await initializePlugin({ fetchImpl: fetchMock });

    const output = await capabilities.invoke('web.read', {
      url: 'https://example.com/docs',
      responseMode: 'readerlm-v2',
      timeoutSeconds: 9,
      noCache: true,
      withLinksSummary: 'all',
      retainLinks: 'gpt-oss',
      maxTokens: 1000
    });

    expect(output).toMatchObject({
      content: 'Reader output body',
      source: 'https://example.com/docs',
      proxy: 'https://r.jina.ai/',
      untrusted: true
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://r.jina.ai/https://example.com/docs',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-No-Cache': 'true',
          'X-Respond-With': 'readerlm-v2',
          'X-Timeout': '9',
          'X-Max-Tokens': '1000',
          'X-Retain-Links': 'gpt-oss',
          'X-With-Links-Summary': 'all'
        })
      })
    );
    await expect(capabilities.invoke('web.read', { url: 'ftp://example.com/file' })).rejects.toMatchObject({
      code: 'web_read_url_invalid'
    });
  });

  it('uses the shared web.read fallback when readerlm-v2 is unauthorized', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response('Fallback markdown body', { status: 200 }));
    const capabilities = await initializePlugin({ fetchImpl: fetchMock });

    const output = await capabilities.invoke('web.read', {
      url: 'https://finance.sina.com.cn/nmetal/quotation.shtml',
      responseMode: 'readerlm-v2',
      timeoutSeconds: 10
    });

    expect(output).toMatchObject({
      content: 'Fallback markdown body',
      source: 'https://finance.sina.com.cn/nmetal/quotation.shtml'
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://r.jina.ai/https://finance.sina.com.cn/nmetal/quotation.shtml',
      expect.objectContaining({
        headers: {
          'X-Respond-With': 'markdown',
          'X-Timeout': '10'
        }
      })
    );
  });
});

async function initializePlugin(options: Parameters<typeof createRuntimeToolsPlugin>[0] = {}): Promise<CapabilityRegistry> {
  const plugin = createRuntimeToolsPlugin({ rootDir: root, workspacePath: workspaceRoot, ...options });
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
