import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { planEvaluationCleanup, applyEvaluationCleanup } from '../lib/cleanup.mjs';
import { hash, sha256 } from '../lib/common.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'roc-eval-cleanup-'));
  t.after(() => rmSync(root, { recursive: true }));
  const write = (path, value) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), value); };
  return { root, write };
}
test('cleanup previews first, preserves active runs and source archives, and confines removal to evaluation outputs', t => {
  const { root, write } = fixture(t), digest = sha256('official-source'), dataset = `evaluation/datasets/qasper-${'a'.repeat(64)}`;
  write(`${dataset}/source.tgz`, 'official-source');
  write(`${dataset}/dataset.json`, JSON.stringify({ suite: 'qasper', identity: 'dataset',
    provenance: { archiveSha256: digest, license: 'CC-BY-4.0', url: 'source' } }));
  write('evaluation/runs/old/summary.json', '{}');
  write('evaluation/runs/active/execution-owner.json', JSON.stringify({ pid: process.pid }));
  write('evaluation/runs/active/manifest.json', JSON.stringify({ dataset: { path: join(root, 'evaluation/datasets', 'roc-capability-' + 'b'.repeat(64)) } }));
  write(`evaluation/datasets/roc-capability-${'b'.repeat(64)}/dataset.json`, '{}');
  write('evaluation/datasets/registry.json', 'tracked-registry');
  write('.artifacts/unrelated-ui/result.json', 'user-artifact');
  const preview = planEvaluationCleanup({ root, includeDatasets: true });
  assert.equal(preview.status, 'preview'); assert.ok(existsSync(join(root, dataset)));
  assert.ok(preview.preserved.some(item => item.path === 'evaluation/runs/active' && item.reason === 'active_owner'));
  assert.ok(preview.preserved.some(item => item.path.includes('roc-capability-') && item.reason === 'referenced_by_retained_record'));
  const result = applyEvaluationCleanup(preview);
  assert.equal(result.status, 'applied'); assert.equal(existsSync(join(root, dataset)), false);
  assert.equal(readFileSync(join(root, 'evaluation/local/sources/qasper', `${digest}.tgz`), 'utf8'), 'official-source');
  assert.equal(readFileSync(join(root, 'evaluation/datasets/registry.json'), 'utf8'), 'tracked-registry');
  assert.equal(readFileSync(join(root, '.artifacts/unrelated-ui/result.json'), 'utf8'), 'user-artifact');
});
test('cleanup rejects target changes, forged scope and symlinks without removing other targets', t => {
  const { root, write } = fixture(t);
  write('evaluation/runs/one/summary.json', '{}'); write('evaluation/runs/two/summary.json', '{}');
  const preview = planEvaluationCleanup({ root });
  write('evaluation/runs/two/summary.json', '{"changed":true}');
  assert.throws(() => applyEvaluationCleanup(preview), /cleanup_target_changed_or_active/);
  assert.ok(existsSync(join(root, 'evaluation/runs/one')));
  const current = planEvaluationCleanup({ root }), { status, planHash, ...content } = current;
  content.targets[0].path = '.artifacts/unrelated';
  assert.throws(() => applyEvaluationCleanup({ ...content, status, planHash: hash(content) }), /cleanup_target_out_of_scope/);
  mkdirSync(join(root, 'unrelated')); symlinkSync(join(root, 'unrelated'), join(root, 'evaluation/runs/link'));
  const linked = planEvaluationCleanup({ root });
  assert.ok(linked.preserved.some(item => item.path === 'evaluation/runs/link' && item.reason === 'cleanup_symlink'));
});
test('cleanup refuses traversal, duplicate targets and records under a deletion target', t => {
  const { root, write } = fixture(t);
  write('evaluation/runs/one/summary.json', '{}');
  const preview = planEvaluationCleanup({ root }), { status, planHash, ...content } = preview;
  for (const path of ['evaluation/runs/..', 'evaluation/runs/.', 'evaluation/runs//one', 'evaluation/runs/../runs/one']) {
    const forged = { ...content, targets: [{ ...content.targets[0], path }] };
    assert.throws(() => applyEvaluationCleanup({ ...forged, status, planHash: hash(forged) }), /cleanup_target_out_of_scope/);
  }
  const duplicate = { ...content, targets: [...content.targets, ...content.targets] };
  assert.throws(() => applyEvaluationCleanup({ ...duplicate, status, planHash: hash(duplicate) }), /cleanup_duplicate_target/);
  assert.throws(() => applyEvaluationCleanup(preview, { outputRoot: join(root, 'evaluation/runs/one/cleanup') }), /cleanup_record_inside_target/);
  assert.ok(existsSync(join(root, 'evaluation/runs/one')));
});
test('active experiment references retain a run and its dataset transitively', t => {
  const { root, write } = fixture(t), dataset = `evaluation/datasets/roc-capability-${'c'.repeat(64)}`;
  write('evaluation/local/experiments/active/execution-owner.json', JSON.stringify({ pid: process.pid }));
  write('evaluation/local/experiments/active/protocol.json', JSON.stringify({ baseline: { path: 'evaluation/runs/seed' } }));
  write('evaluation/runs/seed/manifest.json', JSON.stringify({ dataset: { path: join(root, dataset) } }));
  write(`${dataset}/dataset.json`, '{}');
  const plan = planEvaluationCleanup({ root, includeDatasets: true });
  assert.deepEqual(plan.targets, []);
  assert.equal(plan.preserved.length, 3);
});
test('a newly retained comparison prevents applying a stale deletion preview', t => {
  const { root, write } = fixture(t);
  write('evaluation/runs/seed/manifest.json', '{}');
  const preview = planEvaluationCleanup({ root });
  write('evaluation/comparisons/new/comparison.json', JSON.stringify({ baseline: { path: 'evaluation/runs/seed' } }));
  assert.throws(() => applyEvaluationCleanup(preview), /cleanup_target_newly_referenced/);
  assert.ok(existsSync(join(root, 'evaluation/runs/seed')));
});
test('source retention refuses a linked archive destination before deleting a dataset', t => {
  const { root, write } = fixture(t), digest = sha256('original');
  const dataset = `evaluation/datasets/qasper-${'d'.repeat(64)}`;
  write(`${dataset}/source.tgz`, 'original');
  write(`${dataset}/dataset.json`, JSON.stringify({ suite: 'qasper', provenance: { archiveSha256: digest } }));
  mkdirSync(join(root, 'evaluation/local'), { recursive: true });
  mkdirSync(join(root, 'external'));
  symlinkSync(join(root, 'external'), join(root, 'evaluation/local/sources'));
  const preview = planEvaluationCleanup({ root, includeDatasets: true });
  assert.throws(() => applyEvaluationCleanup(preview), /cleanup_source_archive_symlink/);
  assert.ok(existsSync(join(root, dataset)));
  assert.equal(existsSync(join(root, 'external/qasper', `${digest}.tgz`)), false);
});
