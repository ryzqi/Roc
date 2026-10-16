import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

/**
 * Unit tests for the production panels' pure rules (P7/T7.1–T7.7).
 *
 * Same discipline as P6's workflow-rule tests: every rule a panel obeys is a function of the
 * real contract here, and each test below pins a *contract* subtlety that a component would
 * otherwise re-derive (and get subtly wrong):
 *
 *   - the Idea Canvas save payload's seven `fields` must be byte-identical to the named sections;
 *   - the experiment engine, the file extension and the runtime kind must agree;
 *   - a `supported` claim with no evidence is a backend refusal, so it must be a visible blocker;
 *   - a claim may appear in exactly one manuscript paragraph;
 *   - a compiled-template export needs revision + source digest, and is impossible without them;
 *   - research-storage binaries have no protocol URL, so PDF preview is `unsupported` by design.
 *
 * `production-rules.ts` imports only types, so esbuild (already a devDependency) yields a
 * dependency-free bundle to import.
 */

let rules;
let tempDir;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'roc-production-rules-'));
  const outfile = join(tempDir, 'production-rules.mjs');
  await esbuild.build({
    entryPoints: ['src/renderer/production/production-rules.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'node22',
    logLevel: 'silent'
  });
  rules = await import(outfile);
});

after(() => {
  if (tempDir !== undefined) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

const sections = {
  problem: '问题',
  hypothesis: '假设',
  novelty: '新颖性',
  supportingEvidence: '支持证据',
  counterevidence: '反面证据',
  experiment: '实验设计',
  risks: '风险'
};

test('the Idea Canvas payload has exactly the seven named fields, byte-identical to the sections', () => {
  const fields = rules.ideaCanvasFields(sections);
  assert.deepEqual(
    fields.map((field) => field.key),
    ['problem', 'hypothesis', 'novelty', 'supportingEvidence', 'counterevidence', 'experiment', 'risks']
  );
  assert.equal(fields.length, 7, 'researchIdeaCanvasSaveRequestSchema requires exactly 7');
  for (const field of fields) {
    assert.equal(field.content, sections[field.key], `field ${field.key} must mirror the named section`);
  }
  assert.deepEqual(new Set(fields.map((field) => field.key)).size, 7, 'keys must be unique');
});

test('editing the prose keeps each field’s verification state', () => {
  const previous = [
    { key: 'hypothesis', content: '旧假设', status: 'supported', evidenceIds: ['ev1'] },
    { key: 'problem', content: '旧问题', status: 'pending', evidenceIds: [] }
  ];
  const fields = rules.ideaCanvasFields({ ...sections, hypothesis: '新假设' }, previous);
  const hypothesis = fields.find((field) => field.key === 'hypothesis');
  assert.equal(hypothesis.content, '新假设');
  assert.equal(hypothesis.status, 'supported', 'a status must not be silently reset by an edit');
  assert.deepEqual(hypothesis.evidenceIds, ['ev1']);
  assert.equal(fields.find((field) => field.key === 'novelty').status, 'pending', 'unseen fields start pending');
});

test('required Idea Canvas sections and the rationale are blockers when blank', () => {
  const empty = rules.emptyIdeaSections();
  const issues = rules.ideaSaveBlockers(empty, '');
  const references = issues.map((issue) => issue.reference);
  for (const key of ['problem', 'hypothesis', 'novelty', 'experiment', 'risks', 'rationale']) {
    assert.ok(references.includes(key), `${key} must be reported`);
  }
  assert.equal(references.includes('supportingEvidence'), false, 'optional sections are not required');
  assert.deepEqual(rules.ideaSaveBlockers(sections, '理由'), []);
});

test('the engine comes from the file extension, and each engine has exactly the runtimes the schema allows', () => {
  assert.equal(rules.engineForSourcePath('scripts/run.py'), 'python');
  assert.equal(rules.engineForSourcePath('Scripts/Run.R'), 'r', 'extension matching is case-insensitive');
  assert.equal(rules.engineForSourcePath('model.jl'), 'julia');
  assert.equal(rules.engineForSourcePath('notes.md'), null);
  assert.deepEqual(
    rules.runtimesForEngine('python').map((entry) => entry.kind),
    ['bundled-python', 'uv']
  );
  assert.deepEqual(
    rules.runtimesForEngine('r').map((entry) => entry.kind),
    ['renv'],
    'the schema refuses any runtime but renv for R'
  );
  assert.deepEqual(
    rules.runtimesForEngine('julia').map((entry) => entry.kind),
    ['julia']
  );
});

test('a start request is blocked until file, environment, runtime and label are all settled', () => {
  const environment = { hash: 'a'.repeat(64) };
  const blocked = rules.experimentStartBlockers({
    sourcePath: null,
    environment: null,
    engine: null,
    runtime: null,
    label: ''
  });
  assert.equal(blocked.length, 3, `file, environment and label are all missing: ${JSON.stringify(blocked)}`);

  // 「环境自上次探测后变化」不在前端判断：前端把探测到的 hash 钉进 expectedEnvironmentHash，由后端
  // 比对（`research_experiment_environment_changed`）。这条规则因此不再有这个入参（评审备注）。
  assert.deepEqual(
    rules.experimentStartBlockers({
      sourcePath: 'scripts/run.py',
      environment,
      engine: 'python',
      runtime: { kind: 'uv' },
      label: 'run 1'
    }),
    []
  );
  assert.deepEqual(
    rules.experimentStartBlockers({
      sourcePath: 'notes.md',
      environment,
      engine: null,
      runtime: { kind: 'uv' },
      label: 'run 1'
    }).map((issue) => issue.reference),
    ['notes.md'],
    'a non-script extension is reported against the chosen file'
  );
});

test('environment readiness reports the real snapshot fields, and says "not probed" honestly', () => {
  assert.deepEqual(rules.environmentReadiness(null), {
    ready: false,
    summary: '尚未检查环境',
    detail: '先探测运行时，主操作会由探测结果决定。'
  });
  const ready = rules.environmentReadiness({
    executable: '/opt/python',
    version: '3.12.4',
    platform: 'darwin',
    architecture: 'arm64',
    packages: [{ name: 'numpy', version: '2.0.0' }],
    toolchainHash: 'b'.repeat(64)
  });
  assert.equal(ready.ready, true);
  assert.match(ready.summary, /3\.12\.4/);
  assert.match(ready.detail, /1 个包/);
  assert.match(ready.detail, /bbbbbbbb/, 'the toolchain hash is shown truncated, not invented');
});

test('figure formats come from the path, and PDF has no renderable path in the renderer', () => {
  assert.equal(rules.figureFormatForPath('figure.png'), 'png');
  assert.equal(rules.figureFormatForPath('figure.SVG'), 'svg');
  assert.equal(rules.figureFormatForPath('figure.pdf'), 'pdf');
  assert.equal(rules.figureFormatForPath('figure.eps'), null);

  assert.equal(rules.figureRenderMode('svg', 'utf8'), 'data-url', 'SVG is never injected as markup');
  assert.equal(rules.figureRenderMode('png', 'base64'), 'data-url');
  assert.equal(
    rules.figureRenderMode('pdf', 'base64'),
    'unsupported',
    'research storage has no protocol URL for binaries (B21)'
  );
});

test('claims are grouped with their evidence, and supported-without-evidence is flagged', () => {
  const claims = [
    { id: 'c1', status: 'supported', evidenceIds: ['e1'], content: '有证据' },
    { id: 'c2', status: 'supported', evidenceIds: [], content: '缺证据' },
    { id: 'c3', status: 'hypothesis', evidenceIds: [], content: '假设' }
  ];
  const evidence = [{ id: 'e1', locator: 'p.1' }];
  const rows = rules.claimSupportRows(claims, evidence);
  assert.equal(rows[0].evidence.length, 1);
  assert.equal(rows[0].missingEvidence, false);
  assert.equal(rows[1].missingEvidence, true, 'a supported claim with no ids is a contract violation');
  assert.equal(rows[2].missingEvidence, false, 'a hypothesis does not need evidence');
  assert.deepEqual(rules.claimStatusLabel('supported'), '有证据支持');
});

test('the export bundle is blocked by a supported claim without evidence', () => {
  const bundle = {
    manuscript: { sections: [{ title: '一', claimIds: ['c1'] }] },
    claims: [{ id: 'c1', status: 'supported', evidenceIds: [], content: '缺证据的主张' }],
    evidence: []
  };
  const blocked = rules.exportReadiness(bundle);
  assert.equal(blocked.ready, false);
  assert.equal(blocked.issues.length, 1);
  assert.match(blocked.issues[0].message, /缺少证据/);

  const ready = rules.exportReadiness({
    manuscript: { sections: [{ title: '一', claimIds: ['c1'] }] },
    claims: [{ id: 'c1', status: 'supported', evidenceIds: ['e1'], content: 'ok' }],
    evidence: [{ id: 'e1' }]
  });
  assert.deepEqual(ready, { ready: true, issues: [] });

  assert.equal(rules.exportReadiness(null).ready, false, 'no bundle means nothing to export');
});

test('a compiled template is only usable when its revision and source digest are known', () => {
  assert.equal(rules.exportTemplateSelection(null), null);
  assert.equal(
    rules.exportTemplateSelection({ id: 't1', revision: 2, sourceDigest: null, status: 'ready' }),
    null,
    'without a source digest the optimistic-concurrency triple is incomplete'
  );
  assert.equal(
    rules.exportTemplateSelection({ id: 't1', revision: 2, sourceDigest: 'c'.repeat(64), status: 'imported' }),
    null,
    'an uncompiled template cannot be exported'
  );
  assert.deepEqual(rules.exportTemplateSelection({ id: 't1', revision: 2, sourceDigest: 'c'.repeat(64), status: 'ready' }), {
    kind: 'imported',
    templateId: 't1',
    expectedRevision: 2,
    expectedSourceDigest: 'c'.repeat(64)
  });
});

test('the export file list is grouped by extension, not by invention', () => {
  const groups = rules.exportFileKinds([
    { path: 'main.tex' },
    { path: 'paper.pdf' },
    { path: 'refs.bib' },
    { path: 'figures/plot.png' },
    { path: 'README.md' }
  ]);
  assert.deepEqual(groups.latex, ['main.tex']);
  assert.deepEqual(groups.pdf, ['paper.pdf']);
  assert.deepEqual(groups.bibliography, ['refs.bib']);
  assert.deepEqual(groups.figure, ['figures/plot.png']);
  assert.deepEqual(groups.other, ['README.md']);
});

test('a claim may appear in exactly one paragraph, and every paragraph needs a claim', () => {
  assert.deepEqual(rules.duplicateClaimIds([{ claimIds: ['a', 'b'] }, { claimIds: ['b'] }]), ['b']);
  assert.deepEqual(rules.duplicateClaimIds([{ claimIds: ['a'] }, { claimIds: ['b'] }]), []);

  const issues = rules.manuscriptBlockers([
    { title: '一', claimIds: ['a'] },
    { title: '  ', claimIds: ['a'] },
    { title: '三', claimIds: [] }
  ]);
  const messages = issues.map((issue) => issue.message).join(' | ');
  assert.match(messages, /没有引用任何主张/);
  assert.match(messages, /同一条主张被用在多个段落/);
  assert.match(messages, /段落标题不能为空/);
  assert.deepEqual(rules.manuscriptBlockers([]).map((issue) => issue.message), ['至少需要一个段落']);
  assert.deepEqual(rules.manuscriptBlockers([{ title: '一', claimIds: ['a'] }]), []);
});

test('policy changes only count the operator-editable fields', () => {
  const base = { tier: 'balanced', maxSteps: 30, timeoutMs: 180000, model: { kind: 'app_default' } };
  assert.equal(rules.policyChanged(base, { ...base }), false);
  assert.equal(rules.policyChanged({ ...base, tier: 'deep' }, base), true);
  assert.equal(rules.policyChanged({ ...base, maxSteps: 31 }, base), true);
  assert.equal(rules.policyChanged({ ...base, timeoutMs: 200000 }, base), true);
  assert.equal(rules.policyChanged({ ...base, model: { kind: 'model', providerId: 'p', modelId: 'm' } }, base), true);
  assert.equal(
    rules.policyChanged(
      { ...base, model: { kind: 'model', providerId: 'p', modelId: 'm' } },
      { ...base, model: { kind: 'model', providerId: 'p', modelId: 'm' } }
    ),
    false
  );
});
