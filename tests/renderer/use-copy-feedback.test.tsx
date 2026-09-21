// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCopyFeedback } from '../../src/renderer/utils/use-copy-feedback';

describe('useCopyFeedback', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it('resets copied after the timeout and clears the timer on unmount', () => {
    let markCopied: (() => void) | null = null;
    function Probe(): React.JSX.Element {
      const feedback = useCopyFeedback(1600);
      markCopied = feedback.markCopied;
      return <span data-copied={String(feedback.copied)} />;
    }

    act(() => {
      root.render(<Probe />);
    });
    expect(container.querySelector('[data-copied]')?.getAttribute('data-copied')).toBe('false');

    act(() => {
      markCopied?.();
    });
    expect(container.querySelector('[data-copied]')?.getAttribute('data-copied')).toBe('true');

    act(() => {
      vi.advanceTimersByTime(1599);
    });
    expect(container.querySelector('[data-copied]')?.getAttribute('data-copied')).toBe('true');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(container.querySelector('[data-copied]')?.getAttribute('data-copied')).toBe('false');

    act(() => {
      markCopied?.();
    });
    expect(container.querySelector('[data-copied]')?.getAttribute('data-copied')).toBe('true');
    act(() => {
      root.unmount();
    });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
  });

  it('is the only copy-reset timer owner in renderer copy surfaces', () => {
    const files = [
      'src/renderer/chat/activity-block/use-copy-content.ts',
      'src/renderer/chat/code-block.tsx',
      'src/renderer/views/memory/snapshot-tab.tsx'
    ];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toMatch(/from ['"]\.\.\/(?:\.\.\/)?utils\/use-copy-feedback['"]/);
      expect(source, file).not.toContain('copiedResetTimerRef');
      expect(source, file).not.toContain('window.setTimeout(() => setCopied(false)');
    }
  });
});
