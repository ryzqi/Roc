import {useEffect, useRef} from 'react';
import {ArrowRight, BookOpen, Bot, FileText, ListTodo, Search, Upload} from 'lucide-react';
import {useWorkspaceScope} from '../app/workspace-scope';
import {useAsyncResource} from '../app/use-async-resource';
import {useLiterature} from '../literature/literature-scope';
import {libraryItemTitle} from '../literature/format';
import {researchTaskStatusLabels} from '../research/tasks/TaskSummary';
import {EmptyState} from '../shell/EmptyState';
import {ErrorBar} from '../shell/ErrorBar';
import {formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';
import {formatBeijingDateTime} from '../shared/format';
import {useViewActive} from '../shared/view-activity';
import {projectStatusLabel} from './project-store';
import {FirstSteps} from './FirstSteps';

const rowClass = 'flex min-h-12 w-full min-w-0 items-center gap-3 rounded-control px-3 py-3 text-left hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus-ring';
const sectionClass = 'grid min-w-0 gap-3 border-t-[0.5px] border-line pt-4';

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

  const recentTasks = tasks.data?.tasks ?? [];
  const currentTask = recentTasks.find(task => task.status === 'active');
  const pendingTasks = recentTasks.filter(task =>
    task.status === 'waiting_approval' || task.status === 'interrupted' || task.status === 'failed' || task.status === 'paused');
  const nextTask = pendingTasks[0] ?? currentTask;
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

  return <div data-testid="overview" className="ui-scroll-region h-full">
    <div className="mx-auto grid w-full max-w-[var(--content-readable-max)] gap-6 p-[var(--spacing-page)]">
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-4">
        <div className="grid min-w-0 flex-1 gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="break-words text-balance text-[length:var(--font-h2-size)] font-semibold">{scope.projectTitle ?? '项目工作台'}</h1>
            {project.data === null ? null : <span className="rounded-chip bg-[var(--overlay-hover)] px-2 py-1 text-[length:var(--font-meta-size)] text-muted">
              {projectStatusLabel(project.data.status)}
            </span>}
          </div>
          {project.data === null ? null : <p data-testid="overview-goal" className="whitespace-pre-wrap break-words leading-normal text-muted">{project.data.description}</p>}
        </div>
        <button type="button" className={formPrimaryButtonClass} data-testid="overview-primary"
          onClick={() => nextTask === undefined ? scope.openAssistant() : scope.openTasks(nextTask.id)}>
          {nextTask === undefined ? <Bot size={16} aria-hidden="true"/> : <ListTodo size={16} aria-hidden="true"/>}
          {nextTask === undefined ? '打开助手' : '查看任务'}
        </button>
      </header>
      {project.error === null ? null : <ErrorBar error={{level: 'page', message: project.error, retry: project.reload}}/>}
      {scope.workspaceError === null ? null : <ErrorBar error={{level: 'blocked', message: scope.workspaceError, retry: scope.rebindWorkspace}}/>}
      {!scope.writable ? <p role="note" className="text-muted">项目已归档，现有文献与成果仍可查看。</p> : null}

      {scope.firstStepsVisible ? <FirstSteps writable={scope.writable} requestId={scope.firstStepsRequestId} onDismiss={scope.dismissFirstSteps}
        onDiscover={() => scope.openView('discover')} onImport={addLiterature}
        onRead={() => scope.openLiterature({kind: 'reader', libraryItemId: literature.selectedId})}
        onAsk={scope.openAssistant} onWrite={() => scope.openView('writing')}/> : null}

      <nav aria-label="研究操作" className="flex flex-wrap gap-2" data-testid="overview-shortcuts">
        <button type="button" className={formSecondaryButtonClass} onClick={() => scope.openView('discover')}><Search size={16} aria-hidden="true"/>检索论文</button>
        <button type="button" className={formSecondaryButtonClass} disabled={!scope.writable} onClick={addLiterature}><Upload size={16} aria-hidden="true"/>导入 PDF</button>
        <button type="button" className={formSecondaryButtonClass} onClick={() => scope.openView('knowledge')}><BookOpen size={16} aria-hidden="true"/>问我的资料</button>
        <button type="button" className={formSecondaryButtonClass} onClick={() => scope.openView('writing')}><FileText size={16} aria-hidden="true"/>打开写作</button>
      </nav>

      <section className={sectionClass} aria-labelledby="overview-task-heading">
        <header className="flex items-center justify-between gap-3">
          <h2 id="overview-task-heading" className="font-medium">近期任务</h2>
          <button type="button" className={formSecondaryButtonClass} onClick={() => scope.openTasks()}>全部任务</button>
        </header>
        {tasks.error !== null ? <ErrorBar error={{level: 'page', message: tasks.error, retry: tasks.reload}}/> :
          tasks.data === null ? <EmptyState compact tone="loading" title="正在读取任务" testId="overview-tasks-loading"/> :
            currentTask === undefined ? <p className="text-muted" data-testid="overview-tasks-empty">暂无执行中的任务</p> :
              <button type="button" className={rowClass} data-testid="overview-current-task" onClick={() => scope.openTasks(currentTask.id)}>
                <ListTodo size={16} aria-hidden="true" className="shrink-0 text-muted"/>
                <span className="min-w-0 flex-1 break-words">{currentTask.goal}</span>
                <span className="shrink-0 text-[length:var(--font-meta-size)] text-muted">{researchTaskStatusLabels[currentTask.status]}</span>
                <ArrowRight size={16} aria-hidden="true" className="shrink-0 text-muted"/>
              </button>}
      </section>

      {pendingTasks.length === 0 ? null : <section className={sectionClass} aria-labelledby="overview-pending-heading">
        <h2 id="overview-pending-heading" className="font-medium">待处理</h2>
        <ul className="grid gap-1" data-testid="overview-pending">
          {pendingTasks.slice(0, 3).map(task => <li key={task.id}>
            <button type="button" className={rowClass} onClick={() => scope.openTasks(task.id)}>
              <span className="min-w-0 flex-1 break-words">{task.goal}</span>
              <span className="shrink-0 text-[length:var(--font-meta-size)] text-muted">{researchTaskStatusLabels[task.status]}</span>
              <ArrowRight size={16} aria-hidden="true" className="shrink-0 text-muted"/>
            </button>
          </li>)}
        </ul>
      </section>}

      <section className={sectionClass} aria-labelledby="overview-results-heading">
        <h2 id="overview-results-heading" className="font-medium">近期成果</h2>
        {artifacts.error !== null ? <ErrorBar error={{level: 'page', message: artifacts.error, retry: artifacts.reload}}/> :
          artifacts.data === null ? <EmptyState compact tone="loading" title="正在读取成果"/> :
            recentArtifacts.length === 0 ? <p className="text-muted">尚无研究成果</p> :
              <ul className="grid gap-1" data-testid="overview-artifacts">{recentArtifacts.map(artifact => <li key={artifact.id}>
                <button type="button" className={rowClass} onClick={() => scope.openArtifact(
                  {projectId, artifactId: artifact.id, expectedVersion: null}, () => undefined)}>
                  <FileText size={16} aria-hidden="true" className="shrink-0 text-muted"/>
                  <span className="min-w-0 flex-1 break-words">{artifact.title}</span>
                  <time dateTime={artifact.updatedAt} className="text-[length:var(--font-meta-size)] tabular-nums text-muted">{formatBeijingDateTime(artifact.updatedAt)}</time>
                </button>
              </li>)}</ul>}
      </section>

      <section className={sectionClass} aria-labelledby="overview-library-heading">
        <header className="flex items-center justify-between gap-3">
          <h2 id="overview-library-heading" className="font-medium">{literature.query.trim() === '' ? '近期文献' : '当前筛选文献'}</h2>
          <button type="button" className={formSecondaryButtonClass} onClick={() => scope.openView('library')}>打开文献库</button>
        </header>
        {literature.error !== null ? <ErrorBar error={{level: 'page', message: literature.error, retry: literature.reload}}/> :
          literature.status === 'loading' && recentItems.length === 0 ? <EmptyState compact tone="loading" title="正在读取文献"/> :
            recentItems.length === 0 ? <p className="text-muted">
              {literature.query.trim() === '' ? '尚未添加文献' : '当前筛选没有文献'}</p> : <ul className="grid gap-1" data-testid="overview-literature">
              {recentItems.map(item => <li key={item.id}>
                <button type="button" className={rowClass} onClick={() => openLiterature(item.id)}>
                  <BookOpen size={16} aria-hidden="true" className="shrink-0 text-muted"/>
                  <span className="min-w-0 flex-1 break-words">{libraryItemTitle(item)}</span>
                  {item.metadata.publishedYear === null ? null : <span className="shrink-0 text-[length:var(--font-meta-size)] tabular-nums text-muted">{item.metadata.publishedYear} 年</span>}
                </button>
              </li>)}
            </ul>}
      </section>

    </div>
  </div>;
}
