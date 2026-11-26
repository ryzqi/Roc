import { randomUUID } from 'node:crypto';
import { AIMessage, HumanMessage, RemoveMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { Command, REMOVE_ALL_MESSAGES } from '@langchain/langgraph';
import { z } from 'zod';
import { readCurrentDeepAgentsExecutionIdentity } from './deep-agents-execution-identity-adapter';
import { RunUsageLedger, runInputMessageId, type RunModelConfig } from './run-usage-ledger';
import type { RunUsageObserver } from './run-usage-observer';
import { hashToolInput, type AgentToolEffectStore } from './tool-effect-store';
import { childTaskEnvelopeSchema } from '../../../shared/schemas/task-acceptance';
import type { TaskContract } from '../../../shared/schemas/task-acceptance';
import type { RunCapabilityExecutionScopeV1 } from '../../../shared/types';
import { deriveContextCapacityProfile, type ContextTokenCounter } from './context/context-capacity';

export function createRunUsageMiddleware(
  ledger: RunUsageLedger,
  runId: string,
  limits: RunModelConfig,
  usageObserver: RunUsageObserver,
  effects?: AgentToolEffectStore,
  taskContract?: TaskContract,
  tokenCounter?: ContextTokenCounter,
  toolProgressScope?: string,
  executionScope: RunCapabilityExecutionScopeV1 = 'main'
) {
  return createMiddleware({
    name: 'RocRunUsageMiddleware',
    wrapModelCall: async (request, handler) => {
      request.runtime.signal?.throwIfAborted();
      if (usageObserver === undefined) throw new Error('run_model_observer_missing');
      const count = tokenCounter === undefined ? null : await tokenCounter.countMessages(request.messages);
      const profile = tokenCounter === undefined ? null : await deriveContextCapacityProfile({
        contextWindowTokens: limits.contextWindowTokens,
        counter: tokenCounter,
        systemPrompt: typeof request.systemMessage.content === 'string' ? request.systemMessage.content :
          JSON.stringify(request.systemMessage.content),
        tools: request.tools.map(tool => {
          if (typeof tool.name !== 'string' || typeof tool.description !== 'string') {
            throw new Error('context_tool_definition_invalid');
          }
          return { name: tool.name, description: tool.description, schema: tool.schema };
        })
      });
      return await usageObserver.invoke({
        messages: [request.systemMessage, ...request.messages],
        purpose: 'agent',
        estimatedInputTokens: count === null || profile === null ? null : count.tokens + profile.systemToolOverheadTokens,
        // Provider framing and tool encoding are estimated even when text tokenization is exact.
        estimateApproximate: tokenCounter === undefined ? null : true,
        responseMessage: readModelCallMessage,
        invoke: async () => await handler(request)
      });
    },
    wrapToolCall: async (request, handler) => {
      const identity = readCurrentDeepAgentsExecutionIdentity(request.runtime, executionScope);
      request.runtime.signal?.throwIfAborted();
      const isChildTask = request.toolCall.name === 'task';
      if (isChildTask && identity?.executionPath !== 'main') throw new Error('run_child_task_depth_exhausted');
      if (effects !== undefined && identity !== null && request.toolCall.id !== undefined && effects.readState({
        ...identity, runId, toolCallId: request.toolCall.id
      }).status === 'succeeded') return await handler(request);
      // Every dispatch attempt has a reservation; durable effect replay above does not dispatch.
      if (isChildTask && (identity === null || request.toolCall.id === undefined)) throw new Error('run_child_task_identity_missing');
      const callId = isChildTask
        ? `child_${hashToolInput({ executionPath: identity!.executionPath, toolCallId: request.toolCall.id })}`
        : randomUUID();
      const inputHash = hashToolInput({ name: request.toolCall.name, args: request.toolCall.args });
      let envelope: unknown = { name: request.toolCall.name, inputHash };
      if (isChildTask) {
        const args = request.toolCall.args;
        if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('run_child_task_arguments_invalid');
        const description = Reflect.get(args, 'description');
        const subagentType = Reflect.get(args, 'subagent_type');
        if (typeof description !== 'string' || typeof subagentType !== 'string') throw new Error('run_child_task_arguments_invalid');
        const artifactRefs = (taskContract?.criteria ?? []).flatMap((criterion) => criterion.check.kind === 'artifact_sha256'
          ? [{ path: criterion.check.path, sha256: criterion.check.sha256 }]
          : []);
        envelope = childTaskEnvelopeSchema.parse({
          schemaVersion: 1,
          childTaskId: callId,
          parentRunId: runId,
          subagentType,
          taskDescription: description,
          taskDescriptionHash: hashToolInput(description),
          permissions: subagentType === 'research' ? ['web_read'] : ['workspace_read', 'research_read', 'web_read'],
          artifactRefs,
          acceptanceCriteria: (taskContract?.criteria ?? []).map((criterion) => ({
            id: criterion.id,
            description: criterion.description
          }))
        });
      }
      ledger.reserve(runId, limits, { id: callId, kind: isChildTask ? 'child' : 'tool', tokens: 0, inputHash, envelope });
      let result;
      try {
        result = await handler(request);
      } catch (error) {
        ledger.settle(runId, callId, 0, isChildTask ? 'unknown' : 'settled', undefined, isChildTask ? {
          outcomeStatus: 'failed',
          failureCode: safeChildFailureCode(error)
        } : {});
        throw error;
      }
      const childFailed = isChildTask && ToolMessage.isInstance(result) && result.status === 'error';
      ledger.settle(runId, callId, 0, 'settled', isChildTask ? hashToolInput(ToolMessage.isInstance(result) ? result.content : result) : undefined,
        isChildTask ? {
          outcomeStatus: childFailed ? 'failed' : 'completed',
          ...(childFailed ? { failureCode: 'child_task_reported_error' } : {})
        } : {});
      if (ToolMessage.isInstance(result)) ledger.recordProgress(runId, request.toolCall.name,
        request.toolCall.args, { content: result.content, status: result.status }, toolProgressScope);
      return result;
    }
  });
}

/** LangChain 1.5 returns messages plus structuredResponse for a parsed response. */
function readModelCallMessage(result: unknown): AIMessage | null {
  if (AIMessage.isInstance(result)) return result;
  if (result === null || typeof result !== 'object' || !('messages' in result) ||
    !Array.isArray(result.messages)) return null;
  const message: unknown = result.messages[0];
  return AIMessage.isInstance(message) ? message : null;
}

function safeChildFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^[a-z][a-z0-9_:-]{1,100}$/i.test(message) ? message : 'child_task_failed';
}

// Corrections enter main state before compaction; child agents never own the user inbox.
export function createRunCorrectionMiddleware(ledger: RunUsageLedger, runId: string) {
  return createMiddleware({
    name: 'RocRunCorrectionMiddleware',
    stateSchema: z.object({ rocRunInputProjection: runInputProjectionSchema.optional() }),
    wrapModelCall: async (request, handler) => {
      // A saved model node and jumpTo=model skip beforeModel. Consumption records
      // provider delivery, so a failed attempt can leave a consumed inbox item
      // without a checkpoint projection. Recover that item from the inbox.
      const { pending, projection } = projectRunInputs(ledger, runId, request.messages, request.state.rocRunInputProjection);
      if (pending.length === 0) return await handler(request);
      const response = await handler({ ...request, messages: [...request.messages, ...pending] });
      // LangChain writes its tracked AIMessage before collected Commands. Replace
      // that sequence to keep the input before its response for all afterModel hooks.
      return new Command({ update: {
        messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), ...request.messages, ...pending, response],
        rocRunInputProjection: projection
      } });
    },
    beforeModel: state => {
      const { pending, projection, changed } = projectRunInputs(ledger, runId, state.messages, state.rocRunInputProjection);
      if (pending.length === 0 && !changed) return;
      return { messages: pending, rocRunInputProjection: projection };
    }
  });
}

const runInputProjectionSchema = z.object({ runId: z.string(), submissionIds: z.array(z.string()) });

/** Checkpoint evidence of projection, not a second queue; the inbox owns content and scheduling. */
function projectRunInputs(
  ledger: RunUsageLedger,
  runId: string,
  messages: readonly BaseMessage[],
  previous: z.infer<typeof runInputProjectionSchema> | undefined
) {
  const previousIds = previous?.runId === runId ? previous.submissionIds : [];
  const projected = new Set(previousIds);
  const present = new Set(messages.map(message => message.id));
  const pending: HumanMessage[] = [];
  for (const item of ledger.readRunInputs(runId)) {
    const id = runInputMessageId(runId, item.submissionId);
    const legacyMessage = messages.find(message => message.id === `roc-correction:${item.submissionId}`);
    const legacyPresent = legacyMessage !== undefined && legacyMessage.content === item.content &&
      ledger.ownsLegacyInputMessage(runId, item.submissionId);
    if (present.has(id) || legacyPresent) {
      projected.add(item.submissionId);
      continue;
    }
    if (item.kind === 'follow_up' && item.status === 'queued') continue;
    // Compaction may legitimately remove a delivered human message. Only recover
    // consumed inputs absent from both the messages and their durable projection.
    if (item.status === 'consumed' && projected.has(item.submissionId)) continue;
    pending.push(new HumanMessage({ id, content: item.content }));
    projected.add(item.submissionId);
  }
  return {
    pending,
    projection: { runId, submissionIds: [...projected] },
    changed: projected.size > 0 && (previous?.runId !== runId || projected.size !== previousIds.length)
  };
}
