import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { ResearchProject, ResearchStageRun, ResearchWorkflowSnapshot } from '../../../shared/types';
import type { NextActionPlan, WorkflowCommand } from './workflow-rules';

/**
 * The one "next step" strip inside 项目总览 (P6/T6.2).
 *
 * The strip is the **only** place a workflow command is offered, which is why the stage
 * workspace has no 流程按钮 (T6.3): two copies of "start this stage" would be two buttons
 * that must never disagree about whether the gate is pending.
 *
 * Shape, per the plan: with no artifact there is just the action; with an artifact a title
 * line is added; a failure adds the first sentence of the reason; while a run is in flight
 * the status sentence replaces the primary action and 「取消运行」 appears as a *secondary*
 * button (never a second primary).
 *
 * `primary` and `secondary` come from `currentNextAction` — this component decides nothing
 * about the workflow, it only draws what the rules say.
 */

export type NextActionStripProps = {
  project: ResearchProject;
  workflow: ResearchWorkflowSnapshot;
  runs: readonly ResearchStageRun[];
  /** The derived next-step plan — see `currentNextAction` (T6.1). */
  plan: NextActionPlan;
  /** The stage-instruction draft typed in 阶段工作区; empty means "use the goal". */
  instruction: string;
  busy: boolean;
  error: string | null;
  writable: boolean;
  polling: boolean;
  onCommand: (command: WorkflowCommand, options?: { note?: string }) => void;
  onDismissError: () => void;
};

export function NextActionStrip({
  project,
  workflow,
  plan,
  instruction,
  busy,
  error,
  writable,
  polling,
  onCommand,
  onDismissError
}: NextActionStripProps): React.JSX.Element {
  const currentStatus = workflow.stages.find((stage) => stage.stage === workflow.currentStage)?.status ?? 'locked';
  /**
   * The reviewer's note for a rejection (T6.4).
   *
   * It lives here, next to the 退回修改 button that uses it, rather than in the workflow
   * store: T6.3 keeps every *flow* button on 总览, so this is the only place a rejection can
   * be issued, and the note never needs to travel between views. `transitionWorkflow` puts
   * it in `lastError`, which is what `currentNextAction` then shows as the stage's reason —
   * 「退回说明贴在重试上」 without a second copy of the text.
   */
  const [rejectNote, setRejectNote] = useState('');
  return (
    <section
      className="flex flex-col gap-1.5 rounded-card border border-line bg-surface px-3 py-2.5"
      data-testid="workflow-next-strip"
      data-stage={workflow.currentStage}
      data-status={currentStatus}
      aria-busy={busy}
    >
      <header className="flex items-center gap-2">
        <span className="text-subtle text-[var(--font-micro-size)]">下一步</span>
        {polling ? (
          <span className="flex items-center gap-1 text-subtle text-[var(--font-micro-size)]" data-testid="workflow-polling">
            <Loader2 size={10} aria-hidden="true" className="animate-spin" />
            轮询运行状态
          </span>
        ) : null}
      </header>

      {plan.statusLine === null ? null : (
        <p className="text-ink text-[var(--font-read-size)]" data-testid="workflow-next-status">
          {plan.statusLine}
        </p>
      )}
      {plan.summaryLine === null ? null : (
        <p className="truncate text-ink" data-testid="workflow-next-summary" title={plan.summaryLine}>
          {plan.summaryLine}
        </p>
      )}
      {plan.detailLine === null ? null : (
        <p className="text-[var(--st-bad)] text-[var(--font-meta-size)]" data-testid="workflow-next-detail" role="status">
          {plan.detailLine}
        </p>
      )}
      {plan.readOnlyReason === null ? null : (
        <p className="text-[var(--st-warn)] text-[var(--font-meta-size)]" data-testid="workflow-next-readonly" role="note">
          {plan.readOnlyReason}
        </p>
      )}

      {plan.secondary.some((button) => button.command.type === 'reject') ? (
        <label className="flex flex-col gap-0.5">
          <span className="text-subtle text-[var(--font-micro-size)]">退回说明（会记入阶段事件，并贴在重试后显示）</span>
          <input
            type="text"
            data-testid="workflow-reject-note"
            value={rejectNote}
            onChange={(event) => setRejectNote(event.target.value)}
            placeholder="例如：证据只覆盖了综述，请补充原始研究。"
            className="h-[var(--control-height)] w-full rounded-control border border-line bg-bg px-2 text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          />
        </label>
      ) : null}

      <div className="flex items-center gap-2">
        {plan.secondary.map((button) => (
          <button
            key={button.testId}
            type="button"
            data-testid={button.testId}
            disabled={busy}
            onClick={() => onCommand(button.command, { note: rejectNote })}
            className="h-[var(--control-height)] rounded-control border border-line px-3 text-muted hover:text-ink hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            {button.label}
          </button>
        ))}
        {plan.primary === null ? null : (
          <button
            type="button"
            data-testid={plan.primary.testId}
            disabled={busy}
            onClick={() => onCommand(plan.primary!.command)}
            className="h-[var(--control-height)] rounded-control bg-[var(--fill-strong)] px-3 text-[var(--fill-strong-text)] hover:bg-[var(--accent-deep)] active:bg-[var(--accent-deep)] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            {plan.primary.label}
          </button>
        )}
        {writable ? null : (
          <span className="text-[var(--font-micro-size)] text-subtle">项目已归档，操作已停用</span>
        )}
        <span className="text-subtle text-[var(--font-micro-size)]" data-testid="workflow-next-instruction-source">
          {instruction.trim().length === 0
            ? `阶段指令默认使用研究目标：${truncateLabel(project.description)}`
            : `阶段指令：${truncateLabel(instruction)}`}
        </span>
      </div>

      {error === null ? null : (
        <div className="flex items-start gap-2" role="alert" data-testid="workflow-action-error">
          <p className="min-w-0 flex-1 text-[var(--st-bad)] text-[var(--font-meta-size)]">{error}</p>
          <button
            type="button"
            onClick={onDismissError}
            className="rounded-control px-1.5 text-subtle hover:text-ink"
            aria-label="关闭错误提示"
          >
            关闭
          </button>
        </div>
      )}
    </section>
  );
}

/** One-line preview of a possibly long instruction or goal. */
function truncateLabel(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed;
}
