import type { ResearchProject } from '../../shared/types';
import type { IpcLikeResult } from '../app/loaded-state';
import type { RocClient } from '../shared/roc-client';

/**
 * Project data layer (P2/T2.1).
 *
 * Thin wrappers over `research.projects.*` plus the pure derivations the portal
 * needs. Nothing here touches `localStorage`: projects live in SQLite, and the
 * only local project state is the pin list in `ui-state.ts` (ADR-M06).
 *
 * The entity is exactly `researchProjectSchema`
 * (`id/title/description/workspacePath/status/language/origin/currentStage/
 * createdAt/updatedAt`). Fields the old frontend invented — `paperCount`,
 * `fileCount`, `wordCount`, `isStarred`, `clonedFrom` — are **not** modelled:
 * counts are fetched lazily where they are shown, pinning is a UI preference,
 * and clone has no backend (B2).
 */

export type ProjectStatusFilter = 'active' | 'archived' | 'all';

export type ProjectCreateInput = {
  title: string;
  description: string;
  workspacePath: string;
  language?: 'zh' | 'en';
};

export type ProjectUpdateInput = {
  id: string;
  title?: string;
  description?: string;
  workspacePath?: string;
  status?: ResearchProject['status'];
  language?: 'zh' | 'en';
};

export function listProjects(client: RocClient): Promise<IpcLikeResult<ResearchProject[]>> {
  return client.api.research.listProjects();
}

export function getProject(client: RocClient, id: string): Promise<IpcLikeResult<ResearchProject>> {
  return client.api.research.getProject({ id });
}

export function createProject(client: RocClient, input: ProjectCreateInput): Promise<IpcLikeResult<ResearchProject>> {
  return client.api.research.createProject(input);
}

export function updateProject(client: RocClient, input: ProjectUpdateInput): Promise<IpcLikeResult<ResearchProject>> {
  return client.api.research.updateProject(input);
}

export function deleteProject(client: RocClient, id: string): Promise<IpcLikeResult<{ deleted: true; id: string }>> {
  return client.api.research.deleteProject({ id });
}

/* ------------------------------------------------------------------ */
/* Pure derivations (unit-tested; no IPC, no clock beyond what is given) */
/* ------------------------------------------------------------------ */

export function isProjectArchived(project: ResearchProject): boolean {
  return project.status === 'archived';
}

/**
 * Archived projects are read-only (P2/T2.5): no stage runs, no artifact writes,
 * no file writes. One predicate so every panel agrees.
 */
export function isProjectWritable(project: ResearchProject | null): boolean {
  if (project === null) {
    return false;
  }
  return !isProjectArchived(project);
}

/**
 * "进行中" means **not archived**, not `status === 'active'`.
 *
 * `researchProjectStatusSchema` has four values (active / paused / completed /
 * archived); a paused or completed project is still work the user is looking at,
 * so it belongs in 进行中. Treating it as `active` would hide real projects.
 */
export function matchesStatusFilter(project: ResearchProject, filter: ProjectStatusFilter): boolean {
  if (filter === 'all') {
    return true;
  }
  if (filter === 'archived') {
    return isProjectArchived(project);
  }
  return !isProjectArchived(project);
}

export function matchesQuery(project: ResearchProject, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return true;
  }
  return (
    project.title.toLowerCase().includes(needle) ||
    project.description.toLowerCase().includes(needle) ||
    (project.workspacePath?.toLowerCase().includes(needle) ?? false)
  );
}

/**
 * Pinned projects first, then most recently updated.
 *
 * Pinning is a local preference (`roc.ui.project.starred`) and is labelled as
 * "本机置顶" in the UI. It reorders; it never filters, so it cannot hide a project
 * that the status filter would otherwise show.
 */
export function sortProjects(projects: readonly ResearchProject[], pinnedIds: readonly string[]): ResearchProject[] {
  const pinned = new Set(pinnedIds);
  return [...projects].sort((left, right) => {
    const leftPinned = pinned.has(left.id) ? 0 : 1;
    const rightPinned = pinned.has(right.id) ? 0 : 1;
    if (leftPinned !== rightPinned) {
      return leftPinned - rightPinned;
    }
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

export function visibleProjects(
  projects: readonly ResearchProject[],
  options: { query: string; filter: ProjectStatusFilter; pinnedIds: readonly string[] }
): ResearchProject[] {
  const filtered = projects.filter(
    (project) => matchesStatusFilter(project, options.filter) && matchesQuery(project, options.query)
  );
  return sortProjects(filtered, options.pinnedIds);
}

/** Language is fixed at creation in the UI even though `update` accepts it. */
export function isLanguageLocked(): boolean {
  return true;
}

export function projectStatusLabel(status: ResearchProject['status']): string {
  if (status === 'active') {
    return '进行中';
  }
  if (status === 'paused') {
    return '已暂停';
  }
  if (status === 'completed') {
    return '已完成';
  }
  return '已归档';
}

/**
 * Chinese stage names, matching CONTEXT.md's product vocabulary. P6 reuses this
 * for the stage bar so the two never drift.
 */
export const STAGE_LABELS: Record<ResearchProject['currentStage'], string> = {
  discovery: '发现',
  retrieval: '检索',
  reading: '阅读',
  ideation: '构思',
  planning: '方案',
  experiment: '实验/数据',
  figure: '绘图',
  writing: '写作',
  review: '审稿',
  revision: '修订',
  export: '导出'
};

export function projectStageLabel(stage: ResearchProject['currentStage']): string {
  return STAGE_LABELS[stage];
}
