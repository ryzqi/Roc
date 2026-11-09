import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunUsageStatus } from '../../../shared/types';
import { redactUnknown } from './redaction';
import { hashToolInput } from './tool-effect-store';
import { RunUsageLedger, type RunModelConfig } from './run-usage-ledger';

type RunUsageObserverOptions = {
  providerId?: string;
  modelId?: string;
  onStatus?: (status: RunUsageStatus) => void;
  onInvocation?: (observation: ModelInvocationObservation) => void;
};

export type ModelInvocationObservation = {
  purpose: 'agent' | 'summary';
  status: 'completed' | 'failed' | 'blocked';
  durationMs: number;
  estimatedInputTokens: number | null;
  actualInputTokens: number | null;
  actualOutputTokens: number | null;
  actualCacheReadTokens?: number | null;
  actualCacheCreationTokens?: number | null;
  estimateApproximate: boolean | null;
  /** Generated process-only compaction identity, never part of persisted model payloads. */
  contextCycleId?: string;
};

export type ObservedModelInvocation<T> = {
  messages: readonly BaseMessage[];
  invoke: () => Promise<T>;
  responseMessage: (result: T) => unknown;
  purpose: 'agent' | 'summary';
  estimatedInputTokens?: number | null;
  estimateApproximate?: boolean | null;
};

/** Provider-boundary accounting. Every path calls invoke() before entering the provider handler. */
export class RunUsageObserver {
  private revision: string;
  private readonly contextCycle = new AsyncLocalStorage<string>();

  constructor(
    private readonly ledger: RunUsageLedger,
    private readonly runId: string,
    private readonly limits: RunModelConfig,
    revision: string,
    private readonly options: RunUsageObserverOptions = {}
  ) {
    this.revision = revision;
  }

  setRevision(revision: string): void {
    this.revision = revision;
  }

  withContextCycle<T>(cycleId: string, operation: () => Promise<T>): Promise<T> {
    return this.contextCycle.run(cycleId, operation);
  }

  emitStatus(): void {
    this.options.onStatus?.(this.ledger.readUsageStatus(this.runId));
  }

  async invoke<T>(input: ObservedModelInvocation<T>): Promise<T> {
    const startedAt = performance.now();
    const startedAtIso = new Date().toISOString();
    const callId = randomUUID();
    let reserved = false;
    let status: ModelInvocationObservation['status'] = 'blocked';
    let actualInputTokens: number | null = null;
    let actualOutputTokens: number | null = null;
    let actualCacheReadTokens: number | null = null;
    let actualCacheCreationTokens: number | null = null;
    try {
      const messages = redactUnknown(input.messages.map((message) => message.toDict()));
      const inputHash = hashToolInput({ purpose: input.purpose, messages });
      this.ledger.reserve(this.runId, this.limits, {
        id: callId,
        kind: 'model',
        tokens: input.estimatedInputTokens ?? 0,
        inputHash,
        envelope: {
          schemaVersion: 2,
          callId,
          revision: this.revision,
          providerId: this.options.providerId ?? null,
          modelId: this.options.modelId ?? null,
          purpose: input.purpose,
          messages,
          reservedTokens: input.estimatedInputTokens ?? 0,
          maxOutputTokens: this.limits.maxOutputTokens,
          estimateSource: 'input-token-count'
        }
      });

      reserved = true;
      status = 'failed';
      this.ledger.consumeCorrections(this.runId, input.messages.map((message) => message.id ?? ''));
      this.emitStatus();

      let result: T;
      try {
        result = await input.invoke();
      } catch (error) {
        status = 'failed';
        this.ledger.settle(this.runId, callId, null, 'unknown');
        this.emitStatus();
        throw error;
      }

      status = 'completed';
      const usage = readMessageUsage(input.responseMessage(result));
      if (usage === null) {
        this.ledger.settle(this.runId, callId, null, 'unknown');
        this.emitStatus();
        return result;
      }

      actualInputTokens = usage.inputTokens;
      actualOutputTokens = usage.outputTokens;
      actualCacheReadTokens = usage.cacheReadTokens;
      actualCacheCreationTokens = usage.cacheWriteTokens;
      this.ledger.settle(this.runId, callId, usage.totalTokens, 'settled');
      this.emitStatus();
      return result;
    } catch (error) {
      if (status === 'completed') status = 'failed';
      throw error;
    } finally {
      const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
      if (reserved) this.ledger.recordModelObservation(this.runId, callId, {startedAt: startedAtIso, durationMs, status: status === 'completed' ? 'completed' : 'failed'});
      const observation: ModelInvocationObservation = {
        purpose: input.purpose,
        status,
        durationMs,
        estimatedInputTokens: input.estimatedInputTokens ?? null,
        actualInputTokens,
        actualOutputTokens,
        actualCacheReadTokens,
        actualCacheCreationTokens,
        estimateApproximate: input.estimateApproximate ?? null,
        ...(this.contextCycle.getStore() === undefined ? {} : { contextCycleId: this.contextCycle.getStore() })
      };
      try {
        this.options.onInvocation?.(observation);
      } catch {
        // Diagnostics must never change model execution or usage recording.
      }
    }
  }
}

function readMessageUsage(message: unknown): {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} | null {
  const usage = AIMessage.isInstance(message) ? message.usage_metadata : undefined;
  if (usage === undefined || !isSafeTokenCount(usage.total_tokens) ||
    !isSafeTokenCount(usage.input_tokens) || !isSafeTokenCount(usage.output_tokens) ||
    usage.input_tokens + usage.output_tokens !== usage.total_tokens) return null;
  const cacheReadTokens = readOptionalSafeTokenCount(usage.input_token_details?.cache_read);
  const cacheWriteTokens = readOptionalSafeTokenCount(usage.input_token_details?.cache_creation);
  if (cacheReadTokens === null || cacheWriteTokens === null) return null;
  return {
    totalTokens: usage.total_tokens,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens,
    cacheWriteTokens
  };
}

function readOptionalSafeTokenCount(value: unknown): number | null {
  if (value === undefined) return 0;
  return isSafeTokenCount(value) ? value : null;
}

function isSafeTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export type StructuredModelResponse = { parsed: unknown; raw: AIMessage | null };

export function readStructuredModelResponse(value: unknown): StructuredModelResponse | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    !('parsed' in value) || !('raw' in value)) return null;
  const raw = value.raw;
  return { parsed: value.parsed, raw: AIMessage.isInstance(raw) ? raw : null };
}
