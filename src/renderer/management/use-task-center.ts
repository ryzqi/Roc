import {useCallback, useEffect, useMemo} from 'react';
import type {BackgroundTask} from '../../shared/types';
import type {ResearchTask} from '../../shared/schemas/research-tasks';
import type {PaperAcquisitionJob} from '../../shared/schemas/literature-acquisition';
import {useAsyncResource, type AsyncStatus} from '../app/use-async-resource';
import type {RocClient} from '../shared/roc-client';
import {useVisiblePolling} from '../shared/view-activity';
import {listBackgroundTasks} from '../tasks/task-store';
import {taskStatusLabels} from '../tasks/task-model';

export type TaskCenterGroup = 'current' | 'pending' | 'completed' | 'failed';
export type TaskCenterSourceId = 'research' | 'background' | 'literature';
export type TaskCenterRow = {
  key: string; id: string; source: TaskCenterSourceId; title: string; status: string;
  group: TaskCenterGroup; updatedAt: string; pendingApproval: boolean;
  libraryItemId: string | null;
};
export type TaskCenterSource = {
  id: TaskCenterSourceId; label: string; status: AsyncStatus; error: string | null;
  loaded: number; hasMore: boolean; total: number | null; reload: () => void;
};
export type TaskCenter = {
  rows: TaskCenterRow[]; sources: TaskCenterSource[];
  counts: Record<TaskCenterGroup, number>; pendingApprovalCount: number;
  partial: boolean; loading: boolean; label: string; summary: string; reload: () => void;
};

export const TASK_CENTER_GROUPS: ReadonlyArray<{id: TaskCenterGroup; label: string}> = [
  {id: 'current', label: '当前任务'}, {id: 'pending', label: '待处理'},
  {id: 'completed', label: '最近结束'}, {id: 'failed', label: '失败'}
];
export const TASK_CENTER_SOURCE_LABELS: Record<TaskCenterSourceId, string> = {
  research: '科研任务', background: '后台任务', literature: '文献处理'
};
const researchGroups: Record<ResearchTask['status'], TaskCenterGroup> = {
  active: 'current', paused: 'pending', waiting_approval: 'pending', interrupted: 'pending',
  completed: 'completed', cancelled: 'completed', failed: 'failed'
};
const researchLabels: Record<ResearchTask['status'], string> = {
  active: '进行中', paused: '已暂停', waiting_approval: '等待审批', interrupted: '运行中断',
  completed: '已完成', cancelled: '已取消', failed: '失败'
};
const backgroundGroups: Record<BackgroundTask['status'], TaskCenterGroup> = {
  draft: 'pending', pending_confirmation: 'pending', running: 'current', paused: 'pending',
  waiting_user: 'pending', waiting_next_turn: 'pending', failed: 'failed',
  cancelled: 'completed', completed: 'completed', archived: 'completed'
};
const literatureGroups: Record<PaperAcquisitionJob['status'], TaskCenterGroup> = {
  queued: 'current', running: 'current', ready: 'completed', blocked: 'pending',
  failed: 'failed', unavailable: 'pending', cancelled: 'completed'
};
const literatureLabels: Record<PaperAcquisitionJob['status'], string> = {
  queued: '排队中', running: '处理中', ready: '已就绪', blocked: '受阻',
  failed: '失败', unavailable: '暂无可获取 PDF', cancelled: '已取消'
};
const literatureStages: Record<PaperAcquisitionJob['stage'], string> = {
  resolve: '查找 PDF', download: '下载 PDF', import: '登记文档', parse: '解析全文', index: '全文索引', wiki: '生成知识页'
};

/** Read-only projection: source identifiers and actions stay with their existing owners. */
export function taskCenterRows(research: readonly ResearchTask[], background: readonly BackgroundTask[],
  literature: readonly PaperAcquisitionJob[]): TaskCenterRow[] {
  return [
    ...research.map(task => ({key: `research:${task.id}`, id: task.id, source: 'research' as const, title: task.goal,
      status: researchLabels[task.status], group: researchGroups[task.status], updatedAt: task.updatedAt,
      pendingApproval: task.status === 'waiting_approval', libraryItemId: null})),
    ...background.map(task => ({key: `background:${task.id}`, id: task.id, source: 'background' as const, title: task.goal,
      status: taskStatusLabels[task.status], group: backgroundGroups[task.status], updatedAt: task.updatedAt,
      pendingApproval: task.status === 'pending_confirmation', libraryItemId: null})),
    ...literature.map(job => ({key: `literature:${job.id}`, id: job.id, source: 'literature' as const, title: job.title,
      status: `${literatureStages[job.stage]} / ${literatureLabels[job.status]}`, group: literatureGroups[job.status],
      updatedAt: job.updatedAt, pendingApproval: false, libraryItemId: job.libraryItemId}))
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/** One shell-owned snapshot, shared by the title bar and management drawer. */
export function useTaskCenter(client: RocClient, projectId: string | null, workspacePath: string | null): TaskCenter {
  const research = useAsyncResource(projectId === null ? null : `task-center:research:${projectId}`,
    () => client.api.research.listTasks({projectId: projectId!, afterTaskId: null, limit: 100}), {label: '读取科研任务'});
  const literature = useAsyncResource(projectId === null ? null : `task-center:literature:${projectId}`,
    () => client.api.research.listAcquisition({projectId, destination: 'current_project', offset: 0, limit: 50}), {label: '读取文献处理任务'});
  const background = useAsyncResource(projectId !== null && workspacePath === null ? null : `task-center:background:${workspacePath ?? 'all'}`,
    () => listBackgroundTasks(client), {label: '读取后台任务'});
  const reloadResearch = research.reload, reloadLiterature = literature.reload, reloadBackground = background.reload;
  const reload = useCallback(() => {reloadResearch(); reloadLiterature(); reloadBackground();},
    [reloadResearch, reloadLiterature, reloadBackground]);
  useEffect(() => client.api.research.onTaskUpdated(event => {
    if (event.projectId === projectId) reloadResearch();
  }), [client, projectId, reloadResearch]);
  useEffect(() => client.api.research.onLibraryChanged(event => {
    if (projectId !== null && event.affectedProjectIds.includes(projectId)) reloadLiterature();
  }), [client, projectId, reloadLiterature]);
  useEffect(() => client.api.tasks.onUpdated(reloadBackground), [client, reloadBackground]);
  // Acquisition has no dedicated task event; poll only while an observed job is active.
  const acquisitionActive = literature.data?.jobs.some(job => job.status === 'queued' || job.status === 'running') ?? false;
  useVisiblePolling(reloadLiterature, 4_000, acquisitionActive && literature.status !== 'error');

  return useMemo(() => {
    const backgroundTasks = (background.data ?? []).filter(task => workspacePath === null ? projectId === null : task.workspacePath === workspacePath);
    const researchTasks = (research.data?.tasks ?? []).filter(task => task.projectId === projectId);
    const literatureJobs = (literature.data?.jobs ?? []).filter(job => job.projectId === projectId);
    const rows = taskCenterRows(researchTasks, backgroundTasks, literatureJobs);
    const sources: TaskCenterSource[] = [
      {id: 'background', label: workspacePath !== null ? '后台任务（当前工作区）' : projectId === null ? '后台任务（全局）' : '后台任务（未绑定工作区）', status: background.status,
        error: background.error, loaded: backgroundTasks.length, hasMore: false, total: background.data === null ? null : backgroundTasks.length, reload: reloadBackground},
      ...(projectId === null ? [] : [
        {id: 'research' as const, label: '科研任务（当前项目）', status: research.status, error: research.error,
          loaded: researchTasks.length, hasMore: research.data?.hasMore ?? false, total: null, reload: reloadResearch},
        {id: 'literature' as const, label: '文献处理（当前项目）', status: literature.status, error: literature.error,
          loaded: literatureJobs.length, hasMore: literature.data?.nextOffset != null, total: literature.data?.total ?? null, reload: reloadLiterature}
      ])
    ];
    const counts: Record<TaskCenterGroup, number> = {current: 0, pending: 0, completed: 0, failed: 0};
    for (const row of rows) counts[row.group]++;
    const pendingApprovalCount = rows.filter(row => row.pendingApproval).length;
    const partial = sources.some(source => source.hasMore || source.status !== 'ready');
    const loading = sources.some(source => source.status === 'loading');
    const unavailable = sources.some(source => source.status === 'error');
    const prefix = partial ? '近期 ' : '';
    const label = loading && rows.length === 0 ? '任务加载中' : unavailable ? '任务未更新' :
      counts.current > 0 || pendingApprovalCount > 0 ? `${prefix}执行 ${counts.current} / 待批准 ${pendingApprovalCount}` :
        counts.failed > 0 ? `${prefix}失败 ${counts.failed}` : '任务中心';
    const summary = `${partial ? '已加载任务' : '任务'}：进行中 ${counts.current} 项，待处理 ${counts.pending} 项，待确认 ${pendingApprovalCount} 项，失败 ${counts.failed} 项` +
      (unavailable ? '；部分来源暂不可用' : sources.some(source => source.hasMore) ? '；更多任务见对应来源' : '');
    return {rows, sources, counts, pendingApprovalCount, partial, loading, label, summary, reload};
  }, [research, literature, background, projectId, workspacePath, reload, reloadResearch, reloadLiterature, reloadBackground]);
}
