import { z } from 'zod';
import { fail, hash } from './common.mjs';

const count = z.int().nonnegative();
const identifier = z.string().min(1).max(256);
const requestKind = z.enum(['chat', 'embedding', 'rerank']).default('chat');
const money = z.number().nonnegative();
const pricingRateSchema = z.strictObject({
  providerId: identifier,
  model: identifier,
  inputUsdPerMillionTokens: money,
  outputUsdPerMillionTokens: money
});
export const pricingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  version: identifier,
  currency: z.literal('USD'),
  rates: z.array(pricingRateSchema).min(1)
}).superRefine((pricing, context) => {
  const keys = pricing.rates.map(rate => JSON.stringify([rate.providerId, rate.model]));
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: 'custom', message: 'budget_pricing_duplicate_model', path: ['rates'] });
  }
});
export const budgetOptionsSchema = z.strictObject({
  maxModelRequests: count.optional(),
  maxInputTokens: count.optional(),
  maxOutputTokens: count.optional(),
  maxEstimatedCostUsd: money.optional(),
  maxTaskDurationMs: count.max(2147483647).optional(),
  maxRunDurationMs: count.max(2147483647).optional(),
  pricing: pricingSchema.optional()
}).superRefine((options, context) => {
  if (options.maxEstimatedCostUsd !== undefined && !options.pricing) {
    context.addIssue({ code: 'custom', message: 'budget_pricing_required', path: ['pricing'] });
  }
});

const amountsSchema = z.strictObject({
  inputTokens: count,
  outputTokens: count,
  estimatedCostUsd: money.nullable()
});
const measuredSchema = z.strictObject({
  inputTokens: count.nullable(),
  outputTokens: count.nullable(),
  estimatedCostUsd: money.nullable()
});
const reservationSchema = z.object({
  requestId: identifier,
  trialId: identifier,
  requestHash: identifier,
  kind: requestKind,
  providerId: identifier.nullable(),
  model: identifier,
  requestNumber: count.min(1),
  state: z.enum(['reserved', 'dispatched', 'settled', 'unknown']),
  reserved: amountsSchema,
  measured: measuredSchema,
  createdAtMs: count,
  updatedAtMs: count,
  dispatchedAtMs: count.nullable(),
  reason: z.string().nullable()
});
const restoreSchema = z.object({
  schemaVersion: z.literal(1),
  scope: z.literal('run'),
  policyHash: identifier,
  startedAtMs: count,
  capturedAtMs: count,
  elapsedMs: count,
  nextRequestNumber: count,
  reservations: z.array(reservationSchema)
});
const reservationInputSchema = z.strictObject({
  trialId: identifier.default('unscoped'),
  requestId: identifier,
  requestHash: identifier,
  kind: requestKind,
  providerId: identifier.optional(),
  model: identifier,
  inputTokens: count,
  outputTokens: count
});

const validCount = value => Number.isSafeInteger(value) && value >= 0;
const copy = value => structuredClone(value);
function sum(values) {
  const total = values.reduce((result, value) => result + value, 0);
  if (!validCount(total)) fail('policy', 'budget_token_accounting_overflow');
  return total;
}
function measuredSum(values) {
  const observed = values.filter(value => value !== null);
  return observed.length ? sum(observed) : values.length ? null : 0;
}
function usageCounts(usage) {
  const select = (wire, camel, snake) => usage && Object.hasOwn(usage, wire) ? usage[wire]
    : usage && Object.hasOwn(usage, camel) ? usage[camel] : usage?.[snake];
  const input = select('prompt_tokens', 'inputTokens', 'input_tokens');
  const output = select('completion_tokens', 'outputTokens', 'output_tokens');
  return { inputTokens: validCount(input) ? input : null, outputTokens: validCount(output) ? output : null };
}

// Decimal integer arithmetic keeps admissions exact at monetary boundaries (including 0.1 + 0.2).
// Public USD numbers are estimates; no provider rates or cache discounts are inferred.
function decimal(value) {
  const [base, exponent = '0'] = String(value).split('e');
  const [whole, fraction = ''] = base.split('.');
  return { coefficient: BigInt(whole + fraction), scale: fraction.length - Number(exponent) };
}
function units(value, scale) {
  const parsed = decimal(value);
  return parsed.coefficient * 10n ** BigInt(scale - parsed.scale);
}
function usd(value, scale) {
  const digits = value.toString().padStart(scale + 1, '0');
  const result = Number(`${digits.slice(0, -scale)}.${digits.slice(-scale)}`);
  if (!Number.isFinite(result) || value > 0n && result === 0) fail('policy', 'budget_estimated_cost_invalid');
  return result;
}

/**
 * One trusted host owns this controller for a run. Methods mutate synchronously and callbacks
 * must durably append synchronously (the harness journal fsyncs). Never put this object in a worker.
 * reserve() charges one dispatch, using host-computed aggregate token upper bounds across all
 * messages, embedding texts, or rerank query/documents. kind labels the call, not a chat transport.
 */
export class BudgetController {
  #options;
  #record;
  #now;
  #reservations = new Map();
  #nextRequestNumber = 0;
  #startedAtMs;
  #capturedAtMs;
  #elapsedMs = 0;
  #policyHash;
  #costScale;
  #journalFailed = false;

  constructor(options = {}, record = () => {}, { now = Date.now } = {}) {
    this.#options = budgetOptionsSchema.parse(options);
    this.#record = record;
    this.#now = now;
    this.#startedAtMs = this.#capturedAtMs = this.#time();
    this.#policyHash = hash(this.#options);
    this.#costScale = Math.max(6, ...[
      this.#options.maxEstimatedCostUsd,
      ...this.#options.pricing?.rates.flatMap(rate => [rate.inputUsdPerMillionTokens, rate.outputUsdPerMillionTokens]) ?? []
    ].filter(value => value !== undefined).map(value => decimal(value).scale + 6));
  }

  #time() {
    const value = this.#now();
    if (!validCount(value)) fail('state', 'budget_clock_invalid');
    return value;
  }

  #clock() {
    const now = this.#time();
    this.#elapsedMs = sum([this.#elapsedMs, Math.max(0, now - this.#capturedAtMs)]);
    this.#capturedAtMs = Math.max(this.#capturedAtMs, now);
    return this.#capturedAtMs;
  }

  #emit(type, detail) {
    if (this.#journalFailed) fail('state', 'budget_journal_failed');
    try {
      const result = this.#record({ type, ...copy(detail), elapsedMs: this.#elapsedMs, atMs: this.#capturedAtMs });
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {});
        throw new Error('async_callback');
      }
    } catch {
      this.#journalFailed = true;
      fail('state', 'budget_journal_failed');
    }
  }

  #reject(reason, detail = {}) {
    this.#emit('budget_rejected', { ...detail, state: 'rejected', reason });
    fail('policy', reason);
  }

  #rate(providerId, model) {
    return this.#options.pricing?.rates.find(rate => rate.providerId === providerId && rate.model === model);
  }

  assertPricing(providerId, model, context = {}) {
    if (this.#options.maxEstimatedCostUsd !== undefined && !this.#rate(providerId, model)) {
      this.#reject('budget_pricing_model_missing', { ...context, providerId: providerId ?? null, model });
    }
  }

  #cost(inputTokens, outputTokens, providerId, model) {
    const rate = this.#rate(providerId, model);
    if (!rate || inputTokens === null || outputTokens === null) return null;
    return BigInt(inputTokens) * units(rate.inputUsdPerMillionTokens, this.#costScale - 6)
      + BigInt(outputTokens) * units(rate.outputUsdPerMillionTokens, this.#costScale - 6);
  }

  #amounts(reservation, measured = false) {
    const source = measured ? reservation.measured : reservation.state === 'settled' ? reservation.measured : {
      inputTokens: Math.max(reservation.reserved.inputTokens, reservation.measured.inputTokens ?? 0),
      outputTokens: Math.max(reservation.reserved.outputTokens, reservation.measured.outputTokens ?? 0)
    };
    const cost = this.#cost(source.inputTokens, source.outputTokens, reservation.providerId, reservation.model);
    return { inputTokens: source.inputTokens, outputTokens: source.outputTokens,
      estimatedCostUsd: cost === null ? null : usd(cost, this.#costScale) };
  }

  #view(reservation) {
    return copy({ ...reservation, accounted: this.#amounts(reservation),
      pricingRevision: this.#rate(reservation.providerId, reservation.model) ? this.#options.pricing.version : null });
  }

  #get(requestId) {
    const reservation = this.#reservations.get(requestId);
    if (!reservation) this.#reject('budget_reservation_missing', { requestId });
    return reservation;
  }

  #bind(reservation, binding) {
    if (binding?.trialId !== reservation.trialId || binding?.requestHash !== reservation.requestHash) {
      this.#reject('budget_request_binding_changed', this.#view(reservation));
    }
  }

  #limits(extra) {
    const values = [...this.#reservations.values(), ...(extra ? [extra] : [])];
    const accounted = values.map(value => this.#amounts(value));
    for (const [limit, total, reason] of [
      [this.#options.maxModelRequests, values.length, 'budget_max_model_requests'],
      [this.#options.maxInputTokens, sum(accounted.map(value => value.inputTokens)), 'budget_max_input_tokens'],
      [this.#options.maxOutputTokens, sum(accounted.map(value => value.outputTokens)), 'budget_max_output_tokens']
    ]) {
      if (limit !== undefined && total > limit) return reason;
    }
    if (this.#options.maxEstimatedCostUsd !== undefined) {
      const total = values.reduce((result, value, index) => {
        const amount = accounted[index];
        const cost = this.#cost(amount.inputTokens, amount.outputTokens, value.providerId, value.model);
        if (cost === null) this.#reject('budget_pricing_model_missing', this.#view(value));
        return result + cost;
      }, 0n);
      if (total > units(this.#options.maxEstimatedCostUsd, this.#costScale)) return 'budget_max_estimated_cost_usd';
    }
    return null;
  }

  checkRunDuration(context = {}) {
    this.#clock();
    const limit = this.#options.maxRunDurationMs;
    if (limit !== undefined && this.#elapsedMs >= limit) this.#reject('budget_max_run_duration', context);
    return { elapsedMs: this.#elapsedMs, remainingMs: limit === undefined ? null : limit - this.#elapsedMs };
  }

  checkTaskDuration(trialId, context = {}) {
    const now = this.#clock();
    const entries = [...this.#reservations.values()].filter(value => value.trialId === trialId);
    const elapsedMs = entries.length ? Math.max(0, now - Math.min(...entries.map(value => value.createdAtMs))) : 0;
    const limit = this.#options.maxTaskDurationMs;
    if (limit !== undefined && elapsedMs >= limit) this.#reject('budget_max_task_duration', { ...context, trialId });
    return { elapsedMs, remainingMs: limit === undefined ? null : limit - elapsedMs };
  }

  reserve(input) {
    const request = reservationInputSchema.parse(input);
    this.checkRunDuration(request);
    this.checkTaskDuration(request.trialId, request);
    if (this.#journalFailed) fail('state', 'budget_journal_failed');
    const previous = this.#reservations.get(request.requestId);
    if (previous) {
      this.#bind(previous, request);
      if (previous.kind !== request.kind || previous.model !== request.model || previous.providerId !== (request.providerId ?? null)
        || previous.reserved.inputTokens !== request.inputTokens || previous.reserved.outputTokens !== request.outputTokens) {
        this.#reject('budget_request_binding_changed', this.#view(previous));
      }
      if (previous.state !== 'reserved') this.#reject('budget_request_replay_blocked', this.#view(previous));
      return this.#view(previous);
    }
    this.assertPricing(request.providerId, request.model, request);
    const reservation = { requestId: request.requestId, trialId: request.trialId, requestHash: request.requestHash, kind: request.kind,
      providerId: request.providerId ?? null, model: request.model, requestNumber: this.#nextRequestNumber + 1,
      state: 'reserved', reserved: { inputTokens: request.inputTokens, outputTokens: request.outputTokens, estimatedCostUsd: null },
      measured: { inputTokens: null, outputTokens: null, estimatedCostUsd: null },
      createdAtMs: this.#capturedAtMs, updatedAtMs: this.#capturedAtMs, dispatchedAtMs: null, reason: null };
    reservation.reserved = this.#amounts(reservation);
    const exceeded = this.#limits(reservation);
    if (exceeded) this.#reject(exceeded, this.#view(reservation));
    this.#nextRequestNumber = reservation.requestNumber;
    this.#reservations.set(request.requestId, reservation);
    this.#emit('budget_reserved', this.#view(reservation));
    return this.#view(reservation);
  }

  dispatch(requestId, binding) {
    const reservation = this.#get(requestId);
    this.#bind(reservation, binding);
    const context = this.#view(reservation);
    this.checkRunDuration(context);
    this.checkTaskDuration(reservation.trialId, context);
    if (reservation.state !== 'reserved') this.#reject('budget_request_replay_blocked', this.#view(reservation));
    const exceeded = this.#limits();
    if (exceeded) this.#reject(exceeded, this.#view(reservation));
    reservation.state = 'dispatched';
    reservation.dispatchedAtMs = reservation.updatedAtMs = this.#capturedAtMs;
    this.#emit('budget_dispatched', this.#view(reservation));
    return this.#view(reservation);
  }

  #settle(reservation, usage, reconciled) {
    this.#clock();
    const measured = usageCounts(usage);
    if (reconciled) {
      for (const key of ['inputTokens', 'outputTokens']) {
        const previous = reservation.measured[key];
        if (previous !== null && measured[key] !== null && previous !== measured[key]) {
          this.#reject('budget_usage_reconciliation_changed', this.#view(reservation));
        }
        if (measured[key] === null) measured[key] = previous;
      }
    }
    reservation.measured = { ...measured, estimatedCostUsd: null };
    const complete = measured.inputTokens !== null && measured.outputTokens !== null;
    reservation.state = complete ? 'settled' : 'unknown';
    reservation.reason = complete ? null : 'provider_usage_missing';
    reservation.updatedAtMs = this.#capturedAtMs;
    reservation.measured = this.#amounts(reservation, true);
    this.#emit(complete ? 'budget_settled' : 'budget_unknown', { ...this.#view(reservation), reconciled });
    const exceeded = this.#limits();
    if (exceeded) this.#reject(exceeded, this.#view(reservation));
    return this.#view(reservation);
  }

  settle(requestId, usage) {
    const reservation = this.#get(requestId);
    if (reservation.state !== 'dispatched') this.#reject('budget_settlement_state_invalid', this.#view(reservation));
    return this.#settle(reservation, usage, false);
  }

  unknown(requestId, reason = 'provider_usage_missing') {
    const reservation = this.#get(requestId);
    if (!['dispatched', 'unknown'].includes(reservation.state)) {
      this.#reject('budget_settlement_state_invalid', this.#view(reservation));
    }
    this.#clock();
    reservation.state = 'unknown';
    reservation.reason = /^[a-z][a-z0-9_]{0,127}$/.test(reason) ? reason : 'provider_usage_unknown';
    reservation.updatedAtMs = this.#capturedAtMs;
    this.#emit('budget_unknown', this.#view(reservation));
    return this.#view(reservation);
  }

  reconcile(requestId, usage, binding) {
    const reservation = this.#get(requestId);
    this.#bind(reservation, binding);
    if (!['dispatched', 'unknown'].includes(reservation.state)) {
      this.#reject('budget_settlement_state_invalid', this.#view(reservation));
    }
    return this.#settle(reservation, usage, true);
  }

  snapshot({ trialId } = {}) {
    this.#clock();
    if (trialId !== undefined) identifier.parse(trialId);
    const values = [...this.#reservations.values()].filter(value => trialId === undefined || value.trialId === trialId);
    const accountedValues = values.map(value => this.#amounts(value));
    const knownInputTokens = measuredSum(values.map(value => value.measured.inputTokens));
    const knownOutputTokens = measuredSum(values.map(value => value.measured.outputTokens));
    const unknownUsageRequests = values.filter(value => value.state !== 'settled').length;
    const knownCosts = values.map(value => this.#cost(value.measured.inputTokens, value.measured.outputTokens, value.providerId, value.model));
    const unknownCostRequests = knownCosts.filter(value => value === null).length;
    const knownCostUnits = knownCosts.filter(value => value !== null).reduce((result, value) => result + value, 0n);
    const knownCostUsd = knownCosts.some(value => value !== null) || !values.length ? usd(knownCostUnits, this.#costScale) : null;
    const accountedCosts = values.map((value, index) => this.#cost(accountedValues[index].inputTokens, accountedValues[index].outputTokens, value.providerId, value.model));
    const accountedCostUsd = accountedCosts.some(value => value === null) ? null
      : usd(accountedCosts.reduce((result, value) => result + value, 0n), this.#costScale);
    const pendingRequests = values.filter(value => ['reserved', 'dispatched'].includes(value.state)).length;
    const unknownRequests = values.filter(value => value.state === 'unknown').length;
    const inputTokens = unknownUsageRequests ? null : knownInputTokens;
    const outputTokens = unknownUsageRequests ? null : knownOutputTokens;
    const start = trialId === undefined ? this.#startedAtMs : values.length ? Math.min(...values.map(value => value.createdAtMs)) : null;
    const end = pendingRequests ? this.#capturedAtMs : values.length ? Math.max(...values.map(value => value.updatedAtMs)) : start;
    return {
      schemaVersion: 1, scope: trialId === undefined ? 'run' : 'trial',
      ...(trialId === undefined ? {} : { trialId }),
      policyHash: this.#policyHash, startedAtMs: start, capturedAtMs: this.#capturedAtMs,
      elapsedMs: trialId === undefined ? this.#elapsedMs : start === null ? 0 : Math.max(0, end - start),
      nextRequestNumber: this.#nextRequestNumber,
      requests: values.length, inputTokens, outputTokens,
      totalTokens: inputTokens === null || outputTokens === null ? null : sum([inputTokens, outputTokens]),
      knownInputTokens, knownOutputTokens, unknownUsageRequests,
      costUsd: unknownUsageRequests || unknownCostRequests ? null : knownCostUsd,
      knownCostUsd, unknownCostRequests, pricingRevision: this.#options.pricing?.version ?? null,
      measured: { inputTokens: knownInputTokens, outputTokens: knownOutputTokens, estimatedCostUsd: knownCostUsd },
      accounted: { requests: values.length, inputTokens: sum(accountedValues.map(value => value.inputTokens)),
        outputTokens: sum(accountedValues.map(value => value.outputTokens)), estimatedCostUsd: accountedCostUsd },
      dispatchedRequests: values.filter(value => value.dispatchedAtMs !== null).length,
      settledRequests: values.filter(value => value.state === 'settled').length, pendingRequests, unknownRequests,
      usageState: unknownRequests ? 'unknown' : pendingRequests ? 'pending' : 'measured',
      reservations: values.map(value => this.#view(value)),
      replayBlockedRequestIds: values.filter(value => value.state !== 'reserved').map(value => value.requestId)
    };
  }

  restore(state) {
    if (this.#reservations.size || this.#nextRequestNumber || this.#journalFailed) fail('state', 'budget_restore_requires_empty_controller');
    const parsed = restoreSchema.safeParse(state);
    if (!parsed.success) fail('state', 'budget_snapshot_invalid');
    const saved = parsed.data;
    if (saved.policyHash !== this.#policyHash) fail('state', 'budget_snapshot_policy_changed');
    if (saved.capturedAtMs < saved.startedAtMs || saved.elapsedMs < saved.capturedAtMs - saved.startedAtMs
      || saved.nextRequestNumber !== saved.reservations.length) fail('state', 'budget_snapshot_invalid');
    const restored = new Map(), numbers = new Set();
    for (const value of saved.reservations) {
      if (restored.has(value.requestId) || numbers.has(value.requestNumber) || value.requestNumber > saved.nextRequestNumber
        || value.createdAtMs < saved.startedAtMs || value.updatedAtMs < value.createdAtMs || value.updatedAtMs > saved.capturedAtMs
        || value.dispatchedAtMs !== null && (value.dispatchedAtMs < value.createdAtMs || value.dispatchedAtMs > value.updatedAtMs)
        || (value.state === 'reserved') !== (value.dispatchedAtMs === null)
        || ['reserved', 'dispatched'].includes(value.state) && (value.measured.inputTokens !== null || value.measured.outputTokens !== null)
        || value.state === 'settled' && (value.measured.inputTokens === null || value.measured.outputTokens === null)) {
        fail('state', 'budget_snapshot_invalid');
      }
      this.assertPricing(value.providerId, value.model);
      const reservedCost = this.#cost(value.reserved.inputTokens, value.reserved.outputTokens, value.providerId, value.model);
      if (value.reserved.estimatedCostUsd !== (reservedCost === null ? null : usd(reservedCost, this.#costScale))) fail('state', 'budget_snapshot_invalid');
      value.measured = this.#amounts(value, true);
      restored.set(value.requestId, value);
      numbers.add(value.requestNumber);
    }
    this.#reservations = restored;
    this.#nextRequestNumber = saved.nextRequestNumber;
    this.#startedAtMs = saved.startedAtMs;
    this.#capturedAtMs = saved.capturedAtMs;
    this.#elapsedMs = saved.elapsedMs;
    this.#clock(); // Downtime counts. A backwards wall clock never refunds elapsed time.
    for (const value of restored.values()) {
      if (value.state === 'dispatched') this.unknown(value.requestId, 'resume_usage_unknown');
    }
    return this.snapshot();
  }
}
