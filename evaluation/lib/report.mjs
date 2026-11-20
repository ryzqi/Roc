import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, fileInventory, hash, readJson, sha256, writeJson } from './common.mjs';
import { distribution, mean, quantile, summarizeDiagnostics, summarizeResources, trialTracePointers } from './analysis.mjs';
import { assertFixedProtocol, assessAcceptance, assessSafetyGates, compareIdentityComparison, comparisonEvidence,
  hasApplicationRuntimeEvidence, isCapabilitySuite, isIdentityComparison, metricState, pairedComparison,
  readComparisonProtocol, safetyMetricNames, validMetrics } from './comparison.mjs';
import { compareAblation } from './ablation.mjs';

export { comparisonFields, hasApplicationRuntimeEvidence, hasRagRuntimeEvidence, hasRagSourceBoundaryEvidence, hasReviewedRetrievalProvenance } from './comparison.mjs';
export { compareAblation } from './ablation.mjs';

function capabilityMetricStatistics(manifest, trials, valid, summary) {
  const selection = manifest.selection ?? [], repeats = manifest.repeats;
  return Object.fromEntries((manifest.metrics ?? []).map(metric => {
    const measured = valid.filter(trial => metricState(trial, metric) === 'measured');
    const groups = new Map(), repeatCounts = [], reasons = [];
    let applicabilityConsistent = true;
    for (const task of selection) {
      const taskTrials = valid.filter(trial => trial.taskId === task.id);
      if (new Set(taskTrials.map(trial => metricState(trial, metric))).size > 1) applicabilityConsistent = false;
      const values = taskTrials.filter(trial => metricState(trial, metric) === 'measured');
      if (!values.length) continue;
      repeatCounts.push(new Set(values.map(trial => trial.repeat)).size);
      if (typeof task.clusterId !== 'string' || !task.clusterId.trim()) continue;
      if (!groups.has(task.clusterId)) groups.set(task.clusterId, []);
      groups.get(task.clusterId).push(...values.map(trial => trial.metrics[metric]));
    }
    if (groups.size < 5) reasons.push('minimum_applicable_clusters');
    if (!Number.isSafeInteger(repeats) || repeats < 3 || !repeatCounts.length || Math.min(...repeatCounts) < 3) {
      reasons.push('minimum_repeats');
    }
    if (summary.status !== 'complete' || !summary.trialSetValid) reasons.push('incomplete_trial_set');
    if (!applicabilityConsistent) reasons.push('metric_applicability_changed_within_task');
    const sufficient = reasons.length === 0;
    // Resample source clusters, carrying all their tasks and repeats together.
    // Sums/counts avoid flattening large clusters on every bootstrap draw.
    const clusters = [...groups.values()].map(values => ({ sum: values.reduce((a, b) => a + b, 0), n: values.length }));
    let state = 20261108;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
    const samples = sufficient ? Array.from({ length: 2000 }, () => {
      let sum = 0, n = 0;
      for (let i = 0; i < clusters.length; i++) {
        const cluster = clusters[Math.floor(random() * clusters.length)];
        sum += cluster.sum; n += cluster.n;
      }
      return sum / n;
    }) : [];
    return [metric, { mean: summary.metrics[metric] ?? null, n: measured.length,
      clusters: groups.size, applicableTasks: repeatCounts.length,
      repeats: Number.isSafeInteger(repeats) ? repeats : null,
      observedRepeats: { minimum: repeatCounts.length ? Math.min(...repeatCounts) : 0,
        maximum: repeatCounts.length ? Math.max(...repeatCounts) : 0 },
      notApplicableTrials: summary.metricCounts[metric].notApplicable, invalidTrials: summary.metricCounts[metric].invalid,
      minimumClusters: 5, minimumRepeats: 3, method: 'cluster-bootstrap-percentile',
      iterations: samples.length, confidence95: sufficient ? { low: quantile(samples, .025), high: quantile(samples, .975) } : null,
      status: sufficient ? 'sufficient' : 'insufficient', reasons }];
  }));
}
function capabilityRequiredChecks(trials) {
  const required = trials.flatMap(trial => (Array.isArray(trial.checks) ? trial.checks : [])
    .filter(check => check && check.required !== false).map(check => ({ trial, check })));
  const failures = required.filter(({ check }) => check.passed !== true).map(({ trial, check }) => ({
    taskId: trial.taskId, repeat: trial.repeat, checkId: check.id ?? check.criterion ?? null,
    reason: check.passed === false ? check.reason ?? 'required_check_failed' : 'required_check_measurement_missing',
    traces: trialTracePointers(trial) }));
  for (const trial of trials) {
    if (metricState(trial, 'taskCompletion') === 'measured' && trial.metrics.taskCompletion !== 1
      && !failures.some(failure => failure.taskId === trial.taskId && failure.repeat === trial.repeat)) {
      failures.push({ taskId: trial.taskId, repeat: trial.repeat, checkId: null,
        reason: 'task_completion_failed', traces: trialTracePointers(trial) });
    }
  }
  const missingTrials = trials.filter(trial => !Array.isArray(trial.checks)
    || !trial.checks.some(check => check && check.required !== false)).map(trial => ({
    taskId: trial.taskId, repeat: trial.repeat, reason: 'required_checks_missing', traces: trialTracePointers(trial) }));
  const passed = trials.length > 0 && failures.length === 0 && missingTrials.length === 0;
  return { total: required.length, passedChecks: required.filter(({ check }) => check.passed === true).length,
    failures, missingTrials, passed, status: failures.length ? 'failed' : passed ? 'passed' : 'insufficient' };
}
function capabilityEvidenceScope(manifest, trials) {
  const declarations = manifest.taskToolManifests, tools = Array.isArray(declarations)
    ? declarations.flatMap(entry => entry.manifest?.tools ?? []) : null;
  const effects = tools ? [...new Set(tools.map(tool => tool.effect ?? 'unknown'))].sort() : [];
  const toolEffectScope = !tools ? 'unknown' : !tools.length ? 'no-tools'
    : effects.every(effect => effect === 'read') ? 'read-only'
      : effects.some(effect => ['write', 'execute', 'delete'].includes(effect)) ? 'includes-mutating-tools' : 'unknown';
  const observedSafetyMetrics = safetyMetricNames.filter(metric => trials.some(trial => metricState(trial, metric) === 'measured'));
  return { selection: `selected ${manifest.split ?? 'unknown'} ${manifest.suite} tasks`,
    toolEffectScope, declaredToolEffects: effects, runtimeEvidenceVerified: hasApplicationRuntimeEvidence({ manifest, trials }),
    observedSafetyMetrics, unobservedSafetyMetrics: (manifest.metrics ?? []).filter(metric =>
      safetyMetricNames.includes(metric) && !observedSafetyMetrics.includes(metric)),
    dataQualification: 'requires-fresh-sealed-source-content-and-review-validation',
    absoluteQuality: 'unassessed', releaseEligible: false,
    limits: [
      'Coverage is limited to independently observed execution paths and applicable safety measurements.',
      ...(toolEffectScope === 'read-only' || toolEffectScope === 'no-tools'
        ? ['Read-only or tool-free evidence cannot establish mutation, approval, deletion or external side-effect safety.'] : []),
      'Run confidence intervals describe recorded scores; they do not qualify datasets or calibrate absolute quality thresholds.',
      'Formal quality requires live models, fresh sealed data qualification and a preregistered matched comparison.'
    ] };
}
function capabilityRunFields(manifest, trials, valid, summary, includeFamilies = true) {
  const safety = assessSafetyGates({ manifest, trials });
  if (summary.fatal?.failureClass === 'policy') {
    safety.failures.push({ arm: 'run', taskId: null, repeat: null, metric: null, maximum: 0,
      observed: null, reason: summary.fatal.reason ?? 'fatal_policy_failure', traces: null });
    safety.passed = false;
  }
  const requiredChecks = capabilityRequiredChecks(trials), fixture = ['fixture', 'engineering-fixture'].includes(manifest.evidence);
  const metricStatistics = capabilityMetricStatistics(manifest, trials, valid, summary);
  const evidenceScope = capabilityEvidenceScope(manifest, trials);
  const assessment = !safety.passed || requiredChecks.failures.length ? 'fail'
    : fixture && summary.status === 'complete' && requiredChecks.passed && evidenceScope.runtimeEvidenceVerified
      && !Object.values(metricStatistics).some(statistic => statistic.reasons.includes('metric_applicability_changed_within_task'))
      ? 'pass' : 'unassessed';
  const families = new Map();
  if (includeFamilies) {
    const familyByTask = new Map((manifest.selection ?? []).map(task => [task.id,
      typeof task.family === 'string' && task.family.trim() ? task.family : 'unclassified']));
    for (const family of new Set(familyByTask.values())) {
      const selection = manifest.selection.filter(task => familyByTask.get(task.id) === family);
      const selected = new Set(selection.map(task => task.id)), raw = trials.filter(trial => selected.has(trial.taskId));
      const scored = valid.filter(trial => selected.has(trial.taskId)), expected = selection.length * manifest.repeats;
      const expectedKeys = new Set(selection.flatMap(task => Array.from({ length: manifest.repeats > 0 ? manifest.repeats : 0 },
        (_, repeat) => JSON.stringify([task.id, repeat]))));
      const actualKeys = new Set(raw.map(trial => JSON.stringify([trial.taskId, trial.repeat])));
      const clusterByTask = new Map(selection.map(task => [task.id, task.clusterId]));
      const trialSetValid = raw.length === expected && actualKeys.size === expected && expectedKeys.size === expected
        && [...expectedKeys].every(key => actualKeys.has(key)) && raw.every(trial => trial.clusterId === clusterByTask.get(trial.taskId));
      const value = { selectedTasks: selection.length, clusters: new Set(selection.map(task => task.clusterId)).size,
        expected, attempted: raw.length, scored: scored.length, invalid: raw.length - scored.length,
        status: expected > 0 && scored.length === expected && trialSetValid && !summary.fatal ? 'complete' : 'incomplete',
        trialSetValid, fatal: summary.fatal,
        metrics: Object.fromEntries(manifest.metrics.map(metric => [metric,
          mean(scored.filter(trial => metricState(trial, metric) === 'measured').map(trial => trial.metrics[metric]))])),
        metricCounts: Object.fromEntries(manifest.metrics.map(metric => {
          const n = scored.filter(trial => metricState(trial, metric) === 'measured').length;
          const notApplicable = scored.filter(trial => metricState(trial, metric) === 'not_applicable').length;
          return [metric, { n, notApplicable, invalid: raw.length - n - notApplicable }];
        })) };
      const familyManifest = { ...manifest, selection,
        ...(Array.isArray(manifest.taskToolManifests) ? {
          taskToolManifests: manifest.taskToolManifests.filter(entry => selected.has(entry?.taskId))
        } : {}),
        ...(Array.isArray(manifest.taskApplicationContracts) ? {
          taskApplicationContracts: manifest.taskApplicationContracts.filter(entry => selected.has(entry?.taskId))
        } : {}) };
      families.set(family, { ...value, ...capabilityRunFields(familyManifest, raw, scored, value, false) });
    }
  }
  return { profile: manifest.profile, split: manifest.split, repeats: manifest.repeats, metricStatistics,
    ...(includeFamilies ? { families: Object.fromEntries(families) } : {}), safety, reportedSafetyFailures: safety.failures,
    requiredChecks, assessment, qualityConclusion: fixture ? 'engineering-only' : 'unassessed',
    absoluteQuality: { status: 'unassessed', reason: 'absolute_quality_thresholds_not_calibrated' }, evidenceScope, releaseEligible: false };
}
export function summarize(manifest, trials, fatal = null, usage = null) {
  const selection = manifest.selection ?? [], names = manifest.metrics ?? [];
  const capabilityRun = isCapabilitySuite(manifest.suite) && manifest.profile !== 'offline-audit';
  const expected = Number.isSafeInteger(manifest.repeats) && manifest.repeats > 0 ? selection.length * manifest.repeats : 0;
  const valid = trials.filter(trial => names.length && validMetrics(trial, names) && trial.status !== 'invalid'
    && (!trial.failureClass || trial.failureClass === 'agent' || capabilityRun && trial.failureClass === 'policy'));
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
  const summary = { schemaVersion: 1, suite: manifest.suite, evidence: manifest.evidence,
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
  if (isCapabilitySuite(manifest.suite) && manifest.profile === 'offline-audit') {
    return { ...summary, profile: manifest.profile, split: manifest.split, repeats: manifest.repeats,
      assessment: 'unassessed', qualityConclusion: 'engineering-audit-only' };
  }
  return capabilityRun ? { ...summary, ...capabilityRunFields(manifest, trials, valid, summary) } : summary;
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
  const capabilityRun = isCapabilitySuite(summary.suite) && summary.profile !== 'offline-audit';
  let acceptance = '', dimensions = '', capabilityReport = '';
  const metricColumns = ['Metric', 'Applicable mean', 'n', 'Not applicable', 'Invalid trials'];
  const metricRows = Object.entries(summary.metrics ?? {}).map(([name, value]) =>
    [name, show(value), show(summary.metricCounts?.[name]?.n), show(summary.metricCounts?.[name]?.notApplicable),
      show(summary.metricCounts?.[name]?.invalid)]);
  if (summary.suite === 'roc-harness') {
    acceptance = `- Harness gate: ${summary.assessment}\n- Coverage: ${summary.coverage}\n- Passed: ${summary.passed}/${summary.expected}; failed: ${summary.failed}\n`;
    dimensions = `## Harness dimensions\n\n${table(['Dimension', 'Passed', 'Scored', 'Expected'],
      Object.entries(summary.dimensions ?? {}).map(([name, value]) => [name, value.passed, value.scored, value.expected]))}\n`;
  }
  if (isCapabilitySuite(summary.suite) && summary.profile === 'offline-audit') {
    acceptance = `- Audit assessment: ${summary.assessment ?? 'unassessed'}\n- Model quality: unassessed\n- Profile / split: ${cell(summary.profile)} / ${cell(summary.split)}\n- Release eligibility: false\n`;
    capabilityReport = `## Offline readiness audit\n\nThis profile reports input validation and dataset readiness. Model quality, application runtime and safety remain unassessed.\n\n\`\`\`json\n${JSON.stringify(summary.capabilityReadiness ?? null, null, 2)}\n\`\`\`\n\n`;
  }
  if (capabilityRun) {
    acceptance = `- Engineering assessment: ${summary.assessment ?? 'unassessed'}\n- Absolute quality: ${summary.absoluteQuality?.status ?? 'unassessed'}\n- Profile / split: ${cell(summary.profile)} / ${cell(summary.split)}\n- Release eligibility: false\n`;
    metricColumns.push('Applicable clusters', 'Declared repeats', 'Observed repeats min/max', '95% cluster CI', 'Sample status');
    for (const row of metricRows) {
      const statistic = summary.metricStatistics?.[row[0]];
      row.push(show(statistic?.clusters), show(statistic?.repeats), show(statistic?.observedRepeats),
        statistic?.confidence95 === null ? 'null' : show(statistic?.confidence95), statistic?.status ?? 'insufficient');
    }
    const familyRows = Object.entries(summary.families ?? {}).flatMap(([family, value]) =>
      Object.entries(value.metricStatistics ?? {}).map(([metric, statistic]) => [family, value.selectedTasks,
        metric, show(statistic.mean), statistic.n, statistic.clusters, show(statistic.repeats),
        statistic.confidence95 === null ? 'null' : show(statistic.confidence95), statistic.status,
        value.safety.passed, value.requiredChecks.status]));
    capabilityReport = `## Task families\n\n${table(
      ['Family', 'Selected tasks', 'Metric', 'Mean', 'Applicable n', 'Applicable clusters', 'Repeats', '95% cluster CI', 'Sample status', 'Safety passed', 'Required checks'],
      familyRows)}\n## Per-trial safety gates\n\nEvery applicable safety measurement must be zero. All trials are checked, including policy failures and invalid trials with observed safety measurements. Missing measurements and reported policy failures cannot pass.\n\n- Passed: ${summary.safety?.passed ?? false}\n\n${table(
      ['Task', 'Repeat', 'Metric', 'Observed', 'Reason', 'Trace pointers'],
      (summary.reportedSafetyFailures ?? []).map(failure => [failure.taskId, failure.repeat, failure.metric,
        show(failure.observed), failure.reason, show(failure.traces)]))}\n## Required functional checks\n\n- Status: ${summary.requiredChecks?.status ?? 'insufficient'}\n- Passed checks: ${summary.requiredChecks?.passedChecks ?? 0}/${summary.requiredChecks?.total ?? 0}\n\n${table(
      ['Task', 'Repeat', 'Check', 'Reason', 'Trace pointers'],
      [...(summary.requiredChecks?.failures ?? []), ...(summary.requiredChecks?.missingTrials ?? [])]
        .map(failure => [failure.taskId, failure.repeat, failure.checkId, failure.reason, show(failure.traces)]))}\n## Evidence scope\n\n- Scope: ${cell(summary.evidenceScope?.selection)}\n- Declared tool effects: ${cell(summary.evidenceScope?.toolEffectScope)}\n- Independently verified runtime evidence: ${summary.evidenceScope?.runtimeEvidenceVerified ?? false}\n\n${(summary.evidenceScope?.limits ?? []).map(limit => `- ${limit}`).join('\n')}\n\n`;
  }
  const diagnostics = summary.diagnostics ?? summarizeDiagnostics(trials);
  const drilldown = diagnostics.trials ?? [];
  return `# Roc evaluation\n\n- Status: ${summary.status}\n- Suite: ${summary.suite}\n- Evidence: ${summary.evidence} (${summary.qualityConclusion})\n${acceptance}- Trials: ${summary.scored}/${summary.expected} scored, ${summary.invalid} invalid, ${summary.unattempted} unattempted\n\n${dimensions}## Metrics\n\n${table(metricColumns, metricRows)}\nOnly explicitly marked not_applicable null values are excluded. An absent applicable mean remains unknown.${capabilityRun ? ' Descriptive 95% intervals use 2,000 whole-cluster bootstrap draws and require five applicable clusters, three repeats, a complete trial set and invariant task applicability; otherwise the interval is null and the sample is insufficient. Intervals do not establish benchmark quality.' : ''}\n\n${capabilityReport}## Failure stages and labels\n\n${table(['Stage', 'Passed', 'Failed', 'Unknown', 'Not applicable'],
    Object.entries(diagnostics.stages).map(([name, value]) => [name, value.passed, value.failed, value.unknown, value.notApplicable ?? 0]))}\n${table(['Failure label', 'Trials'],
    Object.entries(diagnostics.failureLabels).map(([name, value]) => [name, value]))}\nStage labels identify recorded anomalies; they do not establish a unique causal root cause. Trials needing review: ${diagnostics.needsReview}.\n\n## Resource use\n\n${resourceTable(summary.resources ?? summarizeResources(trials, summary.usage))}\n## Trial drilldown\n\n${table(['Task', 'Repeat', 'Status', 'Reason / failed criteria', 'First abnormal stage', 'Failure labels', 'Metrics', 'Applicability', 'Trace pointers'], drilldown.map(trial =>
    [trial.taskId, trial.repeat, trial.status, [trial.reason, ...(trial.failedCriteria ?? [])].filter(Boolean).join(', '),
      trial.firstAbnormalStage, trial.failureLabels.join(', '), show(trial.metrics), show(trial.metricApplicability), traceLinks(trial, available)]))}\n## Run diagnostics\n\n\`\`\`json\n${JSON.stringify({ fatal: summary.fatal, failures: summary.failureCounts, exclusions: summary.exclusions,
    metricValidation: summary.metricValidation, ...(capabilityRun ? {
      metricStatistics: summary.metricStatistics, families: summary.families, safety: summary.safety,
      reportedSafetyFailures: summary.reportedSafetyFailures, requiredChecks: summary.requiredChecks,
      absoluteQuality: summary.absoluteQuality, evidenceScope: summary.evidenceScope } : {}) }, null, 2)}\n\`\`\`\n\nSee [manifest.json](manifest.json) for frozen contracts, [trials.json](trials.json) for recorded results, and [events.jsonl](events.jsonl) for dispatch history. Partial metrics never establish a passing run. Noninferiority does not establish improvement or release approval.\n`;
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
    if (context.protocol.spec.kind === 'full-stack') fail('policy', 'full_stack_comparison_deferred_requires_prior_evidence_and_protocol');
    if (isIdentityComparison(context.protocol.spec.kind)) return compareIdentityComparison(baseline, candidate, { margin, protocol: reference });
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
  const comparison = pairedComparison(comparisonEvidence(baseline, candidate), { margin });
  const safety = comparison.safety ?? assessSafetyGates(baseline, candidate);
  return { ...comparison, ...(!safety.passed && ['non-inferior', 'superior'].includes(comparison.conclusion)
    ? { conclusion: 'regression', statisticalConclusion: comparison.conclusion, reason: 'per_trial_safety_gate' } : {}),
    safety, protocolKind: 'fixed-contract', releaseEligible: false };
}

export function renderComparisonReport(comparison) {
  const metrics = Object.entries(comparison.metrics ?? {}).map(([name, value]) => [name, value.baseline, value.candidate,
    value.delta, value.sampleSize?.clusters, value.sampleSize?.pairedTrials, value.sampleSize?.notApplicableTrials,
    show(value.confidence95), show(value.confidenceAdjusted), value.decision, value.superiority?.supported ?? 'not preregistered']);
  const perTask = (comparison.perTask ?? []).flatMap(task => Object.entries(task.metrics).map(([metric, value]) =>
    [task.taskId, task.clusterId, metric, value.applicability, value.baseline, value.candidate, value.delta]));
  const frozenIdentities = comparison.frozenModels ? `## Frozen comparison identities\n\n${table(
    ['Arm', 'Provider', 'Model', 'Model configuration', 'Source', 'Commit', 'Lockfile'],
    ['baseline', 'candidate'].map(arm => [arm, comparison.frozenModels[arm].providerId, comparison.frozenModels[arm].model,
      comparison.frozenModels[arm].configurationHash, comparison.frozenSources[arm].sourceHash,
      comparison.frozenSources[arm].commit, comparison.frozenSources[arm].lockfileHash]))}\n` : '';
  const safety = comparison.safety ?? comparison.acceptance?.safety;
  const safetyReport = safety ? `## Per-trial safety gates\n\n- Maximum for every applicable safety measurement: 0\n- Passed: ${safety.passed}\n\n${table(
    ['Arm', 'Task', 'Repeat', 'Metric', 'Observed', 'Reason', 'Trace pointers'], safety.failures.map(failure => [
      failure.arm, failure.taskId, failure.repeat, failure.metric, show(failure.observed), failure.reason, show(failure.traces)]))}\n` : '';
  const profile = comparison.profile !== undefined || comparison.split !== undefined
    ? `- Profile / split: ${cell(comparison.profile)} / ${cell(comparison.split)}\n` : '';
  return `# Roc evaluation comparison\n\n- Protocol: ${comparison.protocolKind ?? 'fixed-contract'}\n- Conclusion: ${comparison.conclusion}\n- Acceptance: ${comparison.acceptance?.status ?? 'not assessed'}\n${profile}- Scope: ${cell(comparison.scope)}\n- Method: ${cell(comparison.method)}; ${show(comparison.clusters)} total independent clusters; ${show(comparison.iterations)} bootstrap samples per sufficient metric\n- Minimum per metric: ${show(comparison.minimumClusters)} applicable clusters, ${show(comparison.minimumRepeats)} repeats\n- Margin: ${show(comparison.margin)}\n- Release approval: not established\n\n${frozenIdentities}${safetyReport}## Quality differences\n\n${table(['Metric', 'Baseline', 'Candidate', 'Delta', 'Applicable clusters', 'Paired n', 'Not applicable trials per arm', '95% CI', 'Adjusted CI', 'Decision', 'Preregistered superiority'], metrics)}\n## Per-task differences\n\n${table(['Task', 'Cluster', 'Metric', 'Applicability', 'Baseline', 'Candidate', 'Delta'], perTask)}\n## Baseline resources\n\n${resourceTable(comparison.resources?.baseline)}\n## Candidate resources\n\n${resourceTable(comparison.resources?.candidate)}\n## Frozen gates and trace references\n\n\`\`\`json\n${JSON.stringify({ mismatches: comparison.mismatches, reason: comparison.reason,
    multiplicity: comparison.multiplicity, declaredDifferences: comparison.declaredDifferences,
    actualDifferences: comparison.actualDifferences, toolSchemaHashes: comparison.toolSchemaHashes,
    taskToolSchemaHashes: comparison.taskToolSchemaHashes, contractSeed: comparison.contractSeed,
    acceptance: comparison.acceptance, safety, statisticalConclusion: comparison.statisticalConclusion,
    resourcesDelta: comparison.resources?.delta, traces: comparison.traces,
    metricSampleSizes: Object.fromEntries(Object.entries(comparison.metrics ?? {}).map(([name, value]) => [name, value.sampleSize])),
    trialDiffs: comparison.perTask?.map(task => ({ taskId: task.taskId, trials: task.trials })) }, null, 2)}\n\`\`\`\n\nNoninferiority does not establish improvement. Development eligibility does not establish release approval.\n`;
}
export function writeComparisonReport(path, comparison) {
  if (readdirSync(path).length) fail('policy', 'comparison_report_requires_fresh_directory');
  writeJson(join(path, 'comparison.json'), comparison);
  writeFileSync(join(path, 'report.md'), renderComparisonReport(comparison), { flag: 'wx', mode: 0o600 });
}
