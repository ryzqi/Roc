import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

import type { SessionMessageSearchRequest, SessionMessageSearchResult } from '../../../../shared/types';
import { resolveSessionSearchWorkspaceHash } from './workspace-scope';

export type SessionSearchAdapter = (
  request: SessionMessageSearchRequest
) => Promise<SessionMessageSearchResult> | SessionMessageSearchResult;

const sessionSearchSchema = z.object({
  query: z.string(),
  scope: z.enum(['current', 'all']).optional(),
  sinceDays: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(20).optional()
});

type SessionSearchToolInput = z.infer<typeof sessionSearchSchema>;

export function createSessionSearchTool(input: {
  runtimeWorkspacePath: string | null;
  search: SessionSearchAdapter;
}): DynamicStructuredTool<typeof sessionSearchSchema, SessionSearchToolInput, SessionSearchToolInput, string> {
  return new DynamicStructuredTool<typeof sessionSearchSchema, SessionSearchToolInput, SessionSearchToolInput, string>({
    name: 'session_search',
    description:
      'Search snippets from past Roc conversations. Use scope=current for this workspace or scope=all for visible history.',
    schema: sessionSearchSchema,
    func: async (args) => {
      const normalizedQuery = args.query.trim();
      if (normalizedQuery.length === 0) {
        return JSON.stringify({ query: '', total: 0, items: [] });
      }
      const scope = args.scope === undefined ? (input.runtimeWorkspacePath === null ? 'all' : 'current') : args.scope;
      const workspaceHash = resolveSessionSearchWorkspaceHash({
        scope,
        runtimeWorkspacePath: input.runtimeWorkspacePath
      });
      const request: SessionMessageSearchRequest = {
        query: normalizedQuery,
        workspaceScope: scope,
        workspaceHash,
        limit: args.limit === undefined ? 5 : args.limit
      };
      if (args.sinceDays !== undefined) {
        request.sinceDays = args.sinceDays;
      }
      const result = await input.search(request);
      return JSON.stringify({
        query: result.query,
        total: result.total,
        items: result.items.map((item) => ({
          threadId: item.threadId,
          threadTitle: item.threadTitle,
          role: item.role,
          snippet: item.snippet,
          createdAt: item.createdAt
        }))
      });
    }
  });
}
