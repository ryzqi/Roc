import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';
import { SqliteLangGraphStore, buildDeepAgentMemoryNamespace } from '../../src/main/services/deep-agent/sqlite-store';

let root: string;
let services: AppServices;
let store: SqliteLangGraphStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-deep-agent-store-'));
  services = createAppServices(root);
  services.appService.initialize();
  store = new SqliteLangGraphStore(services.databaseService);
});

afterEach(() => {
  services.databaseService.close();
  rmSync(root, { recursive: true, force: true });
});

describe('SqliteLangGraphStore', () => {
  it('supports put, get, search, delete, and namespace listing with workspace scope', async () => {
    const workspaceNamespace = [...buildDeepAgentMemoryNamespace('F:\\Code\\Roc\\workspace-a')];
    const siblingNamespace = [...buildDeepAgentMemoryNamespace('F:\\Code\\Roc\\workspace-b')];

    await store.put(workspaceNamespace, '/accepted.md', {
      content: '# accepted',
      kind: 'memory_note'
    });
    await store.put(workspaceNamespace, '/draft.md', {
      content: '# draft',
      kind: 'draft_note'
    });
    await store.put(siblingNamespace, '/other.md', {
      content: '# other',
      kind: 'memory_note'
    });

    const accepted = await store.get(workspaceNamespace, '/accepted.md');
    const searchAll = await store.search(workspaceNamespace, {
      limit: 10
    });
    const filtered = await store.search(workspaceNamespace, {
      filter: {
        kind: 'memory_note'
      },
      limit: 10
    });
    const namespaces = await store.listNamespaces({
      prefix: ['roc', 'memory', 'workspace'],
      limit: 10
    });

    expect(accepted?.value).toEqual({
      content: '# accepted',
      kind: 'memory_note'
    });
    expect(searchAll.map((item) => item.key)).toEqual(['/accepted.md', '/draft.md']);
    expect(filtered.map((item) => item.key)).toEqual(['/accepted.md']);
    expect(namespaces).toEqual(expect.arrayContaining([workspaceNamespace, siblingNamespace]));

    await store.delete(workspaceNamespace, '/accepted.md');

    expect(await store.get(workspaceNamespace, '/accepted.md')).toBeNull();
  });
});
