import { Check, ChevronRight, CircleAlert, Pause, Play, Plus, RotateCcw, Send, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type {
  ResearchProject,
  ResearchWorkflowSnapshot,
  ResearchWorkflowTransitionRequest
} from '../../../shared/types';
import { unwrap } from '../../loaded-state';
import type { LoadedState } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';

const stageLabels: Record<ResearchWorkflowSnapshot['currentStage'], string> = {
  discovery: '发现',
  retrieval: '检索',
  reading: '阅读',
  ideation: '构思',
  planning: '方案',
  experiment: '实验 / 数据',
  figure: '绘图',
  writing: '写作',
  review: '审稿',
  revision: '修订',
  export: '导出'
};

const stageStatusLabels: Record<ResearchWorkflowSnapshot['stages'][number]['status'], string> = {
  locked: '未开放',
  ready: '待开始',
  running: '进行中',
  waiting_approval: '待审核',
  paused: '已暂停',
  blocked: '已阻塞',
  completed: '已完成',
  failed: '失败'
};

export function ResearchView({ client, state }: { client: RocClient; state: LoadedState }): React.JSX.Element {
  const [projects, setProjects] = useState<ResearchProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<ResearchWorkflowSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    client.api.research
      .listProjects()
      .then((result) => {
        const nextProjects = unwrap('科研项目', result);
        if (cancelled) return;
        setProjects(nextProjects);
        setSelectedProjectId((current) => current ?? nextProjects[0]?.id ?? null);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : '科研项目加载失败。');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    if (selectedProjectId === null) {
      setWorkflow(null);
      return;
    }
    let cancelled = false;
    client.api.research
      .getWorkflow({ id: selectedProjectId })
      .then((result) => {
        if (!cancelled) setWorkflow(unwrap('科研流程', result));
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : '科研流程加载失败。');
      });
    return () => {
      cancelled = true;
    };
  }, [client, selectedProjectId]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );

  async function createProject(): Promise<void> {
    if (title.trim().length === 0 || description.trim().length === 0) {
      setError('项目标题和研究目标不能为空。');
      return;
    }
    setWorking(true);
    try {
      const result = await client.api.research.createProject({
        title: title.trim(),
        description: description.trim(),
        workspacePath: state.workspace?.path ?? null
      });
      const project = unwrap('创建科研项目', result);
      setProjects((current) => [project, ...current]);
      setSelectedProjectId(project.id);
      setTitle('');
      setDescription('');
      setCreateOpen(false);
      setError(null);
    } catch (createError: unknown) {
      setError(createError instanceof Error ? createError.message : '科研项目创建失败。');
    } finally {
      setWorking(false);
    }
  }

  async function transition(action: ResearchWorkflowTransitionRequest['action']): Promise<void> {
    if (workflow === null || selectedProjectId === null) return;
    setWorking(true);
    try {
      const result = await client.api.research.transitionWorkflow({
        projectId: selectedProjectId,
        action,
        expectedStage: workflow.currentStage,
        note: action === 'reject' ? '请补充证据或修改阶段产物。' : undefined
      });
      const nextWorkflow = unwrap('更新科研流程', result);
      setWorkflow(nextWorkflow);
      setProjects((current) =>
        current.map((project) =>
          project.id === selectedProjectId
            ? { ...project, currentStage: nextWorkflow.currentStage, status: nextWorkflow.projectStatus, updatedAt: new Date().toISOString() }
            : project
        )
      );
      setError(null);
    } catch (transitionError: unknown) {
      setError(transitionError instanceof Error ? transitionError.message : '科研流程更新失败。');
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className="canvas-stage research-page" data-testid="research-view">
      <header className="research-header">
        <div>
          <div className="eyebrow">RESEARCH WORKBENCH</div>
          <h1>科研工作台</h1>
          <p>论文、证据、实验、图稿和 LaTeX 文稿，沿同一条可恢复流程推进。</p>
        </div>
        <button className="action-button research-create-button" type="button" onClick={() => setCreateOpen((open) => !open)}>
          <Plus aria-hidden="true" size={16} />
          新建项目
        </button>
      </header>

      {createOpen ? (
        <section className="research-create-panel" aria-label="新建科研项目">
          <label>
            项目标题
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：多模态证据检索" />
          </label>
          <label>
            研究目标
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="写下要解释的问题和预期贡献" rows={3} />
          </label>
          <div className="research-form-actions">
            <button className="action-button" type="button" onClick={() => setCreateOpen(false)}>
              取消
            </button>
            <button className="action-button action-button--primary" type="button" disabled={working} onClick={() => void createProject()}>
              创建项目
            </button>
          </div>
        </section>
      ) : null}

      {error === null ? null : (
        <div className="research-alert" role="alert">
          <CircleAlert aria-hidden="true" size={16} />
          <span>{error}</span>
          <button type="button" title="关闭错误" aria-label="关闭错误" onClick={() => setError(null)}>
            <X aria-hidden="true" size={15} />
          </button>
        </div>
      )}

      {loading ? <div className="research-loading">正在读取科研项目…</div> : null}
      {!loading && projects.length === 0 ? (
        <div className="research-empty">
          <div className="research-empty-mark">∑</div>
          <h2>从一个研究问题开始</h2>
          <p>创建项目后，Roc 会持续记录当前阶段、审核节点和每个产物的来源。</p>
          <button className="action-button action-button--primary" type="button" onClick={() => setCreateOpen(true)}>
            <Plus aria-hidden="true" size={16} />
            新建第一个项目
          </button>
        </div>
      ) : null}

      {!loading && projects.length > 0 ? (
        <div className="research-layout">
          <aside className="research-projects" aria-label="科研项目列表">
            <div className="research-section-label">项目</div>
            {projects.map((project) => (
              <button
                className={project.id === selectedProjectId ? 'research-project-row research-project-row--active' : 'research-project-row'}
                key={project.id}
                type="button"
                onClick={() => setSelectedProjectId(project.id)}
              >
                <span className="research-project-row-title">{project.title}</span>
                <span className="research-project-row-meta">
                  {stageLabels[project.currentStage]} · {project.status === 'completed' ? '已完成' : '进行中'}
                </span>
              </button>
            ))}
          </aside>

          <main className="research-main">
            {selectedProject === null || workflow === null ? (
              <div className="research-loading">选择项目以读取流程。</div>
            ) : (
              <>
                <div className="research-project-heading">
                  <div>
                    <div className="research-section-label">当前项目</div>
                    <h2>{selectedProject.title}</h2>
                    <p>{selectedProject.description}</p>
                  </div>
                  <div className="research-current-stage">
                    <span>当前阶段</span>
                    <strong>{stageLabels[workflow.currentStage]}</strong>
                  </div>
                </div>

                <ol className="research-pipeline" aria-label="科研流程阶段">
                  {workflow.stages.map((stage, index) => (
                    <li className={stage.stage === workflow.currentStage ? 'research-pipeline-step research-pipeline-step--current' : 'research-pipeline-step'} key={stage.stage}>
                      <span className="research-pipeline-number">{stage.status === 'completed' ? <Check aria-hidden="true" size={14} /> : index + 1}</span>
                      <span className="research-pipeline-label">{stageLabels[stage.stage]}</span>
                      {index < workflow.stages.length - 1 ? <ChevronRight aria-hidden="true" className="research-pipeline-chevron" size={14} /> : null}
                    </li>
                  ))}
                </ol>

                <section className="research-stage-panel">
                  <div className="research-stage-panel-head">
                    <div>
                      <span className="research-section-label">阶段状态</span>
                      <h3>{stageLabels[workflow.currentStage]}</h3>
                    </div>
                    <span className={`research-status research-status--${workflow.stages.find((stage) => stage.stage === workflow.currentStage)?.status ?? 'ready'}`}>
                      {stageStatusLabels[workflow.stages.find((stage) => stage.stage === workflow.currentStage)?.status ?? 'ready']}
                    </span>
                  </div>
                  <p className="research-stage-copy">{selectedProject.description}</p>
                  <div className="research-stage-actions">
                    {currentStageStatus(workflow) === 'ready' ? (
                      <button className="action-button action-button--primary" disabled={working} type="button" onClick={() => void transition('start')}>
                        <Play aria-hidden="true" size={15} />
                        开始阶段
                      </button>
                    ) : null}
                    {currentStageStatus(workflow) === 'running' ? (
                      <>
                        <button className="action-button" disabled={working} type="button" onClick={() => void transition('pause')}>
                          <Pause aria-hidden="true" size={15} />
                          暂停
                        </button>
                        <button className="action-button action-button--primary" disabled={working} type="button" onClick={() => void transition('complete')}>
                          <Send aria-hidden="true" size={15} />
                          提交审核
                        </button>
                      </>
                    ) : null}
                    {currentStageStatus(workflow) === 'paused' ? (
                      <button className="action-button action-button--primary" disabled={working} type="button" onClick={() => void transition('resume')}>
                        <Play aria-hidden="true" size={15} />
                        恢复阶段
                      </button>
                    ) : null}
                    {currentStageStatus(workflow) === 'waiting_approval' ? (
                      <>
                        <button className="action-button" disabled={working} type="button" onClick={() => void transition('reject')}>
                          <RotateCcw aria-hidden="true" size={15} />
                          退回修改
                        </button>
                        <button className="action-button action-button--primary" disabled={working} type="button" onClick={() => void transition('approve')}>
                          <Check aria-hidden="true" size={15} />
                          确认通过
                        </button>
                      </>
                    ) : null}
                  </div>
                  {workflow.lastEvent === null ? null : (
                    <div className="research-last-event">
                      <span>最近事件</span>
                      <strong>{workflow.lastEvent.message}</strong>
                      <time>{formatEventTime(workflow.lastEvent.createdAt)}</time>
                    </div>
                  )}
                </section>
              </>
            )}
          </main>
        </div>
      ) : null}
    </section>
  );
}

function currentStageStatus(workflow: ResearchWorkflowSnapshot): ResearchWorkflowSnapshot['stages'][number]['status'] {
  return workflow.stages.find((stage) => stage.stage === workflow.currentStage)?.status ?? 'ready';
}

function formatEventTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

