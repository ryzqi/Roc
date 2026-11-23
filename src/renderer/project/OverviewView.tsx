import {useEffect, useId, useRef, useState} from 'react';
import {ArrowRight, BookOpen, FileText, FlaskConical, Image, ListTodo, Search, Upload, type LucideIcon} from 'lucide-react';
import type {ResearchArtifact} from '../../shared/types';
import {useWorkspaceScope} from '../app/workspace-scope';
import {useAsyncResource} from '../app/use-async-resource';
import {useLiterature} from '../literature/literature-scope';
import {libraryItemTitle} from '../literature/format';
import {researchTaskReasonLabel, researchTaskStatusLabels} from '../research/tasks/TaskSummary';
import {EmptyState} from '../shell/EmptyState';
import {ErrorBar} from '../shell/ErrorBar';
import {ActionButton, formSecondaryButtonClass} from '../shared/form-ui';
import {PageHeader, PageListRow, PageSection} from '../shared/page-ui';
import {useTaskDiagnostics} from '../research/tasks/use-task-diagnostics';
import {formatBeijingDateTime} from '../shared/format';
import {useViewActive} from '../shared/view-activity';
import {projectStageLabel, projectStatusLabel} from './project-store';
import {FirstSteps} from './FirstSteps';
import './project-workspace.css';

const artifactKinds: Record<ResearchArtifact['kind'], {label: string; icon: LucideIcon}> = {
  search_strategy: {label: '检索策略', icon: Search}, source_corpus: {label: '文献集合', icon: BookOpen},
  reading_notes: {label: '阅读笔记', icon: BookOpen}, idea_canvas: {label: '研究构想', icon: FileText},
  research_plan: {label: '研究计划', icon: ListTodo}, experiment_run: {label: '实验记录', icon: FlaskConical},
  figure: {label: '图稿', icon: Image}, manuscript: {label: '文稿', icon: FileText},
  review_report: {label: '审稿报告', icon: FileText}, revision_plan: {label: '修订计划', icon: ListTodo},
  export_package: {label: '导出成果', icon: FileText}
};

function Goal({text}: {text: string}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  if (text.trim() === '') return null;
  const long = text.length > 180 || text.split('\n').length > 3;
  return <div className="grid min-w-0 gap-1">
    <p id={id} data-testid="overview-goal" className={long && !expanded ? 'overview-goal' : undefined}>{text}</p>
    {long ? <button type="button" className={`${formSecondaryButtonClass} justify-self-start`}
      aria-expanded={expanded} aria-controls={id} data-testid="overview-goal-toggle" onClick={() => setExpanded(value => !value)}>
      {expanded ? '收起研究目标' : '展开研究目标'}</button> : null}
  </div>;
}

export function OverviewView(): React.JSX.Element {
  const {projectId} = useWorkspaceScope();
  return projectId === null ? <EmptyState icon={BookOpen} title="选择研究项目" testId="overview-no-project"/> :
    <ProjectOverview key={projectId} projectId={projectId}/>;
}

function ProjectOverview({projectId}: {projectId: string}): React.JSX.Element {
  const scope = useWorkspaceScope();
  const literature = useLiterature();
  const active = useViewActive();
  const project = useAsyncResource(`overview-project:${projectId}`,
    () => scope.client.api.research.getProject({id: projectId}), {label: '读取项目目标'});
  const tasks = useAsyncResource(`overview-tasks:${projectId}`,
    () => scope.client.api.research.listTasks({projectId, afterTaskId: null, limit: 25}), {label: '读取项目任务'});
  const artifacts = useAsyncResource(`overview-artifacts:${projectId}`,
    () => scope.client.api.research.listArtifacts({projectId}), {label: '读取项目成果'});
  const reloadTasks = tasks.reload;
  const reloadArtifacts = artifacts.reload;
  const reloadProject = project.reload;
  const wasActive = useRef(active);
  useEffect(() => {
    if (!active) return;
    return scope.client.api.research.onTaskUpdated(event => {
      if (event.projectId !== projectId) return;
      reloadTasks();
      reloadArtifacts();
    });
  }, [active, scope.client, projectId, reloadTasks, reloadArtifacts]);
  useEffect(() => {
    const resumed = active && !wasActive.current;
    wasActive.current = active;
    if (!resumed) return;
    reloadProject();
    reloadTasks();
    reloadArtifacts();
  }, [active, reloadProject, reloadTasks, reloadArtifacts]);

  const recentTasks = [...(tasks.data?.tasks ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const currentTask = recentTasks.find(task => task.status === 'active') ??
    recentTasks.find(task => task.status === 'waiting_approval') ??
    recentTasks.find(task => ['paused', 'interrupted', 'failed'].includes(task.status));
  const diagnostics = useTaskDiagnostics(scope.client, active && currentTask !== undefined ? {projectId, taskId: currentTask.id} : null,
    currentTask?.updatedAt ?? '');
  const taskFacts = diagnostics.data;
  const continuation = diagnostics.status === 'ready' && taskFacts !== null && ['paused', 'interrupted', 'failed', 'cancelled'].includes(taskFacts.task.status) &&
    taskFacts.continuationRunId !== null && !taskFacts.canRestoreApproval && taskFacts.task.statusReason !== 'research_task_cleanup_failed';
  const actionLabel = currentTask?.status === 'active' ? '查看运行' : currentTask?.status === 'waiting_approval' ? '处理审批' :
    currentTask !== undefined ? continuation ? '继续研究' : '查看任务' : tasks.error !== null ? '查看任务' : '开始研究';
  const primaryAction = (): void => {
    if (currentTask !== undefined || tasks.error !== null) scope.openTasks(currentTask?.id);
    else scope.openAssistant();
  };
  const pendingTasks = recentTasks.filter(task =>
    task.status === 'waiting_approval' || task.status === 'interrupted' || task.status === 'failed' || task.status === 'paused');
  const latestExecution = taskFacts?.executions.filter(execution => execution.endedAt !== null && ['completed', 'complete'].includes(execution.status))
    .sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''))[0];
  const recentItems = [...literature.items].filter(item => !item.archived)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3);
  const recentArtifacts = [...(artifacts.data ?? [])].filter(artifact => artifact.status !== 'superseded')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3);
  const openLiterature = (id: string): void => {
    scope.openLiterature({kind: 'reader', libraryItemId: id});
  };
  const addLiterature = (): void => {
    scope.openView('library', literature.requestImport);
  };

  return <div data-testid="overview" className="overview ui-scroll-region h-full">
    <div className="overview-content">
      <PageHeader title={scope.projectTitle ?? '项目工作台'}
        description={<Goal text={project.data?.description ?? ''}/>}
        status={project.data === null ? undefined : <span className="text-[length:var(--font-meta-size)] text-muted">{projectStatusLabel(project.data.status)}</span>}
        action={<ActionButton variant="primary" data-testid="overview-primary-action" loading={tasks.data === null && tasks.error === null}
          loadingLabel="正在读取任务" disabled={!scope.writable && currentTask === undefined && tasks.error === null}
          title={currentTask === undefined ? '打开助手后输入研究目标' : '打开任务详情，核对后继续操作'} onClick={primaryAction}>{actionLabel}</ActionButton>}/>
      {project.error === null ? null : <ErrorBar error={{level: 'page', message: project.error, retry: project.reload}}/>}
      {scope.workspaceError === null ? null : <ErrorBar error={{level: 'blocked', message: scope.workspaceError, retry: scope.rebindWorkspace}}/>}

      {scope.firstStepsVisible ? <FirstSteps writable={scope.writable} requestId={scope.firstStepsRequestId} onDismiss={scope.dismissFirstSteps}
        onDiscover={() => scope.openView('discover')} onImport={addLiterature}
        onRead={() => scope.openLiterature({kind: 'reader', libraryItemId: literature.selectedId})}
        onWrite={() => scope.openView('writing')}/> : null}

      <PageSection title="当前研究" action={<ActionButton variant="compact" onClick={() => scope.openTasks()}>全部任务</ActionButton>}>
        {tasks.error !== null ? <ErrorBar error={{level: 'page', message: tasks.error, retry: tasks.reload}}/> : null}
        {tasks.data === null ? tasks.error === null ? <EmptyState compact tone="loading" title="正在读取任务" testId="overview-tasks-loading"/> : null :
          currentTask === undefined ? <EmptyState compact title={tasks.data.hasMore ? '近期任务中没有进行中的研究' : '暂无进行中的研究'} testId="overview-tasks-empty"/> :
            <PageListRow title={currentTask.goal} leading={<ListTodo size={16}/>} trailing={<ArrowRight size={16} aria-hidden="true"/>}
              data-testid="overview-current-task" onClick={() => scope.openTasks(currentTask.id)} description={<>
                <span className="flex flex-wrap gap-x-3 gap-y-1"><span>{researchTaskStatusLabels[currentTask.status]}</span>
                  {project.data === null ? null : <span>项目阶段：{projectStageLabel(project.data.currentStage)}</span>}
                  <time dateTime={currentTask.updatedAt} className="tabular-nums">更新于 {formatBeijingDateTime(currentTask.updatedAt)}</time></span>
                {latestExecution === undefined ? null : <span className="mt-1 block">最近完成：{latestExecution.stage === null ? '任务执行' : projectStageLabel(latestExecution.stage)}</span>}
              </>}/>}
        {diagnostics.error === null ? null : <ErrorBar error={{level:'page', message:diagnostics.error, retry:diagnostics.reload}}/>}
        {tasks.data?.hasMore ? <p className="text-[length:var(--font-meta-size)] text-muted" data-testid="overview-task-scope">仅显示近期 {recentTasks.length} 项任务，完整记录见全部任务。</p> : null}
      </PageSection>

      <div className="overview-priorities">
        <PageSection title="待我处理" action={pendingTasks.length > 3 || tasks.data?.hasMore ?
          <ActionButton variant="compact" onClick={() => scope.openTasks()}>查看全部待办</ActionButton> : undefined}>
          {tasks.data === null ? <EmptyState compact title={tasks.error === null ? '正在读取待办' : '待办尚未读取'} tone={tasks.error === null ? 'loading' : 'empty'}/> :
            pendingTasks.length === 0 ? <EmptyState compact title={tasks.data.hasMore ? '近期任务中没有待办' : '暂无待办'}/> :
            <ul className="grid gap-1" data-testid="overview-pending">{pendingTasks.slice(0, 3).map(task => <li key={task.id}>
              <PageListRow title={task.goal} onClick={() => scope.openTasks(task.id)} trailing={<ArrowRight size={16} aria-hidden="true"/>}
                description={<><span>{researchTaskStatusLabels[task.status]}</span>{researchTaskReasonLabel(task.statusReason) === null ? null :
                  <span className="mt-1 block" data-testid={`overview-task-reason-${task.id}`}>{researchTaskReasonLabel(task.statusReason)}</span>}</>}/>
            </li>)}</ul>}
        </PageSection>
        <PageSection title="近期成果">
          {artifacts.error !== null ? <ErrorBar error={{level: 'page', message: artifacts.error, retry: artifacts.reload}}/> :
            artifacts.data === null ? <EmptyState compact tone="loading" title="正在读取成果"/> :
              recentArtifacts.length === 0 ? <EmptyState compact title="尚无研究成果"/> :
                <ul className="grid gap-1" data-testid="overview-artifacts">{recentArtifacts.map(artifact => {
                  const kind = artifactKinds[artifact.kind];
                  const Icon = kind.icon;
                  return <li key={artifact.id}><PageListRow title={artifact.title} leading={<Icon size={16}/>}
                    description={<span className="flex flex-wrap gap-x-3 gap-y-1"><span>{kind.label}</span>
                      <time dateTime={artifact.updatedAt} className="tabular-nums">{formatBeijingDateTime(artifact.updatedAt)}</time></span>}
                    onClick={() => scope.openArtifact({projectId, artifactId: artifact.id, expectedVersion: null}, () => undefined)}/></li>;
                })}</ul>}
        </PageSection>
      </div>

      <PageSection title={literature.query.trim() === '' ? '近期文献' : '当前筛选文献'}
        action={scope.firstStepsVisible ? undefined : <ActionButton variant="compact" onClick={() => scope.openView('library')}>打开文献库</ActionButton>}>
        {literature.error !== null ? <ErrorBar error={{level:'page', message:literature.error, retry:literature.reload}}/> :
          literature.status === 'loading' && recentItems.length === 0 ? <EmptyState compact tone="loading" title="正在读取文献"/> :
            recentItems.length === 0 ? <EmptyState compact title={literature.query.trim() === '' ? '尚未添加文献' : '当前筛选没有文献'}/> :
              <ul className="grid gap-1" data-testid="overview-literature">{recentItems.map(item => <li key={item.id}>
                <PageListRow title={libraryItemTitle(item)} leading={<BookOpen size={16}/>} onClick={() => openLiterature(item.id)}
                  description={item.metadata.publishedYear === null ? undefined : <span className="tabular-nums">{item.metadata.publishedYear} 年</span>}/>
              </li>)}</ul>}
      </PageSection>
      <nav aria-label="研究操作" className="overview-shortcuts" data-testid="overview-shortcuts">
        {scope.firstStepsVisible ? null : <>
          <button type="button" className={formSecondaryButtonClass} onClick={() => scope.openView('discover')}><Search size={16} aria-hidden="true"/>检索论文</button>
          <button type="button" className={formSecondaryButtonClass} disabled={!scope.writable} onClick={addLiterature}><Upload size={16} aria-hidden="true"/>导入 PDF</button>
          <button type="button" className={formSecondaryButtonClass} onClick={() => scope.openView('writing')}><FileText size={16} aria-hidden="true"/>打开写作</button>
        </>}
        <button type="button" className={formSecondaryButtonClass} onClick={() => scope.openView('knowledge')}><BookOpen size={16} aria-hidden="true"/>问我的资料</button>
      </nav>

    </div>
  </div>;
}
