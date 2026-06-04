import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTerminalOutputBatcher } from '../../src/main/terminal-output-batcher';

describe('terminal output batcher', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces terminal output for the same session before crossing the window boundary', () => {
    vi.useFakeTimers();
    const sent: Array<{ sessionId: string; data: string }> = [];
    const batcher = createTerminalOutputBatcher({
      intervalMs: 16,
      send: (event) => {
        sent.push(event);
      }
    });

    batcher.schedule({ sessionId: 'session-1', data: 'pnpm ' });
    batcher.schedule({ sessionId: 'session-1', data: 'test\r\n' });

    expect(sent).toEqual([]);

    vi.advanceTimersByTime(16);

    expect(sent).toEqual([{ sessionId: 'session-1', data: 'pnpm test\r\n' }]);
  });

  it('flushes buffered output before exit events are sent', () => {
    vi.useFakeTimers();
    const sent: Array<{ sessionId: string; data: string }> = [];
    const batcher = createTerminalOutputBatcher({
      intervalMs: 16,
      send: (event) => {
        sent.push(event);
      }
    });

    batcher.schedule({ sessionId: 'session-1', data: 'done' });
    batcher.flush();
    vi.advanceTimersByTime(16);

    expect(sent).toEqual([{ sessionId: 'session-1', data: 'done' }]);
  });
});
