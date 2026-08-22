import { describe, expect, it } from 'vitest';

import { createMemorySearchTool, createRememberTool } from '../../../../../src/main/services/deep-agent/context/memory-tools';
import type {
  MemoryRememberOutcome,
  MemoryRememberRequest,
  MemorySearchRequest,
  MemorySearchResult
} from '../../../../../src/shared/types';

describe('createMemorySearchTool', () => {
  it('returns matched entries without the internal score', async () => {
    const requests: MemorySearchRequest[] = [];
    const tool = createMemorySearchTool({
      search: (request) => {
        requests.push(request);
        return searchResult();
      }
    });

    const parsed = JSON.parse(await tool.invoke({ query: '  喜欢什么语言  ' }));

    expect(tool.name).toBe('memory_search');
    expect(requests).toEqual([{ query: '喜欢什么语言' }]);
    expect(parsed).toEqual({
      query: '喜欢什么语言',
      hits: [
        {
          path: '/memory/global/USER.md',
          scope: 'global',
          entryType: 'user_preference',
          key: 'user.language',
          text: '用户偏好使用 Python 编程语言。'
        }
      ]
    });
    expect(Object.keys(parsed.hits[0])).not.toContain('score');
  });

  it('forwards an explicit limit and skips the search for an empty query', async () => {
    const requests: MemorySearchRequest[] = [];
    const tool = createMemorySearchTool({
      search: (request) => {
        requests.push(request);
        return searchResult();
      }
    });

    await tool.invoke({ query: 'python', limit: 3 });
    const parsed = JSON.parse(await tool.invoke({ query: '   ' }));

    expect(requests).toEqual([{ query: 'python', limit: 3 }]);
    expect(parsed).toEqual({ query: '', hits: [] });
  });
});

describe('createRememberTool', () => {
  it('stamps the run, thread, and workspace from the harness instead of the model', async () => {
    const requests: MemoryRememberRequest[] = [];
    const tool = createRememberTool({
      remember: (request) => {
        requests.push(request);
        return acceptedOutcome();
      },
      runId: 'run_1',
      threadId: 'thread_1',
      workspacePath: 'F:\\Code\\Roc'
    });

    const parsed = JSON.parse(
      await tool.invoke({
        type: 'user_preference',
        confidence: 'high',
        key: '  user.language  ',
        summary: '  User prefers Python.  ',
        evidence: ['user stated: I prefer Python']
      })
    );

    expect(tool.name).toBe('remember');
    expect(requests).toEqual([
      {
        type: 'user_preference',
        confidence: 'high',
        key: 'user.language',
        summary: 'User prefers Python.',
        evidence: ['user stated: I prefer Python'],
        sourceRunId: 'run_1',
        sourceThreadId: 'thread_1',
        workspacePath: 'F:\\Code\\Roc'
      }
    ]);
    expect(parsed).toEqual({
      status: 'accepted',
      reason: 'accepted',
      scope: 'global',
      targetPath: '/memory/global/USER.md',
      archivedTo: []
    });
  });

  it('forwards ttlDays and revalidate only when the model supplies them', async () => {
    const requests: MemoryRememberRequest[] = [];
    const tool = createRememberTool({
      remember: (request) => {
        requests.push(request);
        return acceptedOutcome();
      },
      runId: 'run_1',
      threadId: 'thread_1',
      workspacePath: null
    });

    await tool.invoke({
      type: 'pitfall',
      confidence: 'low',
      key: 'roc.memory.capacity',
      summary: 'Capacity overflow archives the oldest section.',
      evidence: ['src/main/services/memory/auto-memory-writer.ts'],
      ttlDays: 14,
      revalidate: 'when the capacity policy changes'
    });

    expect(requests[0]).toMatchObject({ ttlDays: 14, revalidate: 'when the capacity policy changes', workspacePath: null });
  });

  it('reports a rejection reason back to the model instead of throwing', async () => {
    const tool = createRememberTool({
      remember: () => ({
        status: 'rejected',
        reason: 'user_preference_direct_user_evidence_required',
        scope: 'global',
        targetPath: '/memory/global/USER.md',
        archivedTo: []
      }),
      runId: 'run_1',
      threadId: 'thread_1',
      workspacePath: null
    });

    const parsed = JSON.parse(
      await tool.invoke({
        type: 'user_preference',
        confidence: 'high',
        key: 'user.language',
        summary: 'User prefers Python.',
        evidence: ['the model inferred it from repository files']
      })
    );

    expect(parsed).toMatchObject({
      status: 'rejected',
      reason: 'user_preference_direct_user_evidence_required'
    });
  });

  it('does not expose transient_task_result as a storable type', async () => {
    const tool = createRememberTool({
      remember: () => acceptedOutcome(),
      runId: 'run_1',
      threadId: 'thread_1',
      workspacePath: null
    });

    await expect(
      tool.invoke({
        type: 'transient_task_result',
        confidence: 'high',
        key: 'one.off',
        summary: 'Finished this single run.',
        evidence: ['tests/manual/run.log']
      } as never)
    ).rejects.toThrow();
  });
});

function searchResult(): MemorySearchResult {
  return {
    query: '喜欢什么语言',
    hits: [
      {
        path: '/memory/global/USER.md',
        scope: 'global',
        kind: 'user',
        entryType: 'user_preference',
        key: 'user.language',
        text: '用户偏好使用 Python 编程语言。',
        score: 18
      }
    ],
    scannedDocuments: 5,
    scannedEntries: 12
  };
}

function acceptedOutcome(): MemoryRememberOutcome {
  return {
    status: 'accepted',
    reason: 'accepted',
    scope: 'global',
    targetPath: '/memory/global/USER.md',
    archivedTo: []
  };
}
