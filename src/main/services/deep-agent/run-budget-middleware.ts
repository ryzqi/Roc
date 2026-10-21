import { randomUUID } from 'node:crypto';
import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { readDeepAgentsExecutionIdentity } from './deep-agents-execution-identity-adapter';
import { RunBudgetLedger, type RunLimits } from './run-budget-ledger';
import { hashToolInput, type AgentToolEffectStore } from './tool-effect-store';
import { childTaskEnvelopeSchema } from '../../../shared/schemas/task-acceptance';
import type { TaskContract } from '../../../shared/schemas/task-acceptance';

export function createRunBudgetMiddleware(
  ledger: RunBudgetLedger,
  runId: string,
  limits: RunLimits,
  effects?: AgentToolEffectStore,
  taskContract?: TaskContract
) {
  return createMiddleware({
    name: 'RocRunBudgetMiddleware',
    wrapToolCall: async (request, handler) => {
      const identity = readDeepAgentsExecutionIdentity(request.runtime?.configurable);
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
          maxChildTasks: limits.maxChildTasks,
          maxConcurrentChildTasks: limits.maxConcurrentChildTasks,
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
        request.toolCall.args, { content: result.content, status: result.status });
      return result;
    }
  });
}

function safeChildFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^[a-z][a-z0-9_:-]{1,100}$/i.test(message) ? message : 'child_task_failed';
}

// Corrections enter main state before compaction; child agents never own the user inbox.
export function createRunCorrectionMiddleware(ledger: RunBudgetLedger, runId: string) {
  return createMiddleware({
    name: 'RocRunCorrectionMiddleware',
    beforeModel: () => {
      const corrections = ledger.pendingCorrections(runId);
      if (corrections.length === 0) return;
      return { messages: corrections.map(item => new HumanMessage({ id: `roc-correction:${item.submission_id}`, content: item.content })) };
    }
  });
}
