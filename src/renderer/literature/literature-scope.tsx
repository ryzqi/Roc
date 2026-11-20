import { createContext, useContext } from 'react';
import type { LiteratureStore } from './use-literature-store';

/**
 * The literature store, shared by the sidebar's 文献 tab and the canvas 文献 view
 * (P5/T5.1).
 *
 * Why a context at `AppShell` level rather than one hook per surface: the two
 * surfaces are siblings in different subtrees, and the phase's acceptance
 * criterion is that they cannot drift. If each called `useLiteratureStore`
 * itself, importing a paper in the canvas would leave the sidebar stale and the
 * two would hold different selections — the "two states, one truth" problem this
 * deliberately avoids. Creating the store once and providing it to both is what
 * makes "shared" a structural fact rather than a convention.
 *
 * Throws when absent: a literature view rendered outside the scope is a wiring
 * bug, and an empty render would hide it until something looked broken for an
 * unrelated reason (same reasoning as `useWorkspaceScope`).
 */
const LiteratureScopeContext = createContext<LiteratureStore | null>(null);

export const LiteratureScopeProvider = LiteratureScopeContext.Provider;

export function useLiterature(): LiteratureStore {
  const store = useContext(LiteratureScopeContext);
  if (store === null) {
    throw new Error('literature_scope_missing: 文献视图必须渲染在文献作用域内。');
  }
  return store;
}
