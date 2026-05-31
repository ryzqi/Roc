import { describe, expect, it } from 'vitest';
import { buildControlNavItems } from '../../src/renderer/app/nav-items';
import { buildTopMeta } from '../../src/renderer/app/view-routing';
import { createLoadedState } from './view-test-helpers';

describe('renderer navigation meta', () => {
  it('uses the current memory label instead of the Phase 1 placeholder', () => {
    const state = createLoadedState({
      memoryStatus: {
        ...createLoadedState({}).memoryStatus,
        workspaceLabel: 'Roc'
      }
    });

    const memoryNav = buildControlNavItems(state).find((item) => item.id === 'memory');

    expect(memoryNav?.meta).toBe('Roc');
    expect(buildTopMeta('memory', state)).toBe('Roc');
  });

  it('uses global memory copy when no workspace memory label is available', () => {
    const state = createLoadedState({
      memoryStatus: {
        ...createLoadedState({}).memoryStatus,
        workspaceLabel: null
      }
    });

    const memoryNav = buildControlNavItems(state).find((item) => item.id === 'memory');

    expect(memoryNav?.meta).toBe('全局记忆');
    expect(buildTopMeta('memory', state)).toBe('全局记忆');
  });
});
