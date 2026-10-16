import { useMemo } from 'react';
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

export type ManagementTabId = 'memory' | 'skills' | 'mcp' | 'tasks';

export type ManagementStores = {
  memory: MemoryFilesStore;
  skills: SkillsStore;
  mcp: McpStore;
  tasks: BackgroundTasksStore;
  summaries: Record<ManagementTabId, string>;
};

function memorySummary(memory: MemoryFilesStore): string {
  const parts = [`记忆 ${memory.rows.length} 份（markdown 内容）`];
  if (memory.dirtyCount > 0) {
    parts.push(`未保存 ${memory.dirtyCount}`);
  }
  if (memory.memory !== null && memory.memory.workspaceHash === null) {
    parts.push('未绑定工作目录，项目槽位不可用');
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
