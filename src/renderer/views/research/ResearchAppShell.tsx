import { CircleAlert, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { LoadedState } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { persistResearchShellMode } from '../../app/view-routing';
import { createResearchContext } from './research-context';
import { createResearchWorkbench, createResearchWorkbenchAdapter, type ResearchWorkbench } from './research-workbench';
import { researchProjectStatusLabels, researchStageLabels } from './research-workflow';

export function ResearchAppShell({
  client,
  onFallbackLegacy,
  state
}: {
  client: RocClient;
  onFallbackLegacy: () => void;
  state: LoadedState;
}): React.JSX.Element {
  const workbenchRef = useRef<{ client: RocClient; workbench: ResearchWorkbench } | null>(null);
  if (workbenchRef.current === null || workbenchRef.current.client !== client) {
    workbenchRef.current = { client, workbench: createResearchWorkbench(createResearchWorkbenchAdapter(client)) };
  }
  const workbench = workbenchRef.current.workbench;
  const [snapshot, setSnapshot] = useState(workbench.getSnapshot());
  const [modelsReady, setModelsReady] = useState<boolean | null>(null);
  const [modelsDownloading, setModelsDownloading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [language, setLanguage] = useState<'zh' | 'en'>('zh');

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

  return (
    <section className="canvas-stage research-page research-app-shell" data-shell-state={shellState} data-testid="research-app-shell">
      <header className="research-shell-banner">
        <div>
          <div className="eyebrow">RESEARCH SHELL</div>
          <h1>科研主工作台</h1>
          <p>项目是一级上下文。当前为迁移壳层，旧科研页面仍可回退。</p>
        </div>
        <button className="action-button" data-testid="research-shell-fallback" type="button" onClick={fallbackLegacy}>
          返回旧页面
        </button>
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
        <div className="research-shell-layout" data-testid="research-shell-project">
          <aside className="research-projects" aria-label="最近项目">
            <div className="research-section-label">项目</div>
            {snapshot.projects.map((project) => (
              <button
                className={project.id === context.projectId ? 'research-project-row research-project-row--active' : 'research-project-row'}
                key={project.id}
                type="button"
                onClick={() => void workbench.selectProject(project.id)}
              >
                <span className="research-project-row-title">{project.title}</span>
                <span className="research-project-row-meta">
                  {researchStageLabels[project.currentStage]} · {researchProjectStatusLabels[project.status]}
                </span>
              </button>
            ))}
          </aside>
          <main className="research-shell-canvas">
            <dl className="research-shell-context">
              <div>
                <dt>当前项目</dt>
                <dd data-testid="research-shell-project-title">{context.project.title}</dd>
              </div>
              <div>
                <dt>当前阶段</dt>
                <dd data-testid="research-shell-stage">{context.currentStage === null ? '未开始' : researchStageLabels[context.currentStage]}</dd>
              </div>
              <div>
                <dt>人工闸门</dt>
                <dd data-testid="research-shell-gates">{context.pendingGates.length}</dd>
              </div>
              <div>
                <dt>活动运行</dt>
                <dd data-testid="research-shell-runs">{context.activeRuns.length}</dd>
              </div>
              <div>
                <dt>索引</dt>
                <dd data-testid="research-shell-index">{context.serviceHealth.indexPhase ?? '未知'}</dd>
              </div>
              <div>
                <dt>产物</dt>
                <dd data-testid="research-shell-artifacts">{context.artifactSummary.total}</dd>
              </div>
            </dl>
          </main>
        </div>
      ) : null}
    </section>
  );
}
