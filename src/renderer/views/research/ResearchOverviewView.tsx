import type {
  ResearchArtifact,
  ResearchProject,
  ResearchStageRun,
  ResearchWorkflowEvent,
  ResearchWorkflowSnapshot
} from '../../../shared/types';
import type { ResearchContext } from './research-context';
import {
  artifactStatusLabel,
  currentArtifacts,
  currentStageState,
  formatResearchTime,
  indexPhaseLabel,
  latestCurrentRun,
  nextActionLabel,
  researchStageLabels,
  researchStageStatusLabels
} from './research-workflow';

export function ResearchOverviewView({
  artifacts,
  context,
  events,
  onApprove,
  onControlIndex,
  onOpenActivity,
  onOpenProvenance,
  onOpenStage,
  onRetryRun,
  onTransition,
  onDownloadModels,
  project,
  runs,
  workflow,
  working
}: {
  artifacts: ResearchArtifact[];
  context: ResearchContext;
  events: ResearchWorkflowEvent[];
  onApprove: () => void;
  onControlIndex: (action: 'retry' | 'rebuild') => void;
  onOpenActivity: () => void;
  onOpenProvenance: (artifactId: string) => void;
  onOpenStage?: () => void;
  onRetryRun: () => void;
  onTransition: (action: 'start' | 'resume' | 'reject') => void;
  onDownloadModels?: () => void;
  project: ResearchProject;
  runs: ResearchStageRun[];
  workflow: ResearchWorkflowSnapshot;
  working: boolean;
}): React.JSX.Element {
  const current = currentStageState(workflow);
  const run = latestCurrentRun(runs, workflow);
  const stageArtifacts = currentArtifacts(artifacts, workflow);
  const indexStatus = context.indexStatus;
  return (
    <section className="research-overview" data-testid="research-overview">
      <header className="research-project-heading">
        <div>
          <div className="research-section-label">研究目标</div>
          <h2 data-testid="research-shell-project-title">{project.title}</h2>
          <p data-testid="research-overview-goal">{project.description}</p>
        </div>
        <div className="research-current-stage">
          <span>当前阶段</span>
          <strong data-testid="research-overview-stage">{researchStageLabels[workflow.currentStage]}</strong>
          <span data-testid="research-shell-stage">{researchStageLabels[workflow.currentStage]}</span>
          <span data-testid="research-overview-status">{researchStageStatusLabels[current.status]}</span>
          {onOpenStage === undefined ? null : (
            <button className="action-button" data-testid="research-overview-open-stage" type="button" onClick={onOpenStage}>进入阶段工作区</button>
          )}
        </div>
      </header>

      <p className="research-stage-copy" data-testid="research-overview-next">{nextActionLabel(workflow)}</p>
      {current.lastError === null ? null : <p className="research-stage-error">{current.lastError}</p>}

      <ol className="research-pipeline" aria-label="阶段进度" data-testid="research-overview-progress">
        {workflow.stages.map((stage) => (
          <li className={stage.stage === workflow.currentStage ? 'research-pipeline-step research-pipeline-step--current' : 'research-pipeline-step'} key={stage.stage}>
            <span>{researchStageLabels[stage.stage]}</span>
            <span>{researchStageStatusLabels[stage.status]}</span>
          </li>
        ))}
      </ol>

      <div className="research-stage-actions">
        {current.status === 'ready' ? (
          <button className="action-button action-button--primary" disabled={working} type="button" onClick={() => onTransition('start')}>开始阶段</button>
        ) : null}
        {current.status === 'paused' ? (
          <button className="action-button action-button--primary" disabled={working} type="button" onClick={() => onTransition('resume')}>继续</button>
        ) : null}
        {current.status === 'waiting_approval' ? (
          <>
            <button className="action-button" disabled={working} type="button" onClick={() => onTransition('reject')}>退回修改</button>
            <button className="action-button action-button--primary" data-testid="research-overview-approve" disabled={working} type="button" onClick={onApprove}>审批</button>
          </>
        ) : null}
        {run !== null && (run.status === 'failed' || run.status === 'cancelled' || run.status === 'interrupted') ? (
          <button className="action-button" data-testid="research-overview-retry" disabled={working} type="button" onClick={onRetryRun}>重试</button>
        ) : null}
        {indexStatus?.phase === 'failed' ? (
          <button className="action-button" type="button" onClick={() => onControlIndex('retry')}>修复索引</button>
        ) : null}
        {context.serviceHealth.modelsReady === false ? (
          <>
            <span data-testid="research-overview-models">解析模型未安装，文档解析前需先配置。</span>
            {onDownloadModels === undefined ? null : (
              <button className="action-button" data-testid="research-overview-download-models" type="button" onClick={onDownloadModels}>下载模型</button>
            )}
          </>
        ) : null}
      </div>

      <dl className="research-shell-context">
        <div>
          <dt>人工闸门</dt>
          <dd data-testid="research-overview-gates">{context.pendingGates.length === 0 ? '无' : context.pendingGates.map((gate) => `${researchStageLabels[gate.stage]}：${gate.reason}`).join('；')}</dd>
          <dd data-testid="research-shell-gates">{context.pendingGates.length}</dd>
        </div>
        <div>
          <dt>索引</dt>
          <dd data-testid="research-shell-index">{indexPhaseLabel(indexStatus)}</dd>
        </div>
        <div>
          <dt>当前运行</dt>
          <dd data-testid="research-shell-runs">{context.activeRuns.length}</dd>
        </div>
        <div>
          <dt>产物</dt>
          <dd data-testid="research-shell-artifacts">{context.artifactSummary.total}</dd>
        </div>
      </dl>

      <section>
        <div className="research-section-label">最近活动</div>
        {events.length === 0 ? <p>暂无活动。</p> : (
          <button className="research-overview-event" data-testid="research-overview-event" type="button" onClick={onOpenActivity}>
            {events[0]?.message} · {events[0] === undefined ? '' : formatResearchTime(events[0].createdAt)}
          </button>
        )}
      </section>

      <section>
        <div className="research-section-label">关键产物</div>
        {stageArtifacts.length === 0 ? <p>当前阶段还没有产物。</p> : (
          <ul className="research-artifact-list" data-testid="research-overview-artifacts">
            {stageArtifacts.map((artifact) => (
              <li key={artifact.id}>
                <button type="button" onClick={() => onOpenProvenance(artifact.id)}>
                  <strong>{artifact.title}</strong>
                  <span>{artifactStatusLabel(artifact.status)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
