// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatTranscriptActivityBlock } from '../../src/renderer/chat-transcript';
import { SubagentActivityCard } from '../../src/renderer/chat/subagent/SubagentActivityCard';

type SubagentBlock = Extract<ChatTranscriptActivityBlock, { kind: 'subagent' }>;

describe('SubagentActivityCard', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps failed subagents open after a streaming run fails', async () => {
    await act(async () => {
      root.render(<SubagentActivityCard block={subagentBlock({ status: 'running' })} />);
    });

    expect(querySubagent().open).toBe(true);

    await act(async () => {
      root.render(<SubagentActivityCard block={subagentBlock({ error: 'remote failed', status: 'failed' })} />);
    });

    expect(querySubagent().open).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(querySubagent().open).toBe(true);
    expect(container.textContent).toContain('remote failed');
  });

  function querySubagent(): HTMLDetailsElement {
    const details = container.querySelector<HTMLDetailsElement>('[data-testid="chat-activity-subagent"]');
    expect(details).not.toBeNull();
    return details as HTMLDetailsElement;
  }
});

function subagentBlock({
  error = null,
  status
}: {
  error?: string | null;
  status: SubagentBlock['status'];
}): SubagentBlock {
  return {
    id: 'subagent-root',
    kind: 'subagent',
    identity: {
      subagentId: 'subagent-root',
      parentSubagentId: null,
      name: 'research',
      depth: 0,
      path: ['research#0'],
      execution: 'sync',
      taskInput: null
    },
    status,
    summary: null,
    error,
    blocks: [
      {
        id: 'subagent-text',
        kind: 'text',
        content: '正在检索资料。'
      }
    ],
    children: []
  };
}
