import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkSuite } from '../lib/checks.mjs';
import { ROOT, readJson } from '../lib/common.mjs';
import { readEvents } from '../lib/lifecycle.mjs';
import { inspectRun } from '../lib/report.mjs';
import { testArtifacts } from './test-artifacts.mjs';

const root = testArtifacts('offline-checks');

test('sealed S01 readiness audit retains insufficient scientific status and performs no model trial', async () => {
  const result = await checkSuite({ suite: 'roc-s01', outputRoot: root });
  assert.equal(result.status, 'complete', JSON.stringify(result.fatal));
  assert.equal(result.qualityConclusion, 'engineering-audit-only');
  assert.equal(result.regressionAcceptance, 'not_evaluated');
  assert.equal(result.scientificStatus, 'insufficient');
  assert.equal(result.fullDatasetReady, false);
  assert.equal(result.usage.requests, 0);
  const sealed = inspectRun(result.directory), [trial] = sealed.trials;
  assert.equal(sealed.manifest.evidence, 'engineering-fixture');
  assert.equal(readJson(join(result.directory, trial.trialId, 'audit.json')).tasks, 16);
  const events = readEvents(join(result.directory, 'events.jsonl'));
  assert.equal(events.some(event => ['worker_started', 'model_request', 'budget_dispatched'].includes(event.type)), false);
});

test('canonical frozen retrieval check seals real offline ranking without claiming an acceptance threshold', () => {
  const child = spawnSync(process.execPath, ['evaluation/lib/cli.mjs', 'check', '--suite', 'frozen-retrieval',
    '--corpus', 'tests/fixtures/local-retrieval-quality-context-role-v2.json', '--output-root', root], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const result = JSON.parse(child.stdout), sealed = inspectRun(result.directory), [trial] = sealed.trials;
  assert.equal(result.regressionAcceptance, 'not_evaluated');
  assert.equal(result.qualityConclusion, 'engineering-audit-only');
  assert.equal(result.usage.requests, 0);
  const audit = readJson(join(result.directory, trial.trialId, 'audit.json'));
  assert.equal(audit.evaluationMode, 'frozen-embedding');
  assert.equal(audit.evaluationPurpose, 'engineering-regression');
  assert.equal(audit.rows.length, 32);
  assert.equal(audit.groups.length, 12);
  assert.ok(audit.rows.some(row => row.recall20 === 0));
  assert.equal(sealed.trials[0].metrics.auditPassRate, 1);
});

test('offline checks reject incompatible inputs and never reinterpret them as successful audits', async () => {
  await assert.rejects(checkSuite({ suite: 'rag-paper-qa', outputRoot: root }), /check_requires_contract_or_engineering_suite/);
  await assert.rejects(checkSuite({ suite: 'roc-s01', dataset: 'tests/fixtures/quality-evaluation/manifest.json',
    outputRoot: root }), /s01_manifest_hash_required/);
  const result = await checkSuite({ suite: 'frozen-retrieval',
    corpus: 'tests/fixtures/local-retrieval-quality.json', outputRoot: root });
  assert.equal(result.status, 'incomplete');
  assert.match(result.fatal.reason, /document_embedding_input_changed/);
  const sealed = inspectRun(result.directory);
  assert.equal(sealed.trials[0].status, 'invalid');
  assert.equal(sealed.trials[0].metrics, null);
  assert.equal(result.usage.requests, 0);
});
