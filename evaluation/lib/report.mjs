import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, fileInventory, hash, readJson, sha256, writeJson } from './common.mjs';

const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const quantile = (xs, p) => xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] : null;
export function summarize(manifest, trials, fatal = null) {
  const expected = manifest.selection.length * manifest.repeats;
  const valid = trials.filter(t => t.metrics && (!t.failureClass || t.failureClass === 'agent'));
  const complete = expected > 0 && !fatal && trials.length === expected && valid.length === expected;
  const metrics = Object.fromEntries(manifest.metrics.map(name => [name, mean(valid.map(t => t.metrics[name]))]));
  return { schemaVersion: 1, suite: manifest.suite, evidence: manifest.evidence,
    status: complete ? 'complete' : 'incomplete', qualityConclusion: manifest.evidence === 'fixture' ? 'fixture-only' : 'comparison-required',
    expected, attempted: trials.length, scored: valid.length, invalid: trials.length - valid.length, unattempted: expected - trials.length,
    exclusions: Object.fromEntries([...new Set(manifest.exclusions.map(e => e.reason))].map(reason => [reason, manifest.exclusions.filter(e => e.reason === reason).length])), metrics, fatal,
    failureCounts: Object.fromEntries([...new Set(trials.filter(t => t.failureClass).map(t => t.failureClass))].map(c => [c, trials.filter(t => t.failureClass === c).length])),
    latencyMs: { median: quantile(trials.map(t => t.latencyMs), .5), p95: quantile(trials.map(t => t.latencyMs), .95) } };
}
export function sealRun(path, summary) {
  writeJson(join(path, 'summary.json'), summary);
  let acceptance = '', dimensions = '';
  if (summary.suite === 'roc-harness') {
    acceptance = `- Harness gate: ${summary.assessment}\n- Coverage: ${summary.coverage}\n- Passed: ${summary.passed}/${summary.expected}; failed: ${summary.failed}\n`;
    dimensions = `## Harness dimensions\n\n| Dimension | Passed | Scored | Expected |\n|---|---:|---:|---:|\n${Object.entries(summary.dimensions).map(([name, result]) =>
      `| ${name} | ${result.passed} | ${result.scored} | ${result.expected} |`).join('\n')}\n\n`;
    const failures = readJson(join(path, 'trials.json')).filter(trial => trial.status !== 'passed');
    if (failures.length) {
      const cell = value => String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]/g, ' ');
      dimensions += `## Failed or invalid cases\n\n| Case | Repeat | Status | Failed criteria or invalid reason |\n|---|---:|---|---|\n${failures.map(trial =>
        `| ${cell(trial.taskId)} | ${trial.repeat} | ${cell(trial.status)} | ${cell(trial.reason)} |`).join('\n')}\n\n`;
    }
  }
  writeFileSync(join(path, 'report.md'), `# Roc harness evaluation\n\n- Status: ${summary.status}\n- Suite: ${summary.suite}\n- Evidence: ${summary.evidence} (${summary.qualityConclusion})\n${acceptance}- Trials: ${summary.scored}/${summary.expected} scored, ${summary.invalid} invalid, ${summary.unattempted} unattempted\n\n${dimensions}## Metrics\n\n${Object.entries(summary.metrics).map(([k,v]) => `- ${k}: ${v ?? 'unavailable'}`).join('\n')}\n\n## Diagnostics and resource use\n\n\`\`\`json\n${JSON.stringify({ fatal: summary.fatal, failures: summary.failureCounts, exclusions: summary.exclusions, latencyMs: summary.latencyMs, usage: summary.usage }, null, 2)}\n\`\`\`\n\nSee manifest.json for frozen selection and exclusions, trials.json for per-task results, events.jsonl for dispatch history, and trial directories for full application traces. Partial metrics never establish a passing run.\n`, { flag: 'wx', mode: 0o600 });
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
export const comparisonFields = ['suite', 'evidence', 'datasetIdentity', 'selection', 'repeats', 'metrics', 'scorerHash', 'provider', 'environment', 'split', 'toolManifest'];
export function compareRuns(baseline, candidate, { margin = .05 } = {}) {
  if (!Number.isFinite(margin) || margin < 0 || margin > .05) fail('policy', 'comparison_margin_invalid');
  const a = baseline.manifest, b = candidate.manifest;
  const mismatches = comparisonFields.filter(k => hash(a[k] ?? null) !== hash(b[k] ?? null));
  if (mismatches.length) return { conclusion: 'incompatible', mismatches };
  if ([baseline, candidate].some(r => r.summary.status !== 'complete')) return { conclusion: 'incomplete' };
  if (baseline.sealHash && baseline.sealHash === candidate.sealHash) return { conclusion: 'insufficient', reason: 'same_run_is_not_independent_evidence' };
  const expectedKeys = a.selection.flatMap(t => Array.from({ length: a.repeats }, (_, repeat) => `${t.id}:${repeat}`));
  const index = run => {
    const result = new Map(run.trials.map(t => [`${t.taskId}:${t.repeat}`, t]));
    if (result.size !== expectedKeys.length || run.trials.length !== result.size || expectedKeys.some(k => !result.has(k))) fail('state', 'comparison_trial_set_invalid');
    for (const trial of result.values()) if (a.metrics.some(m => !Number.isFinite(trial.metrics?.[m]) || trial.metrics[m] < 0 || trial.metrics[m] > 1)) fail('state', 'comparison_metric_invalid');
    return result;
  };
  const left = index(baseline), right = index(candidate);
  // Legacy runs lack this evidence. Matching omissions do not establish a fixed tool contract.
  if (!a.toolManifest?.tools?.length || !b.toolManifest?.tools?.length
    || [baseline, candidate].some(r => r.trials.some(t => typeof t.toolSchemaHash !== 'string' || !/^[a-f0-9]{64}$/.test(t.toolSchemaHash)))) {
    return { conclusion: 'insufficient', reason: 'tool_contract_evidence_missing' };
  }
  const schemas = [baseline, candidate].map(r => new Set(r.trials.map(t => t.toolSchemaHash)));
  if (schemas.some(s => s.size !== 1)) return { conclusion: 'incompatible', mismatches: ['toolSchemaHash'], reason: 'tool_schema_changed_within_run' };
  if (baseline.trials[0].toolSchemaHash !== candidate.trials[0].toolSchemaHash) return { conclusion: 'incompatible', mismatches: ['toolSchemaHash'] };
  const groups = [...new Set(a.selection.map(t => t.clusterId))];
  const sufficient = a.evidence === 'live-model' && a.repeats >= 3 && groups.length >= 5;
  const metrics = {};
  for (const metric of a.metrics) {
    // Resample independent papers/repos, keeping each task and all repeats together.
    const clusters = groups.map(group => a.selection.filter(t => t.clusterId === group).flatMap(t =>
      Array.from({ length: a.repeats }, (_, i) => right.get(`${t.id}:${i}`).metrics[metric] - left.get(`${t.id}:${i}`).metrics[metric])));
    let state = 20261108;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
    const samples = sufficient ? Array.from({ length: 2000 }, () => mean(Array.from({ length: groups.length }, () => clusters[Math.floor(random() * groups.length)]).flat())) : [];
    const interval = sufficient ? { low: quantile(samples, .025), high: quantile(samples, .975) } : null;
    metrics[metric] = { baseline: mean([...left.values()].map(t => t.metrics[metric])), candidate: mean([...right.values()].map(t => t.metrics[metric])), delta: mean(clusters.flat()), confidence95: interval,
      decision: !interval ? 'insufficient' : interval.high < -margin ? 'regression' : interval.low >= -margin ? 'non-inferior' : 'inconclusive' };
  }
  const decisions = Object.values(metrics).map(m => m.decision);
  return { conclusion: !sufficient ? 'insufficient' : decisions.includes('regression') ? 'regression' : decisions.every(d => d === 'non-inferior') ? 'non-inferior' : 'inconclusive',
    method: 'paired-cluster-bootstrap-percentile', iterations: 2000, margin, clusters: groups.length,
    scope: 'selected public benchmark tasks; no S01 or production-wide claim', metrics,
    latency: { baseline: baseline.summary.latencyMs, candidate: candidate.summary.latencyMs },
    baselineSource: a.source.sourceHash, candidateSource: b.source.sourceHash };
}
