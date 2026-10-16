import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ResearchArtifact,
  ResearchIndexStatus,
  ResearchProject,
  ResearchReviewCycle,
  ResearchStagePolicy,
  ResearchStageRoleProfile,
  ResearchStageRun,
  ResearchWorkflowEvent,
  ResearchWorkflowSnapshot
} from '../../../shared/types';
import type { AsyncStatus } from '../../app/use-async-resource';
import { errorMessage } from '../../app/loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { getIndexStatus } from '../../literature/library-store';
import { activeParentRun, currentStageState, isStageRejectedByGate, type WorkflowCommand } from './workflow-rules';
import {
  cancelStageRun,
  createRequestId,
  getReviewCycle,
  getRoleProfile,
  getWorkflow,
  listArtifacts,
  listStageRuns,
  listStagePolicies,
  listWorkflowEvents,
  retryStageRun,
  startStageRun,
  transitionWorkflow
} from './workflow-store';

/**
 * The research-workflow data hook (P6/T6.2–T6.4, T6.9).
 *
 * Created **once per project in the shell** and shared through `WorkflowScope`, for the
 * same reason the literature store is (P5/T5.1): 总览, 阶段工作区 and 活动流 are separate
 * canvas views that must agree about the stage, the runs and the gate. Two instances
 * would each poll, and the one that mounted first would be the stale one.
 *
 * **Polling, not push.** `research.workflow.*` has no event channel (B11), so the only
 * honest way to watch a run is to ask again. The poll runs *only* while something is in
 * flight (`activeParentRun`), because a timer that ticks over a static project is a
 * battery cost with no user-visible benefit; the interval is deliberately slow (2s) since
 * a stage run takes minutes.
 *
 * **Actions are sequenced, not optimistic.** Every command answers with the refreshed
 * snapshot or the backend's own error message; nothing is guessed in the renderer, so the
 * primary action can never claim to have advanced a stage it did not (P4/P5's lesson:
 * 「状态里有」≠「界面有」).
 */

export type WorkflowSnapshotBundle = {
  workflow: ResearchWorkflowSnapshot | null;
  runs: ResearchStageRun[];
  artifacts: ResearchArtifact[];
  events: ResearchWorkflowEvent[];
  indexStatus: ResearchIndexStatus | null;
  /** `research.index.status` fails with `workspace_path_missing` before a workspace exists. */
  indexUnavailableReason: string | null;
  role: ResearchStageRoleProfile | null;
  reviewCycle: ResearchReviewCycle | null;
  policies: ResearchStagePolicy[];
};

const emptyBundle: WorkflowSnapshotBundle = {
  workflow: null,
  runs: [],
  artifacts: [],
  events: [],
  indexStatus: null,
  indexUnavailableReason: null,
  role: null,
  reviewCycle: null,
  policies: []
};

export type WorkflowActionOptions = {
  /** Typed stage instruction; empty means "use the project description". */
  instruction?: string;
  /** The reviewer's note, attached to a rejection. */
  note?: string;
};

export type WorkflowStore = WorkflowSnapshotBundle & {
  /** The project this workflow belongs to, as the shell already loaded it. */
  project: ResearchProject | null;
  /**
   * The optional stage-instruction draft (T6.3).
   *
   * It lives in the store rather than in a component because two surfaces use it: the
   * stage workspace types it, and 总览's primary action sends it — and the flow buttons
   * deliberately live only on 总览 (T6.3), so a component-local copy would be dropped on
   * the way. Empty means "use the project description", which is what the backend asks
   * for (a stage run's instruction is required).
   */
  instruction: string;
  setInstruction: (value: string) => void;
  status: AsyncStatus;
  error: string | null;
  busy: boolean;
  actionError: string | null;
  /** True while this store is polling because a run is in flight. */
  polling: boolean;
  refresh: () => void;
  runAction: (command: WorkflowCommand, options?: WorkflowActionOptions) => Promise<boolean>;
  dismissActionError: () => void;
};

const POLL_INTERVAL_MS = 2000;
const EVENT_LIMIT = 50;
const RUN_LIMIT = 50;

type CommandOutcome = { ok: true } | { ok: false; message: string };

export function useWorkflowStore(
  client: RocClient,
  projectId: string | null,
  project: ResearchProject | null
): WorkflowStore {
  /**
   * The bundle **together with the project it was loaded for**.
   *
   * Same reasoning as `useAsyncResource`'s key-tagged value: keeping them apart let a
   * project→project switch render the previous project's stage, gate, artifacts and goal for one
   * IPC round-trip — and `ProjectOverview`'s `project === null` guard turned that moment into a
   * false 「读取项目流程失败」 bar. Tagging makes staleness unrepresentable.
   */
  const [loaded, setLoaded] = useState<{ projectId: string; bundle: WorkflowSnapshotBundle } | null>(null);
  const [status, setStatus] = useState<AsyncStatus>(projectId === null ? 'idle' : 'loading');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [instruction, setInstruction] = useState('');
  /**
   * The draft belongs to one project.
   *
   * It is sent as `startRun.instruction` by 总览's primary action, so carrying it across a project
   * switch would submit project A's instruction into project B's run record and workflow events.
   * Cleared here rather than in each view because the store is the only thing that survives the
   * switch.
   */
  const instructionScopeRef = useRef<string | null>(projectId);
  if (instructionScopeRef.current !== projectId) {
    instructionScopeRef.current = projectId;
    if (instruction !== '') {
      setInstruction('');
    }
  }

  /** Guards against a slow load from a previous project overwriting the new one. */
  const scopeRef = useRef<string | null>(projectId);
  scopeRef.current = projectId;

  useEffect(() => {
    if (projectId === null) {
      setLoaded(null);
      setStatus('idle');
      setError(null);
      return;
    }
    let cancelled = false;
    setStatus('loading');
    setError(null);
    void (async () => {
      try {
        const [workflow, runs, artifacts, events, index] = await Promise.all([
          getWorkflow(client, projectId),
          listStageRuns(client, projectId, RUN_LIMIT),
          listArtifacts(client, projectId),
          listWorkflowEvents(client, projectId, EVENT_LIMIT),
          getIndexStatus(client, projectId)
        ]);
        if (cancelled || scopeRef.current !== projectId) {
          return;
        }
        if (!workflow.ok) {
          setStatus('error');
          setError(workflow.error.message);
          return;
        }
        // The role profile and the review cycle are per-stage/per-project and small, but
        // they can only be asked for once the current stage is known.
        const [role, reviewCycle, policies] = await Promise.all([
          getRoleProfile(client, workflow.data.currentStage),
          getReviewCycle(client, projectId),
          listStagePolicies(client, projectId)
        ]);
        if (cancelled || scopeRef.current !== projectId) {
          return;
        }
        setLoaded({
          projectId,
          bundle: {
          workflow: workflow.data,
          runs: runs.ok ? runs.data : [],
          artifacts: artifacts.ok ? artifacts.data : [],
          events: events.ok ? events.data : [],
          indexStatus: index.ok ? index.data : null,
          indexUnavailableReason: index.ok ? null : index.error.message,
          role: role.ok ? role.data : null,
          reviewCycle: reviewCycle.ok ? reviewCycle.data : null,
          policies: policies.ok ? policies.data : []
          }
        });
        setStatus('ready');
      } catch (caught) {
        if (!cancelled && scopeRef.current === projectId) {
          setStatus('error');
          setError(errorMessage(caught));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // `project` is deliberately not a dependency: the workflow is keyed by project id, and
    // a project title edit must not re-fetch the whole workflow.
  }, [client, projectId, nonce]);

  /**
   * Refresh without the loading state.
   *
   * Used by the poll and by every post-action refresh: re-entering `loading` would blank
   * the stage bar on each tick, which reads as a broken surface rather than a live one.
   */
  const refresh = useCallback(() => {
    setNonce((current) => current + 1);
  }, []);

  const bundle = loaded !== null && loaded.projectId === projectId ? loaded.bundle : emptyBundle;
  const workflow = bundle.workflow;
  const active = workflow === null ? null : activeParentRun(bundle.runs, workflow);
  /**
   * When to keep asking.
   *
   * Two reasons, and one exclusion:
   *   - a run is in flight (`activeParentRun`), which is the only case the module doc promises;
   *   - the stage claims to be `running` while we cannot see that run — a failed
   *     `listRuns` (the list is empty, so `activeParentRun` says nothing) or the brief window
   *     between `runs.complete` and the gate's auto-submit;
   *   - **except** the gate-rejected state, which is `running` with a completed run and stays that
   *     way until the user acts: polling a static stage forever would be a battery cost with no
   *     user-visible benefit.
   */
  const stageRunning = workflow !== null && currentStageState(workflow).status === 'running';
  const rejected = workflow !== null && isStageRejectedByGate(workflow, bundle.runs);
  const polling = active !== null || (stageRunning && !rejected);

  useEffect(() => {
    if (!polling || projectId === null) {
      return;
    }
    const timer = window.setInterval(() => {
      setNonce((current) => current + 1);
    }, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [polling, projectId]);

  const runAction = useCallback(
    async (command: WorkflowCommand, options: WorkflowActionOptions = {}): Promise<boolean> => {
      if (projectId === null || workflow === null) {
        setActionError('尚未进入项目，无法操作阶段流程。');
        return false;
      }
      const instruction = (options.instruction ?? '').trim() || (project?.description ?? '').trim();
      if ((command.type === 'start' || command.type === 'rerunStage') && instruction.length === 0) {
        setActionError('阶段指令不能为空：项目研究目标也没有可用的文字。');
        return false;
      }
      setBusy(true);
      setActionError(null);
      let outcome: CommandOutcome;
      try {
        outcome = await executeWorkflowCommand(client, {
          projectId,
          command,
          instruction,
          expectedStage: workflow.currentStage,
          stageStatus: currentStageState(workflow).status,
          note: options.note
        });
      } catch (caught) {
        outcome = { ok: false, message: errorMessage(caught) };
      }
      setBusy(false);
      if (!outcome.ok) {
        setActionError(outcome.message);
        return false;
      }
      setNonce((current) => current + 1);
      return true;
    },
    [client, project?.description, projectId, workflow]
  );

  const dismissActionError = useCallback(() => {
    setActionError(null);
  }, []);

  return useMemo(
    () => ({
      ...bundle,
      project,
      instruction,
      setInstruction,
      status,
      error,
      busy,
      actionError,
      polling,
      refresh,
      runAction,
      dismissActionError
    }),
    [
      bundle,
      project,
      instruction,
      status,
      error,
      busy,
      actionError,
      polling,
      refresh,
      runAction,
      dismissActionError
    ]
  );
}

type CommandInput = {
  projectId: string;
  command: WorkflowCommand;
  instruction: string;
  expectedStage: ResearchStageRun['stage'];
  /** The current stage's status, so `rerunStage` only pauses when it has to. */
  stageStatus: ResearchWorkflowSnapshot['stages'][number]['status'];
  note: string | undefined;
};

/** One command → one IPC call (or the two the `rerunStage` state legally needs). */
async function executeWorkflowCommand(client: RocClient, input: CommandInput): Promise<CommandOutcome> {
  const { projectId, command, instruction, expectedStage, stageStatus, note } = input;
  switch (command.type) {
    case 'start': {
      const started = await startStageRun(client, {
        projectId,
        expectedStage,
        instruction,
        requestId: createRequestId()
      });
      return started.ok ? { ok: true } : { ok: false, message: started.error.message };
    }
    case 'retry': {
      const retried = await retryStageRun(client, {
        projectId,
        runId: command.runId,
        requestId: createRequestId()
      });
      return retried.ok ? { ok: true } : { ok: false, message: retried.error.message };
    }
    case 'rerunStage':
      return rerunStage(client, projectId, expectedStage, command.instruction || instruction, stageStatus);
    case 'cancel': {
      const cancelled = await cancelStageRun(client, projectId, command.runId);
      return cancelled.ok ? { ok: true } : { ok: false, message: cancelled.error.message };
    }
    case 'approve': {
      const approved = await transitionWorkflow(
        client,
        command.reviewDecision === undefined
          ? { projectId, expectedStage, action: 'approve' }
          : { projectId, expectedStage, action: 'approve', reviewDecision: command.reviewDecision }
      );
      return approved.ok ? { ok: true } : { ok: false, message: approved.error.message };
    }
    case 'reject': {
      const withNote = (note ?? '').trim();
      const rejected = await transitionWorkflow(client, {
        projectId,
        expectedStage,
        action: 'reject',
        note: withNote.length === 0 ? '请补充证据或修改阶段产物。' : withNote
      });
      return rejected.ok ? { ok: true } : { ok: false, message: rejected.error.message };
    }
    default: {
      const completed = await transitionWorkflow(client, { projectId, expectedStage, action: 'complete' });
      return completed.ok ? { ok: true } : { ok: false, message: completed.error.message };
    }
  }
}

/**
 * Re-runs a stage that `retryRun` will not accept.
 *
 * The contract (read in `stage-runtime.ts` + `run-repository.ts`, and confirmed by the P6
 * gate run) refuses both halves of the obvious approach after a gate **reject**:
 *
 *   - `retryRun` requires `failed|cancelled|interrupted`, and the rejected artifact's run
 *     is `completed`;
 *   - `startRun` requires the stage not to be `running` with a completed parent
 *     (`research_stage_awaiting_gate`), and `reject` leaves the stage `running`.
 *
 * What the contract *does* allow is starting a run on a `paused` stage. So the re-run is
 * pause → start; the pause is an implementation detail of reaching a legal state, and the
 * rejection note stays visible in `lastError` as the stage's reason. Registered as backend
 * task order B19: `reject` should leave the stage re-runnable so this round-trip disappears.
 */
async function rerunStage(
  client: RocClient,
  projectId: string,
  expectedStage: ResearchStageRun['stage'],
  instruction: string,
  stageStatus: ResearchWorkflowSnapshot['stages'][number]['status']
): Promise<CommandOutcome> {
  /**
   * The pause is **conditional**, and that matters.
   *
   * `pause` is only legal while the stage is `running` (`repository.ts` → `research_stage_not_running`).
   * Pausing unconditionally meant that a failed `startRun` left the stage `paused`, after which the
   * only primary action (`rerunStage`) would try to pause again and fail forever — an
   * undiscoverable dead end. `startRun` accepts `ready|running|paused|failed|blocked`, so the
   * rejection case (`running` with a completed parent) is the only one that needs the pause.
   */
  if (stageStatus === 'running') {
    const paused = await transitionWorkflow(client, { projectId, expectedStage, action: 'pause' });
    if (!paused.ok) {
      return { ok: false, message: paused.error.message };
    }
  }
  const started = await startStageRun(client, {
    projectId,
    expectedStage,
    instruction,
    requestId: createRequestId()
  });
  return started.ok ? { ok: true } : { ok: false, message: started.error.message };
}
