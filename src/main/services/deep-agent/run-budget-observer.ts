import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { calculateModelCostMicrousd, resolveModelPricing, estimateModelReservationMicrousd } from '../../../shared/run-budget-policy';
import type { RunBudgetStatus } from '../../../shared/types';
import { redactUnknown } from './redaction';
import { hashToolInput } from './tool-effect-store';
import { RunBudgetLedger, type RunLimits } from './run-budget-ledger';

type RunBudgetObserverOptions = {
  providerId?: string;
  modelId?: string;
  onStatus?: (status: RunBudgetStatus) => void;
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

export type BudgetedModelInvocation<T> = {
  messages: readonly BaseMessage[];
  invoke: () => Promise<T>;
  responseMessage: (result: T) => unknown;
  purpose: 'agent' | 'summary';
  estimatedInputTokens?: number | null;
  estimateApproximate?: boolean | null;
};

/** Provider-boundary accounting. Every path calls invoke() before entering the provider handler. */
export class RunBudgetObserver {
  private revision: string;
  private readonly pricing: ReturnType<typeof resolveModelPricing>;
  private readonly contextCycle = new AsyncLocalStorage<string>();

  constructor(
    private readonly ledger: RunBudgetLedger,
    private readonly runId: string,
    private readonly limits: RunLimits,
    revision: string,
    private readonly options: RunBudgetObserverOptions = {}
  ) {
    this.revision = revision;
    this.pricing = options.providerId === undefined || options.modelId === undefined
      ? null
      : resolveModelPricing({
          catalogVersion: limits.pricingCatalogVersion,
          providerId: options.providerId,
          modelId: options.modelId,
          asOf: new Date().toISOString()
        });
  }

  setRevision(revision: string): void {
    this.revision = revision;
  }

  withContextCycle<T>(cycleId: string, operation: () => Promise<T>): Promise<T> {
    return this.contextCycle.run(cycleId, operation);
  }

  emitStatus(): void {
    this.options.onStatus?.(this.ledger.readBudgetStatus(this.runId, this.limits, this.pricing !== null));
  }

  async invoke<T>(input: BudgetedModelInvocation<T>): Promise<T> {
    const startedAt = performance.now();
    let status: ModelInvocationObservation['status'] = 'blocked';
    let actualInputTokens: number | null = null;
    let actualOutputTokens: number | null = null;
    let actualCacheReadTokens: number | null = null;
    let actualCacheCreationTokens: number | null = null;
    try {
      const callId = randomUUID();
      const messages = redactUnknown(input.messages.map((message) => message.toDict()));
      const reservationCostMicrousd = this.pricing === null
        ? null
        : estimateModelReservationMicrousd({
            inputTokens: this.limits.maxCallTokens - this.limits.maxOutputTokens,
            outputTokens: this.limits.maxOutputTokens,
            price: this.pricing
          });
      if (this.pricing !== null && reservationCostMicrousd === null) {
        this.recordStopReason('run_cost_estimate_unavailable');
        throw new Error('run_cost_estimate_unavailable');
      }
      const pricingVersion = this.limits.pricingCatalogVersion;
      const inputHash = hashToolInput({ purpose: input.purpose, messages });
      try {
        this.ledger.reserve(this.runId, this.limits, {
          id: callId,
          kind: 'model',
          tokens: this.limits.maxCallTokens,
          inputHash,
          envelope: {
            schemaVersion: 2,
            callId,
            revision: this.revision,
            purpose: input.purpose,
            messages,
            reservedTokens: this.limits.maxCallTokens,
            maxOutputTokens: this.limits.maxOutputTokens,
            estimateSource: 'context-output-margin-upper-bound',
            reservedCostMicrousd: reservationCostMicrousd,
            pricingVersion
          },
          costMicrousd: reservationCostMicrousd,
          pricingVersion
        });
      } catch (error) {
        this.recordErrorStopReason(error);
        throw error;
      }

      status = 'failed';
      this.ledger.consumeCorrections(this.runId, input.messages.map((message) => message.id ?? ''));
      this.emitStatus();

      let result: T;
      try {
        result = await input.invoke();
      } catch (error) {
        status = 'failed';
        this.ledger.settle(this.runId, callId, null, 'unknown', undefined, {}, null, pricingVersion);
        this.recordErrorStopReason(error);
        this.emitStatus();
        throw error;
      }

      status = 'completed';
      const usage = readMessageUsage(input.responseMessage(result));
      if (usage === null) {
        this.ledger.settle(this.runId, callId, null, 'unknown', undefined, {}, null, pricingVersion);
        this.emitStatus();
        return result;
      }

      actualInputTokens = usage.inputTokens;
      actualOutputTokens = usage.outputTokens;
      actualCacheReadTokens = usage.cacheReadTokens;
      actualCacheCreationTokens = usage.cacheWriteTokens;
      const costMicrousd = this.pricing === null
        ? null
        : calculateModelCostMicrousd({
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            price: this.pricing
          });
      const settledState = costMicrousd === null && this.pricing !== null ? 'unknown' : 'settled';
      this.ledger.settle(
        this.runId,
        callId,
        usage.totalTokens,
        settledState,
        undefined,
        {},
        costMicrousd,
        pricingVersion
      );
      const budgetStatus = this.ledger.readBudgetStatus(this.runId, this.limits, this.pricing !== null);
      const overReservation = usage.totalTokens > this.limits.maxCallTokens ||
        (costMicrousd !== null && reservationCostMicrousd !== null && costMicrousd > reservationCostMicrousd);
      const overCostCap = budgetStatus.cost.limitMicrousd !== null &&
        budgetStatus.cost.settledMicrousd !== null && budgetStatus.cost.reservedMicrousd !== null &&
        budgetStatus.cost.settledMicrousd + budgetStatus.cost.reservedMicrousd > budgetStatus.cost.limitMicrousd;
      if (overReservation || overCostCap) {
        const reason = overCostCap ? 'run_cost_budget_exhausted' : 'run_model_call_token_reservation_exhausted';
        this.ledger.recordStopReason(this.runId, reason);
        this.emitStatus();
        throw new Error(reason);
      }
      this.emitStatus();
      return result;
    } catch (error) {
      if (status === 'completed') status = 'failed';
      throw error;
    } finally {
      const observation: ModelInvocationObservation = {
        purpose: input.purpose,
        status,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
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
        // Diagnostics must never change model execution or budget settlement.
      }
    }
  }

  private recordErrorStopReason(error: unknown): void {
    if (error instanceof Error && error.message.startsWith('run_')) {
      this.recordStopReason(error.message.slice(0, 128));
    }
  }

  private recordStopReason(reason: string): void {
    this.ledger.recordStopReason(this.runId, reason);
    this.emitStatus();
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
