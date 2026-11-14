export type ProposedResearchTool = {id: string; function: {name: string; arguments: string}};
type ResearchCall = {
  name: 'research.knowledge.search' | 'research.knowledge.context';
  request: unknown;
  projectId: string;
  toolCallId?: string;
};

export function takeProposedResearchTool(pending: ProposedResearchTool[], call: ResearchCall): ProposedResearchTool {
  const toolName = call.name === 'research.knowledge.search'
    ? 'research_search_knowledge' : 'research_read_knowledge_context';
  const schema = call.name === 'research.knowledge.search'
    ? researchKnowledgeSearchRequestSchema : knowledgeContextRequestSchema;
  const request = schema.parse(call.request);
  // Read-only tools do not create an effect operation context. Match the
  // production-normalized request so concurrent same-name calls may run in any order.
  const index = pending.findIndex(tool => tool.function.name === toolName
    && (call.toolCallId === undefined || call.toolCallId === tool.id)
    && matchesRequest(tool, call, request));
  if (index < 0) throw new Error('benchmark_research_tool_binding_missing');
  return pending.splice(index, 1)[0]!;
}
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {researchKnowledgeSearchRequestSchema} from '../../src/shared/schemas/research';
import {knowledgeContextRequestSchema} from '../../src/shared/schemas/research-knowledge-context';


function matchesRequest(tool: ProposedResearchTool, call: ResearchCall, request: unknown): boolean {
  try {
    const args = z.record(z.string(), z.unknown()).parse(JSON.parse(tool.function.arguments));
    const expected = call.name === 'research.knowledge.search'
      ? researchKnowledgeSearchRequestSchema.parse({
        query: args.query, projectId: call.projectId, limit: args.limit ?? 6,
        ...(args.documentId ? {documentId: args.documentId} : {}), embeddingConfigId: null
      })
      : knowledgeContextRequestSchema.parse({...args, projectId: call.projectId});
    return isDeepStrictEqual(expected, request);
  } catch {
    return false;
  }
}
