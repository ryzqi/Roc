import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, fileInventory, hash, readJson, sha256, writeJson } from './common.mjs';
import { distribution, mean, summarizeDiagnostics, summarizeResources } from './analysis.mjs';
import { assertFixedProtocol, assessAcceptance, comparisonEvidence, metricState, pairedComparison, readComparisonProtocol, validMetrics } from './comparison.mjs';
import { compareAblation } from './ablation.mjs';

export { comparisonFields, hasApplicationRuntimeEvidence, hasRagRuntimeEvidence, hasRagSourceBoundaryEvidence, hasReviewedRetrievalProvenance } from './comparison.mjs';
export { compareAblation } from './ablation.mjs';

export function summarize(manifest, trials, fatal = null, usage = null) {
  const selection = manifest.selection ?? [], names = manifest.metrics ?? [];
  const expected = Number.isSafeInteger(manifest.repeats) && manifest.repeats > 0 ? selection.length * manifest.repeats : 0;
  const valid = trials.filter(trial => names.length && validMetrics(trial, names) && trial.status !== 'invalid'
    && (!trial.failureClass || trial.failureClass === 'agent'));
  const expectedKeys = new Set(selection.flatMap(task => Array.from({ length: manifest.repeats > 0 ? manifest.repeats : 0 },
    (_, repeat) => JSON.stringify([task.id, repeat]))));
  const actualKeys = new Set(trials.map(trial => JSON.stringify([trial.taskId, trial.repeat])));
  const clusters = new Map(selection.map(task => [task.id, task.clusterId]));
  const trialSetValid = expectedKeys.size === expected && actualKeys.size === expected && trials.length === actualKeys.size
    && [...expectedKeys].every(key => actualKeys.has(key)) && trials.every(trial => trial.clusterId === clusters.get(trial.taskId));
  const complete = expected > 0 && names.length > 0 && !fatal && trials.length === expected && valid.length === expected && trialSetValid;
  const metrics = Object.fromEntries(names.map(name => [name,
    mean(valid.filter(trial => metricState(trial, name) === 'measured').map(trial => trial.metrics[name]))]));
  const metricCounts = Object.fromEntries(names.map(name => {
    const n = valid.filter(trial => metricState(trial, name) === 'measured').length;
    const notApplicable = valid.filter(trial => metricState(trial, name) === 'not_applicable').length;
    return [name, { n, notApplicable, invalid: trials.length - n - notApplicable }];
  }));
  const diagnostics = summarizeDiagnostics(trials), resources = summarizeResources(trials, usage);
  const latency = distribution(trials.map(trial => trial.latencyMs));
  const exclusions = Array.isArray(manifest.exclusions) ? manifest.exclusions : [];
  const fixture = ['fixture', 'engineering-fixture'].includes(manifest.evidence);
  return { schemaVersion: 1, suite: manifest.suite, evidence: manifest.evidence,
    status: complete ? 'complete' : 'incomplete', qualityConclusion: fixture ? 'fixture-only'
      : manifest.suite === 'rag-retrieval' && ['production-component', 'human-reviewed-retrieval'].includes(manifest.evidence) ? 'component-comparison-required'
        : manifest.evidence === 'live-model' ? 'comparison-required' : 'controlled-or-insufficient-evidence',
    expected, attempted: trials.length, scored: valid.length, invalid: trials.length - valid.length, unattempted: Math.max(0, expected - trials.length),
    overattempted: Math.max(0, trials.length - expected), trialSetValid,
    exclusions: Object.fromEntries([...new Set(exclusions.map(e => e.reason))].map(reason => [reason, exclusions.filter(e => e.reason === reason).length])), metrics, metricCounts, fatal,
    failureCounts: Object.fromEntries([...new Set(trials.filter(t => t.failureClass).map(t => t.failureClass))].map(c => [c, trials.filter(t => t.failureClass === c).length])),
    metricValidation: { invalidTrials: trials.filter(trial => !validMetrics(trial, names)).map(trial =>
      ({ taskId: trial.taskId, repeat: trial.repeat, invalidMetrics: names.filter(name => metricState(trial, name) === 'invalid'),
        unknownApplicabilityMetrics: Object.keys(trial.metricApplicability && typeof trial.metricApplicability === 'object'
          ? trial.metricApplicability : {}).filter(name => !names.includes(name)) })) },
    latencyMs: { median: latency.p50, p50: latency.p50, p95: latency.p95, observed: latency.observed, unknown: latency.unknown },
    diagnostics, resources, usage, releaseEligible: false };
}
const cell = value => String(value ?? 'unknown').replaceAll('|', '\\|').replace(/[\r\n]/g, ' ').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const table = (columns, rows) => `| ${columns.join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n${rows.map(row =>
  `| ${row.map(cell).join(' | ')} |`).join('\n')}\n`;
const show = value => value === null || value === undefined ? 'unknown' : typeof value === 'object' ? JSON.stringify(value) : value;
function resourceTable(resources) {
  if (!resources) return 'Resource measurements unavailable.\n';
  return table(['Resource', 'Complete total', 'Known subtotal', 'Mean per trial', 'P50 per trial', 'P95 per trial', 'Unknown trials'],
    ['requests', 'inputTokens', 'outputTokens', 'totalTokens', 'costUsd'].map(name => {
      const value = resources[name] ?? {};
      return [name, show(value.total), show(value.knownTotal), show(value.mean), show(value.p50), show(value.p95), show(value.unknown)];
    })) + `\n- Unknown usage requests: ${show(resources.unknownUsageRequests)}\n- Unknown cost requests: ${show(resources.unknownCostRequests)}\n- Pending requests: ${show(resources.pendingRequests)}\n- Cost per successful task: ${show(resources.costPerSuccessfulTaskUsd)} USD (${show(resources.successfulTrials)} successful trials; ${show(resources.unknownSuccessTrials)} unknown outcomes)\n- Price revision: ${cell(resources.costBasis)}\n- End-to-end P50/P95: ${show(resources.latencyMs?.p50)} / ${show(resources.latencyMs?.p95)} ms\n- Retrieval P50/P95: ${show(resources.retrievalLatencyMs?.p50)} / ${show(resources.retrievalLatencyMs?.p95)} ms\n- Run duration: ${show(resources.runDurationMs)} ms\n\nBudget accounting is recorded separately from measured cost. Missing usage or prices remain unknown.\n`;
}
function traceLinks(trial, available) {
  const directories = [`trial-${hash(trial.taskId).slice(0, 16)}-${trial.repeat}`, `trial-${trial.taskId}-${trial.repeat}`];
  const recorded = trial.traces?.artifacts ?? [];
  const candidates = [...directories.map(directory => available.has(`${directory}/grade.json`) ? `${directory}/grade.json` : null),
    ...recorded.map(value => typeof value === 'string' ? value : value.artifact ?? value.path)].filter(Boolean);
  const paths = [...new Set(candidates)];
  return paths.length ? paths.map(path => available.has(path)
    ? `[${cell(path).replaceAll('[', '\\[').replaceAll(']', '\\]')}](${path.split('/').map(encodeURIComponent).join('/')})`
    : `${cell(path)} (recorded pointer)`).join(', ') : `trials.json: ${cell(trial.taskId)}, repeat ${trial.repeat}`;
}
export function renderRunReport(path, summary, trials) {
  const available = new Set(fileInventory(path).map(file => file.path));
  let acceptance = '', dimensions = '';
  if (summary.suite === 'roc-harness') {
    acceptance = `- Harness gate: ${summary.assessment}\n- Coverage: ${summary.coverage}\n- Passed: ${summary.passed}/${summary.expected}; failed: ${summary.failed}\n`;
    dimensions = `## Harness dimensions\n\n${table(['Dimension', 'Passed', 'Scored', 'Expected'],
      Object.entries(summary.dimensions ?? {}).map(([name, value]) => [name, value.passed, value.scored, value.expected]))}\n`;
  }
  const diagnostics = summary.diagnostics ?? summarizeDiagnostics(trials);
  const drilldown = diagnostics.trials ?? [];
  return `# Roc evaluation\n\n- Status: ${summary.status}\n- Suite: ${summary.suite}\n- Evidence: ${summary.evidence} (${summary.qualityConclusion})\n${acceptance}- Trials: ${summary.scored}/${summary.expected} scored, ${summary.invalid} invalid, ${summary.unattempted} unattempted\n\n${dimensions}## Metrics\n\n${table(['Metric', 'Applicable mean', 'n', 'Not applicable', 'Invalid trials'], Object.entries(summary.metrics ?? {}).map(([name, value]) =>
    [name, show(value), show(summary.metricCounts?.[name]?.n), show(summary.metricCounts?.[name]?.notApplicable), show(summary.metricCounts?.[name]?.invalid)]))}\nOnly explicitly marked not_applicable null values are excluded. An absent applicable mean remains unknown.\n\n## Failure stages and labels\n\n${table(['Stage', 'Passed', 'Failed', 'Unknown', 'Not applicable'],
    Object.entries(diagnostics.stages).map(([name, value]) => [name, value.passed, value.failed, value.unknown, value.notApplicable ?? 0]))}\n${table(['Failure label', 'Trials'],
    Object.entries(diagnostics.failureLabels).map(([name, value]) => [name, value]))}\nStage labels identify recorded anomalies; they do not establish a unique causal root cause. Trials needing review: ${diagnostics.needsReview}.\n\n## Resource use\n\n${resourceTable(summary.resources ?? summarizeResources(trials, summary.usage))}\n## Trial drilldown\n\n${table(['Task', 'Repeat', 'Status', 'Reason / failed criteria', 'First abnormal stage', 'Failure labels', 'Metrics', 'Applicability', 'Trace pointers'], drilldown.map(trial =>
    [trial.taskId, trial.repeat, trial.status, [trial.reason, ...(trial.failedCriteria ?? [])].filter(Boolean).join(', '),
      trial.firstAbnormalStage, trial.failureLabels.join(', '), show(trial.metrics), show(trial.metricApplicability), traceLinks(trial, available)]))}\n## Run diagnostics\n\n\`\`\`json\n${JSON.stringify({ fatal: summary.fatal, failures: summary.failureCounts, exclusions: summary.exclusions,
    metricValidation: summary.metricValidation }, null, 2)}\n\`\`\`\n\nSee [manifest.json](manifest.json) for frozen contracts, [trials.json](trials.json) for recorded results, and [events.jsonl](events.jsonl) for dispatch history. Partial metrics never establish a passing run. Noninferiority does not establish improvement or release approval.\n`;
}
export function sealRun(path, summary) {
  writeJson(join(path, 'summary.json'), summary);
  writeFileSync(join(path, 'report.md'), renderRunReport(path, summary, readJson(join(path, 'trials.json'))), { flag: 'wx', mode: 0o600 });
  const inventory = fileInventory(path);
  writeJson(join(path, 'seal.json'), { schemaVersion: 1, inventory, sha256: hash(inventory) });
}
export function inspectRun(path) {
  const seal = readJson(join(path, 'seal.json'));
  const actual = fileInventory(path).filter(f => f.path !== 'seal.json');
  if (hash(actual) !== seal.sha256 || hash(seal.inventory) !== seal.sha256) fail('state', 'run_evidence_changed');
  const manifest = readJson(join(path, 'manifest.json')), summary = readJson(join(path, 'summary.json')), trials = readJson(join(path, 'trials.json'));
  return { path, sealHash: sha256(readFileSync(join(path, 'seal.json'))), manifest, summary, trials };
}
export function compareRuns(baseline, candidate, { margin, protocol: reference } = {}) {
  if (reference !== undefined) {
    const context = readComparisonProtocol(reference);
    if (context.protocol.spec.kind === 'ablation') return compareAblation(baseline, candidate, { margin, protocol: reference });
    assertFixedProtocol(context, baseline, candidate);
    const acceptance = context.protocol.spec.acceptance;
    if (margin !== undefined && margin !== acceptance.nonInferiorityMargin) fail('policy', 'comparison_protocol_margin_mismatch');
    const comparison = pairedComparison(comparisonEvidence(baseline, candidate), { margin: acceptance.nonInferiorityMargin, acceptance });
    return { ...comparison, protocolKind: 'fixed-contract', protocolHash: context.protocol.recordHash,
      acceptance: assessAcceptance(acceptance, baseline, candidate, comparison), releaseEligible: false };
  }
  margin ??= .05;
  if (!Number.isFinite(margin) || margin < 0 || margin > .05) fail('policy', 'comparison_margin_invalid');
  return { ...pairedComparison(comparisonEvidence(baseline, candidate), { margin }), protocolKind: 'fixed-contract', releaseEligible: false };
}

export function renderComparisonReport(comparison) {
  const metrics = Object.entries(comparison.metrics ?? {}).map(([name, value]) => [name, value.baseline, value.candidate,
    value.delta, value.sampleSize?.clusters, value.sampleSize?.pairedTrials, value.sampleSize?.notApplicableTrials,
    show(value.confidence95), show(value.confidenceAdjusted), value.decision, value.superiority?.supported ?? 'not preregistered']);
  const perTask = (comparison.perTask ?? []).flatMap(task => Object.entries(task.metrics).map(([metric, value]) =>
    [task.taskId, task.clusterId, metric, value.applicability, value.baseline, value.candidate, value.delta]));
  return `# Roc evaluation comparison\n\n- Protocol: ${comparison.protocolKind ?? 'fixed-contract'}\n- Conclusion: ${comparison.conclusion}\n- Scope: ${cell(comparison.scope)}\n- Method: ${cell(comparison.method)}; ${show(comparison.clusters)} total independent clusters; ${show(comparison.iterations)} bootstrap samples per sufficient metric\n- Minimum per metric: ${show(comparison.minimumClusters)} applicable clusters, ${show(comparison.minimumRepeats)} repeats\n- Margin: ${show(comparison.margin)}\n- Release approval: not established\n\n## Quality differences\n\n${table(['Metric', 'Baseline', 'Candidate', 'Delta', 'Applicable clusters', 'Paired n', 'Not applicable trials per arm', '95% CI', 'Adjusted CI', 'Decision', 'Preregistered superiority'], metrics)}\n## Per-task differences\n\n${table(['Task', 'Cluster', 'Metric', 'Applicability', 'Baseline', 'Candidate', 'Delta'], perTask)}\n## Baseline resources\n\n${resourceTable(comparison.resources?.baseline)}\n## Candidate resources\n\n${resourceTable(comparison.resources?.candidate)}\n## Frozen gates and trace references\n\n\`\`\`json\n${JSON.stringify({ mismatches: comparison.mismatches, reason: comparison.reason,
    multiplicity: comparison.multiplicity, declaredDifferences: comparison.declaredDifferences,
    actualDifferences: comparison.actualDifferences, toolSchemaHashes: comparison.toolSchemaHashes,
    acceptance: comparison.acceptance, resourcesDelta: comparison.resources?.delta, traces: comparison.traces,
    metricSampleSizes: Object.fromEntries(Object.entries(comparison.metrics ?? {}).map(([name, value]) => [name, value.sampleSize])),
    trialDiffs: comparison.perTask?.map(task => ({ taskId: task.taskId, trials: task.trials })) }, null, 2)}\n\`\`\`\n\nNoninferiority does not establish improvement. Development eligibility does not establish release approval.\n`;
}
export function writeComparisonReport(path, comparison) {
  if (readdirSync(path).length) fail('policy', 'comparison_report_requires_fresh_directory');
  writeJson(join(path, 'comparison.json'), comparison);
  writeFileSync(join(path, 'report.md'), renderComparisonReport(comparison), { flag: 'wx', mode: 0o600 });
}
