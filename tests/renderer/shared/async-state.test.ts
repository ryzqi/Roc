import { describe, expect, it } from 'vitest';
import { failedAsyncState, idleAsyncState, loadedAsyncState, loadingAsyncState } from '../../../src/renderer/shared/async-state';

describe('async state', () => {
  it('distinguishes idle, loading, loaded, and failed states', () => {
    expect(idleAsyncState()).toEqual({ status: 'idle' });
    expect(loadingAsyncState()).toEqual({ status: 'loading' });
    expect(loadedAsyncState({ value: 42 })).toEqual({ status: 'loaded', data: { value: 42 } });
    expect(failedAsyncState('load failed')).toEqual({ status: 'failed', message: 'load failed' });
  });

  it('keeps failed message as a string', () => {
    const state = failedAsyncState('Roc failed');

    expect(state.message).toBe('Roc failed');
    expect(typeof state.message).toBe('string');
  });
});
