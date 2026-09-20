// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
  parseResearchRoute,
  sameResearchRoute,
  writeResearchRoute
} from '../../src/renderer/views/research/research-route';

describe('research route', () => {
  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('parses project, canvas view, stage groups, tabs, and legacy aliases', () => {
    expect(parseResearchRoute(new URLSearchParams('project=research_2'))).toEqual({
      projectId: 'research_2',
      view: 'overview',
      stageGroup: 'discover',
      stageTab: 'library'
    });
    expect(parseResearchRoute(new URLSearchParams('view=service&stage=write'))).toEqual({
      projectId: null,
      view: 'stage',
      stageGroup: 'write',
      stageTab: 'manuscript'
    });
    expect(parseResearchRoute(new URLSearchParams('view=stage&stage=knowledge'))).toEqual({
      projectId: null,
      view: 'stage',
      stageGroup: 'discover',
      stageTab: 'knowledge'
    });
    expect(parseResearchRoute(new URLSearchParams('view=activity&stage=writing'))).toEqual({
      projectId: null,
      view: 'activity',
      stageGroup: 'write',
      stageTab: 'manuscript'
    });
  });

  it('writes research params without dropping page or shell', () => {
    window.history.replaceState({}, '', '/?page=research&shell=research&tool=files');
    writeResearchRoute({
      projectId: 'research_2',
      view: 'stage',
      stageGroup: 'write',
      stageTab: 'manuscript'
    }, 'push');
    const url = new URL(window.location.href);
    expect(url.searchParams.get('page')).toBe('research');
    expect(url.searchParams.get('shell')).toBe('research');
    expect(url.searchParams.get('tool')).toBe('files');
    expect(url.searchParams.get('project')).toBe('research_2');
    expect(url.searchParams.get('view')).toBe('stage');
    expect(url.searchParams.get('stage')).toBe('write');
  });

  it('omits overview view and default stage tabs, then compares routes', () => {
    window.history.replaceState({}, '', '/?page=research&shell=research');
    writeResearchRoute({
      projectId: 'research_1',
      view: 'overview',
      stageGroup: 'discover',
      stageTab: 'library'
    }, 'replace');
    const url = new URL(window.location.href);
    expect(url.searchParams.get('view')).toBeNull();
    expect(url.searchParams.get('stage')).toBeNull();
    expect(url.searchParams.get('project')).toBe('research_1');
    expect(sameResearchRoute(
      parseResearchRoute(url.searchParams),
      { projectId: 'research_1', view: 'overview', stageGroup: 'discover', stageTab: 'library' }
    )).toBe(true);
    expect(sameResearchRoute(
      { projectId: 'research_1', view: 'overview', stageGroup: 'write', stageTab: 'manuscript' },
      { projectId: 'research_1', view: 'overview', stageGroup: 'discover', stageTab: 'library' }
    )).toBe(true);
  });
});
