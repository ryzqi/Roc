// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryFeature } from '../../../src/renderer/features/memory';
import type { RocClient } from '../../../src/renderer/shared/roc-client';
import type { RocPreloadApi } from '../../../src/shared/ipc';
import type { MemoryStatus } from '../../../src/shared/types';
import { createLoadedState } from '../view-test-helpers';

describe('MemoryFeature', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('uses RocClient for memory files, session search, and snapshot preview', async () => {
    const memoryStatus = createMemoryStatus();
    const client = createMemoryClient(memoryStatus);

    await act(async () => {
      root.render(
        <MemoryFeature
          client={client}
          loadState={{ status: 'ready', error: null, key: null }}
          state={createLoadedState({ memoryStatus })}
        />
      );
    });
    await flushPromises();

    await act(async () => {
      queryButton('memory-file-row-global-user').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();
    setTextareaValue('memory-file-editor', 'updated memory');
    await act(async () => {
      queryButton('memory-file-save').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    await act(async () => {
      queryButton('memory-tab-sessions').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    setInputValue('memory-session-query', 'electron');
    await act(async () => {
      queryButton('memory-session-search').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    await act(async () => {
      queryButton('memory-tab-snapshot').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(client.api.memory.status).toHaveBeenCalled();
    expect(client.api.memory.readFile).toHaveBeenCalledWith({ scope: 'global', kind: 'user' });
    expect(client.api.memory.writeFile).toHaveBeenCalledWith({
      scope: 'global',
      kind: 'user',
      content: 'updated memory'
    });
    expect(client.api.sessions.search).toHaveBeenCalledWith({
      query: 'electron',
      workspaceScope: 'current',
      sinceDays: 30,
      limit: 50
    });
    expect(client.api.memory.snapshotPreview).toHaveBeenCalled();
    expect(container.querySelector('[data-testid="memory-snapshot-preview"]')?.textContent).toContain('<FROZEN_SNAPSHOT>');
  });
});

function createMemoryStatus(): MemoryStatus {
  return {
    root: 'F:\\Code\\Roc\\.roc\\memory',
    workspaceHash: 'abcdef0123456789',
    workspaceLabel: 'Roc',
    files: [
      {
        scope: 'global',
        kind: 'user',
        exists: true,
        charCount: 25,
        charLimit: 1375,
        absolutePath: 'F:\\Code\\Roc\\.roc\\memory\\global\\USER.md',
        effective: true,
        updatedAt: '2026-05-28T00:00:00.000Z'
      }
    ],
    snapshot: { enabled: true, totalChars: 25, totalLimit: 3575 },
    sessionMessages: { totalRows: 1, retentionDays: 90, oldestAt: null },
    fullTextIndex: { healthy: true, status: 'ready' }
  };
}

function createMemoryClient(memoryStatus: MemoryStatus): RocClient {
  const api = {
    memory: {
      status: vi.fn().mockResolvedValue({ ok: true, data: memoryStatus }),
      readFile: vi.fn().mockResolvedValue({ ok: true, data: '# user prefers PowerShell' }),
      writeFile: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          ok: true,
          meta: memoryStatus.files[0]
        }
      }),
      snapshotPreview: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          text: '<FROZEN_SNAPSHOT>\n# user prefers PowerShell\n</FROZEN_SNAPSHOT>'
        }
      })
    },
    sessions: {
      search: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          query: 'electron',
          total: 1,
          items: [
            {
              id: 'm1',
              threadId: 't1',
              threadTitle: '过去对话',
              role: 'user',
              content: 'electron',
              phase: 'visible',
              tokenCount: null,
              createdAt: '2026-05-28T00:00:00.000Z',
              snippet: '**electron**'
            }
          ]
        }
      })
    }
  } as unknown as RocPreloadApi;
  return { api };
}

function queryButton(testId: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  expect(button).not.toBeNull();
  return button as HTMLButtonElement;
}

function setTextareaValue(testId: string, value: string): void {
  const textarea = document.querySelector<HTMLTextAreaElement>(`[data-testid="${testId}"]`);
  expect(textarea).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  expect(setter).not.toBeUndefined();
  setter?.call(textarea, value);
  textarea?.dispatchEvent(new Event('input', { bubbles: true }));
}

function setInputValue(testId: string, value: string): void {
  const input = document.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  expect(input).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  expect(setter).not.toBeUndefined();
  setter?.call(input, value);
  input?.dispatchEvent(new Event('input', { bubbles: true }));
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
