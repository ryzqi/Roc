import { AsyncLocalStorage } from 'node:async_hooks';
import type { ResearchSearchPlan } from '../../shared/schemas/research-search-plan';

/** Only main-process callers establish this scope; it never comes from model/tool arguments. */
export type LiteratureExecutionContext = {
  owner: string;
  projectId: string | null;
  runId?: string;
  signal?: AbortSignal;
  assertActive?: () => void;
  searchStrategy?: {plan: ResearchSearchPlan; artifactId: string; contentHash: string; approvedAt: string; assertCurrent: () => void};
  queryId?: string;
};
const contexts = new AsyncLocalStorage<LiteratureExecutionContext>();
export function withLiteratureContext<T>(context: LiteratureExecutionContext, action: () => T): T {
  return contexts.run(context, action);
}
export function literatureContext(): LiteratureExecutionContext {
  const context = contexts.getStore();
  if (context === undefined) throw new Error('literature_execution_context_required');
  return context;
}
export function assertLiteratureActive(context: LiteratureExecutionContext): void {
  context.signal?.throwIfAborted();
  context.assertActive?.();
  context.searchStrategy?.assertCurrent();
}
