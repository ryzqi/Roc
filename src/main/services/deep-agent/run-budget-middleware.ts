import { randomUUID } from 'node:crypto';
import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { readDeepAgentsExecutionIdentity } from './deep-agents-execution-identity-adapter';
import { RunBudgetLedger, type RunLimits } from './run-budget-ledger';
import { hashToolInput, type AgentToolEffectStore } from './tool-effect-store';

export function createRunBudgetMiddleware(ledger: RunBudgetLedger, runId: string, limits: RunLimits, effects?: AgentToolEffectStore) {
  return createMiddleware({
    name: 'RocRunBudgetMiddleware',
    wrapToolCall: async (request, handler) => {
      const identity = readDeepAgentsExecutionIdentity(request.runtime?.configurable);
      request.runtime.signal?.throwIfAborted();
      if (effects !== undefined && identity !== null && request.toolCall.id !== undefined && effects.readState({
        ...identity, runId, toolCallId: request.toolCall.id
      }).status === 'succeeded') return await handler(request);
      // Every dispatch attempt has a reservation; durable effect replay above does not dispatch.
      const callId = randomUUID();
      const inputHash = hashToolInput({ name: request.toolCall.name, args: request.toolCall.args });
      ledger.reserve(runId, limits, { id: callId, kind: request.toolCall.name === 'task' ? 'child' : 'tool', tokens: 0, inputHash,
        envelope: { name: request.toolCall.name, inputHash } });
      let result;
      try {
        result = await handler(request);
      } catch (error) {
        ledger.settle(runId, callId, 0, 'settled');
        throw error;
      }
      ledger.settle(runId, callId, 0, 'settled');
      if (ToolMessage.isInstance(result)) ledger.recordProgress(runId, request.toolCall.name,
        request.toolCall.args, { content: result.content, status: result.status });
      return result;
    }
  });
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
