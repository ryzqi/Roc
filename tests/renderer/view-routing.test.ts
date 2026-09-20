// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
  parseResearchShellMode,
  persistResearchShellMode,
  RESEARCH_SHELL_STORAGE_KEY,
  syncRendererUrl
} from '../../src/renderer/app/view-routing';

describe('research shell routing', () => {
  afterEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('keeps the legacy shell unless query or storage opts in', () => {
    expect(parseResearchShellMode(new URLSearchParams('page=research'))).toBe('legacy');
    expect(parseResearchShellMode(new URLSearchParams('page=research&shell=legacy'), 'research')).toBe('legacy');
    expect(parseResearchShellMode(new URLSearchParams('page=research'), 'research')).toBe('research');
    expect(parseResearchShellMode(new URLSearchParams('page=research&shell=research'))).toBe('research');
  });

  it('persists the research shell and writes the query', () => {
    persistResearchShellMode('research');
    expect(window.localStorage.getItem(RESEARCH_SHELL_STORAGE_KEY)).toBe('research');
    expect(new URL(window.location.href).searchParams.get('shell')).toBe('research');
    persistResearchShellMode('legacy');
    expect(window.localStorage.getItem(RESEARCH_SHELL_STORAGE_KEY)).toBeNull();
    expect(new URL(window.location.href).searchParams.get('shell')).toBe('legacy');
  });

  it('keeps page=research and an explicit legacy shell query', () => {
    window.history.replaceState({}, '', '/?page=research&shell=legacy');
    syncRendererUrl('research', 'files', false);
    const url = new URL(window.location.href);
    expect(url.searchParams.get('page')).toBe('research');
    expect(url.searchParams.get('shell')).toBe('legacy');
  });
});
