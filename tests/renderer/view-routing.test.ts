// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
  syncRendererUrl
} from '../../src/renderer/app/view-routing';

describe('research shell routing', () => {
  afterEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('writes page=research and drops leftover shell query', () => {
    window.history.replaceState({}, '', '/');
    syncRendererUrl('research', 'files', false);
    const url = new URL(window.location.href);
    expect(url.searchParams.get('page')).toBe('research');
    expect(url.searchParams.get('shell')).toBeNull();
  });

  it('clears an old shell query when syncing the research page', () => {
    window.history.replaceState({}, '', '/?page=research&shell=legacy');
    syncRendererUrl('research', 'files', false);
    const url = new URL(window.location.href);
    expect(url.searchParams.get('page')).toBe('research');
    expect(url.searchParams.get('shell')).toBeNull();
  });
});
