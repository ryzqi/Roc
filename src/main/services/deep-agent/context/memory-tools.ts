import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

import type {
  MemoryRememberOutcome,
  MemoryRememberRequest,
  MemorySearchRequest,
  MemorySearchResult
} from '../../../../shared/types';

export type MemorySearchAdapter = (
  request: MemorySearchRequest
) => Promise<MemorySearchResult> | MemorySearchResult;

export type MemoryRememberAdapter = (
  request: MemoryRememberRequest
) => Promise<MemoryRememberOutcome> | MemoryRememberOutcome;

const memorySearchSchema = z.object({
  query: z.string(),
  limit: z.number().int().positive().max(20).optional()
});

type MemorySearchToolInput = z.infer<typeof memorySearchSchema>;

const rememberSchema = z.object({
  type: z.enum(['user_preference', 'workspace_fact', 'decision', 'pitfall', 'verification']),
  confidence: z.enum(['high', 'medium', 'low']),
  key: z.string(),
  summary: z.string(),
  evidence: z.array(z.string()),
  ttlDays: z.number().int().positive().optional(),
  revalidate: z.string().optional()
});

type RememberToolInput = z.infer<typeof rememberSchema>;

export function createMemorySearchTool(input: {
  search: MemorySearchAdapter;
}): DynamicStructuredTool<typeof memorySearchSchema, MemorySearchToolInput, MemorySearchToolInput, string> {
  return new DynamicStructuredTool<typeof memorySearchSchema, MemorySearchToolInput, MemorySearchToolInput, string>({
    name: 'memory_search',
    description:
      'Search stored memory entries (USER.md, AGENTS.md, MEMORY.md, and topic files) for a fact, preference, or decision. Use this before guessing a memory file path.',
    schema: memorySearchSchema,
    func: async (args) => {
      const normalizedQuery = args.query.trim();
      if (normalizedQuery.length === 0) {
        return JSON.stringify({ query: '', hits: [] });
      }
      const request: MemorySearchRequest = { query: normalizedQuery };
      if (args.limit !== undefined) {
        request.limit = args.limit;
      }
      const result = await input.search(request);
      return JSON.stringify({
        query: result.query,
        hits: result.hits.map((hit) => ({
          path: hit.path,
          scope: hit.scope,
          entryType: hit.entryType,
          key: hit.key,
          text: hit.text
        }))
      });
    }
  });
}

export function createRememberTool(input: {
  remember: MemoryRememberAdapter;
  runId: string;
  threadId: string;
  workspacePath: string | null;
}): DynamicStructuredTool<typeof rememberSchema, RememberToolInput, RememberToolInput, string> {
  return new DynamicStructuredTool<typeof rememberSchema, RememberToolInput, RememberToolInput, string>({
    name: 'remember',
    description: [
      'Store one durable fact in memory. Roc validates the entry, drops duplicates, supersedes an older value for the same key, and reports the target file.',
      'type=user_preference requires confidence=high and evidence quoting the user (for example "user stated: I prefer Python"); it lands in /memory/global/USER.md.',
      'Every other type lands in the scoped MEMORY.md. Do not store transient task results.',
      'key is a stable slug (lowercase letters, digits, dots, colons, hyphens) so a later value can supersede this one.'
    ].join('\n'),
    schema: rememberSchema,
    func: async (args) => {
      const request: MemoryRememberRequest = {
        type: args.type,
        confidence: args.confidence,
        key: args.key.trim(),
        summary: args.summary.trim(),
        evidence: args.evidence,
        sourceRunId: input.runId,
        sourceThreadId: input.threadId,
        workspacePath: input.workspacePath
      };
      if (args.ttlDays !== undefined) {
        request.ttlDays = args.ttlDays;
      }
      if (args.revalidate !== undefined) {
        request.revalidate = args.revalidate;
      }
      const outcome = await input.remember(request);
      return JSON.stringify({
        status: outcome.status,
        reason: outcome.reason,
        scope: outcome.scope,
        targetPath: outcome.targetPath,
        archivedTo: outcome.archivedTo
      });
    }
  });
}
