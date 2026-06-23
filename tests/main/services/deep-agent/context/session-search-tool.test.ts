import { describe, expect, it } from 'vitest';

import { createSessionSearchTool } from '../../../../../src/main/services/deep-agent/context/session-search-tool';
import { buildWorkspaceHash } from '../../../../../src/main/services/paths';
import type { SessionMessageSearchRequest, SessionMessageSearchResult } from '../../../../../src/shared/types';

describe('createSessionSearchTool', () => {
  it('creates a session_search tool that defaults to current scope when a workspace exists', async () => {
    const requests: SessionMessageSearchRequest[] = [];
    const tool = createSessionSearchTool({
      runtimeWorkspacePath: 'F:\\Code\\Roc',
      search: (request) => {
        requests.push(request);
        return resultWithContent('Full content should not be returned', 'matching **snippet**');
      }
    });

    const output = await tool.invoke({ query: 'memory' });
    const parsed = JSON.parse(output);

    expect(tool.name).toBe('session_search');
    expect(requests).toEqual([
      {
        query: 'memory',
        workspaceScope: 'current',
        workspaceHash: buildWorkspaceHash('F:\\Code\\Roc'),
        limit: 5
      }
    ]);
    expect(parsed.items).toEqual([
      {
        threadId: 'thread_1',
        threadTitle: 'Thread title',
        role: 'assistant',
        snippet: 'matching **snippet**',
        createdAt: '2026-06-24T00:00:00.000Z'
      }
    ]);
    expect(JSON.stringify(parsed)).not.toContain('Full content should not be returned');
  });

  it('defaults to all scope when no workspace exists', async () => {
    const requests: SessionMessageSearchRequest[] = [];
    const tool = createSessionSearchTool({
      runtimeWorkspacePath: null,
      search: (request) => {
        requests.push(request);
        return resultWithContent('content', 'snippet');
      }
    });

    await tool.invoke({ query: 'memory' });

    expect(requests[0]).toMatchObject({
      query: 'memory',
      workspaceScope: 'all',
      workspaceHash: null,
      limit: 5
    });
  });

  it('returns a clear error when current scope is requested without a workspace', async () => {
    const tool = createSessionSearchTool({
      runtimeWorkspacePath: null,
      search: () => resultWithContent('content', 'snippet')
    });

    await expect(tool.invoke({ query: 'memory', scope: 'current' })).rejects.toThrow('session_search_workspace_required');
  });
});

function resultWithContent(content: string, snippet: string): SessionMessageSearchResult {
  return {
    query: 'memory',
    total: 1,
    items: [
      {
        id: 'smsg_1',
        threadId: 'thread_1',
        threadTitle: 'Thread title',
        role: 'assistant',
        content,
        phase: 'visible',
        tokenCount: null,
        workspaceHash: 'workspace_hash',
        createdAt: '2026-06-24T00:00:00.000Z',
        snippet
      }
    ]
  };
}
