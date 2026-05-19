import { describe, expect, it } from 'vitest';
import { idleLazyLoadState } from '../../src/renderer/app/empty-states';
import { planLazyStartupTransition } from '../../src/renderer/app/use-lazy-startup-resource';

describe('use lazy startup resource transition planner', () => {
  it('resets a stale loading state when the resource becomes disabled before completion', () => {
    const transition = planLazyStartupTransition({
      cacheKey: 'F:\\Code\\Roc',
      enabled: false,
      loadState: {
        status: 'loading',
        error: null,
        key: 'F:\\Code\\Roc'
      }
    });

    expect(transition).toEqual({
      cancelActiveRequest: true,
      nextLoadState: idleLazyLoadState('F:\\Code\\Roc'),
      shouldStartLoad: false
    });
  });

  it('does not restart a resource that is already ready for the same stable workspace path', () => {
    const transition = planLazyStartupTransition({
      cacheKey: 'F:\\Code\\Roc',
      enabled: true,
      loadState: {
        status: 'ready',
        error: null,
        key: 'F:\\Code\\Roc'
      }
    });

    expect(transition).toEqual({
      cancelActiveRequest: false,
      nextLoadState: null,
      shouldStartLoad: false
    });
  });
});
