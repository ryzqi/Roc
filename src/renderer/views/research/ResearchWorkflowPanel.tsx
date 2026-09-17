import { Check, ChevronRight, Pause, Play, RotateCcw, Send, Square } from 'lucide-react';

import type {
  ResearchArtifact,
  ResearchIndexStatus,
  ResearchProject,
  ResearchStageRun,
  ResearchWorkflowEvent,
  ResearchWorkflowSnapshot,
  ResearchWorkflowTransitionRequest
} from '../../../shared/types';
import {
  artifactStatusLabel,
  currentArtifacts,
  currentStageState,
  eventTone,
  formatResearchTime,
  latestCurrentRun,
  nextActionLabel,
  nextStageLabel,
  researchRunStatusLabels,
  researchStageLabels,
  researchStageStatusLabels,
  reviewDecisionRequired
} from './research-workflow';

export function ResearchWorkflowPanel({
  artifacts,
  events,
  indexStatus,
  instruction,
  onApprove,
  onCancelRun,
  onControlIndex,
  onInstructionChange,
  onRetryRun,
  onStartRun,
  onTransition,
  project,
  runs,
  working,
  workflow
}: {
  artifacts: ResearchArtifact[];
  events: ResearchWorkflowEvent[];
  indexStatus: ResearchIndexStatus | null;
  instruction: string;
  onApprove: (decision?: 'accept' | 'revise') => void;
  onCancelRun: () => void;
  onControlIndex: (action: 'pause' | 'resume' | 'rebuild' | 'retry') => void;
  onInstructionChange: (value: string) => void;
  onRetryRun: () => void;
  onStartRun: () => void;
  onTransition: (action: Exclude<ResearchWorkflowTransitionRequest['action'], 'move'>, decision?: 'accept' | 'revise') => void;
  project: ResearchProject;
  runs: ResearchStageRun[];
  working: boolean;
  workflow: ResearchWorkflowSnapshot;
}): React.JSX.Element {
  const current = currentStageState(workflow);
  const run = latestCurrentRun(runs, workflow);
  const stageArtifacts = currentArtifacts(artifacts, workflow);
  const next = nextStageLabel(workflow);
  return (
    <>
      <div className="research-project-heading">
        <div>
          <div className="research-section-label">当前项目</div>
          <h2>{project.title}</h2>
          <p>{project.description}</p>
        </div>
        <div className="research-current-stage">
          <span>当前阶段</span>
          <strong data-testid="research-current-stage">{researchStageLabels[workflow.currentStage]}</strong>
          <span data-testid="research-project-language">{project.language === 'en' ? 'English' : '中文'}</span>
        </div>
      </div>

      <ol className="research-pipeline" aria-label="科研流程阶段" data-testid="research-pipeline">
        {workflow.stages.map((stage, index) => (
          <li className={stage.stage === workflow.currentStage ? 'research-pipeline-step research-pipeline-step--current' : 'research-pipeline-step'} key={stage.stage}>
            <span className="research-pipeline-number">{stage.status === 'completed' ? <Check aria-hidden="true" size={14} /> : index + 1}</span>
            <span className="research-pipeline-label">{researchStageLabels[stage.stage]}</span>
            {index < workflow.stages.length - 1 ? <ChevronRight aria-hidden="true" className="research-pipeline-chevron" size={14} /> : null}
          </li>
        ))}
      </ol>

      <section className="research-stage-panel" data-testid="research-stage-panel">
        <div className="research-stage-panel-head">
          <div>
            <span className="research-section-label">阶段状态</span>
            <h3>{researchStageLabels[current.stage]}</h3>
          </div>
          <span className={`research-status research-status--${current.status}`} data-testid="research-stage-status">
            {researchStageStatusLabels[current.status]}
          </span>
        </div>
        <p className="research-stage-copy" data-testid="research-next-action">{nextActionLabel(workflow)}{next === null || current.status === 'completed' ? '' : `。下一阶段：${next}`}</p>
        {current.lastError === null ? null : <p className="research-stage-error" data-testid="research-stage-error">{current.lastError}</p>}
        <div className="research-stage-actions">
          {current.status === 'ready' ? (
            <button className="action-button action-button--primary" disabled={working} type="button" onClick={() => onTransition('start')}>
              <Play aria-hidden="true" size={15} />
              开始阶段
            </button>
          ) : null}
          {current.status === 'running' ? (
            <>
              <button className="action-button" disabled={working} type="button" onClick={() => onTransition('pause')}>
                <Pause aria-hidden="true" size={15} />
                暂停
              </button>
              <button className="action-button action-button--primary" disabled={working} type="button" onClick={() => onTransition('complete')}>
                <Send aria-hidden="true" size={15} />
                {current.gateRequired ? '提交审核' : '完成阶段'}
              </button>
            </>
          ) : null}
          {current.status === 'paused' ? (
            <button className="action-button action-button--primary" disabled={working} type="button" onClick={() => onTransition('resume')}>
              <Play aria-hidden="true" size={15} />
              恢复阶段
            </button>
          ) : null}
          {current.status === 'waiting_approval' && !reviewDecisionRequired(workflow) ? (
            <>
              <button className="action-button" disabled={working} type="button" onClick={() => onTransition('reject')}>
                <RotateCcw aria-hidden="true" size={15} />
                退回修改
              </button>
              <button className="action-button action-button--primary" disabled={working} type="button" data-testid="research-approve" onClick={() => onApprove()}>

                <Check aria-hidden="true" size={15} />
                确认通过
              </button>
            </>
          ) : null}
          {reviewDecisionRequired(workflow) ? (
            <>
              <button className="action-button" disabled={working} type="button" onClick={() => onTransition('reject')}>
                <RotateCcw aria-hidden="true" size={15} />
                退回修改
              </button>
              <button className="action-button" disabled={working} type="button" data-testid="research-review-revise" onClick={() => onApprove('revise')}>
                要求修订
              </button>
              <button className="action-button action-button--primary" disabled={working} type="button" data-testid="research-review-accept" onClick={() => onApprove('accept')}>
                <Check aria-hidden="true" size={15} />
                接受稿件
              </button>
            </>
          ) : null}
        </div>
        {stageArtifacts.length === 0 ? null : (
          <ul className="research-artifact-list" data-testid="research-artifacts">
            {stageArtifacts.map((artifact) => (
              <li key={artifact.id}>
                <strong>{artifact.title}</strong>
                <span>{artifactStatusLabel(artifact.status)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="research-stage-panel" data-testid="research-index-panel">
        <div className="research-stage-panel-head">
          <div>
            <span className="research-section-label">项目索引</span>
            <h3>知识库状态</h3>
          </div>
          <span className={`research-status research-status--${indexPhaseTone(indexStatus)}`} data-testid="research-index-phase">
            {indexPhaseLabel(indexStatus)}
          </span>
        </div>
        <p className="research-stage-copy" data-testid="research-index-counts">
          {indexStatus === null
            ? '正在读取索引状态。'
            : `共 ${indexStatus.counts.total} 个文件，已就绪 ${indexStatus.counts.ready}，排队 ${indexStatus.counts.queued}，失败 ${indexStatus.counts.failed}。`}
        </p>
        {indexStatus?.error === null || indexStatus === null ? null : <p className="research-stage-error" data-testid="research-index-error">{indexStatus.error === 'research_models_unavailable' ? '解析模型尚未下载' : indexStatus.error}</p>}
        <div className="research-stage-actions">
          {indexStatus?.phase === 'paused' ? (
            <button className="action-button action-button--primary" disabled={working} type="button" data-testid="research-index-resume" onClick={() => onControlIndex('resume')}>
              <Play aria-hidden="true" size={15} />
              恢复索引
            </button>
          ) : (
            <button className="action-button" disabled={working || indexStatus === null} type="button" data-testid="research-index-pause" onClick={() => onControlIndex('pause')}>
              <Pause aria-hidden="true" size={15} />
              暂停索引
            </button>
          )}
          <button className="action-button" disabled={working || indexStatus === null || indexStatus.phase === 'paused'} type="button" data-testid="research-index-rebuild" onClick={() => onControlIndex('rebuild')}>
            <RotateCcw aria-hidden="true" size={15} />
            重建索引
          </button>
          {indexStatus !== null && indexStatus.counts.failed > 0 ? (
            <button className="action-button action-button--primary" disabled={working || indexStatus.phase === 'paused'} type="button" data-testid="research-index-retry" onClick={() => onControlIndex('retry')}>
              重试失败文件
            </button>
          ) : null}
        </div>
      </section>

      <section className="research-run-panel" data-testid="research-run-panel">
        <div className="research-stage-panel-head">
          <div>
            <span className="research-section-label">阶段 Agent</span>
            <h3>{run === null ? '尚未启动角色' : run.role}</h3>
          </div>
          {run === null ? null : <span className={`research-status research-status--${run.status === 'failed' ? 'failed' : run.status}`}>{researchRunStatusLabels[run.status]}</span>}
        </div>
        {run === null ? <p className="research-stage-copy">给当前阶段一条明确指令后启动角色。取消或失败后可按原指令重试。</p> : (
          <p className="research-stage-copy" data-testid="research-run-instruction">{run.instruction}</p>
        )}
        {run?.error ? <p className="research-stage-error" data-testid="research-run-error">{run.error}</p> : null}
        {(current.status === 'ready' || current.status === 'running' || current.status === 'paused' || current.status === 'failed' || current.status === 'blocked') && (run === null || !['queued', 'running'].includes(run.status)) ? (
          <label className="research-run-instruction">
            角色指令
            <textarea data-testid="research-run-input" spellCheck={true} value={instruction} onChange={(event) => onInstructionChange(event.target.value)} rows={3} placeholder="例如：基于已有证据形成可检验假设。" />
          </label>
        ) : null}
        <div className="research-stage-actions">
          {run === null || !['queued', 'running', 'failed', 'cancelled', 'interrupted'].includes(run.status) ? (
            <button className="action-button action-button--primary" disabled={working || instruction.trim().length === 0} type="button" data-testid="research-start-run" onClick={onStartRun}>
              <Play aria-hidden="true" size={15} />
              启动角色
            </button>
          ) : null}
          {run !== null && ['queued', 'running'].includes(run.status) ? (
            <button className="action-button" disabled={working} type="button" data-testid="research-cancel-run" onClick={onCancelRun}>
              <Square aria-hidden="true" size={15} />
              取消运行
            </button>
          ) : null}
          {run !== null && ['failed', 'cancelled', 'interrupted'].includes(run.status) ? (
            <button className="action-button action-button--primary" disabled={working} type="button" data-testid="research-retry-run" onClick={onRetryRun}>
              <RotateCcw aria-hidden="true" size={15} />
              重试运行
            </button>
          ) : null}
        </div>
      </section>

      <section className="research-timeline" data-testid="research-timeline" aria-label="事件时间线">
        <div className="research-section-label">事件时间线</div>
        {events.length === 0 ? <div className="research-loading">还没有流程事件。</div> : (
          <ol>
            {events.map((event) => (
              <li className={`research-timeline-item research-timeline-item--${eventTone(event.type)}`} key={event.id}>
                <span>{researchStageLabels[event.stage]}</span>
                <strong>{event.message}</strong>
                <time dateTime={event.createdAt}>{formatResearchTime(event.createdAt)}</time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

function indexPhaseLabel(status: ResearchIndexStatus | null): string {
  if (status === null) return '读取中';
  if (status.phase === 'unavailable') return '不可用';
  if (status.phase === 'idle') return '空闲';
  if (status.phase === 'queued') return '排队中';
  if (status.phase === 'scanning') return '扫描中';
  if (status.phase === 'indexing') return '索引中';
  if (status.phase === 'paused') return '已暂停';
  return '失败';
}

function indexPhaseTone(status: ResearchIndexStatus | null): string {
  if (status === null) return 'ready';
  if (status.phase === 'failed') return 'failed';
  if (status.phase === 'paused') return 'waiting_approval';
  if (status.phase === 'scanning' || status.phase === 'indexing' || status.phase === 'queued') return 'running';
  if (status.phase === 'idle') return 'completed';
  return 'ready';
}
