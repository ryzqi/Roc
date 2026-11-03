import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { QUALITY_TASKS, toAgentTaskView, type AgentTaskView, type QualityTask } from './data';
import { assertQualityProtocolAuthorized, type QualityEvaluationProtocol } from './protocol';
import {
  QUALITY_FAILURE_CLASSES, summarizePairedQualityTrials,
  type PairedQualityTrial, type QualityArmOutcome, type QualityFailureClass
} from './statistics';
import { validateQualityTaskOutput, type QualityValidationResult } from './validators';

type Arm = 'baseline' | 'candidate';

export type QualityExecutorBinding = {
  evidence: 'fixture' | 'live-model';
  providerId: string;
  baselineModelId: string;
  candidateModelId: string;
  baselineCommitSha: string;
  candidateCommitSha: string;
  toolManifestHash: string;
  environmentHash: string;
};

/**
 * Trusted host adapter. It must cap every provider request and all internal retries within
 * the quoted trial ceiling, and stop those requests when signal aborts.
 * This interface alone does not establish that a provider or sandbox enforces those limits.
 */
export type QualityExecutor = {
  binding: QualityExecutorBinding;
  quote(view: AgentTaskView, arm: Arm): number | null;
  execute(view: AgentTaskView, context: {
    arm: Arm; trialId: string; repeatIndex: number; maximumCostMicrousd: number; signal: AbortSignal;
  }): Promise<{ output: string | null; costMicrousd: number | null }>;
};

export class QualityExecutionFailure extends Error {
  constructor(readonly failureClass: QualityFailureClass) {
    super(`quality_execution_${failureClass}`);
  }
}

export type QualityRunnerEvent = {
  type: 'started' | 'dispatched' | 'finished' | 'completed';
  trialId: string | null;
  heldCostMicrousd: number;
  reservedCostMicrousd: number | null;
  outcome: QualityArmOutcome | null;
};

export function qualityPromptSetHash(): string {
  return createHash('sha256').update(JSON.stringify(QUALITY_TASKS.map(toAgentTaskView))).digest('hex');
}

export function qualityPilotAudit(): Record<string, unknown> {
  const byFamily = Object.fromEntries([...new Set(QUALITY_TASKS.map((task) => task.family))].map((family) => {
    const tasks = QUALITY_TASKS.filter((task) => task.family === family);
    return [family, { tasks: tasks.length, clusters: new Set(tasks.map((task) => task.clusterId)).size }];
  }));
  return {
    scope: 'frozen-pilot-only', tasks: QUALITY_TASKS.length, byFamily,
    splits: [...new Set(QUALITY_TASKS.map((task) => task.split))],
    promptSetHash: qualityPromptSetHash(), fullDatasetReady: false,
    missing: ['reviewed-independent-200-task-corpus', 'train-dev-holdout-source-separation',
      'five-independent-clusters-per-family', 'blind-domain-review', 'isolated-live-executor-and-pricing']
  };
}

/** Exclusive journal creation makes restart refuse an already dispatched protocol. */
export async function runQualityPilotWithJournal(input: {
  protocol: QualityEvaluationProtocol;
  executor: QualityExecutor;
  signal: AbortSignal;
  artifactsRoot: string;
}) {
  assertQualityProtocolAuthorized(input.protocol);
  const directory = join(input.artifactsRoot, 'quality');
  await mkdir(directory, { recursive: true });
  const journalPath = join(directory, `${input.protocol.lockHash}.jsonl`);
  const journal = await open(journalPath, 'wx', 0o600);
  try {
    await journal.appendFile(`${JSON.stringify({ protocol: input.protocol, binding: input.executor.binding })}\n`);
    await journal.sync();
    const result = await runQualityPilot({
      protocol: input.protocol, executor: input.executor, signal: input.signal,
      async writeEvent(event) {
        await journal.appendFile(`${JSON.stringify(event)}\n`);
        await journal.sync();
      }
    });
    const reportPath = join(directory, `${input.protocol.lockHash}.json`);
    await writeFile(reportPath, JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
    return { result, journalPath, reportPath };
  } finally {
    await journal.close();
  }
}

function costLimit(usd: number): number {
  const value = usd * 1_000_000;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('quality_runner_cost_limit_invalid');
  return value;
}

function failure(failureClass: QualityFailureClass, latencyMs: number, costUsd: number | null): QualityArmOutcome {
  return { status: 'failure', score: null, latencyMs, costUsd, failureClass };
}

/**
 * Runs the frozen paired pilot sequentially. Event writes are awaited before dispatch;
 * callers must retain a one-use durable journal and never automatically replay a dispatched trial.
 */
export async function runQualityPilot(input: {
  protocol: QualityEvaluationProtocol;
  executor: QualityExecutor;
  signal: AbortSignal;
  writeEvent(event: QualityRunnerEvent): Promise<void>;
}) {
  assertQualityProtocolAuthorized(input.protocol);
  const protocol = structuredClone(input.protocol);
  const { executor, signal, writeEvent } = input;
  const lock = protocol.lock;
  Object.freeze(lock);
  Object.freeze(protocol);
  Object.freeze(executor.binding);
  if (lock.executionMode !== 'pilot') throw new Error('quality_runner_pilot_required');
  if (lock.promptSetHash !== qualityPromptSetHash()) throw new Error('quality_runner_prompt_set_changed');
  for (const key of ['providerId', 'baselineModelId', 'candidateModelId', 'baselineCommitSha',
    'candidateCommitSha', 'toolManifestHash', 'environmentHash'] as const) {
    if (executor.binding[key] !== lock[key]) throw new Error(`quality_runner_binding_mismatch:${key}`);
  }
  if (!['fixture', 'live-model'].includes(executor.binding.evidence)) throw new Error('quality_runner_evidence_invalid');
  const totalLimit = costLimit(lock.maxTotalCostUsd);
  const trialLimit = costLimit(lock.maxPerTaskCostUsd);
  let heldCost = 0;
  let dispatches = 0;
  let unknownCalls = 0;
  let stopReason: string | null = null;
  const trials: PairedQualityTrial[] = [];
  const validations: Array<{ trialId: string; validation: QualityValidationResult | null }> = [];
  await writeEvent({ type: 'started', trialId: null, heldCostMicrousd: heldCost, reservedCostMicrousd: null, outcome: null });

  async function runArm(task: QualityTask, repeatIndex: number, arm: Arm): Promise<QualityArmOutcome> {
    const trialId = `${task.id}:${repeatIndex}:${arm}`;
    if (signal.aborted || stopReason !== null) {
      return failure(signal.aborted ? 'operator' : 'policy', 0, 0);
    }
    const view = toAgentTaskView(task);
    let reserved: number | null;
    try {
      reserved = executor.quote(view, arm);
    } catch {
      return failure('infra', 0, 0);
    }
    if (reserved === null || !Number.isSafeInteger(reserved) || reserved <= 0 || reserved > trialLimit
      || reserved > totalLimit - heldCost) {
      return failure('policy', 0, 0);
    }
    heldCost += reserved;
    await writeEvent({ type: 'dispatched', trialId, heldCostMicrousd: heldCost, reservedCostMicrousd: reserved, outcome: null });
    dispatches += 1;
    const started = performance.now();
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error('quality_runner_timeout')), lock.taskTimeoutMs);
    let output: string | null = null;
    let actualCost: number | null = null;
    let executionFailure: QualityFailureClass | null = null;
    try {
      if (signal.aborted) abort();
      controller.signal.throwIfAborted();
      const pending = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return executor.execute(view, {
          arm, trialId, repeatIndex, maximumCostMicrousd: reserved, signal: controller.signal
        });
      });
      const result = await new Promise<Awaited<typeof pending>>((resolve, reject) => {
        const interrupted = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', interrupted, { once: true });
        pending.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', interrupted));
      });
      if (result.costMicrousd !== null && (!Number.isSafeInteger(result.costMicrousd) || result.costMicrousd < 0
        || result.costMicrousd > reserved)) {
        stopReason = 'executor_cost_ceiling_violated';
        executionFailure = 'effect';
      } else {
        actualCost = result.costMicrousd;
        output = result.output;
        if (actualCost !== null) heldCost -= reserved - actualCost;
      }
    } catch (error) {
      if (controller.signal.aborted) {
        stopReason = signal.aborted ? 'cancelled' : 'executor_abort_unconfirmed';
        executionFailure = signal.aborted ? 'operator' : 'infra';
      } else {
        executionFailure = error instanceof QualityExecutionFailure && QUALITY_FAILURE_CLASSES.includes(error.failureClass)
          ? error.failureClass : 'infra';
      }
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
    }
    const latencyMs = performance.now() - started;
    if (actualCost === null) unknownCalls += 1;
    const validation = executionFailure === null && output !== null ? validateQualityTaskOutput(task, output) : null;
    validations.push({ trialId, validation });
    const costUsd = actualCost === null ? null : actualCost / 1_000_000;
    const outcome: QualityArmOutcome = executionFailure !== null
      ? failure(executionFailure, latencyMs, costUsd)
      : validation === null || !validation.passed ? failure('agent', latencyMs, costUsd)
        : { status: 'success', score: validation.score, latencyMs, costUsd };
    await writeEvent({ type: 'finished', trialId, heldCostMicrousd: heldCost, reservedCostMicrousd: reserved, outcome });
    return outcome;
  }

  for (const task of QUALITY_TASKS) {
    for (let repeatIndex = 0; repeatIndex < protocol.repeatsPerTask; repeatIndex += 1) {
      const arms: Record<Arm, QualityArmOutcome> = {} as Record<Arm, QualityArmOutcome>;
      // Counterbalance order without changing the preregistered task/repeat identities.
      const order: Arm[] = repeatIndex % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
      for (const arm of order) arms[arm] = await runArm(task, repeatIndex, arm);
      trials.push({ taskId: task.id, family: task.family, clusterId: task.clusterId, repeatIndex, ...arms });
    }
  }
  await writeEvent({ type: 'completed', trialId: null, heldCostMicrousd: heldCost, reservedCostMicrousd: null, outcome: null });
  return {
    evidence: executor.binding.evidence, lockHash: protocol.lockHash, dispatches, unknownCalls,
    heldCostMicrousd: heldCost, stopReason, trials, validations,
    statistics: summarizePairedQualityTrials(trials, {
      repeatsPerTask: protocol.repeatsPerTask, bootstrapIterations: protocol.bootstrapIterations, seed: protocol.seed,
      targetCaseCount: protocol.targetCaseCount, minimumClustersPerFamily: protocol.minimumClustersPerFamily,
      nonInferiorityMargin: protocol.nonInferiorityMargin, targetByFamily: protocol.targetByFamily
    })
  };
}
