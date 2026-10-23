import { useMemo } from 'react';
import type { DrawerSectionId } from '../../shared/surfaces';
import { schedulerStatusWord } from './background-task-model';
import { skillSummary } from './skill-model';
import type { ManagementScope } from './management-scope';
import { useBackgroundTasks, type BackgroundTasksStore } from './use-background-tasks';
import { useMcp, type McpStore } from './use-mcp';
import { useMemoryFiles, type MemoryFilesStore } from './use-memory';
import { useSkills, type SkillsStore } from './use-skills';

/**
 * The four management datasets, created once per shell (P9/T9.5).
 *
 * Both shells — the drawer and the three canvas views — need the same four stores, and the tab
 * strip needs a **real** one-line summary per tab (a static string would be the placeholder P1
 * shipped). Loading all four on open is deliberate: every read is local (`memory.status` is a
 * SQLite read, `skills.list` a directory scan, `mcp.*` a JSON config, `tasks.*` a list plus the
 * scheduler's own state), and the summaries are only honest if they come from the data.
 *
 * The sections stay presentational: they receive their store, so a shell cannot end up with two
 * instances of the same hook (two `tasks.onUpdated` subscriptions, two capability previews) just
 * because it rendered the same section in two places.
 */

/**
 * 管理抽屉的分区。
 *
 * 别名到面表（`src/shared/surfaces.ts`），不再是一份手抄的字面量联合。好处很具体：加一个分区时，
 * `summaries` 的 `Record<ManagementTabId, string>` 会立刻报缺项，而不是静默渲染一个空摘要。
 */
export type ManagementTabId = DrawerSectionId;

export type ManagementStores = {
  memory: MemoryFilesStore;
  skills: SkillsStore;
  mcp: McpStore;
  tasks: BackgroundTasksStore;
  summaries: Record<ManagementTabId, string>;
};

function memorySummary(memory: MemoryFilesStore): string {
  const parts = ['查看助手记住的项目背景与个人偏好'];
  if (memory.dirtyCount > 0) {
    parts.push(`未保存 ${memory.dirtyCount}`);
  }
  if (memory.memory !== null && memory.memory.workspaceHash === null) {
    parts.push('打开项目后可查看项目记忆');
  }
  return parts.join(' · ');
}

export function useManagementStores(scope: ManagementScope): ManagementStores {
  const memory = useMemoryFiles(scope.client);
  const skills = useSkills(scope.client);
  // The MCP assembly preview claims "what the next run can call", so it must be given the same
  // enabled skills the assistant would use.
  const mcp = useMcp(scope.client, skills.enabledIds);
  const tasks = useBackgroundTasks(scope.client, scope.workspacePath);

  const summaries = useMemo<Record<ManagementTabId, string>>(
    () => ({
      memory: memorySummary(memory),
      skills: skillSummary(skills.skills),
      mcp: `MCP ${mcp.rows.length} 个服务 · ${mcp.rows.filter((row) => row.server.enabled).length} 已启用 · 装配预览 ${mcp.preview?.toolCards.length ?? 0} 个工具`,
      tasks: `后台任务 ${tasks.tasks.length} 个 · 调度器 ${schedulerStatusWord(tasks.scheduler)}`
    }),
    [memory, skills.skills, mcp.rows, mcp.preview, tasks.tasks.length, tasks.scheduler]
  );

  return useMemo(
    () => ({ memory, skills, mcp, tasks, summaries }),
    [memory, skills, mcp, tasks, summaries]
  );
}
