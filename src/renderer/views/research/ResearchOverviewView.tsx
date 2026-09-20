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
  nextActionLabel,
  researchStageLabels,
  researchStageStatusLabels
} from './research-workflow';
import { ResearchWorkflowPanel } from './ResearchWorkflowPanel';

export function ResearchOverviewView({
  artifacts,
  context,
  events,
  instruction,
  onApprove,
  onCancelRun,
  onControlIndex,
  onInstructionChange,
  onOpenActivity,
  onOpenProvenance,
  onOpenStage,
  onRetryRun,
  onStartRun,
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
  instruction: string;
  onApprove: (decision?: 'accept' | 'revise') => void;
  onCancelRun: () => void;
  onControlIndex: (action: 'pause' | 'resume' | 'rebuild' | 'retry') => void;
  onInstructionChange: (value: string) => void;
  onOpenActivity: () => void;
  onOpenProvenance: (artifactId: string) => void;
  onOpenStage?: () => void;
  onRetryRun: () => void;
  onStartRun: () => void;
  onTransition: (action: 'start' | 'resume' | 'reject' | 'pause' | 'complete', decision?: 'accept' | 'revise') => void;
  onDownloadModels?: () => void;
  project: ResearchProject;
  runs: ResearchStageRun[];
  workflow: ResearchWorkflowSnapshot;
  working: boolean;
}): React.JSX.Element {
  const current = currentStageState(workflow);
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

      {context.serviceHealth.modelsReady === false ? (
        <div className="research-alert" role="status" data-testid="research-overview-models">
          <span>解析模型未安装，文档解析前需先配置。</span>
          {onDownloadModels === undefined ? null : (
            <button className="action-button" data-testid="research-overview-download-models" type="button" onClick={onDownloadModels}>下载模型</button>
          )}
        </div>
      ) : null}

      <ResearchWorkflowPanel
        artifacts={artifacts}
        events={events}
        indexStatus={indexStatus}
        instruction={instruction}
        onApprove={onApprove}
        onCancelRun={onCancelRun}
        onControlIndex={onControlIndex}
        onInstructionChange={onInstructionChange}
        onRetryRun={onRetryRun}
        onStartRun={onStartRun}
        onTransition={onTransition}
        project={project}
        runs={runs}
        working={working}
        workflow={workflow}
      />

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
