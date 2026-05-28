import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { SessionArchiveService } from '../../memory/session-archive';

const sessionSearchSchema = z.object({
  query: z.string().min(1).describe('FTS5 query syntax: space=AND, double quotes=phrase, OR=or, prefix*=prefix.'),
  workspaceScope: z.enum(['current', 'global', 'all']).default('current'),
  threadId: z.string().nullish(),
  limit: z.number().int().min(1).max(50).default(10),
  sinceDays: z.number().int().min(1).nullish()
});

export function createSessionSearchTool(archive: SessionArchiveService) {
  return tool(
    async (input) => {
      const threadId = input.threadId === null || input.threadId === undefined ? undefined : input.threadId;
      const sinceDays = input.sinceDays === null || input.sinceDays === undefined ? undefined : input.sinceDays;
      const result = archive.search({
        query: input.query,
        workspaceScope: input.workspaceScope,
        threadId,
        limit: input.limit,
        sinceDays
      });
      if (result.total === 0) {
        return `No matches for "${result.query}".`;
      }

      const lines = [`Found ${result.total} message(s). Query: "${result.query}"`, ''];
      for (const item of result.items) {
        lines.push(`## ${item.createdAt}  thread:${item.threadId}  Title: ${item.threadTitle ?? '(untitled)'}`);
        lines.push(`**${item.role}**: ${item.snippet}`);
        lines.push('');
      }
      return lines.join('\n');
    },
    {
      name: 'session_search',
      description:
        'Search past conversation messages using SQLite FTS5. Use only when you need to recall what was discussed or done in earlier conversations. The current ongoing conversation is not in this index.',
      schema: sessionSearchSchema
    }
  );
}
