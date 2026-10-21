import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';
import type { Serialized } from '@langchain/core/load/serializable';
import { redactUnknown } from './redaction';
import { hashToolInput } from './tool-effect-store';
import { RunBudgetLedger, type RunLimits } from './run-budget-ledger';

/** Callbacks run at the provider boundary, after compaction, and propagate to child/summary calls. */
export class RunBudgetObserver extends BaseCallbackHandler {
  name = 'RocRunBudgetObserver';
  raiseError = true;
  awaitHandlers = true;
  private readonly pending = new Set<string>();

  constructor(private readonly ledger: RunBudgetLedger, private readonly runId: string,
    private readonly limits: RunLimits, private readonly revision: string) { super(); }

  override handleChatModelStart(_model: Serialized, batches: BaseMessage[][], callId: string, parentId?: string, extra?: Record<string, unknown>): void {
    // Reserve the full request window when provider-specific worst-case output usage is unavailable.
    // Missing usage keeps the reservation charged and visible as unknown.
    const tokens = this.limits.contextWindowTokens;
    if (tokens === null) throw new Error('agent_context_budget_missing');
    const messages = redactUnknown(batches.map(batch => batch.map(message => message.toDict())));
    this.ledger.reserve(this.runId, this.limits, { id: callId, kind: 'model', tokens,
      inputHash: hashToolInput(messages), envelope: { schemaVersion: 1, callId, parentId,
        revision: this.revision, messages, invocation: redactUnknown(readInvocation(extra)), tokenEstimate: tokens, estimateSource: 'window-upper-bound', costUsd: null } });
    this.ledger.consumeCorrections(this.runId, batches.flat().map(message => message.id ?? ''));
    this.pending.add(callId);
  }

  override handleLLMEnd(output: LLMResult, callId: string): void {
    if (!this.pending.delete(callId)) return;
    let tokens = 0;
    let known = output.generations.length > 0;
    for (const generations of output.generations) {
      const generation = generations[0];
      const message = generation !== undefined && 'message' in generation ? generation.message : null;
      const usage = AIMessage.isInstance(message) ? message.usage_metadata : undefined;
      if (usage === undefined || !Number.isFinite(usage.total_tokens)) known = false;
      else tokens += usage.total_tokens;
    }
    this.ledger.settle(this.runId, callId, known ? tokens : null, known ? 'settled' : 'unknown');
  }

  override handleLLMError(_error: Error, callId: string): void {
    if (this.pending.delete(callId)) this.ledger.settle(this.runId, callId, null, 'unknown');
  }
}

function readInvocation(extra: Record<string, unknown> | undefined): unknown {
  const params = extra?.invocation_params;
  if (params === null || typeof params !== 'object') return null;
  return Object.fromEntries(['model', 'tools', 'temperature', 'top_p', 'max_tokens', 'max_completion_tokens']
    .filter(key => key in params).map(key => [key, Reflect.get(params, key)]));
}
