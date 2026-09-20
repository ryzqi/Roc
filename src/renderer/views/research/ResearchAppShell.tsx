import { CircleAlert, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { LoadedState } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { unwrap } from '../../loaded-state';
import { persistResearchShellMode } from '../../app/view-routing';
import { buildResearchTopMeta, createResearchContext } from './research-context';
import { createResearchSession, type ResearchSession } from './research-session';
import { researchProjectStatusLabels, researchStageLabels } from './research-workflow';
import type { ResearchEvidence, ResearchProvenance } from '../../../shared/types';
import { ResearchActivityView } from './ResearchActivityView';
import { ResearchOverviewView } from './ResearchOverviewView';
import { ResearchProvenanceView } from './ResearchProvenanceView';
import { ResearchStageWorkspace } from './ResearchStageWorkspace';
import {
  RESEARCH_STAGE_GROUPS,
  isCurrentStageGroup,
  stageGroupForStage,
  type ResearchStageGroupId,
  type ResearchStageTab
} from './research-stage-groups';

export function ResearchAppShell({
  client,
  onFallbackLegacy,
  onContextChange,
  onOpenAssistant,
  state
}: {
  client: RocClient;
  onFallbackLegacy: () => void;
  onContextChange?: (meta: string) => void;
  onOpenAssistant?: () => void;
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
  const [projectQuery, setProjectQuery] = useState('');
  const [activityOpen, setActivityOpen] = useState(false);
  const [canvasView, setCanvasView] = useState<'overview' | 'activity' | 'provenance' | 'stage'>('overview');
  const [stageGroup, setStageGroup] = useState<ResearchStageGroupId>('discover');
  const [stageTab, setStageTab] = useState<ResearchStageTab>('library');
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [provenance, setProvenance] = useState<ResearchProvenance[]>([]);
  const [evidence, setEvidence] = useState<ResearchEvidence[]>([]);
  const [provenanceError, setProvenanceError] = useState<string | null>(null);

  useEffect(() => workbench.subscribe(setSnapshot), [workbench]);
  useEffect(() => {
    void workbench.load();
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
  const shellState = snapshot.loading ? 'loading' : context.projectId === null ? 'empty' : 'project';
  const visibleProjects = snapshot.projects.filter((project) => {
    const query = projectQuery.trim().toLowerCase();
    if (query.length === 0) {
      return true;
    }
    return project.title.toLowerCase().includes(query) || project.description.toLowerCase().includes(query);
  });
  useEffect(() => {
    onContextChange?.(buildResearchTopMeta(context));
  }, [context, onContextChange]);

  useEffect(() => {
    session.bindProject(context.projectId);
    if (context.projectId !== null) {
      void session.knowledge.loadEvidence();
    }
  }, [context.projectId, session]);

  useEffect(() => {
    const nextGroup = stageGroupForStage(snapshot.project?.currentStage ?? null);
    const group = RESEARCH_STAGE_GROUPS.find((item) => item.id === nextGroup);
    setCanvasView('overview');
    setActivityOpen(false);
    setSelectedEventId(null);
    setSelectedArtifactId(null);
    setProvenance([]);
    setEvidence([]);
    setProvenanceError(null);
    setStageGroup(nextGroup);
    setStageTab(group?.tabs[0]?.id ?? 'library');
  }, [context.projectId]);

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

  async function createProject(): Promise<void> {
    await workbench.createProject({
      title,
      description,
      workspacePath: state.workspace?.path ?? null,
      language
    });
    if (workbench.getSnapshot().error === null) {
      setTitle('');
      setDescription('');
    }
  }

  function fallbackLegacy(): void {
    persistResearchShellMode('legacy');
    onFallbackLegacy();
  }

  function openEvent(eventId: string): void {
    setSelectedEventId(eventId);
    const payload = snapshot.events.find((item) => item.id === eventId)?.payload ?? {};
    const artifactId = payload.artifactId;
    if (typeof artifactId === 'string') {
      setSelectedArtifactId(artifactId);
      setCanvasView('provenance');
      return;
    }
    setCanvasView('activity');
  }

  function openStageGroup(groupId: ResearchStageGroupId): void {
    const group = RESEARCH_STAGE_GROUPS.find((item) => item.id === groupId);
    const nextTab = group?.tabs[0]?.id ?? 'library';
    setStageGroup(groupId);
    setStageTab(nextTab);
    setCanvasView('stage');
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
      <header className="research-shell-banner">
        <div>
          <div className="eyebrow">RESEARCH SHELL</div>
          <h1>科研主工作台</h1>
          <p>项目是一级上下文。当前为迁移壳层，旧科研页面仍可回退。</p>
        </div>
        <div className="research-shell-banner-actions">
          {onOpenAssistant === undefined ? null : (
            <button className="action-button" data-testid="research-shell-assistant" type="button" onClick={onOpenAssistant}>
              研究助手
            </button>
          )}
          {shellState === 'project' ? (
            <button className="action-button" data-testid="research-shell-activity-toggle" type="button" onClick={() => setActivityOpen((open) => !open)}>
              {activityOpen ? '关闭活动' : '活动与运行'}
            </button>
          ) : null}
          {shellState === 'project' ? (
            <button className="action-button" data-testid="research-shell-overview" type="button" onClick={() => setCanvasView('overview')}>项目总览</button>
          ) : null}
          {shellState === 'project' ? (
            <button className="action-button" data-testid="research-shell-provenance" type="button" onClick={() => setCanvasView('provenance')}>溯源</button>
          ) : null}
          {shellState === 'project' ? (
            <button className="action-button" data-testid="research-shell-settings" type="button" onClick={() => openStageGroup('settings')}>项目设置</button>
          ) : null}
          <button className="action-button" data-testid="research-shell-fallback" type="button" onClick={fallbackLegacy}>
            返回旧页面
          </button>
        </div>
      </header>

      {snapshot.error === null ? null : (
        <div className="research-alert" role="alert">
          <CircleAlert aria-hidden="true" size={16} />
          <span>{snapshot.error}</span>
        </div>
      )}

      {shellState === 'loading' ? <div className="research-loading">正在读取科研项目…</div> : null}

      {shellState === 'empty' ? (
        <div className="research-empty" data-testid="research-shell-empty">
          <div className="research-empty-mark">∑</div>
          <h2>创建或导入研究项目</h2>
          <p>没有研究项目时进入空态。创建后会进入项目壳层，而不是通用对话页。</p>
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
              <input data-testid="research-shell-title" onChange={(event) => setTitle(event.target.value)} value={title} />
            </label>
            <label>
              研究目标
              <textarea data-testid="research-shell-description" onChange={(event) => setDescription(event.target.value)} rows={3} value={description} />
            </label>
            <label>
              项目语言
              <select data-testid="research-shell-language" onChange={(event) => setLanguage(event.target.value === 'en' ? 'en' : 'zh')} value={language}>
                <option value="zh">中文</option>
                <option value="en">English</option>
              </select>
            </label>
            <button className="action-button action-button--primary" type="submit">
              <Plus aria-hidden="true" size={16} />
              创建研究项目
            </button>
          </form>
        </div>
      ) : null}

      {shellState === 'project' && context.project !== null ? (
        <div className={activityOpen ? 'research-shell-layout research-shell-layout--activity' : 'research-shell-layout'} data-testid="research-shell-project">
          <aside className="research-projects" aria-label="最近项目">
            <div className="research-section-label">项目</div>
            <label className="research-shell-search">
              搜索项目
              <input data-testid="research-shell-project-search" onChange={(event) => setProjectQuery(event.target.value)} value={projectQuery} />
            </label>
            {visibleProjects.map((project) => (
              <button
                className={project.id === context.projectId ? 'research-project-row research-project-row--active' : 'research-project-row'}
                key={project.id}
                data-testid={`research-shell-project-${project.id}`}
                type="button"
                onClick={() => void workbench.selectProject(project.id)}
              >
                <span className="research-project-row-title">{project.title}</span>
                <span className="research-project-row-meta">
                  {researchStageLabels[project.currentStage]} · {researchProjectStatusLabels[project.status]}
                </span>
              </button>
            ))}
            {visibleProjects.length === 0 ? <div className="research-shell-search-empty">没有匹配的项目</div> : null}
          </aside>
          <main className="research-shell-canvas">
            {context.workflow === null ? null : (
              <nav aria-label="研究阶段" className="research-shell-stages" data-testid="research-shell-stages">
                {RESEARCH_STAGE_GROUPS.filter((group) => group.id !== 'settings').map((group) => {
                  const current = isCurrentStageGroup(group.id, context.currentStage);
                  const selected = stageGroup === group.id && canvasView === 'stage';
                  return (
                    <button
                      aria-current={selected ? 'page' : undefined}
                      className={selected || (current && canvasView !== 'stage') ? 'research-shell-stage research-shell-stage--current' : 'research-shell-stage'}
                      data-testid={`research-stage-group-${group.id}`}
                      key={group.id}
                      type="button"
                      onClick={() => openStageGroup(group.id)}
                    >
                      <strong>{group.label}</strong>
                      <em>{current ? '当前' : '查看'}</em>
                    </button>
                  );
                })}
              </nav>
            )}
            {context.workflow === null ? null : canvasView === 'overview' ? (
              <ResearchOverviewView
                artifacts={snapshot.artifacts}
                context={context}
                events={snapshot.events}
                onApprove={() => void workbench.transition('approve')}
                onControlIndex={(action) => void workbench.controlIndex(action)}
                onOpenActivity={() => {
                  setCanvasView('activity');
                  setActivityOpen(true);
                }}
                onOpenProvenance={(artifactId) => {
                  setSelectedArtifactId(artifactId);
                  setCanvasView('provenance');
                }}
                onOpenStage={() => openStageGroup(stageGroupForStage(context.currentStage))}
                onRetryRun={() => void workbench.retryRun()}
                onTransition={(action) => void workbench.transition(action)}
                onDownloadModels={() => void downloadModels()}
                project={context.project}
                runs={snapshot.runs}
                workflow={context.workflow}
                working={snapshot.working}
              />
            ) : canvasView === 'activity' ? (
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
                onBackToOverview={() => setCanvasView('overview')}
                provenance={provenance}
                runs={snapshot.runs}
                selectedArtifactId={selectedArtifactId}
              />
            ) : (
              <ResearchStageWorkspace
                groupId={stageGroup}
                onTabChange={setStageTab}
                session={session}
                state={state}
                tab={stageTab}
              />
            )}
            {canvasView === 'provenance' && provenanceError !== null ? (
              <div className="research-alert" role="alert" data-testid="research-provenance-error">{provenanceError}</div>
            ) : null}
            {state.workspace?.path === undefined ? null : (
              <p className="research-shell-workspace" data-testid="research-shell-workspace">计算目录：{state.workspace.path}</p>
            )}
          </main>
          {activityOpen ? (
            <aside aria-label="活动与运行" className="research-shell-activity" data-testid="research-shell-activity">
              <div className="research-section-label">最近活动</div>
              {snapshot.events[0] === undefined ? <p>暂无活动。</p> : (
                <button className="research-overview-event" type="button" onClick={() => openEvent(snapshot.events[0]!.id)}>
                  {snapshot.events[0].message}
                </button>
              )}
              <button className="action-button" data-testid="research-shell-open-activity" type="button" onClick={() => setCanvasView('activity')}>
                打开活动详情
              </button>
            </aside>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
