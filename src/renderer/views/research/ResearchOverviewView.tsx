import type {
  ResearchArtifact,
  ResearchProject,
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

export function ResearchOverviewView({
  artifacts,
  context,
  events,
  onBindWorkspace,
  onOpenActivity,
  onOpenProvenance,
  onOpenStage,
  onDownloadModels,
  project,
  workflow
}: {
  artifacts: ResearchArtifact[];
  context: ResearchContext;
  events: ResearchWorkflowEvent[];
  onBindWorkspace: () => void;
  onOpenActivity: () => void;
  onOpenProvenance: (artifactId: string) => void;
  onOpenStage?: () => void;
  onDownloadModels?: () => void;
  project: ResearchProject;
  workflow: ResearchWorkflowSnapshot;
}): React.JSX.Element {
  const current = currentStageState(workflow);
  const stageArtifacts = currentArtifacts(artifacts, workflow);
  const indexStatus = context.indexStatus;
  const stageLabel = researchStageLabels[workflow.currentStage];
  const nextAction = nextActionLabel(workflow);
  return (
    <section className="research-overview" data-testid="research-overview">
      <header className="research-project-heading">
        <div>
          <div className="research-section-label">研究目标</div>
          <p data-testid="research-overview-goal">{project.description}</p>
          <span className="visually-hidden" data-testid="research-shell-project-title">{project.title}</span>
        </div>
        <div className="research-current-stage">
          <span>当前阶段</span>
          <strong data-testid="research-overview-stage">
            <span data-testid="research-shell-stage">
              <span data-testid="research-current-stage">{stageLabel}</span>
            </span>
          </strong>
          <span data-testid="research-overview-status">{researchStageStatusLabels[current.status]}</span>
          {onOpenStage === undefined ? null : (
            <button className="action-button action-button--primary" data-testid="research-overview-open-stage" type="button" onClick={onOpenStage}>进入阶段工作区</button>
          )}
        </div>
      </header>

      <p className="research-stage-copy" data-testid="research-overview-next">
        <span data-testid="research-next-action">{nextAction}</span>
      </p>
      {current.lastError === null ? null : <p className="research-stage-error">{current.lastError}</p>}

      {context.serviceHealth.modelsReady === false ? (
        <div className="research-alert" role="status" data-testid="research-overview-models">
          <span>解析模型未安装，文档解析前需先配置。</span>
          {onDownloadModels === undefined ? null : (
            <button className="action-button" data-testid="research-overview-download-models" type="button" onClick={onDownloadModels}>下载模型</button>
          )}
        </div>
      ) : null}

      {project.workspacePath === null ? (
        <div className="research-alert" role="status" data-testid="research-overview-bind-workspace">
          <span>当前项目还没有工作目录，打开文件与代码前必须先绑定。</span>
          <button className="action-button" data-testid="research-overview-choose-workspace" type="button" onClick={onBindWorkspace}>绑定工作目录</button>
        </div>
      ) : (
        <p className="research-shell-workspace" data-testid="research-shell-workspace">工作目录：{project.workspacePath}</p>
      )}

      <ol className="research-pipeline" aria-label="科研流程阶段" data-testid="research-pipeline">
        {workflow.stages.map((stage, index) => (
          <li className={stage.stage === workflow.currentStage ? 'research-pipeline-step research-pipeline-step--current' : 'research-pipeline-step'} key={stage.stage}>
            <span className="research-pipeline-number">{index + 1}</span>
            <span className="research-pipeline-label">{researchStageLabels[stage.stage]}</span>
          </li>
        ))}
      </ol>

      <dl className="research-shell-context">
        <div>
          <dt>人工闸门</dt>
          <dd data-testid="research-overview-gates">{context.pendingGates.length === 0 ? '无' : context.pendingGates.map((gate) => `${researchStageLabels[gate.stage]}：${gate.reason}`).join('；')}</dd>
          <dd data-testid="research-shell-gates">{context.pendingGates.length}</dd>
        </div>
        <div>
          <dt>索引</dt>
          <dd data-testid="research-shell-index">
            <span data-testid="research-index-phase">{indexPhaseLabel(indexStatus)}</span>
          </dd>
          <dd data-testid="research-index-counts">
            {indexStatus === null
              ? '正在读取索引状态。'
              : `共 ${indexStatus.counts.total} 个文件，已就绪 ${indexStatus.counts.ready}，排队 ${indexStatus.counts.queued}，失败 ${indexStatus.counts.failed}。`}
          </dd>
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

      <section className="research-timeline" data-testid="research-timeline" aria-label="最近活动">
        <div className="research-section-label">最近活动</div>
        {events.length === 0 ? <div className="research-empty-inline" role="status">暂无活动。</div> : (
          <ol>
            {events.map((event, index) => (
              <li className="research-timeline-item" key={event.id}>
                <span>{researchStageLabels[event.stage]}</span>
                {index === 0 ? (
                  <button className="research-inline-event" data-testid="research-overview-event" type="button" onClick={onOpenActivity}>
                    {event.message}
                  </button>
                ) : <strong>{event.message}</strong>}
                <time dateTime={event.createdAt}>{formatResearchTime(event.createdAt)}</time>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section>
        <div className="research-section-label">关键产物</div>
        {stageArtifacts.length === 0 ? <p className="research-empty-inline" role="status">当前阶段还没有产物。</p> : (
          <ul className="research-artifact-list" data-testid="research-artifacts">
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
