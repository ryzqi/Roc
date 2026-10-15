import { createContext, useContext } from 'react';
import type { WorkflowStore } from './use-workflow-store';

/**
 * The research-workflow store, shared by every canvas surface that shows the stage axis
 * (P6/T6.1–T6.9).
 *
 * 总览, 阶段工作区 and 活动流 are separate lazily-loaded canvas views, so they are
 * siblings in the view registry — not a parent/child pair that could pass state down.
 * They must nevertheless agree on the current stage, the in-flight run and the pending
 * gate: the primary action 总览 offers is the transition 阶段工作区 explains, and the
 * activity stream is that same project's event log. One store provided from `AppShell`
 * makes that a structural fact, and it also means exactly one poll runs (no push channel
 * exists — B11).
 *
 * Throws when absent, for the same reason `useWorkspaceScope` does: a workflow view outside
 * the scope is a wiring bug, and an empty render would hide it.
 */
const WorkflowScopeContext = createContext<WorkflowStore | null>(null);

export const WorkflowScopeProvider = WorkflowScopeContext.Provider;

export function useWorkflow(): WorkflowStore {
  const store = useContext(WorkflowScopeContext);
  if (store === null) {
    throw new Error('workflow_scope_missing: 阶段视图必须渲染在项目流程作用域内。');
  }
  return store;
}
