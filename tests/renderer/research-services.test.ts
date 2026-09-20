import { describe, expect, it } from 'vitest';

import { buildResearchServices, createResearchServiceContext } from '../../src/renderer/views/research/research-services';
import { createLoadedState } from './view-test-helpers';

describe('research services', () => {
  it('binds service entries to the current project and workspace', () => {
    const state = createLoadedState({
      taskSnapshot: {
        ...createLoadedState({}).taskSnapshot,
        counts: { total: 2, running: 1, failed: 0, pendingConfirmation: 1 }
      },
      agent: {
        ...createLoadedState({}).agent,
        execution: 'ready'
      }
    });
    const context = createResearchServiceContext({
      projectId: 'research_1',
      project: {
        id: 'research_1',
        title: '证据图',
        description: '把想法变成可追溯项目。',
        workspacePath: '/tmp/project',
        status: 'active',
        language: 'zh',
        origin: null,
        currentStage: 'writing',
        createdAt: '2026-09-14T00:00:00.000Z',
        updatedAt: '2026-09-14T01:00:00.000Z'
      },
      currentStage: 'writing'
    }, '/tmp/global');
    const services = buildResearchServices(state, context);
    expect(context.workspacePath).toBe('/tmp/project');
    expect(services.find((item) => item.id === 'assistant')).toMatchObject({
      view: 'chat',
      status: 'available',
      projectId: 'research_1',
      stage: 'writing',
      workspacePath: '/tmp/project'
    });
    expect(services.find((item) => item.id === 'tasks')?.status).toBe('blocked');
    expect(services.find((item) => item.id === 'files')?.view).toBe('workspace');
  });

  it('does not treat the global compute directory as a selected project workspace', () => {
    const withProject = createResearchServiceContext({
      projectId: 'research_1',
      project: {
        id: 'research_1',
        title: '证据图',
        description: '把想法变成可追溯项目。',
        workspacePath: null,
        status: 'active',
        language: 'zh',
        origin: null,
        currentStage: 'writing',
        createdAt: '2026-09-14T00:00:00.000Z',
        updatedAt: '2026-09-14T01:00:00.000Z'
      },
      currentStage: 'writing'
    }, '/tmp/global');
    expect(withProject.workspacePath).toBeNull();

    const empty = createResearchServiceContext({
      projectId: null,
      project: null,
      currentStage: null
    }, '/tmp/global');
    expect(empty.workspacePath).toBe('/tmp/global');
  });
});
