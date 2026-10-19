import { createContext, useContext, type ReactNode } from 'react';
import type { DrawerSectionId } from '../../shared/surfaces';
import type { RocClient } from '../shared/roc-client';

/**
 * Management context (P9/T9.5).
 *
 * The four management sections are rendered from **two** shells — the drawer (assistant-adjacent
 * 管理 button, 560px) and the three canvas views (`?view=memory|skills|mcp`, the route contract
 * P1 froze) — and both need the same four facts plus the two shell actions that leave the
 * management surface:
 *
 *   - `onOpenThread(threadId)` — a memory-search hit jumps back to the conversation it came from
 *     (that selection belongs to the shell, which owns the assistant panel);
 *   - `onAskAssistant(prompt)` — 「用助手整理记忆」 hands a prompt to the assistant's composer. The
 *     management drawer **must not** start a run itself: run state and the transcript live in the
 *     assistant panel, so a run started from a drawer would be invisible.
 *
 * Creating the context once in the shell (like the literature and workflow scopes) is what makes
 * "the same component in two shells" structural rather than a convention, and it keeps the
 * sections free of `AppShell` internals.
 */

export type ManagementScope = {
  client: RocClient;
  projectId: string | null;
  /** Bound working directory: needed for the workspace memory slots and for a task's workspacePath. */
  workspacePath: string | null;
  onOpenThread: (threadId: string) => void;
  onAskAssistant: (prompt: string) => void;
  /**
   * Opens the settings centre.
   *
   * The MCP approval mode is shown **read-only** here with a jump to 设置 → 授权与安全: P8 shipped
   * that control as the single writer for the global policy, and a second live switch in the
   * drawer would be two writers for one value with no way to reconcile them if both are open.
   */
  openSettings: () => void;
  /**
   * 打开一个管理分区，落在它真正拥有的宿主上。
   *
   * 记忆 / 技能 / MCP 有两个落点（画布视图与抽屉分区），任务只有抽屉（ADR 0024：两个界面盯一个数据集
   * 就是发散）。选哪一个由壳决定，所以这些分区永远不会长出第二条导航路径——而参数类型来自面表，
   * 不是手写的字面量联合。
   */
  openManagementView: (section: DrawerSectionId) => void;
};

const ManagementContext = createContext<ManagementScope | null>(null);

export function ManagementScopeProvider({
  value,
  children
}: {
  value: ManagementScope;
  children: ReactNode;
}): React.JSX.Element {
  return <ManagementContext.Provider value={value}>{children}</ManagementContext.Provider>;
}

export function useManagement(): ManagementScope {
  const scope = useContext(ManagementContext);
  if (scope === null) {
    throw new Error('management_scope_missing: 管理面板必须在 ManagementScopeProvider 内渲染。');
  }
  return scope;
}
