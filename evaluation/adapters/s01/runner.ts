import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toAgentTaskView, qualityHash, freezeQualityDataset, qualityValidatorSchema, deepFreeze, type FrozenQualityDataset, type QualityExpectations, type AgentTaskView, type QualityTask } from './dataset';
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
  temperature: number;
  isolationHash: string;
  isolation: 'process-files-tools' | 'fixture-object';
};

export type QualityExecutor = {
  binding: QualityExecutorBinding;
  execute(view: AgentTaskView, context: {
    arm: Arm; trialId: string; repeatIndex: number; signal: AbortSignal;
    recordRequest(input: { requestHash: string }): Promise<void>;
  }): Promise<{ output: string | null }>;
};

export class QualityExecutionFailure extends Error {
  constructor(readonly failureClass: QualityFailureClass, readonly stopReason?: string) {
    super(`quality_execution_${failureClass}`);
    this.name = 'QualityExecutionFailure';
  }
}

export type QualityRunnerEvent = {
  type: 'started' | 'dispatched' | 'request' | 'finished' | 'completed';
  trialId: string | null;
  outcome: QualityArmOutcome | null;
  requestHash?: string;
};

export function qualityPromptSetHash(dataset: FrozenQualityDataset, mode: 'fixture' | 'pilot' | 'full'): string {
  return qualityHash(selectedTasks(dataset, mode).map(toAgentTaskView));
}

function selectedTasks(dataset: FrozenQualityDataset, mode: 'fixture' | 'pilot' | 'full') {
  const split = mode === 'fixture' ? 'fixture' : mode === 'pilot' ? 'dev' : 'holdout';
  return dataset.tasks.filter(task => task.split === split);
}

/** Exclusive journal creation makes restart refuse an already dispatched protocol. */
export async function runQualityEvaluationWithJournal(input: {
  dataset: FrozenQualityDataset;
  expectations: QualityExpectations;
  protocol: QualityEvaluationProtocol;
  executor: QualityExecutor;
  signal: AbortSignal;
  artifactsRoot: string;
}) {
  assertQualityProtocolAuthorized(input.dataset, input.protocol);
  const directory = join(input.artifactsRoot, 'quality');
  await mkdir(directory, { recursive: true });
  const journalPath = join(directory, `${input.protocol.lockHash}.jsonl`);
  const journal = await open(journalPath, 'wx', 0o600);
  try {
    await journal.appendFile(`${JSON.stringify({ protocol: input.protocol, binding: input.executor.binding })}\n`);
    await journal.sync();
    const result = await runQualityEvaluation({
      dataset: input.dataset, expectations: input.expectations, protocol: input.protocol, executor: input.executor, signal: input.signal,
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

function failure(failureClass: QualityFailureClass, latencyMs: number): QualityArmOutcome {
  return { status: 'failure', score: null, latencyMs, failureClass };
}

/**
 * Runs the selected frozen split sequentially. Event writes are awaited before dispatch;
 * callers must retain a one-use durable journal and never automatically replay a dispatched trial.
 */
export async function runQualityEvaluation(input: {
  dataset: FrozenQualityDataset;
  expectations: QualityExpectations;
  protocol: QualityEvaluationProtocol;
  executor: QualityExecutor;
  signal: AbortSignal;
  writeEvent(event: QualityRunnerEvent): Promise<void>;
}) {
  assertQualityProtocolAuthorized(input.dataset, input.protocol);
  const { datasetHash, ...manifest } = input.dataset;
  const dataset = freezeQualityDataset(manifest, datasetHash);
  const expectations = deepFreeze(structuredClone(input.expectations));
  for (const task of dataset.tasks) {
    const validator = qualityValidatorSchema.parse(expectations[task.id]);
    if (qualityHash(validator) !== task.expectedHash) throw new Error('quality_runner_expected_changed');
  }
  const protocol = structuredClone(input.protocol);
  const { executor, signal, writeEvent } = input;
  const lock = protocol.lock;
  Object.freeze(lock);
  Object.freeze(protocol);
  Object.freeze(executor.binding);
  if (lock.executionMode !== 'fixture' && (executor.binding.evidence !== 'live-model'
    || executor.binding.isolation !== 'process-files-tools')) throw new Error('quality_runner_live_isolation_required');
  if (lock.executionMode === 'fixture' && executor.binding.evidence !== 'fixture') throw new Error('quality_runner_fixture_binding_required');
  if (lock.promptSetHash !== qualityPromptSetHash(dataset, lock.executionMode)) throw new Error('quality_runner_prompt_set_changed');
  for (const key of ['providerId', 'baselineModelId', 'candidateModelId', 'baselineCommitSha',
    'candidateCommitSha', 'toolManifestHash', 'environmentHash', 'temperature', 'isolationHash'] as const) {
    if (executor.binding[key] !== lock[key]) throw new Error(`quality_runner_binding_mismatch:${key}`);
  }
  if (!['fixture', 'live-model'].includes(executor.binding.evidence)) throw new Error('quality_runner_evidence_invalid');
  let dispatches = 0;
  let stopReason: string | null = null;
  const trials: PairedQualityTrial[] = [];
  const validations: Array<{ trialId: string; validation: QualityValidationResult | null }> = [];
  await writeEvent({ type: 'started', trialId: null, outcome: null });

  async function runArm(task: QualityTask, repeatIndex: number, arm: Arm): Promise<QualityArmOutcome> {
    const trialId = `${task.id}:${repeatIndex}:${arm}`;
    if (signal.aborted || stopReason !== null) {
      return failure(signal.aborted ? 'operator' : 'policy', 0);
    }
    const view = toAgentTaskView(task);
    await writeEvent({ type: 'dispatched', trialId, outcome: null });
    dispatches += 1;
    const started = performance.now();
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error('quality_runner_timeout')), lock.taskTimeoutMs);
    let output: string | null = null;
    let executionFailure: QualityFailureClass | null = null;
    try {
      if (signal.aborted) abort();
      controller.signal.throwIfAborted();
      const pending = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return executor.execute(view, {
          arm, trialId, repeatIndex, signal: controller.signal,
          async recordRequest(request) {
            controller.signal.throwIfAborted();
            if (!/^[a-f0-9]{64}$/u.test(request.requestHash)) throw new QualityExecutionFailure('policy', 'executor_request_invalid');
            try {
              await writeEvent({ type: 'request', trialId, outcome: null, requestHash: request.requestHash });
            } catch {
              throw new QualityExecutionFailure('infra', 'executor_journal_failed');
            }
            controller.signal.throwIfAborted();
          }
        });
      });
      const result = await new Promise<Awaited<typeof pending>>((resolve, reject) => {
        const interrupted = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', interrupted, { once: true });
        pending.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', interrupted));
      });
      output = result.output;
    } catch (error) {
      if (controller.signal.aborted) {
        stopReason = signal.aborted ? 'cancelled' : 'executor_abort_unconfirmed';
        executionFailure = signal.aborted ? 'operator' : 'infra';
      } else {
        // Adapters may be separately bundled host modules; their Error constructor identity
        // differs while the explicit trusted-host failure contract remains the same.
        const classified = error as Partial<QualityExecutionFailure> | null;
        executionFailure = error instanceof Error && error.name === 'QualityExecutionFailure'
          && classified?.failureClass !== undefined && QUALITY_FAILURE_CLASSES.includes(classified.failureClass)
          ? classified.failureClass : 'infra';
        if (error instanceof Error && error.name === 'QualityExecutionFailure' && classified?.stopReason !== undefined) {
          stopReason = classified.stopReason;
        }
      }
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
    }
    const latencyMs = performance.now() - started;
    const validation = executionFailure === null && output !== null ? validateQualityTaskOutput(expectations[task.id], output) : null;
    validations.push({ trialId, validation });
    const outcome: QualityArmOutcome = executionFailure !== null
      ? failure(executionFailure, latencyMs)
      : validation === null || !validation.passed ? failure('agent', latencyMs)
        : { status: 'success', score: validation.score, latencyMs };
    await writeEvent({ type: 'finished', trialId, outcome });
    return outcome;
  }

  for (const task of selectedTasks(dataset, lock.executionMode)) {
    for (let repeatIndex = 0; repeatIndex < protocol.repeatsPerTask; repeatIndex += 1) {
      const arms: Record<Arm, QualityArmOutcome> = {} as Record<Arm, QualityArmOutcome>;
      // Counterbalance order without changing the preregistered task/repeat identities.
      const order: Arm[] = parseInt(createHash('sha256').update(`${protocol.seed}:${task.id}:${repeatIndex}`).digest('hex').slice(0, 8), 16) % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
      for (const arm of order) arms[arm] = await runArm(task, repeatIndex, arm);
      trials.push({ taskId: task.id, family: task.family, clusterId: task.clusterId, repeatIndex, ...arms });
    }
  }
  await writeEvent({ type: 'completed', trialId: null, outcome: null });
  return {
    evidence: executor.binding.evidence, datasetHash: dataset.datasetHash, executionMode: lock.executionMode, lockHash: protocol.lockHash, dispatches,
    stopReason, trials, validations,
    statistics: summarizePairedQualityTrials(trials, {
      dataset, evidence: executor.binding.evidence, repeatsPerTask: protocol.repeatsPerTask, bootstrapIterations: protocol.bootstrapIterations, seed: protocol.seed,
      targetCaseCount: protocol.targetCaseCount, minimumClustersPerFamily: protocol.minimumClustersPerFamily,
      nonInferiorityMargin: protocol.nonInferiorityMargin, targetByFamily: protocol.targetByFamily
    })
  };
}
