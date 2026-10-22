import { HumanMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';

import type {
  ChatRunEvent,
  ChatValidatedImageAttachment,
  RunExecutionSnapshot
} from '../../../shared/types';
import { adaptDeepAgentRun } from '../../services/deep-agent/deep-agent-stream-adapter';
import {
  consumeDeepAgentEventStream,
  createStreamConsumerState,
  createUsageAccumulator
} from '../../services/deep-agent/stream-consumers';
import { defaultErrorTracker } from '../../services/forge-guardrails';
import { createToolOutputProjector } from '../../services/deep-agent/tool-output-projection';
import { validateOutcomeConsistency } from '../../services/deep-agent/outcome-validator';
import { recoverOrphanedOperation } from '../../services/deep-agent/operation-recovery';
import { validateRunTokenBudget } from '../../services/deep-agent/runtime-state-validator';
import type { MetricsService } from '../../services/metrics-service';
import type { AgentDeepAgentExecutor } from './runtime';
import type { AgentModelUsageTelemetry } from './run-telemetry';
import { createAgentDeepAgentExecution, type RunOutcome } from './agent-execution';
import { createChatRunEventQueue } from './chat-run-event-queue';
import { createRunInterruptedEvents, projectDeepAgentInterrupts } from './interrupt-projection';
import { buildRunHarness, type RunHarnessServices } from './run-harness';

export type AgentDeepAgentExecutorOptions = RunHarnessServices & {
  metricsService?: Pick<MetricsService, 'recordPromptCacheMetrics'>;
};

export function createAgentDeepAgentExecutor(options: AgentDeepAgentExecutorOptions): AgentDeepAgentExecutor {
  return {
    execute(input) {
      let resolveOutcome: (outcome: RunOutcome) => void = () => {};
      let rejectOutcome: (error: unknown) => void = () => {};
      let outcomePublished = false;
      const outcome = new Promise<RunOutcome>((resolve, reject) => {
        resolveOutcome = resolve;
        rejectOutcome = reject;
      });
      const events = (async function* () {
        try {
      const eventQueue = createChatRunEventQueue();

      // 在构建 harness 前检查是否需要恢复
      if (input.resumeFromCheckpoint === true && 'validateCheckpointIntegrity' in options.checkpointer) {
        const checkpointer = options.checkpointer as import('../../services/deep-agent/sqlite-checkpointer').RocSqliteCheckpointer;
        const recovery = await recoverOrphanedOperation(
          {
            runId: input.run.id,
            threadId: input.run.threadId,
            lastCheckpointId: null
          },
          checkpointer
        );

        switch (recovery.action) {
          case 'restart':
            break;

          case 'fail':
            eventQueue.fail(new Error(`checkpoint_recovery_failed: ${recovery.reason}`));
            yield* eventQueue;
            return;

          case 'resume_with_interrupt':
            // LangGraph 会处理 interrupt payload
            break;

          case 'resume_from_checkpoint':
            // 标准 checkpoint 恢复,无需额外处理
            break;
        }
      }

      const mode = input.snapshot.mode;
      const assistantChunks: string[] = [];
      const reasoningChunks: string[] = [];
      const hookDisplayTexts: string[] = [];
      const outcomeText = createOutcomeTextCollector(hookDisplayTexts);
      const successfulToolNamesByBlockId = new Map<string, string>();
      const usageAccumulator = createUsageAccumulator();
      const executionAbortController = new AbortController();
      const abortFromParent = () => executionAbortController.abort(input.abortSignal.reason);
      if (input.abortSignal.aborted) {
        abortFromParent();
      } else {
        input.abortSignal.addEventListener('abort', abortFromParent, { once: true });
      }
      const emitRuntimeEvent = (event: ChatRunEvent): void => {
        collectOutcomeProjection({
          event,
          hookDisplayTexts,
          successfulToolNamesByBlockId
        });
        if (event.type === 'assistant_block' && event.block.kind === 'text' && event.block.text !== undefined) {
          outcomeText.push(event.block.text);
        }

        if (eventQueue.push(event)) {
          return;
        }
        const overflow = new Error('chat_run_event_queue_overflow');
        executionAbortController.abort(overflow);
        throw overflow;
      };

      const harness = await buildRunHarness(options, {
        abortSignal: executionAbortController.signal,
        emitRuntimeEvent,
        modelHandle: input.modelHandle,
        run: input.run,
        snapshot: input.snapshot
      });
      if (harness.kind === 'blocked') {
        eventQueue.fail(new Error(harness.reason));
        try {
          for await (const event of eventQueue) {
            yield event;
          }
        } finally {
          input.abortSignal.removeEventListener('abort', abortFromParent);
        }
        return;
      }
      const agent = harness.agent;
      const deadline = input.snapshot.budget.deadlineAt;
      let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
      const checkDeadline = (): void => {
        if (deadline === null) return;
        const remaining = Date.parse(deadline) - Date.now();
        if (remaining <= 0) executionAbortController.abort(new Error('run_deadline_exhausted'));
        else deadlineTimer = setTimeout(checkDeadline, Math.min(2_147_483_647, remaining));
      };
      checkDeadline();
      const runInput =
        input.resumePayload !== undefined
          ? new Command({ resume: input.resumePayload })
          : input.resumeFromCheckpoint === true
            ? null
            : createInitialState(input.run.userInput, input.validatedAttachments);
      const rawRun = await agent.streamEvents(runInput as never, {
        version: 'v3',
        callbacks: harness.callbacks,
        recursionLimit: 10000,
        configurable: {
          run_id: input.run.id,
          thread_id: input.run.threadId
        },
        signal: executionAbortController.signal
      }).catch((error: unknown) => {
        if (deadlineTimer !== null) clearTimeout(deadlineTimer);
        input.abortSignal.removeEventListener('abort', abortFromParent);
        throw error;
      });
      const projectToolOutput = createToolOutputProjector({
        artifactStore: options.contextArtifactStore,
        runId: input.run.id,
        threadId: input.run.threadId,
        workspaceHash: harness.workspaceHash
      });
      const run = adaptDeepAgentRun(rawRun, { projectToolOutput });
      const runOutputSettlement = Promise.allSettled([run.output] as const);
      const streamState = createStreamConsumerState({
        assistantChunks,
        reasoningChunks,
        usageAccumulator
      });
      const consumeRun = (async () => {
        try {
          await consumeDeepAgentEventStream({
            events: run.events,
            runId: input.run.id,
            state: streamState,
            callbacks: { emitRuntimeEvent }
          });
          recordPromptCacheMetrics({
            metricsService: options.metricsService,
            modelId: input.modelHandle.modelId,
            mode,
            providerId: input.modelHandle.providerId,
            source: harness.source,
            usageAccumulator
          });
          const domainInterrupts = streamState.interrupted;
          if (domainInterrupts !== null) {
            const interrupts = projectDeepAgentInterrupts(domainInterrupts);
            for (const event of createRunInterruptedEvents(input.run.id, input.run.threadId, interrupts)) {
              emitRuntimeEvent(event);
            }
            outcomePublished = true;
            resolveOutcome({
              status: 'interrupted',
              interrupts,
              usage: snapshotUsage(usageAccumulator)
            });
          } else {
            const [settledOutput] = await runOutputSettlement;
            if (settledOutput.status === 'rejected') {
              throw settledOutput.reason;
            }
            const finalAssistantText = settledOutput.value;
            if (assistantChunks.join('').trim().length === 0 && finalAssistantText !== null) {
              assistantChunks.push(finalAssistantText);
              emitRuntimeEvent({
                type: 'assistant_block',
                runId: input.run.id,
                block: {
                  kind: 'text',
                  blockId: `text-${input.run.id}`,
                  phase: 'delta',
                  text: finalAssistantText
                }
              });
            }
            const finalMessage = outcomeText.finish().trim();

            const budgetError = validateRunTokenBudget(usageAccumulator, input.snapshot.budget.maxTotalTokens);
            if (budgetError !== null) {
              throw new Error(budgetError.code);
            }

            // Outcome 一致性校验
            const validationError = validateOutcomeConsistency({
              assistantChunks,
              reasoningChunks,
              toolCallsByBlockId: successfulToolNamesByBlockId,
              hookDisplayTexts,
              usageAccumulated: usageAccumulator.inputTokens !== null && usageAccumulator.inputTokens > 0
            });

            if (validationError !== null) {
              throw new Error(validationError.code);
            }

            outcomePublished = true;
            resolveOutcome({
              status: 'completed',
              finalMessage,
              summarySource: {
                successfulToolNames: [...successfulToolNamesByBlockId.values()]
              },
              usage: snapshotUsage(usageAccumulator)
            });
          }
          eventQueue.close();
        } catch (error) {
          eventQueue.fail(error);
          throw error;
        } finally {
          if (!outcomePublished) {
            input.observeModelUsage(snapshotUsage(usageAccumulator));
          }
        }
      })();
      try {
        for await (const event of eventQueue) {
          yield event;
        }
        await consumeRun;
      } finally {
        if (deadlineTimer !== null) clearTimeout(deadlineTimer);
        executionAbortController.abort(new Error('chat_run_event_consumer_stopped'));
        await consumeRun.catch((error: unknown) => {
          rejectOutcome(error);
        });
        input.abortSignal.removeEventListener('abort', abortFromParent);
      }
        } catch (error) {
          rejectOutcome(error);
          throw error;
        } finally {
          if (input.snapshot.capabilityManifest.resolvedCapabilities.mcpServers.length > 0) {
            await options.capabilities.invoke('mcp.tools.release', { runId: input.run.id });
          }
        }
      })();
      return createAgentDeepAgentExecution({ events, outcome });
    }
  };
}

function snapshotUsage(usage: ReturnType<typeof createUsageAccumulator>): AgentModelUsageTelemetry {
  const { callUsage, ...tokenUsage } = usage;
  return {
    callCount: callUsage.size,
    ...tokenUsage
  };
}

function collectOutcomeProjection(input: {
  event: ChatRunEvent;
  hookDisplayTexts: string[];
  successfulToolNamesByBlockId: Map<string, string>;
}): void {
  if (input.event.type === 'hook_started' || input.event.type === 'hook_completed') {
    collectHookDisplayText(input.hookDisplayTexts, input.event.hook.additionalContext);
    collectHookDisplayText(input.hookDisplayTexts, input.event.hook.requestContinue);
    return;
  }
  if (input.event.type !== 'assistant_block' || input.event.block.kind !== 'tool_call') {
    return;
  }
  if (input.event.block.phase === 'end') {
    input.successfulToolNamesByBlockId.set(input.event.block.blockId, input.event.block.name);
    return;
  }
  if (input.event.block.phase === 'error') {
    input.successfulToolNamesByBlockId.delete(input.event.block.blockId);
  }
}

function collectHookDisplayText(texts: string[], value: string | null): void {
  if (value !== null && value.length > 0 && !texts.includes(value)) {
    texts.push(value);
  }
}

function createOutcomeTextCollector(hookDisplayTexts: readonly string[]): {
  finish: () => string;
  push: (delta: string) => void;
} {
  const chunks: string[] = [];
  let pendingPrefix = '';
  let prefixResolved = false;

  const consumePrefix = (): void => {
    while (pendingPrefix.length > 0) {
      const matchingHookText = [...hookDisplayTexts]
        .sort((left, right) => right.length - left.length)
        .find((text) => pendingPrefix.startsWith(text));
      if (matchingHookText !== undefined) {
        pendingPrefix = pendingPrefix.slice(matchingHookText.length).trimStart();
        continue;
      }
      if (hookDisplayTexts.some((text) => text.startsWith(pendingPrefix))) {
        return;
      }
      prefixResolved = true;
      chunks.push(pendingPrefix);
      pendingPrefix = '';
    }
  };

  return {
    finish: () => {
      consumePrefix();
      if (!prefixResolved && pendingPrefix.length > 0) {
        chunks.push(pendingPrefix);
        pendingPrefix = '';
      }
      return chunks.join('');
    },
    push: (delta) => {
      if (prefixResolved) {
        chunks.push(delta);
        return;
      }
      pendingPrefix += delta;
      consumePrefix();
    }
  };
}

function recordPromptCacheMetrics(input: {
  metricsService: Pick<MetricsService, 'recordPromptCacheMetrics'> | undefined;
  usageAccumulator: ReturnType<typeof createUsageAccumulator>;
  mode: RunExecutionSnapshot['mode'];
  source: 'chat' | 'background_task';
  providerId: string;
  modelId: string;
}): void {
  if (input.metricsService === undefined || input.usageAccumulator.inputTokens === null) {
    return;
  }
  const usage: Parameters<MetricsService['recordPromptCacheMetrics']>[0] = {
    input_tokens: input.usageAccumulator.inputTokens
  };
  if (input.usageAccumulator.cacheReadTokens !== null) {
    usage.cache_read_tokens = input.usageAccumulator.cacheReadTokens;
  }
  if (input.usageAccumulator.cacheCreationTokens !== null) {
    usage.cache_creation_tokens = input.usageAccumulator.cacheCreationTokens;
  }
  input.metricsService.recordPromptCacheMetrics(usage, {
    mode: input.mode,
    source: input.source,
    providerId: input.providerId,
    modelId: input.modelId
  });
}

/**
 * The initial LangGraph state. Named instead of `unknown` so the builder of this object and the
 * `streamEvents` call site agree on its keys; the caller already narrows it with `as never`.
 */
type AgentInitialState = {
  messages: HumanMessage[];
  forge_error_tracker: ReturnType<typeof defaultErrorTracker>;
};

function createInitialState(
  input: string,
  attachments: readonly ChatValidatedImageAttachment[] | undefined
): AgentInitialState {
  if (attachments !== undefined && attachments.length > 0) {
    return {
      messages: [
        new HumanMessage({
          content: [
            { type: 'text', text: input },
            ...attachments.map((attachment) => ({
              type: 'image' as const,
              mimeType: attachment.mediaType,
              data: attachment.base64
            }))
          ]
        })
      ],
      forge_error_tracker: defaultErrorTracker()
    };
  }
  return {
    messages: [new HumanMessage(input)],
    forge_error_tracker: defaultErrorTracker()
  };
}

