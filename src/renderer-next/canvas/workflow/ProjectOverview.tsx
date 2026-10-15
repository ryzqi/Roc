import { Activity, AlertTriangle, BookOpen, CheckCircle2, CircleDashed, Loader2 } from 'lucide-react';
import type { ResearchWorkflowSnapshot } from '../../../shared/types';
import { useWorkspaceScope } from '../../app/workspace-scope';
import { EmptyState } from '../../shell/EmptyState';
import { ErrorBar } from '../../shell/ErrorBar';
import { formatBeijingDateTime, formatCount } from '../../shared/format';
import {
  currentArtifacts,
  currentNextAction,
  currentStageState,
  stageGroupForStage,
  type NextActionPlan,
  type WorkflowCommand
} from './workflow-rules';
import {
  eventTone,
  indexPhaseLabel,
  researchArtifactKindLabels,
  researchArtifactStatusLabels,
  researchProjectStatusLabels,
  researchRunStatusLabels,
  researchStageLabels,
  researchStageStatusLabels
} from './format';
import { NextActionStrip } from './NextActionStrip';
import { StageBar } from './StageBar';
import { useWorkflow } from './workflow-scope';

/**
 * 项目总览 (P6/T6.2) — the read-only projection the shell lands on when a project opens.
 *
 * P2 already made `overview` the default view for a project (the route module defaults to
 * it), so unlike the plan's T6.2 there is nothing to re-point: entering a project already
 * lands here, and before P6 this view was a placeholder.
 *
 * What this screen is *for*: answer "where is this project, and what is the one thing I
 * should do now?" without opening anything. So it shows the goal, the stage, the gate, the
 * index, the recent events and the current stage's artifacts — and exactly one primary
 * action, which comes from `currentNextAction` rather than from any local conditionals.
 *
 * Archived projects are read-only; the shell already shows the banner, and the plan is
 * asked for `projectWritable: false` so the strip has no primary action and says why
 * (gate 4).
 */

export function ProjectOverview(): React.JSX.Element {
  const scope = useWorkspaceScope();
  const store = useWorkflow();
  const { workflow, project, runs, artifacts, events, indexStatus, indexUnavailableReason } = store;

  /**
   * Guard order: **error only when the store says error.**
   *
   * `workflow === null` alone is not a failure — it is also the moment a project switch is
   * in flight, and treating it as one painted a false 「读取项目流程失败」 bar over the incoming
   * project (the store now drops the previous bundle, so the null case is common and brief).
   */
  if (store.status === 'error') {
    return (
      <div className="flex h-full flex-col gap-2 p-4" data-testid="workflow-overview-error">
        <ErrorBar
          error={{
            level: 'page',
            message: store.error ?? '读取项目流程失败',
            retry: store.refresh,
            actionLabel: '重试读取 research.workflow.get'
          }}
        />
      </div>
    );
  }
  if (workflow === null || project === null) {
    return (
      <div className="flex h-full items-center justify-center p-6" data-testid="workflow-overview-loading">
        <EmptyState tone="loading" title="正在读取阶段状态" />
      </div>
    );
  }

  const current = currentStageState(workflow);
  const plan: NextActionPlan = currentNextAction({
    workflow,
    runs,
    artifacts,
    description: project.description,
    instructionDraft: store.instruction,
    projectWritable: scope.writable
  });
  const currentGroup = stageGroupForStage(workflow.currentStage);
  const stageArtifacts = currentArtifacts(artifacts, workflow);
  const recentEvents = events.slice(0, 4);
  const activeRun = runs.find((run) => run.parentRunId === null && (run.status === 'queued' || run.status === 'running')) ?? null;

  const onCommand = (command: WorkflowCommand, options?: { note?: string }): void => {
    // The draft instruction typed in 阶段工作区 is the one that counts when it is not empty;
    // the store falls back to `project.description` otherwise (T6.3). The rejection note
    // comes from the strip's own input (T6.4).
    void store.runAction(command, { instruction: store.instruction, note: options?.note });
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workflow-overview">
      <StageBar
        stages={workflow.stages}
        currentStage={workflow.currentStage}
        currentGroup={currentGroup}
        selectedGroup={currentGroup}
        onSelectGroup={(groupId) => {
          if (groupId === 'settings') {
            scope.openSettings();
            return;
          }
          scope.openStage(groupId);
        }}
        projectWritable={scope.writable}
      />

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-subtle text-[var(--font-micro-size)]">研究目标</p>
            <p className="mt-0.5 whitespace-pre-wrap text-ink text-[var(--font-read-size)]" data-testid="workflow-overview-goal">
              {project.description}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-0.5">
            <span className="text-subtle text-[var(--font-micro-size)]">当前阶段</span>
            <strong className="text-ink text-[var(--font-h2-size)]" data-testid="workflow-overview-stage">
              {researchStageLabels[workflow.currentStage]}
            </strong>
            <span className="flex items-center gap-1 text-muted text-[var(--font-meta-size)]" data-testid="workflow-overview-stage-status">
              {current.status === 'running' ? <Loader2 size={11} aria-hidden="true" className="animate-spin" /> : null}
              {researchStageStatusLabels[current.status]}
              <span className="text-subtle">· 项目{researchProjectStatusLabels[workflow.projectStatus]}</span>
            </span>
          </div>
        </header>

        <NextActionStrip
          project={project}
          workflow={workflow}
          runs={runs}
          plan={plan}
          instruction={store.instruction}
          busy={store.busy}
          error={store.actionError}
          writable={scope.writable}
          polling={store.polling}
          onCommand={onCommand}
          onDismissError={store.dismissActionError}
        />

        <dl className="grid grid-cols-2 gap-2 lg:grid-cols-4" data-testid="workflow-overview-facts">
          <Fact
            label="人工闸门"
            testId="workflow-overview-gate"
            value={gateValue(current.gateRequired, current.gateApproved, current.status)}
            detail={
              current.gateRequired
                ? '闸门要求由后端阶段定义给出（research.workflow.get 的 gateRequired）'
                : '后端 gateRequired=false，完成运行即推进'
            }
          />
          <Fact
            label="索引"
            testId="workflow-overview-index"
            value={indexPhaseLabel(indexStatus)}
            detail={
              indexUnavailableReason === null
                ? `文件 ${indexStatus?.counts.total ?? 0} · 就绪 ${indexStatus?.counts.ready ?? 0} · 排队 ${indexStatus?.counts.queued ?? 0} · 失败 ${indexStatus?.counts.failed ?? 0}`
                : `research.index.status 不可用：${indexUnavailableReason}`
            }
          />
          <Fact
            label="当前运行"
            testId="workflow-overview-run"
            value={activeRun === null ? '无进行中的运行' : researchRunStatusLabels[activeRun.status]}
            detail={
              activeRun === null
                ? `${runs.length} 条运行记录（research.workflow.listRuns）`
                : `${researchStageLabels[activeRun.stage]} · 角色 ${activeRun.role}`
            }
          />
          <Fact
            label="当前阶段产物"
            testId="workflow-overview-artifacts-count"
            value={`${formatCount(stageArtifacts.length)} 个`}
            detail={stageArtifacts.length === 0 ? '本阶段还没有产物' : stageArtifacts.map((item) => item.title).join('、')}
          />
        </dl>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <section className="flex flex-col gap-1.5 rounded-card border border-line bg-surface px-3 py-2.5">
            <header className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-subtle text-[var(--font-micro-size)]">
                <Activity size={12} aria-hidden="true" />
                最近活动
              </span>
              <button
                type="button"
                data-testid="workflow-overview-open-activity"
                onClick={() => scope.openView('activity')}
                className="rounded-control px-1.5 py-0.5 text-muted text-[var(--font-micro-size)] hover:text-ink active:bg-[var(--overlay-active)]"
              >
                打开活动流
              </button>
            </header>
            {recentEvents.length === 0 ? (
              <p className="text-muted text-[var(--font-meta-size)]" role="status">
                本项目还没有流程事件。
              </p>
            ) : (
              <ol className="flex flex-col gap-1" data-testid="workflow-overview-events">
                {recentEvents.map((event) => (
                  <li key={event.id} className="flex items-start gap-2 text-[var(--font-meta-size)]">
                    <EventMark tone={eventTone(event.type)} />
                    <span className="min-w-0 flex-1">
                      <span className="text-subtle">{researchStageLabels[event.stage]}</span>
                      <span className="ml-1.5 text-ink">{event.message}</span>
                    </span>
                    <time className="shrink-0 text-subtle" dateTime={event.createdAt}>
                      {formatBeijingDateTime(event.createdAt)}
                    </time>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="flex flex-col gap-1.5 rounded-card border border-line bg-surface px-3 py-2.5">
            <span className="flex items-center gap-1.5 text-subtle text-[var(--font-micro-size)]">
              <BookOpen size={12} aria-hidden="true" />
              当前阶段产物
            </span>
            {stageArtifacts.length === 0 ? (
              <p className="text-muted text-[var(--font-meta-size)]" role="status">
                还没有产物：本阶段的运行完成后，产物会出现在这里，并在人工闸门里等待确认。
              </p>
            ) : (
              <ul className="flex flex-col gap-1" data-testid="workflow-overview-artifacts">
                {stageArtifacts.map((artifact) => (
                  <li key={artifact.id} className="flex items-center gap-2 text-[var(--font-meta-size)]">
                    <CheckCircle2 size={12} aria-hidden="true" className="text-[var(--st-ok)]" />
                    <span className="min-w-0 flex-1 truncate text-ink" title={artifact.title}>
                      {artifact.title}
                    </span>
                    <span className="text-subtle">{researchArtifactKindLabels[artifact.kind]}</span>
                    <span className="text-subtle">{researchArtifactStatusLabels[artifact.status]}</span>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              data-testid="workflow-overview-open-stage"
              onClick={() => scope.openStage(currentGroup)}
              className="self-start rounded-control px-1.5 py-0.5 text-muted text-[var(--font-micro-size)] hover:text-ink active:bg-[var(--overlay-active)]"
            >
              打开阶段工作区
            </button>
          </section>
        </div>

        {current.lastError === null ? null : (
          <p className="flex items-start gap-1.5 text-[var(--st-bad)] text-[var(--font-meta-size)]" data-testid="workflow-overview-last-error">
            <AlertTriangle size={12} aria-hidden="true" className="mt-0.5" />
            {current.lastError}
          </p>
        )}
      </div>
    </div>
  );
}

function Fact({ label, value, detail, testId }: { label: string; value: string; detail: string; testId: string }): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-card border border-line bg-surface px-3 py-2" data-testid={testId}>
      <dt className="text-subtle text-[var(--font-micro-size)]">{label}</dt>
      <dd className="truncate text-ink text-[var(--font-num-sm-size)]" data-testid={`${testId}-value`} title={value}>
        {value}
      </dd>
      <dd className="text-muted text-[var(--font-micro-size)]">{detail}</dd>
    </div>
  );
}

/**
 * Human gate wording, in one place because the four facts (required / approved / stage
 * status / this round's artifact) combine in ways that read wrong if interleaved inline.
 */
function gateValue(
  gateRequired: boolean,
  gateApproved: boolean,
  status: ResearchWorkflowSnapshot['stages'][number]['status']
): string {
  if (!gateRequired) {
    return '本阶段无需人工闸门';
  }
  if (status === 'waiting_approval') {
    return '待你确认';
  }
  if (status === 'failed') {
    return '未通过（运行失败）';
  }
  if (status === 'completed') {
    return '已通过';
  }
  if (gateApproved) {
    return '已通过（本阶段）';
  }
  if (status === 'running') {
    return '产物生成后自动提交审核';
  }
  return '未到审核点';
}

/** Never colour alone: each tone also picks a different glyph (AGENTS.md). */
function EventMark({ tone }: { tone: 'info' | 'warn' | 'good' }): React.JSX.Element {
  if (tone === 'good') {
    return <CheckCircle2 size={12} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--st-ok)]" />;
  }
  if (tone === 'warn') {
    return <AlertTriangle size={12} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--st-warn)]" />;
  }
  return <CircleDashed size={12} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--st-info)]" />;
}
