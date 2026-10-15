import type {
  ResearchArtifact,
  ResearchProject,
  ResearchStageRun,
  ResearchWorkflowSnapshot
} from '../../../shared/types';
import {
  RESEARCH_STAGE_GROUPS,
  STAGE_GROUP_IDS,
  STAGE_TAB_IDS,
  defaultTabForGroup,
  isCurrentStageGroup,
  stageGroupForStage,
  stageGroupLabel,
  stageGroupWriteAllowed,
  type ResearchStageGroupId,
  type ResearchStageTab
} from './stage-groups';
import { explainRunError, firstSentence, researchStageLabels, researchStageOutputs } from './format';

/**
 * Research-workflow semantics as pure functions (P6/T6.1).
 *
 * This module is the answer to R17. The whole risk of P6 is that the stage axis —
 * the product's main spine — degrades into "just another field" once it is redrawn in
 * the new visual language. So every rule the UI obeys is expressed here as a function
 * of the *real* contract and is unit-tested without a DOM or an IPC stub:
 *
 *   - grouping and read-only rules (ported from `research-stage-groups.ts`)
 *   - `currentNextAction` — the single primary action for the current stage, derived
 *     from `status` + `gateRequired` + `gateApproved` + `lastError` + the run history
 *
 * Two contract facts shape `currentNextAction` and are worth stating up front, because
 * both were discovered by reading `src/main` (they are not guessable from the plan):
 *
 *   1. A completed parent run **auto-submits** the stage to its human gate
 *      (`stage-runtime.executeOutput` → `humanGate.complete`). A gate-required stage
 *      therefore lands in `waiting_approval` by itself; the UI's job there is the
 *      decision, not "提交审核". That state is also why `research.workflow.startRun`
 *      answers `research_stage_awaiting_gate` while a stage is `running` with a
 *      completed run: the guard exists to stop a second submission.
 *   2. `research.workflow.retryRun` only accepts a run in
 *      `failed|cancelled|interrupted`. After a gate **reject** the previous run is
 *      `completed`, so "重试" cannot be the retry interface; the stage has to be
 *      re-opened before it can run again. See the backend task order B19 and
 *      `stageRetryCommand` below.
 */

export {
  RESEARCH_STAGE_GROUPS,
  STAGE_GROUP_IDS,
  STAGE_TAB_IDS,
  defaultTabForGroup,
  isCurrentStageGroup,
  stageGroupForStage,
  stageGroupLabel,
  stageGroupWriteAllowed
};
export type { ResearchStageGroupId, ResearchStageTab };

/** Archived projects are read-only (P2). Re-exported so P6 has one import surface. */
export { isProjectWritable } from '../../project/project-store';

/* ------------------------------------------------------------------ */
/* Snapshot derivations                                                */
/* ------------------------------------------------------------------ */

export type StageState = ResearchWorkflowSnapshot['stages'][number];

export function currentStageState(workflow: ResearchWorkflowSnapshot): StageState {
  const current = workflow.stages.find((stage) => stage.stage === workflow.currentStage);
  if (current !== undefined) {
    return current;
  }
  // The backend always seeds all eleven stages, so this is a contract violation rather than a
  // state to render. An explicit throw beats `workflow.stages[0]!`, which would surface as a
  // `undefined` property read somewhere else entirely.
  const first = workflow.stages[0];
  if (first === undefined) {
    throw new Error('workflow_snapshot_stages_missing: research.workflow.get 没有返回任何阶段状态。');
  }
  return first;
}

export function stageStateFor(
  workflow: ResearchWorkflowSnapshot,
  stage: ResearchWorkflowSnapshot['currentStage']
): ResearchWorkflowSnapshot['stages'][number] | undefined {
  return workflow.stages.find((entry) => entry.stage === stage);
}

export function nextStageLabel(workflow: ResearchWorkflowSnapshot): string | null {
  const index = workflow.stages.findIndex((stage) => stage.stage === workflow.currentStage);
  const next = workflow.stages[index + 1];
  return next === undefined ? null : researchStageLabels[next.stage];
}

/** Artifacts attached to the stage that is current right now, in snapshot order. */
export function currentArtifacts(
  artifacts: readonly ResearchArtifact[],
  workflow: ResearchWorkflowSnapshot
): ResearchArtifact[] {
  const ids = new Set(currentStageState(workflow).artifactIds);
  return artifacts.filter((artifact) => ids.has(artifact.id));
}

/**
 * Newest **parent** run of the current stage.
 *
 * Child runs (review panels) are excluded on purpose: they are produced by the stage
 * run itself and never have their own next action.
 */
export function latestParentRun(
  runs: readonly ResearchStageRun[],
  workflow: ResearchWorkflowSnapshot
): ResearchStageRun | null {
  const matching = runs
    .filter((run) => run.stage === workflow.currentStage && run.parentRunId === null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return matching[0] ?? null;
}

/** The parent run that is still in flight, if any. */
export function activeParentRun(
  runs: readonly ResearchStageRun[],
  workflow: ResearchWorkflowSnapshot
): ResearchStageRun | null {
  const latest = latestParentRun(runs, workflow);
  if (latest === null) {
    return null;
  }
  return latest.status === 'queued' || latest.status === 'running' ? latest : null;
}

/** The review stage's approval additionally carries a verdict (`accept` / `revise`). */
export function reviewDecisionRequired(workflow: ResearchWorkflowSnapshot): boolean {
  const current = currentStageState(workflow);
  return current.stage === 'review' && current.status === 'waiting_approval';
}

/**
 * A stage **rejected at the gate**, as opposed to a stage that merely failed.
 *
 * `transitionWorkflow('reject')` sets `status: 'running'` with `gateApproved: false`
 * and the reviewer's note in `lastError`, while the run that produced the rejected
 * artifact stays `completed`. That triple is the signature — and it is why this
 * cannot be inferred from the status alone.
 */
export function isStageRejectedByGate(workflow: ResearchWorkflowSnapshot, runs: readonly ResearchStageRun[]): boolean {
  const current = currentStageState(workflow);
  if (current.status !== 'running' || current.gateApproved || current.lastError === null) {
    return false;
  }
  const latest = latestParentRun(runs, workflow);
  return latest !== null && latest.status === 'completed' && latest.error === null;
}

/* ------------------------------------------------------------------ */
/* The single next action                                              */
/* ------------------------------------------------------------------ */

export type WorkflowCommand =
  | { type: 'start' }
  | { type: 'retry'; runId: string }
  | { type: 'rerunStage'; instruction: string }
  | { type: 'complete' }
  | { type: 'approve'; reviewDecision?: 'accept' | 'revise' }
  | { type: 'reject' }
  | { type: 'cancel'; runId: string };

export type WorkflowButton = {
  command: WorkflowCommand;
  label: string;
  testId: string;
};

export type NextActionPlan = {
  /** Shown while a run is in flight, e.g. 「正在写出检索策略」. */
  statusLine: string | null;
  /** Title of the finished stage output, when there is one. */
  summaryLine: string | null;
  /** Mapped failure/rejection explanation — never a generic one-liner (P5's lesson). */
  detailLine: string | null;
  primary: WorkflowButton | null;
  /** 「取消运行」 lives here: a secondary action, never a second primary button. */
  secondary: WorkflowButton[];
  /** Non-null when nothing on this surface may be acted on, with the reason to show. */
  readOnlyReason: string | null;
};

export type NextActionInput = {
  workflow: ResearchWorkflowSnapshot;
  runs: readonly ResearchStageRun[];
  artifacts: readonly ResearchArtifact[];
  /** `project.description` — the default instruction when a stage starts. */
  description: string;
  /**
   * The stage-instruction draft typed in 阶段工作区 (T6.3).
   *
   * It only overrides the default when it differs from the last run's instruction: after a
   * failure the primary action must be 「用同一阶段指令重试」 (gate 2), but a user who has
   * just typed a *new* instruction must not have that click silently re-run the old one — so
   * a dirty draft promotes a plain start to the primary and keeps the retry as a secondary.
   */
  instructionDraft?: string;
  projectWritable: boolean;
};

const ARCHIVED_REASON = '项目已归档，仅可阅读：无法启动阶段运行、修改产物或写入文件。恢复项目后才能继续。';

export function startRunLabel(stage: ResearchWorkflowSnapshot['currentStage']): string {
  if (stage === 'discovery') {
    return '开始发现：写出检索策略';
  }
  return `开始${researchStageLabels[stage]}：${researchStageOutputs[stage]}`;
}

export function runningStageLabel(stage: ResearchWorkflowSnapshot['currentStage']): string {
  if (stage === 'discovery') {
    return '正在写出检索策略';
  }
  return `正在准备${researchStageOutputs[stage]}`;
}

export function completeStageLabel(workflow: ResearchWorkflowSnapshot): string {
  if (workflow.currentStage === 'discovery') {
    return '完成发现，进入检索';
  }
  const next = nextStageLabel(workflow);
  return next === null
    ? `完成${researchStageLabels[workflow.currentStage]}`
    : `完成${researchStageLabels[workflow.currentStage]}，进入${next}`;
}

/**
 * How to re-run a stage that cannot use `retryRun`.
 *
 * After a gate reject the sibling run is `completed`, so `research.workflow.retryRun`
 * refuses it (`research_run_not_retryable`) and `startRun` refuses the stage
 * (`research_stage_awaiting_gate`: `status === 'running'` *and* a completed parent
 * exists). The contract does allow starting on a **paused** stage, so the command
 * carries the instruction and the store pauses the stage first — see
 * `use-workflow-store.runStageAgain`. Registered as backend task order B19: `reject`
 * should leave the stage re-runnable instead of forcing a pause round-trip.
 */
function rerunStageCommand(instruction: string): WorkflowCommand {
  return { type: 'rerunStage', instruction };
}

/**
 * The one primary action for the current stage, plus the lines that explain it.
 *
 * Order matters and is the specification: in-flight → gate decision → rejected →
 * stopped → finished → start. Later branches are only reachable when every earlier
 * one declined.
 */
export function currentNextAction(input: NextActionInput): NextActionPlan {
  const { workflow, runs, artifacts, description, projectWritable } = input;
  const draft = (input.instructionDraft ?? '').trim();
  const current = currentStageState(workflow);
  const active = activeParentRun(runs, workflow);
  const latest = latestParentRun(runs, workflow);
  const produced = currentArtifacts(artifacts, workflow);
  const latestTitle = produced[produced.length - 1]?.title ?? null;

  if (!projectWritable) {
    return {
      statusLine: active === null ? null : runningStageLabel(current.stage),
      summaryLine: latestTitle,
      detailLine: null,
      primary: null,
      secondary: [],
      readOnlyReason: ARCHIVED_REASON
    };
  }

  if (active !== null) {
    return {
      statusLine: runningStageLabel(current.stage),
      summaryLine: null,
      detailLine: null,
      primary: null,
      secondary: [{ command: { type: 'cancel', runId: active.id }, label: '取消运行', testId: 'workflow-cancel-run' }],
      readOnlyReason: null
    };
  }

  if (current.status === 'waiting_approval') {
    if (reviewDecisionRequired(workflow)) {
      return {
        statusLine: null,
        summaryLine: latestTitle,
        detailLine: null,
        primary: {
          command: { type: 'approve', reviewDecision: 'accept' },
          label: '接受稿件',
          testId: 'workflow-approve'
        },
        secondary: [
          { command: { type: 'reject' }, label: '退回修改', testId: 'workflow-reject' },
          { command: { type: 'approve', reviewDecision: 'revise' }, label: '要求修订', testId: 'workflow-revise' }
        ],
        readOnlyReason: null
      };
    }
    return {
      statusLine: null,
      summaryLine: latestTitle,
      detailLine: null,
      primary: { command: { type: 'approve' }, label: '确认通过', testId: 'workflow-approve' },
      secondary: [{ command: { type: 'reject' }, label: '退回修改', testId: 'workflow-reject' }],
      readOnlyReason: null
    };
  }

  if (isStageRejectedByGate(workflow, runs)) {
    // The reviewer's note is the detail line and the *same* instruction is reused: the
    // rejection changed what must be verified, not what the stage was asked to do.
    const instruction = latest?.instruction.trim() || description.trim();
    return {
      statusLine: null,
      summaryLine: latestTitle,
      detailLine: current.lastError === null ? null : firstSentence(current.lastError),
      primary: {
        command: rerunStageCommand(instruction),
        label: '用同一阶段指令重试',
        testId: 'workflow-retry-run'
      },
      secondary: [],
      readOnlyReason: null
    };
  }

  const stopped =
    current.status === 'failed' ||
    current.status === 'blocked' ||
    current.status === 'paused' ||
    (current.status === 'running' && current.lastError !== null) ||
    (latest !== null && (latest.status === 'failed' || latest.status === 'cancelled' || latest.status === 'interrupted'));

  if (stopped) {
    const retryable =
      latest !== null && (latest.status === 'failed' || latest.status === 'cancelled' || latest.status === 'interrupted');
    const reason = current.lastError ?? latest?.error ?? null;
    const detailLine = reason === null ? null : explainRunError(reason);
    const retryButton: WorkflowButton = retryable
      ? {
          command: { type: 'retry', runId: latest.id },
          label: '用同一阶段指令重试',
          testId: 'workflow-retry-run'
        }
      : {
          command: rerunStageCommand(latest?.instruction.trim() || description.trim()),
          label: '用同一阶段指令重试',
          testId: 'workflow-retry-run'
        };
    const draftIsNew = draft.length > 0 && draft !== (latest?.instruction.trim() ?? '');
    if (draftIsNew) {
      return {
        statusLine: null,
        summaryLine: latestTitle,
        detailLine,
        primary: { command: { type: 'start' }, label: '用当前指令重新运行', testId: 'workflow-start-run' },
        secondary: [retryButton],
        readOnlyReason: null
      };
    }
    return {
      statusLine: null,
      summaryLine: latestTitle,
      detailLine,
      primary: retryButton,
      secondary: [],
      readOnlyReason: null
    };
  }

  const finished = latest?.status === 'completed' || produced.length > 0;
  if (current.status === 'running' && finished) {
    if (current.gateRequired && produced.length > 0) {
      // Transient: the run auto-submits, so this is only visible in the moment between
      // the run's completion and the gate's `waiting_approval`. Kept because the UI must
      // never show *no* action in a state the backend can actually be observed in.
      return {
        statusLine: null,
        summaryLine: latestTitle,
        detailLine: null,
        primary: { command: { type: 'complete' }, label: '提交审核', testId: 'workflow-submit' },
        secondary: [],
        readOnlyReason: null
      };
    }
    if (!current.gateRequired) {
      return {
        statusLine: null,
        summaryLine: latestTitle,
        detailLine: null,
        primary: { command: { type: 'complete' }, label: completeStageLabel(workflow), testId: 'workflow-complete' },
        secondary: [],
        readOnlyReason: null
      };
    }
  }

  if (current.status === 'completed') {
    // Only the last stage can be both current and completed: `completeStage` moves
    // `currentStage` forward for every other stage. So this is "the workflow is done" and
    // there is deliberately no next action.
    return {
      statusLine: null,
      summaryLine: latestTitle,
      detailLine: `科研流程已完成，「${researchStageLabels[current.stage]}」是最后一个阶段。`,
      primary: null,
      secondary: [],
      readOnlyReason: null
    };
  }

  if (current.status === 'locked') {
    return {
      statusLine: null,
      summaryLine: null,
      detailLine: `上一阶段还没有完成，「${researchStageLabels[current.stage]}」保持只读。`,
      primary: null,
      secondary: [],
      readOnlyReason: null
    };
  }

  return {
    statusLine: null,
    summaryLine: null,
    detailLine: null,
    primary: { command: { type: 'start' }, label: startRunLabel(current.stage), testId: 'workflow-start-run' },
    secondary: [],
    readOnlyReason: null
  };
}
