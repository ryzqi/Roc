import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BindToolsInput
} from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import { InMemoryStore } from '@langchain/langgraph';
import { StateBackend } from 'deepagents';
import { describe, it, vi } from 'vitest';
import { z } from 'zod';

import { createChatRunEventQueue } from '../../src/main/plugins/agent/chat-run-event-queue';
import {
  compileRunCapabilityManifest,
  isRunCapabilityManifestIntegrityValid
} from '../../src/main/plugins/agent/run-capability-manifest';
import { applyAgentDatabaseSchema } from '../../src/main/infrastructure/database-schemas';
import { AgentTaskHistoryContract } from '../../src/main/plugins/agent/agent-task-history-contract';
import { applyTaskDatabaseSchema } from '../../src/main/infrastructure/database-schemas';
import { TaskRepository } from '../../src/main/plugins/task/task-repository';
import {
  buildDeepAgent,
  type DeepAgentBuildInput
} from '../../src/main/services/deep-agent/agent-builder';
import type { RocCompositeBackend } from '../../src/main/services/deep-agent/backend';
import { RocSqliteCheckpointer } from '../../src/main/services/deep-agent/sqlite-checkpointer';
import { defaultErrorTracker } from '../../src/main/services/forge-guardrails';
import { createDeepAgentTestSnapshot } from '../main/deep-agent-test-helpers';
import type { ChatRunEvent, RunCapabilityManifestV1 } from '../../src/shared/types';
import {
  assertAgentPerformanceBaselineCompatible,
  buildAgentPerformanceArtifact,
  buildAgentPerformanceMetricResult,
  calculatePercentile95,
  parseAgentPerformanceArtifact,
  parseAgentPerformanceBaseline,
  type AgentPerformanceArtifact,
  type AgentPerformanceEnvironment,
  type AgentPerformanceMetricEvidence,
  type AgentPerformanceMetricId
} from './agent-performance-contract';

const execFileAsync = promisify(execFile);
const artifactPath = resolve('.artifacts/wave1/agent-performance-smoke.json');
const sampleCount = 3;
const eventBatchSize = 250;
const graphStepsPerIteration = 12;
const graphStepHeadroom = 20;
const terminalContent = 'roc-performance-terminal';
const performanceToolName = 'performance_step';

type PerformanceToolCall = {
  args: Record<string, unknown>;
  id: string;
  name: string;
};

type PerformanceModelState = {
  invocationCount: number;
  nextResponseIndex: number;
};

type MetricMeasurement = {
  evidence: AgentPerformanceMetricEvidence;
  samplesMs: number[];
};

type StreamMessage = {
  readonly text: AsyncIterable<string>;
};

type StreamToolCall = {
  readonly error: Promise<string | undefined>;
  readonly name: string;
  readonly output: Promise<unknown>;
  readonly status: Promise<'error' | 'finished' | 'running'>;
};

type StreamSubagent = {
  readonly messages: AsyncIterable<StreamMessage>;
  readonly name: string;
  readonly output: Promise<unknown>;
  readonly subagents: AsyncIterable<StreamSubagent>;
  readonly toolCalls: AsyncIterable<StreamToolCall>;
};

type ObservableRun = {
  readonly messages: AsyncIterable<StreamMessage>;
  readonly output: Promise<unknown>;
  readonly subagents: AsyncIterable<StreamSubagent>;
  readonly toolCalls: AsyncIterable<StreamToolCall>;
};

class RocPerformanceFakeModel extends BaseChatModel {
  private readonly responses: readonly (readonly PerformanceToolCall[])[];
  private readonly state: PerformanceModelState;
  private readonly onInvocation: ((messages: readonly BaseMessage[]) => void) | undefined;

  constructor(input: {
    onInvocation?: (messages: readonly BaseMessage[]) => void;
    responses: readonly (readonly PerformanceToolCall[])[];
    state?: PerformanceModelState;
  }) {
    super({});
    this.responses = input.responses;
    this.state = input.state === undefined
      ? { invocationCount: 0, nextResponseIndex: 0 }
      : input.state;
    this.onInvocation = input.onInvocation;
  }

  get invocationCount(): number {
    return this.state.invocationCount;
  }

  override _llmType(): string {
    return 'roc-performance-fake';
  }

  override bindTools(
    _tools: BindToolsInput[],
    _kwargs?: Partial<BaseChatModelCallOptions>
  ): RocPerformanceFakeModel {
    return new RocPerformanceFakeModel({
      onInvocation: this.onInvocation,
      responses: this.responses,
      state: this.state
    });
  }

  override async _generate(
    messages: BaseMessage[],
    _options?: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    const response = this.responses[this.state.nextResponseIndex];
    if (response === undefined) {
      throw new Error('agent_performance_model_sequence_exhausted');
    }
    this.state.nextResponseIndex += 1;
    this.state.invocationCount += 1;
    this.onInvocation?.(messages);

    const content = response.length === 0 ? terminalContent : '';
    if (content.length > 0 && runManager !== undefined) {
      await runManager.handleLLMNewToken(content);
    }
    const message = new AIMessage({
      content,
      tool_calls: response.length === 0
        ? undefined
        : response.map((call) => ({
            ...call,
            type: 'tool_call' as const
          }))
    });
    return {
      generations: [{ message, text: content }],
      llmOutput: {}
    };
  }
}

describe('Roc agent performance smoke', () => {
  it('measures the deterministic agent loop and enforces the versioned baseline', async () => {
    await rm(artifactPath, { force: true });
    const environment = currentEnvironment();
    const fixture = performanceFixture();
    const gitSource = await readGitSource();
    const workspacePath = await mkdtemp(join(tmpdir(), 'roc-agent-performance-workspace-'));
    const unexpectedFetches: string[] = [];
    let metricResults: AgentPerformanceArtifact['metrics'] = [];
    let cleanupError: unknown;
    const buildExecutionFailureArtifact = (error: unknown): AgentPerformanceArtifact =>
      parseAgentPerformanceArtifact({
        environment,
        error: errorMessage(error),
        fixture,
        generatedAt: new Date().toISOString(),
        gitRevision: gitSource.gitRevision,
        metrics: metricResults,
        passed: false,
        schemaVersion: 1,
        worktreeDirty: gitSource.worktreeDirty
      });
    try {
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
        unexpectedFetches.push(String(input));
        throw new Error(`agent_performance_unexpected_fetch:${String(input)}`);
      }));
      const baseline = await loadBaseline();
      assertAgentPerformanceBaselineCompatible(baseline, { environment, fixture });
      const measurements = await measureAllScenarios(workspacePath);
      metricResults = baseline.metrics.map((baselineMetric) => {
        const measurement = measurements.get(baselineMetric.id);
        if (measurement === undefined) {
          throw new Error(`agent_performance_measurement_missing:${baselineMetric.id}`);
        }
        return buildAgentPerformanceMetricResult(
          baselineMetric,
          measurement.samplesMs,
          measurement.evidence
        );
      });
    } catch (error) {
      const failureArtifact = buildExecutionFailureArtifact(error);
      await writeArtifact(failureArtifact);
      throw error;
    } finally {
      try {
        await rm(workspacePath, { force: true, recursive: true });
      } catch (error) {
        cleanupError = error;
      } finally {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
      }
    }

    if (cleanupError !== undefined) {
      const failureArtifact = buildExecutionFailureArtifact(cleanupError);
      await writeArtifact(failureArtifact);
      throw cleanupError;
    }

    const artifact = buildAgentPerformanceArtifact({
      environment,
      fixture,
      generatedAt: new Date().toISOString(),
      gitRevision: gitSource.gitRevision,
      metrics: metricResults,
      unexpectedFetches,
      worktreeDirty: gitSource.worktreeDirty
    });
    await writeArtifact(artifact);

    if (artifact.error !== null) {
      throw new Error(artifact.error);
    }
  });
});

async function measureAllScenarios(
  workspacePath: string
): Promise<Map<AgentPerformanceMetricId, MetricMeasurement>> {
  const measurements = new Map<AgentPerformanceMetricId, MetricMeasurement>();
  measurements.set('agent_build', await measureAgentBuild(workspacePath));

  const simple = await measureSimpleCompletion(workspacePath);
  measurements.set('first_model_token', {
    evidence: simple.evidence,
    samplesMs: simple.firstTokenSamplesMs
  });
  measurements.set('simple_completion', {
    evidence: simple.evidence,
    samplesMs: simple.completionSamplesMs
  });

  const toolRoundtrip = await measureSingleToolRoundtrip(workspacePath);
  measurements.set('first_tool_call', {
    evidence: toolRoundtrip.evidence,
    samplesMs: toolRoundtrip.firstToolSamplesMs
  });
  measurements.set('tool_roundtrip', {
    evidence: toolRoundtrip.evidence,
    samplesMs: toolRoundtrip.roundtripSamplesMs
  });

  measurements.set('restart_resume', await measureRestartResume(workspacePath));
  measurements.set('iterations_10', await measureIterations(workspacePath, 10));
  measurements.set('iterations_100', await measureIterations(workspacePath, 100));
  measurements.set('subagent_fan_out', await measureSubagentFanOut(workspacePath));
  measurements.set('event_queue', await measureEventQueue());
  measurements.set('outbox_projection', await measureOutboxProjection());
  return measurements;
}

async function measureAgentBuild(workspacePath: string): Promise<MetricMeasurement> {
  const samplesMs: number[] = [];
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const db = new Database(':memory:');
    try {
      applyAgentDatabaseSchema(db);
      const startedAt = performance.now();
      createPerformanceAgent({
        checkpointer: new RocSqliteCheckpointer(db),
        model: new RocPerformanceFakeModel({ responses: [[]] }),
        workspacePath
      });
      samplesMs.push(performance.now() - startedAt);
    } finally {
      db.close();
    }
  }
  return { evidence: emptyEvidence(), samplesMs };
}

async function measureSimpleCompletion(workspacePath: string): Promise<{
  completionSamplesMs: number[];
  evidence: AgentPerformanceMetricEvidence;
  firstTokenSamplesMs: number[];
}> {
  const completionSamplesMs: number[] = [];
  const firstTokenSamplesMs: number[] = [];
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const db = new Database(':memory:');
    try {
      applyAgentDatabaseSchema(db);
      const model = new RocPerformanceFakeModel({ responses: [[]] });
      const agent = createPerformanceAgent({
        checkpointer: new RocSqliteCheckpointer(db),
        model,
        workspacePath
      });
      const startedAt = performance.now();
      const observation = await observeAgentRun(
        agent,
        `Complete performance sample ${sampleIndex}.`,
        `thread_agent_performance_simple_${sampleIndex}`,
        20
      );
      if (observation.firstTokenAt === null) {
        throw new Error('agent_performance_first_model_token_missing');
      }
      if (model.invocationCount !== 1 || observation.toolCallCount !== 0) {
        throw new Error('agent_performance_simple_completion_evidence_invalid');
      }
      assertTerminalOutput(observation.output);
      firstTokenSamplesMs.push(observation.firstTokenAt - startedAt);
      completionSamplesMs.push(observation.completedAt - startedAt);
    } finally {
      db.close();
    }
  }
  return {
    completionSamplesMs,
    evidence: {
      ...emptyEvidence(),
      modelInvocationCount: 1,
      toolExecutionCount: 0
    },
    firstTokenSamplesMs
  };
}

async function measureSingleToolRoundtrip(workspacePath: string): Promise<{
  evidence: AgentPerformanceMetricEvidence;
  firstToolSamplesMs: number[];
  roundtripSamplesMs: number[];
}> {
  const firstToolSamplesMs: number[] = [];
  const roundtripSamplesMs: number[] = [];
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const db = new Database(':memory:');
    let toolExecutionCount = 0;
    try {
      applyAgentDatabaseSchema(db);
      const performanceStep = createPerformanceStepTool(() => {
        toolExecutionCount += 1;
      });
      const model = new RocPerformanceFakeModel({
        responses: [[performanceToolCall(sampleIndex, 0)], []]
      });
      const agent = createPerformanceAgent({
        checkpointer: new RocSqliteCheckpointer(db),
        model,
        tools: [performanceStep],
        workspacePath
      });
      const startedAt = performance.now();
      const observation = await observeAgentRun(
        agent,
        `Execute one performance step for sample ${sampleIndex}.`,
        `thread_agent_performance_tool_${sampleIndex}`,
        24
      );
      if (observation.firstToolAt === null || observation.firstToolOutputAt === null) {
        throw new Error('agent_performance_tool_roundtrip_timing_missing');
      }
      if (model.invocationCount !== 2 || toolExecutionCount !== 1 || observation.toolCallCount !== 1) {
        throw new Error('agent_performance_tool_roundtrip_evidence_invalid');
      }
      assertTerminalOutput(observation.output);
      firstToolSamplesMs.push(observation.firstToolAt - startedAt);
      roundtripSamplesMs.push(observation.firstToolOutputAt - observation.firstToolAt);
    } finally {
      db.close();
    }
  }
  return {
    evidence: {
      ...emptyEvidence(),
      modelInvocationCount: 2,
      toolExecutionCount: 1
    },
    firstToolSamplesMs,
    roundtripSamplesMs
  };
}

async function measureRestartResume(workspacePath: string): Promise<MetricMeasurement> {
  const samplesMs: number[] = [];
  let finalCheckpointCount = 0;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const tempDir = await mkdtemp(join(tmpdir(), 'roc-agent-performance-restart-'));
    const databasePath = join(tempDir, 'agent.db');
    const priorTurnMarker = `prior-turn-marker-${sampleIndex}`;
    let db: Database.Database | null = null;
    try {
      db = new Database(databasePath);
      applyAgentDatabaseSchema(db);
      const firstModel = new RocPerformanceFakeModel({ responses: [[]] });
      const firstAgent = createPerformanceAgent({
        checkpointer: new RocSqliteCheckpointer(db),
        model: firstModel,
        workspacePath
      });
      const firstObservation = await observeAgentRun(
        firstAgent,
        priorTurnMarker,
        `thread_agent_performance_restart_${sampleIndex}`,
        20
      );
      assertTerminalOutput(firstObservation.output);
      const checkpointCountBeforeRestart = readCheckpointCount(
        db,
        `thread_agent_performance_restart_${sampleIndex}`
      );
      db.close();
      db = null;

      const resumeStartedAt = performance.now();
      db = new Database(databasePath);
      let priorTurnRecovered = false;
      const secondModel = new RocPerformanceFakeModel({
        onInvocation: (messages) => {
          priorTurnRecovered = messages.some((message) =>
            HumanMessage.isInstance(message) && message.content === priorTurnMarker
          );
        },
        responses: [[]]
      });
      const secondAgent = createPerformanceAgent({
        checkpointer: new RocSqliteCheckpointer(db),
        model: secondModel,
        workspacePath
      });
      const secondObservation = await observeAgentRun(
        secondAgent,
        `Resume performance sample ${sampleIndex}.`,
        `thread_agent_performance_restart_${sampleIndex}`,
        20
      );
      const resumeCompletedAt = performance.now();
      assertTerminalOutput(secondObservation.output);
      const checkpointCountAfterRestart = readCheckpointCount(
        db,
        `thread_agent_performance_restart_${sampleIndex}`
      );
      if (
        firstModel.invocationCount !== 1 ||
        secondModel.invocationCount !== 1 ||
        !priorTurnRecovered ||
        checkpointCountAfterRestart <= checkpointCountBeforeRestart
      ) {
        throw new Error('agent_performance_restart_resume_evidence_invalid');
      }
      finalCheckpointCount = checkpointCountAfterRestart;
      samplesMs.push(resumeCompletedAt - resumeStartedAt);
    } finally {
      try {
        if (db !== null) {
          db.close();
        }
      } finally {
        await rm(tempDir, { force: true, recursive: true });
      }
    }
  }
  return {
    evidence: {
      ...emptyEvidence(),
      checkpointCount: finalCheckpointCount,
      modelInvocationCount: 2,
      priorTurnRecovered: true
    },
    samplesMs
  };
}

async function measureIterations(
  workspacePath: string,
  iterationCount: 10 | 100
): Promise<MetricMeasurement> {
  const samplesMs: number[] = [];
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const db = new Database(':memory:');
    let toolExecutionCount = 0;
    try {
      applyAgentDatabaseSchema(db);
      const responses: Array<readonly PerformanceToolCall[]> = Array.from(
        { length: iterationCount },
        (_, iterationIndex) => [performanceToolCall(sampleIndex, iterationIndex)]
      );
      responses.push([]);
      const model = new RocPerformanceFakeModel({ responses });
      const agent = createPerformanceAgent({
        checkpointer: new RocSqliteCheckpointer(db),
        model,
        tools: [createPerformanceStepTool(() => {
          toolExecutionCount += 1;
        })],
        workspacePath
      });
      const startedAt = performance.now();
      const threadId = `thread_agent_performance_iterations_${iterationCount}_${sampleIndex}`;
      let observation: Awaited<ReturnType<typeof observeAgentRun>>;
      try {
        observation = await observeAgentRun(
          agent,
          `Execute ${iterationCount} deterministic performance steps.`,
          threadId,
          (iterationCount + 1) * graphStepsPerIteration + graphStepHeadroom
        );
      } catch (error) {
        throw new Error(
          `agent_performance_iterations_run_failed:${iterationCount}:models=${model.invocationCount}:tools=${toolExecutionCount}:checkpoints=${readCheckpointCount(db, threadId)}`,
          { cause: error }
        );
      }
      if (
        model.invocationCount !== iterationCount + 1 ||
        toolExecutionCount !== iterationCount ||
        observation.toolCallCount !== iterationCount
      ) {
        throw new Error(`agent_performance_iterations_evidence_invalid:${iterationCount}`);
      }
      assertTerminalOutput(observation.output);
      samplesMs.push(observation.completedAt - startedAt);
    } finally {
      db.close();
    }
  }
  return {
    evidence: {
      ...emptyEvidence(),
      modelInvocationCount: iterationCount + 1,
      toolExecutionCount: iterationCount
    },
    samplesMs
  };
}

async function measureSubagentFanOut(workspacePath: string): Promise<MetricMeasurement> {
  const samplesMs: number[] = [];
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const db = new Database(':memory:');
    try {
      applyAgentDatabaseSchema(db);
      const subagentNames = ['performance-a', 'performance-b', 'performance-c'] as const;
      const subagentModels = subagentNames.map(() =>
        new RocPerformanceFakeModel({ responses: [[]] })
      );
      const mainModel = new RocPerformanceFakeModel({
        responses: [
          subagentNames.map((name, index) => ({
            args: {
              description: `Complete deterministic fan-out branch ${index}.`,
              subagent_type: name
            },
            id: `call_agent_performance_subagent_${sampleIndex}_${index}`,
            name: 'task'
          })),
          []
        ]
      });
      const subagents: DeepAgentBuildInput['subagents'] = subagentNames.map((name, index) => ({
        description: `Deterministic performance subagent ${index}.`,
        model: subagentModels[index],
        name,
        systemPrompt: 'Return the deterministic terminal response.',
        tools: []
      }));
      const agent = createPerformanceAgent({
        checkpointer: new RocSqliteCheckpointer(db),
        model: mainModel,
        subagents,
        workspacePath
      });
      const startedAt = performance.now();
      const observation = await observeAgentRun(
        agent,
        'Delegate all three deterministic performance branches.',
        `thread_agent_performance_subagents_${sampleIndex}`,
        60
      );
      if (
        mainModel.invocationCount !== 2 ||
        observation.subagentCount !== 3 ||
        subagentModels.some((model) => model.invocationCount !== 1)
      ) {
        throw new Error('agent_performance_subagent_fan_out_evidence_invalid');
      }
      assertTerminalOutput(observation.output);
      samplesMs.push(observation.completedAt - startedAt);
    } finally {
      db.close();
    }
  }
  return {
    evidence: {
      ...emptyEvidence(),
      subagentCount: 3
    },
    samplesMs
  };
}

async function measureEventQueue(): Promise<MetricMeasurement> {
  const samplesMs: number[] = [];
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const queue = createChatRunEventQueue({ maxEvents: eventBatchSize + 1 });
    const enqueuedAt = new Map<ChatRunEvent, number>();
    for (let eventIndex = 0; eventIndex < eventBatchSize; eventIndex += 1) {
      const event = runStartedEvent(sampleIndex, eventIndex);
      enqueuedAt.set(event, performance.now());
      if (!queue.push(event)) {
        throw new Error('agent_performance_event_queue_push_failed');
      }
    }
    const highWaterStats = queue.stats();
    queue.close();
    let drainedEventCount = 0;
    const eventLagSamplesMs: number[] = [];
    for await (const event of queue) {
      const startedAt = enqueuedAt.get(event);
      if (startedAt === undefined) {
        throw new Error('agent_performance_event_queue_timestamp_missing');
      }
      eventLagSamplesMs.push(performance.now() - startedAt);
      drainedEventCount += 1;
    }
    samplesMs.push(calculatePercentile95(eventLagSamplesMs));
    const drainedStats = queue.stats();
    if (
      drainedEventCount !== eventBatchSize ||
      highWaterStats.highWaterMark !== eventBatchSize ||
      drainedStats.queuedEventCount !== 0
    ) {
      throw new Error('agent_performance_event_queue_evidence_invalid');
    }
  }
  return {
    evidence: {
      ...emptyEvidence(),
      queueEventCount: eventBatchSize,
      queueHighWaterMark: eventBatchSize
    },
    samplesMs
  };
}

async function measureOutboxProjection(): Promise<MetricMeasurement> {
  const samplesMs: number[] = [];
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const agentDb = new Database(':memory:');
    const taskDb = new Database(':memory:');
    try {
      applyAgentDatabaseSchema(agentDb);
      applyTaskDatabaseSchema(taskDb);
      const createdAt = new Date().toISOString();
      const insert = agentDb.prepare(
        `INSERT INTO agent_outbox
         (id, event_type, run_id, thread_id, payload_json, created_at)
         VALUES (?, 'run_deleted', ?, ?, '{}', ?)`
      );
      const startedAt = performance.now();
      agentDb.transaction(() => {
        for (let eventIndex = 0; eventIndex < eventBatchSize; eventIndex += 1) {
          insert.run(
            `outbox_agent_performance_${sampleIndex}_${eventIndex}`,
            `run_agent_performance_${sampleIndex}_${eventIndex}`,
            `thread_agent_performance_${sampleIndex}_${eventIndex}`,
            createdAt
          );
        }
      })();

      const history = new AgentTaskHistoryContract(agentDb);
      const repository = new TaskRepository(taskDb, history);
      const events = history.listOutboxEventsAfter({
        afterSequence: 0,
        limit: eventBatchSize + 1
      });
      const projection = repository.projectAgentOutboxEvents({
        events,
        projectorName: 'agent_performance'
      });
      samplesMs.push(performance.now() - startedAt);
      if (
        events.length !== eventBatchSize ||
        projection.appliedCount !== eventBatchSize ||
        projection.lastSequence !== eventBatchSize ||
        repository.getAgentOutboxCursor('agent_performance') !== eventBatchSize
      ) {
        throw new Error('agent_performance_outbox_projection_evidence_invalid');
      }
    } finally {
      taskDb.close();
      agentDb.close();
    }
  }
  return {
    evidence: {
      ...emptyEvidence(),
      outboxEventCount: eventBatchSize,
      outboxLastSequence: eventBatchSize
    },
    samplesMs
  };
}

function createPerformanceAgent(input: {
  checkpointer: RocSqliteCheckpointer;
  model: BaseChatModel;
  subagents?: DeepAgentBuildInput['subagents'];
  tools?: DeepAgentBuildInput['tools'];
  workspacePath: string;
}) {
  const tools = input.tools === undefined ? [] : input.tools;
  const backend = Object.assign(new StateBackend(), { routePrefixes: [] }) as RocCompositeBackend;
  const capabilityManifest = createPerformanceCapabilityManifest(
    tools.some((candidate) => candidate.name === performanceToolName)
  );
  return buildDeepAgent({
    backend,
    checkpointer: input.checkpointer,
    memorySources: [],
    snapshot: createDeepAgentTestSnapshot({
      capabilityManifest,
      workspacePath: input.workspacePath,
      budget: {
        contextBudgetTokens: null
      }
    }),
    model: input.model,
    skillSources: [],
    store: new InMemoryStore(),
    subagents: input.subagents === undefined ? [] : input.subagents,
    systemPrompt: 'Execute only the deterministic performance fixture requested by the user.',
    tools
  });
}

function createPerformanceCapabilityManifest(includePerformanceTool: boolean): RunCapabilityManifestV1 {
  const manifest = compileRunCapabilityManifest({
    deleteFileApprovalMode: 'fully_automatic',
    mcpApprovalMode: 'fully_automatic',
    mcpServers: [],
    mode: 'chat',
    requestedCapabilities: { mcpServers: [], skills: [] },
    skills: [],
    workflowHint: null
  }).manifest;
  if (!includePerformanceTool) {
    return manifest;
  }
  const { manifestHash: _manifestHash, ...manifestWithoutHash } = manifest;
  const performanceManifestTool: RunCapabilityManifestV1['tools'][number] = {
    approvalPolicy: { kind: 'none' },
    canonicalIdentity: 'roc:performance_step',
    effectClass: 'none',
    executionScopes: ['main'],
    idempotencyStrategy: 'none',
    modelVisibleName: performanceToolName,
    provenance: { kind: 'builtin', source: 'roc' },
    resourceScope: 'app',
    riskLevel: 'none'
  };
  const withPerformanceTool = {
    ...manifestWithoutHash,
    tools: [
      ...manifest.tools,
      performanceManifestTool
    ]
  };
  const result: RunCapabilityManifestV1 = {
    ...withPerformanceTool,
    manifestHash: createHash('sha256')
      .update(JSON.stringify(withPerformanceTool))
      .digest('hex')
  };
  if (!isRunCapabilityManifestIntegrityValid(result)) {
    throw new Error('agent_performance_capability_manifest_invalid');
  }
  return result;
}

function createPerformanceStepTool(onExecute: () => void): DeepAgentBuildInput['tools'][number] {
  return tool(
    async ({ step }: { step: number }) => {
      onExecute();
      return `performance-step-${step}`;
    },
    {
      description: 'Execute one deterministic local performance step.',
      name: performanceToolName,
      schema: z.object({ step: z.number().int().nonnegative() })
    }
  );
}

async function observeAgentRun(
  agent: ReturnType<typeof createPerformanceAgent>,
  prompt: string,
  threadId: string,
  recursionLimit: number
): Promise<{
  completedAt: number;
  firstTokenAt: number | null;
  firstToolAt: number | null;
  firstToolOutputAt: number | null;
  output: unknown;
  subagentCount: number;
  toolCallCount: number;
}> {
  const run = await agent.streamEvents(
    {
      forge_error_tracker: defaultErrorTracker(),
      messages: [new HumanMessage(prompt)]
    },
    {
      configurable: { thread_id: threadId },
      recursionLimit,
      version: 'v3'
    }
  );
  return await observeRun(run);
}

async function observeRun(run: ObservableRun): Promise<{
  completedAt: number;
  firstTokenAt: number | null;
  firstToolAt: number | null;
  firstToolOutputAt: number | null;
  output: unknown;
  subagentCount: number;
  toolCallCount: number;
}> {
  const outputPromise = run.output.then((output) => ({
    completedAt: performance.now(),
    output
  }));
  const [messageObservation, toolObservation, subagentCount, outputObservation] = await Promise.all([
    consumeMessages(run.messages),
    consumeToolCalls(run.toolCalls),
    consumeSubagents(run.subagents),
    outputPromise
  ]);
  return {
    completedAt: outputObservation.completedAt,
    firstTokenAt: messageObservation.firstTokenAt,
    firstToolAt: toolObservation.firstToolAt,
    firstToolOutputAt: toolObservation.firstToolOutputAt,
    output: outputObservation.output,
    subagentCount,
    toolCallCount: toolObservation.toolCallCount
  };
}

async function consumeMessages(messages: AsyncIterable<StreamMessage>): Promise<{
  firstTokenAt: number | null;
}> {
  let firstTokenAt: number | null = null;
  for await (const message of messages) {
    for await (const token of message.text) {
      if (firstTokenAt === null && token.length > 0) {
        firstTokenAt = performance.now();
      }
    }
  }
  return { firstTokenAt };
}

async function consumeToolCalls(toolCalls: AsyncIterable<StreamToolCall>): Promise<{
  firstToolAt: number | null;
  firstToolOutputAt: number | null;
  toolCallCount: number;
}> {
  let firstToolAt: number | null = null;
  let toolCallCount = 0;
  const completions: Array<Promise<{ completedAt: number; position: number }>> = [];
  for await (const call of toolCalls) {
    const position = toolCallCount;
    toolCallCount += 1;
    if (firstToolAt === null) {
      firstToolAt = performance.now();
    }
    completions.push((async () => {
      const [status, error] = await Promise.all([call.status, call.error, call.output]);
      if (status !== 'finished' || error !== undefined) {
        throw new Error(`agent_performance_tool_call_failed:${call.name}`);
      }
      return { completedAt: performance.now(), position };
    })());
  }
  const completedCalls = await Promise.all(completions);
  const firstCompletion = completedCalls.find((completion) => completion.position === 0);
  return {
    firstToolAt,
    firstToolOutputAt: firstCompletion === undefined ? null : firstCompletion.completedAt,
    toolCallCount
  };
}

async function consumeSubagents(subagents: AsyncIterable<StreamSubagent>): Promise<number> {
  let subagentCount = 0;
  const drains: Array<Promise<void>> = [];
  for await (const subagent of subagents) {
    subagentCount += 1;
    drains.push(drainSubagent(subagent));
  }
  await Promise.all(drains);
  return subagentCount;
}

async function drainSubagent(subagent: StreamSubagent): Promise<void> {
  const [, , , output] = await Promise.all([
    consumeMessages(subagent.messages),
    consumeToolCalls(subagent.toolCalls),
    consumeSubagents(subagent.subagents),
    subagent.output
  ]);
  assertTerminalOutput(output);
}

function assertTerminalOutput(output: unknown): void {
  if (typeof output !== 'object' || output === null || Array.isArray(output)) {
    throw new Error('agent_performance_output_invalid');
  }
  const messages = Reflect.get(output, 'messages');
  if (!Array.isArray(messages)) {
    throw new Error('agent_performance_output_messages_missing');
  }
  const terminalMessage = messages.at(-1);
  if (!AIMessage.isInstance(terminalMessage) || terminalMessage.content !== terminalContent) {
    throw new Error(
      `agent_performance_terminal_output_invalid:${JSON.stringify(messages.slice(-3).map((message) => ({
        constructor: typeof message === 'object' && message !== null ? message.constructor.name : typeof message,
        content: typeof message === 'object' && message !== null ? Reflect.get(message, 'content') : null,
        type: typeof message === 'object' && message !== null && typeof Reflect.get(message, 'getType') === 'function'
          ? Reflect.apply(Reflect.get(message, 'getType'), message, [])
          : null
      })))}`
    );
  }
}

function performanceToolCall(sampleIndex: number, iterationIndex: number): PerformanceToolCall {
  return {
    args: { step: iterationIndex },
    id: `call_agent_performance_${sampleIndex}_${iterationIndex}`,
    name: performanceToolName
  };
}

function runStartedEvent(sampleIndex: number, eventIndex: number): ChatRunEvent {
  return {
    createdAt: '2026-07-27T00:00:00.000Z',
    mode: 'run',
    modelId: 'roc-performance-fake',
    providerId: 'deterministic-local',
    runId: `run_agent_performance_queue_${sampleIndex}_${eventIndex}`,
    threadId: `thread_agent_performance_queue_${sampleIndex}`,
    type: 'run_started'
  };
}

function readCheckpointCount(db: Database.Database, threadId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM langgraph_checkpoints WHERE thread_id = ?')
    .get(threadId) as { count: number };
  return row.count;
}

function emptyEvidence(): AgentPerformanceMetricEvidence {
  return {
    checkpointCount: null,
    modelInvocationCount: null,
    outboxEventCount: null,
    outboxLastSequence: null,
    priorTurnRecovered: null,
    queueEventCount: null,
    queueHighWaterMark: null,
    subagentCount: null,
    toolExecutionCount: null
  };
}

function currentEnvironment(): AgentPerformanceEnvironment {
  const processors = cpus();
  const firstProcessor = processors[0];
  if (firstProcessor === undefined || firstProcessor.model.trim().length === 0) {
    throw new Error('agent_performance_cpu_model_missing');
  }
  return {
    arch: process.arch,
    cpuCount: processors.length,
    cpuModel: firstProcessor.model.trim(),
    nodeVersion: process.version,
    platform: process.platform
  };
}

function performanceFixture(): AgentPerformanceArtifact['fixture'] {
  return {
    model: 'RocPerformanceFakeModel',
    network: 'disabled',
    provider: 'deterministic-local'
  };
}

async function loadBaseline() {
  const content = await readFile(
    new URL('./datasets/agent-performance-baseline.v1.json', import.meta.url),
    'utf8'
  );
  const parsed: unknown = JSON.parse(content);
  return parseAgentPerformanceBaseline(parsed);
}

async function readGitSource(): Promise<{
  gitRevision: string;
  worktreeDirty: boolean;
}> {
  const options = {
    cwd: process.cwd(),
    encoding: 'utf8' as const
  };
  const [revisionResult, statusResult] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], options),
    execFileAsync(
      'git',
      [
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
        '--',
        '.',
        ':(exclude)plan.md',
        ':(exclude).artifacts'
      ],
      options
    )
  ]);
  const revision = revisionResult.stdout.trim();
  if (revision.length === 0) {
    throw new Error('agent_performance_git_revision_missing');
  }
  return {
    gitRevision: revision,
    worktreeDirty: statusResult.stdout.trim().length > 0
  };
}

async function writeArtifact(artifact: AgentPerformanceArtifact): Promise<void> {
  await mkdir(resolve('.artifacts/wave1'), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
