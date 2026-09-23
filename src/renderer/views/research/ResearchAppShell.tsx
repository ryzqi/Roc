import { CircleAlert, FolderSearch, Plus, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';

import type { LoadedState } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { unwrap } from '../../loaded-state';
import { buildResearchTopMeta, createResearchContext } from './research-context';
import { createResearchSession, type ResearchSession } from './research-session';
import { formatResearchTime, researchProjectStatusLabels, researchStageLabels } from './research-workflow';
import type { ResearchEvidence, ResearchProject, ResearchProvenance } from '../../../shared/types';
import { EmptyState } from '../../components/EmptyState';
import { Button, ConfirmDialog, Drawer, Select, TextArea, TextInput } from '../../components/ui';
import { useResearchLayout } from './research-layout';
import { ResearchOverviewView } from './ResearchOverviewView';
import { ResearchServicesPanel } from './ResearchServicesPanel';
import {
  buildResearchServices,
  createResearchServiceContext,
  type ResearchServiceContext,
  type ResearchServiceEntry
} from './research-services';
import {
  RESEARCH_STAGE_GROUPS,
  isCurrentStageGroup,
  stageGroupForStage,
  type ResearchStageGroupId,
  type ResearchStageTab
} from './research-stage-groups';
import {
  readResearchRoute,
  researchRouteFromState,
  sameResearchRoute,
  writeResearchRoute,
  type ResearchCanvasView
} from './research-route';

const ResearchActivityView = lazy(() => import('./ResearchActivityView').then((module) => ({ default: module.ResearchActivityView })));
const ResearchProvenanceView = lazy(() => import('./ResearchProvenanceView').then((module) => ({ default: module.ResearchProvenanceView })));
const ResearchStageWorkspace = lazy(() => import('./ResearchStageWorkspace').then((module) => ({ default: module.ResearchStageWorkspace })));
import type { ResearchStageWorkspaceHandle } from './ResearchStageWorkspace';

export function ResearchAppShell({
  client,
  onContextChange,
  onOpenAssistant,
  onOpenService,
  onServiceContextChange,
  state
}: {
  client: RocClient;
  onContextChange?: (meta: string) => void;
  onOpenAssistant?: () => void;
  onOpenService?: (service: ResearchServiceEntry) => void;
  onServiceContextChange?: (context: ResearchServiceContext | null) => void;
  state: LoadedState;
}): React.JSX.Element {
  const sessionRef = useRef<{ client: RocClient; session: ResearchSession } | null>(null);
  if (sessionRef.current === null || sessionRef.current.client !== client) {
    sessionRef.current = { client, session: createResearchSession(client) };
  }
  const session = sessionRef.current.session;
  const workbench = session.workbench;
  const [snapshot, setSnapshot] = useState(workbench.getSnapshot());
  const [modelsReady, setModelsReady] = useState<boolean | null>(null);
  const [modelsDownloading, setModelsDownloading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [language, setLanguage] = useState<'zh' | 'en'>('zh');
  const [workspacePath, setWorkspacePath] = useState('');
  const [projectQuery, setProjectQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'active' | 'all' | 'archived'>('active');
  const [activityOpen, setActivityOpen] = useState(false);
  const initialRoute = readResearchRoute();
  const [canvasView, setCanvasView] = useState<ResearchCanvasView>(initialRoute.view);
  const [stageGroup, setStageGroup] = useState<ResearchStageGroupId>(initialRoute.stageGroup);
  const [stageTab, setStageTab] = useState<ResearchStageTab>(initialRoute.stageTab);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [provenance, setProvenance] = useState<ResearchProvenance[]>([]);
  const [evidence, setEvidence] = useState<ResearchEvidence[]>([]);
  const [provenanceError, setProvenanceError] = useState<string | null>(null);
  const skipProjectResetRef = useRef(false);
  const routeWriteModeRef = useRef<'replace' | 'push'>('replace');
  const previousProjectIdRef = useRef<string | null>(null);
  const initialProjectIdRef = useRef(initialRoute.projectId);
  const { compact, narrow } = useResearchLayout();
  const [servicesOpen, setServicesOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const projectSearchRef = useRef<HTMLInputElement>(null);
  const stageWorkspaceRef = useRef<ResearchStageWorkspaceHandle>(null);
  const projectTypeaheadRef = useRef({ prefix: '', at: 0 });

  useEffect(() => workbench.subscribe(setSnapshot), [workbench]);
  useEffect(() => {
    function onNewProject(): void {
      setCreating(true);
    }
    window.addEventListener('research-new-project', onNewProject);
    return () => window.removeEventListener('research-new-project', onNewProject);
  }, []);
  useEffect(() => {
    void workbench.load(initialProjectIdRef.current);
  }, [workbench]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await client.api.research.getModelsStatus();
      if (cancelled) {
        return;
      }
      if (!result.ok) {
        setModelsReady(false);
        setModelsError(result.error.message);
        return;
      }
      setModelsReady(result.data.ready);
      setModelsDownloading(result.data.downloading);
      setModelsError(result.data.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const context = useMemo(
    () => createResearchContext(snapshot, { modelsReady, modelsDownloading, modelsError }),
    [modelsDownloading, modelsError, modelsReady, snapshot]
  );
  const shellState = snapshot.loading ? 'loading' : context.projectId === null ? 'list' : 'project';
  const visibleProjects = [...snapshot.projects]
    .filter((project) => {
      if (statusFilter === 'active') {
        return project.status !== 'archived';
      }
      if (statusFilter === 'archived') {
        return project.status === 'archived';
      }
      return true;
    })
    .filter((project) => {
      const query = projectQuery.trim().toLowerCase();
      if (query.length === 0) {
        return true;
      }
      return project.title.toLowerCase().includes(query) || project.description.toLowerCase().includes(query);
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const serviceContext = useMemo(
    () => createResearchServiceContext(context, state.workspace?.path ?? null),
    [context, state.workspace?.path]
  );
  const services = useMemo(() => buildResearchServices(state, serviceContext), [serviceContext, state]);
  const shellServices = useMemo(
    () => services.filter((service) => service.id !== 'assistant' && service.id !== 'tasks'),
    [services]
  );
  useEffect(() => {
    onContextChange?.(buildResearchTopMeta(context));
  }, [context, onContextChange]);

  useEffect(() => {
    onServiceContextChange?.(serviceContext.projectId === null ? null : serviceContext);
  }, [onServiceContextChange, serviceContext]);

  useEffect(() => {
    session.bindProject(context.projectId);
    if (context.projectId !== null) {
      void session.knowledge.loadEvidence();
    }
  }, [context.projectId, session]);

  useEffect(() => {
    const previousProjectId = previousProjectIdRef.current;
    previousProjectIdRef.current = context.projectId;
    if (skipProjectResetRef.current) {
      skipProjectResetRef.current = false;
      return;
    }
    if (previousProjectId === null || context.projectId === null || previousProjectId === context.projectId) {
      return;
    }
    const nextGroup = stageGroupForStage(snapshot.project?.currentStage ?? null);
    const group = RESEARCH_STAGE_GROUPS.find((item) => item.id === nextGroup);
    setCanvasView('overview');
    setStageGroup(nextGroup);
    setStageTab(group?.tabs[0]?.id ?? 'library');
    setActivityOpen(false);
    setSelectedEventId(null);
    setSelectedArtifactId(null);
    setProvenance([]);
    setEvidence([]);
    setProvenanceError(null);
  }, [context.projectId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('.canvas:not(.canvas--chat) .canvas-scroll')?.scrollTo(0, 0);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [canvasView]);

  useEffect(() => {
    const route = researchRouteFromState({
      projectId: context.projectId,
      view: canvasView,
      stageGroup,
      stageTab
    });
    if (sameResearchRoute(route, readResearchRoute())) {
      return;
    }
    if (snapshot.loading && context.projectId === null && initialProjectIdRef.current !== null) {
      return;
    }
    writeResearchRoute(route, routeWriteModeRef.current);
    routeWriteModeRef.current = 'push';
  }, [canvasView, context.projectId, snapshot.loading, stageGroup, stageTab]);

  useEffect(() => {
    function onPopState(): void {
      const route = readResearchRoute();
      routeWriteModeRef.current = 'replace';
      setCanvasView(route.view);
      setStageGroup(route.stageGroup);
      setStageTab(route.stageTab);
      setActivityOpen(route.view === 'activity');
      if (route.projectId !== context.projectId) {
        skipProjectResetRef.current = true;
      }
      if (route.projectId === null) {
        workbench.clearProject();
        return;
      }
      if (route.projectId !== context.projectId) {
        void workbench.selectProject(route.projectId);
      }
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [context.projectId, workbench]);

  useEffect(() => {
    const projectId = context.projectId;
    if (projectId === null || canvasView !== 'provenance') {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [nextProvenance, nextEvidence] = await Promise.all([
          unwrap('溯源', await client.api.research.listProvenance({ projectId })),
          unwrap('证据', await client.api.research.listEvidence({ projectId }))
        ]);
        if (cancelled) {
          return;
        }
        setProvenance(nextProvenance);
        setEvidence(nextEvidence);
        setProvenanceError(null);
      } catch {
        if (!cancelled) {
          setProvenance([]);
          setEvidence([]);
          setProvenanceError('溯源记录加载失败。');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canvasView, client, context.projectId]);

  useEffect(() => {
    if (!compact) {
      setServicesOpen(false);
    }
  }, [compact]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented) {
        return;
      }
      const target = event.target;
      const inField = target instanceof HTMLElement && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      );
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'n' && shellState === 'list') {
        event.preventDefault();
        setCreating(true);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f' && shellState === 'list') {
        event.preventDefault();
        projectSearchRef.current?.focus();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key === '[' && shellState === 'project') {
        event.preventDefault();
        returnToList();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return;
      }
      if (inField && event.key !== 'Escape') {
        return;
      }
      if (event.key === 'Escape') {
        if (servicesOpen) {
          event.preventDefault();
          setServicesOpen(false);
          return;
        }
        if (activityOpen) {
          event.preventDefault();
          setActivityOpen(false);
          return;
        }
        if (snapshot.error !== null) {
          event.preventDefault();
          workbench.clearError();
          return;
        }
        if (provenanceError !== null) {
          event.preventDefault();
          setProvenanceError(null);
          return;
        }
        if (stageWorkspaceRef.current !== null) {
          event.preventDefault();
          stageWorkspaceRef.current.clearSurfaceError();
        }
        return;
      }
      if (shellState !== 'project') {
        return;
      }
      if (event.key === '1') {
        event.preventDefault();
        applyRoute({ view: 'overview' });
      }
      if (event.key === '2') {
        event.preventDefault();
        applyRoute({ view: 'activity' });
      }
      if (event.key === '3') {
        event.preventDefault();
        applyRoute({ view: 'provenance' });
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activityOpen, provenanceError, servicesOpen, shellState, snapshot.error, workbench]);

  function applyRoute(route: {
    view?: ResearchCanvasView;
    stageGroup?: ResearchStageGroupId;
    stageTab?: ResearchStageTab;
  }): void {
    routeWriteModeRef.current = 'push';
    if (route.view !== undefined) {
      setCanvasView(route.view);
    }
    if (route.stageGroup !== undefined) {
      setStageGroup(route.stageGroup);
    }
    if (route.stageTab !== undefined) {
      setStageTab(route.stageTab);
    }
  }

  function selectListedProject(projectId: string): void {
    routeWriteModeRef.current = 'push';
    skipProjectResetRef.current = false;
    setCreating(false);
    void workbench.selectProject(projectId);
  }

  function returnToList(): void {
    routeWriteModeRef.current = 'push';
    skipProjectResetRef.current = true;
    setCreating(false);
    setActivityOpen(false);
    setServicesOpen(false);
    setCanvasView('overview');
    workbench.clearProject();
  }

  function renderProjectCard(project: ResearchProject): React.JSX.Element {
    const goal = project.description.trim();
    return (
      <button
        className="research-project-card"
        data-testid={`research-shell-project-${project.id}`}
        key={project.id}
        type="button"
        onClick={() => selectListedProject(project.id)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
            return;
          }
          const cards = [...document.querySelectorAll<HTMLButtonElement>('.research-project-card')];
          const index = cards.indexOf(event.currentTarget);
          if (index < 0 || cards.length === 0) {
            return;
          }
          const grid = event.currentTarget.parentElement;
          const columns = grid === null ? 1 : Math.max(1, Math.round(grid.clientWidth / Math.max(event.currentTarget.offsetWidth, 1)));
          const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowDown' ? columns : -columns;
          const next = cards[index + delta];
          if (next === undefined) {
            return;
          }
          event.preventDefault();
          next.focus();
        }}
      >
        <span className="research-project-card-title">{project.title}</span>
        {goal.length === 0 ? null : <span className="research-project-card-goal">{goal}</span>}
        <span className="research-project-card-meta">
          {researchStageLabels[project.currentStage]} · {researchProjectStatusLabels[project.status]} · {formatResearchTime(project.updatedAt)}
        </span>
      </button>
    );
  }

  async function chooseWorkspace(): Promise<string | null> {
    const selected = await client.api.workspace.selectFromDialog();
    if (!selected.ok) {
      workbench.fail(selected.error.message);
      return null;
    }
    if (selected.data === null) {
      return null;
    }
    setWorkspacePath(selected.data.path);
    return selected.data.path;
  }

  async function bindWorkspace(): Promise<void> {
    const path = await chooseWorkspace();
    if (path === null) {
      return;
    }
    await workbench.bindWorkspace(path);
  }

  async function deleteCurrentProject(): Promise<void> {
    const project = workbench.getSnapshot().project;
    if (project === null) {
      return;
    }
    await workbench.deleteProject(project.id);
    setDeleteConfirmOpen(false);
  }

  async function createProject(): Promise<void> {
    await workbench.createProject({
      title,
      description,
      workspacePath,
      language
    });
    if (workbench.getSnapshot().error === null) {
      setTitle('');
      setDescription('');
      setWorkspacePath('');
      setCreating(false);
    }
  }

  function openEvent(eventId: string): void {
    setSelectedEventId(eventId);
    const payload = snapshot.events.find((item) => item.id === eventId)?.payload ?? {};
    const artifactId = payload.artifactId;
    if (typeof artifactId === 'string') {
      setSelectedArtifactId(artifactId);
      applyRoute({ view: 'provenance' });
      return;
    }
    applyRoute({ view: 'activity' });
  }

  function openStageGroup(groupId: ResearchStageGroupId): void {
    const group = RESEARCH_STAGE_GROUPS.find((item) => item.id === groupId);
    const nextTab = group?.tabs[0]?.id ?? 'library';
    applyRoute({ view: 'stage', stageGroup: groupId, stageTab: nextTab });
  }

  async function downloadModels(): Promise<void> {
    setModelsDownloading(true);
    setModelsError(null);
    const result = await client.api.research.downloadModels();
    if (!result.ok) {
      setModelsReady(false);
      setModelsDownloading(false);
      setModelsError(result.error.message);
      return;
    }
    setModelsReady(result.data.ready);
    setModelsDownloading(result.data.downloading);
    setModelsError(result.data.error);
  }

  return (
    <section className="canvas-stage research-page research-app-shell" data-shell-state={shellState} data-testid="research-app-shell">
      <header className="page-strip research-shell-banner">
        {shellState === 'project' && context.project !== null ? (
          <>
            <div className="research-shell-banner-tools">
              <div className="page-flags research-shell-banner-actions" role="toolbar" aria-label="科研工具">
                {onOpenAssistant === undefined ? null : (
                  <button className="research-toolbar-button" data-testid="research-shell-assistant" title="打开研究助手" type="button" onClick={onOpenAssistant}>
                    研究助手
                  </button>
                )}
                {onOpenService !== undefined ? (
                  <button
                    aria-expanded={servicesOpen}
                    className="research-toolbar-button"
                    data-testid="research-shell-services-toggle"
                    title="打开科研服务"
                    type="button"
                    onClick={() => setServicesOpen(true)}
                  >
                    科研服务
                  </button>
                ) : null}
                <button
                  aria-pressed={activityOpen}
                  className={activityOpen ? 'research-toolbar-button research-toolbar-button--selected' : 'research-toolbar-button'}
                  data-testid="research-shell-activity-toggle"
                  title="显示最近活动"
                  type="button"
                  onClick={() => setActivityOpen((open) => !open)}
                >
                  活动与运行
                </button>
                <button
                  aria-pressed={canvasView === 'overview'}
                  className={canvasView === 'overview' ? 'research-toolbar-button research-toolbar-button--selected' : 'research-toolbar-button'}
                  data-testid="research-shell-overview"
                  type="button"
                  onClick={() => applyRoute({ view: 'overview' })}
                >
                  项目总览
                </button>
                <button
                  aria-pressed={canvasView === 'provenance'}
                  className={canvasView === 'provenance' ? 'research-toolbar-button research-toolbar-button--selected' : 'research-toolbar-button'}
                  data-testid="research-shell-provenance"
                  title="溯源（3）"
                  type="button"
                  onClick={() => applyRoute({ view: 'provenance' })}
                >
                  溯源
                </button>
                <button
                  aria-pressed={canvasView === 'stage' && stageGroup === 'settings'}
                  className={canvasView === 'stage' && stageGroup === 'settings' ? 'research-toolbar-button research-toolbar-button--selected' : 'research-toolbar-button'}
                  data-testid="research-shell-settings"
                  type="button"
                  onClick={() => openStageGroup('settings')}
                >
                  项目设置
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="page-copy">
              <h1 className="page-title">研究项目</h1>
            </div>
            <div className="page-flags research-shell-banner-actions">
              <Button data-testid="research-shell-new-project" icon={<Plus aria-hidden="true" size={16} />} variant={creating ? 'secondary' : 'primary'} onClick={() => setCreating(true)}>
                新建研究项目
              </Button>
            </div>
          </>
        )}
      </header>

      {snapshot.error === null ? null : (
        <div className="research-alert" role="alert">
          <CircleAlert aria-hidden="true" size={16} />
          <span>{snapshot.error}</span>
          <Button aria-label="关闭错误" size="compact" variant="ghost" onClick={() => workbench.clearError()}>
            <X aria-hidden="true" size={15} />
          </Button>
        </div>
      )}

      {shellState === 'loading' ? <div className="research-loading" role="status">正在读取科研项目…</div> : null}

      {shellState === 'list' ? (
        <div className="research-project-list" data-testid="research-shell-list">
          {snapshot.projects.length > 0 ? (
            <div className="research-project-list-toolbar">
              <label className="research-shell-search">
                搜索项目
                <TextInput data-testid="research-shell-project-search" onChange={(event) => setProjectQuery(event.target.value)} ref={projectSearchRef} value={projectQuery} />
              </label>
              <label className="research-shell-search">
                状态
                <Select
                  data-testid="research-shell-status-filter"
                  onChange={(event) => {
                    const value = event.target.value;
                    setStatusFilter(value === 'all' || value === 'archived' ? value : 'active');
                  }}
                  value={statusFilter}
                >
                  <option value="active">进行中</option>
                  <option value="archived">已归档</option>
                  <option value="all">全部</option>
                </Select>
              </label>
            </div>
          ) : null}
          {creating ? (
            <form
              className="research-shell-create"
              data-testid="research-shell-create"
              onSubmit={(event) => {
                event.preventDefault();
                void createProject();
              }}
            >
              <label>
                项目标题
                <TextInput data-testid="research-shell-title" onChange={(event) => setTitle(event.target.value)} value={title} />
              </label>
              <label>
                研究目标
                <TextArea data-testid="research-shell-description" onChange={(event) => setDescription(event.target.value)} rows={3} value={description} />
              </label>
              <label>
                项目语言
                <Select data-testid="research-shell-language" onChange={(event) => setLanguage(event.target.value === 'en' ? 'en' : 'zh')} value={language}>
                  <option value="zh">中文</option>
                  <option value="en">英文</option>
                </Select>
              </label>
              <label>
                工作目录
                <TextInput data-testid="research-shell-workspace-path" readOnly value={workspacePath} />
              </label>
              <Button data-testid="research-shell-choose-workspace" variant="secondary" onClick={() => void chooseWorkspace()}>
                选择目录
              </Button>
              <div className="research-form-actions">
                <Button variant="secondary" onClick={() => setCreating(false)}>取消</Button>
                <Button icon={<Plus aria-hidden="true" size={16} />} type="submit" variant="primary">
                  创建研究项目
                </Button>
              </div>
            </form>
          ) : null}
          {snapshot.projects.length === 0 && !creating ? (
            <EmptyState
              action={(
                <Button data-testid="research-shell-empty-create" icon={<Plus aria-hidden="true" size={16} />} variant="primary" onClick={() => setCreating(true)}>
                  新建研究项目
                </Button>
              )}
              className="research-empty"
              detail="新建研究项目后才会进入该项目的科研工作台。"
              icon={FolderSearch}
              testId="research-shell-empty"
              title="还没有研究项目"
            />
          ) : (
            <div className="research-project-grid" data-testid="research-shell-project-grid">
              {visibleProjects.map(renderProjectCard)}
            </div>
          )}
          {snapshot.projects.length > 0 && visibleProjects.length === 0 ? (
            <EmptyState
              action={(
                <button
                  className="ui-button ui-button--secondary"
                  data-testid="research-shell-clear-search"
                  type="button"
                  onClick={() => {
                    setProjectQuery('');
                    setStatusFilter('active');
                    projectSearchRef.current?.focus();
                  }}
                >
                  清空搜索
                </button>
              )}
              className="research-shell-search-empty"
              detail="换个关键词，或把状态改成全部。"
              icon={FolderSearch}
              testId="research-shell-search-empty"
              title="没有匹配的项目"
            />
          ) : null}
        </div>
      ) : null}

      {shellState === 'project' && context.project !== null ? (
        <>
        {context.workflow === null ? null : (
          <nav aria-label="研究阶段" className="research-shell-stages" data-testid="research-shell-stages">
            {RESEARCH_STAGE_GROUPS.filter((group) => group.id !== 'settings').map((group) => {
              const current = isCurrentStageGroup(group.id, context.currentStage);
              const selected = stageGroup === group.id && canvasView === 'stage';
              return (
                <button
                  aria-current={current ? 'step' : undefined}
                  aria-pressed={selected}
                  className={[
                    'research-shell-stage',
                    selected ? 'research-shell-stage--selected' : '',
                    current ? 'research-shell-stage--current' : ''
                  ].filter((value) => value.length > 0).join(' ')}
                  data-testid={`research-stage-group-${group.id}`}
                  key={group.id}
                  type="button"
                  onClick={() => openStageGroup(group.id)}
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') {
                      return;
                    }
                    const buttons = [...event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('.research-shell-stage') ?? []];
                    const index = buttons.indexOf(event.currentTarget);
                    const next = buttons[index + (event.key === 'ArrowRight' ? 1 : -1)];
                    if (next === undefined) {
                      return;
                    }
                    event.preventDefault();
                    next.focus();
                  }}
                >
                  <strong>{group.label}</strong>
                  {current || selected ? <em>{current ? '当前阶段' : '正在查看'}</em> : null}
                </button>
              );
            })}
          </nav>
        )}
        <div
          className={[
            'research-shell-layout',
            activityOpen ? 'research-shell-layout--activity' : '',
            compact ? 'research-shell-layout--compact' : '',
            narrow ? 'research-shell-layout--narrow' : ''
          ].filter((value) => value.length > 0).join(' ')}
          data-testid="research-shell-project"
        >
          <main className="research-shell-canvas">
            {context.workflow === null ? null : canvasView === 'overview' ? (
              <ResearchOverviewView
                artifacts={snapshot.artifacts}
                context={context}
                events={snapshot.events}
                onOpenActivity={() => applyRoute({ view: 'activity' })}
                onOpenArtifacts={() => applyRoute({ view: 'provenance' })}
                onOpenIndex={() => applyRoute({ view: 'stage', stageGroup: 'discover', stageTab: 'knowledge' })}
                onOpenProvenance={(artifactId) => {
                  setSelectedArtifactId(artifactId);
                  applyRoute({ view: 'provenance' });
                }}
                onOpenRuns={() => applyRoute({ view: 'activity' })}
                onBindWorkspace={() => void bindWorkspace()}
                onOpenStage={() => openStageGroup(stageGroupForStage(context.currentStage))}
                onDownloadModels={() => void downloadModels()}
                project={context.project}
                workflow={context.workflow}
              />
            ) : (
              <Suspense fallback={<div className="view-loading" role="status">正在加载视图…</div>}>
                {canvasView === 'activity' ? (
                  <ResearchActivityView
                    events={snapshot.events}
                    onSelectEvent={openEvent}
                    runs={snapshot.runs}
                    selectedEventId={selectedEventId}
                  />
                ) : canvasView === 'provenance' ? (
                  <ResearchProvenanceView
                    artifacts={snapshot.artifacts}
                    evidence={evidence}
                    onSelectArtifact={setSelectedArtifactId}
                    onBackToOverview={() => applyRoute({ view: 'overview' })}
                    provenance={provenance}
                    runs={snapshot.runs}
                    selectedArtifactId={selectedArtifactId}
                  />
                ) : (
                  <ResearchStageWorkspace
                    ref={stageWorkspaceRef}
                    groupId={stageGroup}
                    onTabChange={(tab) => applyRoute({ view: 'stage', stageTab: tab })}
                    session={session}
                    state={state}
                    tab={stageTab}
                  />
                )}
              </Suspense>
            )}
            {canvasView === 'provenance' && provenanceError !== null ? (
              <div className="research-alert" role="alert" data-testid="research-provenance-error">
                <span>{provenanceError} 返回总览后可重试。</span>
                <button aria-label="关闭错误" className="research-toolbar-button" type="button" onClick={() => setProvenanceError(null)}>
                  <X aria-hidden="true" size={15} />
                </button>
              </div>
            ) : null}
            {canvasView === 'stage' && stageGroup === 'settings' ? (
              <section className="research-danger-zone" data-testid="research-project-danger-zone">
                <h2>危险操作</h2>
                <p>删除后无法恢复该研究项目及其工作台状态。</p>
                <Button data-testid="research-shell-delete-project" variant="danger" onClick={() => setDeleteConfirmOpen(true)}>删除项目</Button>
              </section>
            ) : null}
          </main>
          {activityOpen ? (
            <aside aria-label="活动与运行" className="research-shell-activity" data-testid="research-shell-activity">
              <div className="research-section-label">最近活动</div>
              {snapshot.events.length === 0 ? <p className="research-empty-inline" role="status">暂无活动。</p> : snapshot.events.slice(0, 6).map((entry) => (
                <button
                  className={entry.id === selectedEventId ? 'research-overview-event research-overview-event--active' : 'research-overview-event'}
                  key={entry.id}
                  type="button"
                  onClick={() => openEvent(entry.id)}
                >
                  <span>{researchStageLabels[entry.stage]}</span>
                  <strong>{entry.message}</strong>
                  <time>{formatResearchTime(entry.createdAt)}</time>
                </button>
              ))}
              <button className="research-toolbar-button" data-testid="research-shell-open-activity" type="button" onClick={() => applyRoute({ view: 'activity' })}>
                打开活动详情
              </button>
            </aside>
          ) : null}
        </div>
        </>
      ) : null}
      <Drawer onClose={() => setServicesOpen(false)} open={servicesOpen} title="科研服务">
        {onOpenService === undefined || !servicesOpen ? null : (
          <ResearchServicesPanel
            onOpenService={(service) => {
              setServicesOpen(false);
              onOpenService(service);
            }}
            services={shellServices}
          />
        )}
      </Drawer>
      <ConfirmDialog
        confirmLabel="删除项目"
        description="删除后无法恢复该研究项目及其工作台状态。"
        onCancel={() => setDeleteConfirmOpen(false)}
        onConfirm={() => void deleteCurrentProject()}
        open={deleteConfirmOpen}
        title="删除研究项目"
      />
    </section>
  );
}
