// Reporting consumes recorded measurements only. Missing usage, prices or stage
// evidence stay unknown; a report must not turn an absent receipt into zero.
export const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
export const quantile = (values, p) => values.length
  ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(p * values.length))] : null;
const measured = value => Number.isFinite(value) && value >= 0;
const count = value => Number.isSafeInteger(value) && value >= 0;

export function distribution(values) {
  const known = values.filter(measured);
  return { observed: known.length, unknown: values.length - known.length, mean: mean(known),
    p50: quantile(known, .5), p95: quantile(known, .95) };
}
function aggregate(values) {
  const result = distribution(values), knownTotal = values.filter(measured).reduce((a, b) => a + b, 0);
  return { ...result, knownTotal: result.observed ? knownTotal : null,
    total: values.length && !result.unknown ? knownTotal : null };
}
function usageOf(trial) { return trial.usage ?? trial.resources ?? {}; }
function unknownUsage(usage) {
  const value = usage.unknownUsageRequests ?? usage.unknownRequests;
  return count(value) ? value : null;
}
function settledUsage(usage) {
  return unknownUsage(usage) === 0 && !(usage.pendingRequests > 0)
    && !['unknown', 'pending', 'partial'].includes(usage.usageState ?? usage.usageStatus);
}
function tokenMeasurement(usage, key) {
  // Legacy counters without completeness evidence remain known subtotals.
  if (!settledUsage(usage)) return null;
  return count(usage[key]) ? usage[key] : null;
}
function knownTokens(usage, key) {
  const knownKey = `known${key[0].toUpperCase()}${key.slice(1)}`;
  const value = usage[knownKey] ?? usage[key] ?? usage.measured?.[key];
  return count(value) ? value : null;
}
function costMeasurement(usage) {
  if (!settledUsage(usage) || (usage.unknownCostRequests ?? usage.unknownPriceRequests) !== 0
    || ['unknown', 'partial', 'unpriced'].includes(usage.costStatus)) return null;
  return measured(usage.costUsd) ? usage.costUsd : null;
}
function knownCost(usage) {
  const value = usage.knownCostUsd ?? usage.costUsd;
  return measured(value) ? value : null;
}
function knownSum(values) {
  const known = values.filter(measured);
  return known.length ? known.reduce((total, value) => total + value, 0) : null;
}
function successOf(trial) {
  if (typeof trial.success === 'boolean') return trial.success;
  if (trial.metrics?.successRate === 0 || trial.metrics?.successRate === 1) return trial.metrics.successRate === 1;
  if (trial.status === 'passed') return true;
  if (trial.status === 'failed') return false;
  return null;
}
function retrievalMeasurements(trial) {
  if (Object.hasOwn(trial, 'retrievalLatenciesMs')) {
    return Array.isArray(trial.retrievalLatenciesMs) && trial.retrievalLatenciesMs.length
      ? trial.retrievalLatenciesMs : [null];
  }
  return [trial.retrievalLatencyMs ?? trial.diagnostics?.retrievalLatencyMs];
}

export function summarizeResources(trials, usage = null) {
  const requests = trials.map(t => count(usageOf(t).requests ?? t.requests) ? (usageOf(t).requests ?? t.requests) : null);
  const result = {
    requests: aggregate(requests),
    inputTokens: aggregate(trials.map(t => tokenMeasurement(usageOf(t), 'inputTokens'))),
    outputTokens: aggregate(trials.map(t => tokenMeasurement(usageOf(t), 'outputTokens'))),
    totalTokens: aggregate(trials.map(t => {
      const u = usageOf(t), input = tokenMeasurement(u, 'inputTokens'), output = tokenMeasurement(u, 'outputTokens');
      return tokenMeasurement(u, 'totalTokens') ?? (input !== null && output !== null ? input + output : null);
    })),
    costUsd: aggregate(trials.map(t => costMeasurement(usageOf(t)))),
    latencyMs: distribution(trials.map(t => t.latencyMs)),
    retrievalLatencyMs: distribution(trials.flatMap(retrievalMeasurements)),
    unknownUsageRequests: aggregate(trials.map(t => unknownUsage(usageOf(t)))).total,
    unknownCostRequests: aggregate(trials.map(t => {
      const u = usageOf(t), value = u.unknownCostRequests ?? u.unknownPriceRequests;
      return count(value) ? value : null;
    })).total,
    runDurationMs: measured(usage?.runDurationMs ?? usage?.elapsedMs) ? (usage.runDurationMs ?? usage.elapsedMs) : null
  };
  for (const key of ['inputTokens', 'outputTokens']) {
    result[key].knownTotal = knownSum(trials.map(trial => knownTokens(usageOf(trial), key)));
  }
  result.totalTokens.knownTotal = knownSum(trials.map(trial => {
    const u = usageOf(trial);
    return knownTokens(u, 'totalTokens') ?? knownSum([knownTokens(u, 'inputTokens'), knownTokens(u, 'outputTokens')]);
  }));
  result.costUsd.knownTotal = knownSum(trials.map(trial => knownCost(usageOf(trial))));
  // A host snapshot can establish run totals, but cannot supply missing per-trial
  // quantiles. Old token counters without an unknown-usage count are subtotals.
  if (usage) {
    result.requests.total = count(usage.requests) ? usage.requests : null;
    if (count(usage.requests)) result.requests.knownTotal = usage.requests;
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) {
      result[key].knownTotal = key === 'totalTokens' ? knownTokens(usage, key)
        ?? knownSum([knownTokens(usage, 'inputTokens'), knownTokens(usage, 'outputTokens')]) : knownTokens(usage, key);
      result[key].total = tokenMeasurement(usage, key) ?? (key === 'totalTokens'
        && tokenMeasurement(usage, 'inputTokens') !== null && tokenMeasurement(usage, 'outputTokens') !== null
        ? usage.inputTokens + usage.outputTokens : null);
    }
    result.unknownUsageRequests = unknownUsage(usage);
    const unknownCostRequests = usage.unknownCostRequests ?? usage.unknownPriceRequests;
    result.unknownCostRequests = count(unknownCostRequests) ? unknownCostRequests : null;
    result.costUsd.knownTotal = knownCost(usage);
    result.costUsd.total = costMeasurement(usage);
  }
  const successes = trials.map(successOf), successCount = successes.filter(value => value === true).length;
  result.successfulTrials = successes.length && successes.every(value => value !== null) ? successCount : null;
  result.unknownSuccessTrials = successes.filter(value => value === null).length;
  result.costPerSuccessfulTaskUsd = result.costUsd.total !== null && result.successfulTrials > 0
    ? result.costUsd.total / result.successfulTrials : null;
  result.costBasis = usage?.pricingRevision ?? usage?.priceTableRevision ?? null;
  result.budgetAccounting = usage?.accounted ?? null;
  result.measurementState = usage?.usageState ?? null;
  result.pendingRequests = count(usage?.pendingRequests) ? usage.pendingRequests : null;
  return result;
}

export const resourceNames = ['requests', 'inputTokens', 'outputTokens', 'totalTokens', 'costUsd',
  'costPerSuccessfulTaskUsd', 'latencyP95Ms', 'retrievalP95Ms', 'runDurationMs'];
export function resourceValues(resources) {
  return Object.fromEntries(resourceNames.map(name => [name,
    name === 'latencyP95Ms' ? resources?.latencyMs?.unknown === 0 ? resources.latencyMs.p95 : null
      : name === 'retrievalP95Ms' ? resources?.retrievalLatencyMs?.unknown === 0 ? resources.retrievalLatencyMs.p95 : null
        : ['costPerSuccessfulTaskUsd', 'runDurationMs'].includes(name) ? resources?.[name] ?? null
          : resources?.[name]?.total ?? null]));
}

export const diagnosticStages = ['ingestion', 'retrieval', 'rerank', 'context', 'tool', 'generation', 'format', 'verification'];
const reasonLabels = {
  output_not_json: ['format_error'], output_schema_invalid: ['format_error'],
  citation_invalid: ['citation_invalid'], provider_transport_failed: ['provider_error'],
  provider_response_invalid: ['provider_error'], run_cancelled: ['operator_interrupt']
};
function stageStatus(value) {
  const status = typeof value === 'object' && value !== null ? value.status : value;
  return status === true || status === 'passed' || status === 'verified' ? 'passed'
    : status === false || status === 'failed' || status === 'invalid' ? 'failed'
      : status === 'not_applicable' ? 'not_applicable' : 'unknown';
}
export function trialDiagnostics(trial) {
  const input = trial.diagnostics && typeof trial.diagnostics === 'object' ? trial.diagnostics : {};
  const suppliedStages = Array.isArray(input.stages)
    ? Object.fromEntries(input.stages.filter(stage => stage && typeof stage.stage === 'string').map(stage => [stage.stage, stage]))
    : input.stages && typeof input.stages === 'object' ? input.stages : {};
  const stages = Object.fromEntries(diagnosticStages.map(stage => [stage, stageStatus(suppliedStages[stage])]));
  for (const [field, stage] of [['indexContainsGold', 'ingestion'], ['goldInCandidates', 'retrieval'],
    ['goldInContext', 'context'], ['formatValid', 'format']]) {
    if (typeof input[field] === 'boolean') stages[stage] = stageStatus(input[field]);
  }
  for (const [field, stage] of [['ingestionCoverage', 'ingestion'], ['retrievalCoverage', 'retrieval'], ['contextCoverage', 'context']]) {
    if (Number.isFinite(input[field]) && input[field] >= 0 && input[field] <= 1) {
      stages[stage] = input[field] === 1 ? 'passed' : 'failed';
    }
  }
  if (trial.runtimeVerification || trial.ragVerification) {
    const verifications = [trial.runtimeVerification, trial.ragVerification].filter(Boolean).map(value => stageStatus(value.status));
    stages.verification = verifications.includes('failed') ? 'failed'
      : verifications.every(value => value === 'passed') ? 'passed' : 'unknown';
  }
  const suppliedLabels = input.failureLabels ?? input.labels ?? trial.failureLabels ?? [];
  const labels = new Set((Array.isArray(suppliedLabels) ? suppliedLabels : []).filter(label => typeof label === 'string' && label.trim()));
  for (const label of reasonLabels[trial.reason] ?? []) labels.add(label);
  for (const stage of diagnosticStages.filter(stage => stages[stage] === 'failed')) {
    labels.add(stage === 'retrieval' ? 'retrieval_miss' : stage === 'context' ? 'context_loss' : `${stage}_failure`);
  }
  if (trial.failureClass && trial.failureClass !== 'agent') labels.add(trial.failureClass);
  const unsuccessful = trial.status === 'failed' || trial.status === 'invalid' || Boolean(trial.failureClass);
  const needsReview = Boolean(input.needsReview) || (unsuccessful && !labels.size);
  if (needsReview) labels.add('needs_review');
  if (unsuccessful && diagnosticStages.every(stage => stages[stage] !== 'failed')) labels.add('unknown');
  const firstAbnormalStage = diagnosticStages.find(stage => stages[stage] === 'failed')
    ?? (diagnosticStages.includes(input.firstAbnormalStage ?? input.firstStage) ? (input.firstAbnormalStage ?? input.firstStage) : null);
  return { failureLabels: [...labels].sort(), firstAbnormalStage, needsReview, stages };
}
export function trialTracePointers(trial) {
  const artifacts = trial.tracePointers ?? trial.artifacts ?? trial.traces?.artifacts ?? [];
  const supplied = Array.isArray(artifacts) ? artifacts : typeof artifacts === 'string' ? [artifacts]
    : artifacts && typeof artifacts === 'object' ? Object.values(artifacts) : [];
  return { trialRecord: { artifact: 'trials.json', taskId: trial.taskId, repeat: trial.repeat },
    artifacts: supplied.filter(value => typeof value === 'string' && value.length > 0
      || value && typeof value === 'object' && typeof (value.artifact ?? value.path) === 'string') };
}
export function summarizeDiagnostics(trials) {
  const drilldown = trials.map(trial => ({ taskId: trial.taskId, clusterId: trial.clusterId, repeat: trial.repeat,
    status: trial.status, failureClass: trial.failureClass ?? null, reason: trial.reason ?? null,
    failedCriteria: Array.isArray(trial.checks) ? trial.checks.filter(check => check && check.passed === false)
      .map(check => check.criterion ?? check.name ?? check.id).filter(value => typeof value === 'string') : [],
    ...trialDiagnostics(trial), metrics: trial.metrics ?? null, metricApplicability: trial.metricApplicability ?? null,
    latencyMs: measured(trial.latencyMs) ? trial.latencyMs : null,
    usage: trial.usage ?? null, traces: trialTracePointers(trial) }));
  const failureLabels = {}, firstAbnormalStages = {};
  for (const trial of drilldown) {
    for (const label of trial.failureLabels) failureLabels[label] = (failureLabels[label] ?? 0) + 1;
    if (trial.firstAbnormalStage) firstAbnormalStages[trial.firstAbnormalStage] = (firstAbnormalStages[trial.firstAbnormalStage] ?? 0) + 1;
  }
  const stages = Object.fromEntries(diagnosticStages.map(stage => [stage, {
    passed: drilldown.filter(t => t.stages[stage] === 'passed').length,
    failed: drilldown.filter(t => t.stages[stage] === 'failed').length,
    unknown: drilldown.filter(t => t.stages[stage] === 'unknown').length,
    notApplicable: drilldown.filter(t => t.stages[stage] === 'not_applicable').length
  }]));
  return { failureLabels, firstAbnormalStages, stages, needsReview: drilldown.filter(t => t.needsReview).length, trials: drilldown };
}
