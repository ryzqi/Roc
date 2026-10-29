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
 * The four management datasets, created once per active management scope (P9/T9.5).
 *
 * The drawer and canvas can be mounted together. Their previous independent hook instances held
 * separate memory drafts, allowing a stale save to overwrite newer edits. The source hooks now live
 * in one lazy scope owner; a Zustand snapshot store publishes stable slices to both shells.
 *
 * Loading all four on open remains deliberate: every read is local (`memory.status` is a SQLite
 * read, `skills.list` a directory scan, `mcp.*` a JSON config, `tasks.*` a list plus the scheduler's
 * own state), and the summaries are only honest if they come from the data. Sections select their
 * own slice so unrelated updates do not invalidate the whole management surface.
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

export function useManagementStoresSource(scope: ManagementScope): ManagementStores {
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
      mcp: `${mcp.rows.length} 个服务 · ${mcp.rows.filter((row) => mcp.serverEnabled(row.server)).length} 个已启用`,
      tasks: `后台任务 ${tasks.tasks.length} 个 · 调度器 ${schedulerStatusWord(tasks.scheduler)}`
    }),
    [memory, skills.skills, mcp, tasks.tasks.length, tasks.scheduler]
  );

  return useMemo(
    () => ({ memory, skills, mcp, tasks, summaries }),
    [memory, skills, mcp, tasks, summaries]
  );
}
