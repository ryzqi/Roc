import type {
  ResearchArtifact,
  ResearchProject,
  ResearchWorkflowEvent,
  ResearchWorkflowSnapshot
} from '../../../shared/types';
import { Button } from '../../components/ui';
import type { ResearchContext } from './research-context';
import {
  artifactStatusLabel,
  currentArtifacts,
  currentStageState,
  formatResearchTime,
  indexPhaseLabel,
  researchStageLabels,
  researchStageStatusLabels
} from './research-workflow';

export function ResearchOverviewView({
  artifacts,
  context,
  events,
  onBindWorkspace,
  onOpenActivity,
  onOpenArtifacts,
  onOpenIndex,
  onOpenProvenance,
  onOpenRuns,
  project,
  workflow
}: {
  artifacts: ResearchArtifact[];
  context: ResearchContext;
  events: ResearchWorkflowEvent[];
  onBindWorkspace: () => void;
  onOpenActivity: () => void;
  onOpenArtifacts: () => void;
  onOpenIndex: () => void;
  onOpenProvenance: (artifactId: string) => void;
  onOpenRuns: () => void;
  project: ResearchProject;
  workflow: ResearchWorkflowSnapshot;
}): React.JSX.Element {
  const current = currentStageState(workflow);
  const stageArtifacts = currentArtifacts(artifacts, workflow);
  const indexStatus = context.indexStatus;
  const stageLabel = researchStageLabels[workflow.currentStage];
  const recentEvents = events.slice(0, 4);
  const gateText = context.pendingGates.length === 0
    ? '没有待确认'
    : context.pendingGates.map((gate) => `${researchStageLabels[gate.stage]}：${gate.reason}`).join('；');
  const indexDetail = indexStatus === null
    ? '正在读取索引状态。'
    : `共 ${indexStatus.counts.total} 个文件，已就绪 ${indexStatus.counts.ready}，排队 ${indexStatus.counts.queued}，失败 ${indexStatus.counts.failed}。`;
  return (
    <section className="research-overview" data-testid="research-overview">
      <header className="research-project-heading">
        <div>
          <div className="research-section-label">研究目标</div>
          <p data-testid="research-overview-goal">{project.description}</p>
        </div>
        <div className="research-current-stage">
          <span>当前阶段</span>
          <strong data-testid="research-overview-stage">
            <span data-testid="research-shell-stage">
              <span data-testid="research-current-stage">{stageLabel}</span>
            </span>
          </strong>
          <span data-testid="research-overview-status">{researchStageStatusLabels[current.status]}</span>
        </div>
      </header>

      {current.lastError === null ? null : <p className="research-stage-error" data-testid="research-overview-error">{current.lastError}</p>}

      {project.workspacePath === null ? (
        <div className="research-alert" role="status" data-testid="research-overview-bind-workspace">
          <span>当前项目还没有工作目录，打开文件与代码前必须先绑定。</span>
          <Button data-testid="research-overview-choose-workspace" variant="secondary" onClick={onBindWorkspace}>绑定工作目录</Button>
        </div>
      ) : (
        <p className="research-shell-workspace" data-testid="research-shell-workspace">工作目录：{project.workspacePath}</p>
      )}

      <dl className="research-shell-context">
        <div>
          <dt>人工闸门</dt>
          <dd data-count={context.pendingGates.length} data-testid="research-overview-gates">{gateText}</dd>
        </div>
        <div>
          <dt>索引</dt>
          <dd>
            <button className="research-status-row" data-testid="research-shell-index" type="button" onClick={onOpenIndex}>
              <span data-testid="research-index-phase">{indexPhaseLabel(indexStatus)}</span>
              <span data-testid="research-index-counts">{indexDetail}</span>
            </button>
          </dd>
        </div>
        <div>
          <dt>当前运行</dt>
          <dd>
            <button className="research-status-row" data-testid="research-shell-runs" type="button" onClick={onOpenRuns}>
              <span>{context.activeRuns.length} 个运行</span>
            </button>
          </dd>
        </div>
        <div>
          <dt>产物</dt>
          <dd>
            <button className="research-status-row" data-testid="research-shell-artifacts" type="button" onClick={onOpenArtifacts}>
              <span>{context.artifactSummary.total} 个产物</span>
            </button>
          </dd>
        </div>
      </dl>

      <section className="research-timeline" data-testid="research-timeline" aria-label="最近活动">
        <div className="research-section-label">最近活动</div>
        {recentEvents.length === 0 ? <div className="research-empty-inline" role="status">暂无活动。</div> : (
          <ol>
            {recentEvents.map((event, index) => (
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
        <button className="research-toolbar-button" data-testid="research-overview-open-activity" type="button" onClick={onOpenActivity}>打开活动</button>
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
