// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
  parseViewId,
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

  it('sends chat and workspace without a project back to research', () => {
    expect(parseViewId('chat', null)).toBe('research');
    expect(parseViewId('workspace', null)).toBe('research');
    expect(parseViewId('chat', 'research_1')).toBe('chat');
    expect(parseViewId('workspace', 'research_1')).toBe('workspace');
    expect(parseViewId('research', null)).toBe('research');
  });

  it('clears an old shell query when syncing the research page', () => {
    window.history.replaceState({}, '', '/?page=research&shell=legacy');
    syncRendererUrl('research', 'files', false);
    const url = new URL(window.location.href);
    expect(url.searchParams.get('page')).toBe('research');
    expect(url.searchParams.get('shell')).toBeNull();
  });

  it('records the assistant overlay without leaving the research page', () => {
    window.history.replaceState({}, '', '/?page=research&project=research_1');
    syncRendererUrl('research', 'files', false, true);
    const url = new URL(window.location.href);
    expect(url.searchParams.get('page')).toBe('research');
    expect(url.searchParams.get('assistant')).toBe('1');
  });
});
