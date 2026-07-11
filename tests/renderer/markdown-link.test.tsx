// @vitest-environment jsdom
import { readFileSync } from 'node:fs';

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MarkdownView } from '../../src/renderer/chat/markdown-view';

describe('Markdown external links', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('opens an HTTPS Markdown link through the Electron window-open boundary', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);

    await renderMarkdown('[Docs](https://example.com/docs)');
    const anchor = container.querySelector('a');

    expect(anchor?.textContent).toBe('Docs');
    anchor?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(open).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener,noreferrer');
  });

  it.each(['./relative', 'file:///C:/secret.txt', 'javascript:alert(1)'])(
    'keeps a blocked Markdown target readable but non-interactive: %s',
    async (href) => {
      const open = vi.spyOn(window, 'open').mockReturnValue(null);

      await renderMarkdown(`[Blocked](${href})`);

      expect(container.querySelector('a')).toBeNull();
      expect(container.textContent).toContain('Blocked');
      expect(open).not.toHaveBeenCalled();
    }
  );

  it('uses the same controlled anchor component for completed and streaming Markdown', () => {
    const completedSource = readFileSync('src/renderer/chat/markdown-view.tsx', 'utf8');
    const streamingSource = readFileSync('src/renderer/chat/streaming-markdown-view.tsx', 'utf8');

    expect(completedSource).toContain('a: MarkdownLink');
    expect(streamingSource).toContain('a: MarkdownLink');
  });

  async function renderMarkdown(text: string): Promise<void> {
    await act(async () => {
      root.render(<MarkdownView text={text} />);
    });
  }
});
