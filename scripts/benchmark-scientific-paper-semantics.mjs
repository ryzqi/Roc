import assert from 'node:assert/strict';
import {mkdirSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {build} from 'esbuild';
import {importTypeScriptModule} from './lib/bundle-ts.mjs';
import {directory, hash, ROOT, sha256, writeJson} from '../evaluation/lib/common.mjs';

// Reuse the fixed, verified complete source cohort without fresh OCR or invented role gold.
const sourceReport = join(ROOT, 'evaluation/results/scientific-paper-structure-regression.json');
const summary = JSON.parse(readFileSync(sourceReport));
const priorPath = join(ROOT, summary.savedReplay.report), priorBytes = readFileSync(priorPath);
assert.equal(sha256(priorBytes), summary.artifactHashes[summary.savedReplay.report]);
const prior = JSON.parse(priorBytes);
assert.equal(prior.status, 'verified-repeatable');
const baseline = join(ROOT, '.artifacts/scientific-rag/baselines/current-code-pair-01/public-pdf-2026-11-16T05-37-19.680Z-a15d7add');
const entries = ['src/main/plugins/research/paper-semantic-service.ts', 'src/main/plugins/research/paper-ir.ts',
  'src/main/plugins/research/pdf-document-reading.ts'];
const compiled = await build({entryPoints: entries, bundle: true, format: 'esm', platform: 'node',
  outdir: 'in-memory', write: false, metafile: true, logLevel: 'silent', packages: 'external'});
const paths = [...new Set([...Object.keys(compiled.metafile.inputs),
  'scripts/benchmark-scientific-paper-semantics.mjs', 'pnpm-lock.yaml'])].sort();
const codeHashes = Object.fromEntries(paths.map(path => [path, sha256(readFileSync(join(ROOT, path)))]));
const [semantics, {paperBlocks}, {annotatePdfDocumentReading}] = await Promise.all(entries.map(entry =>
  importTypeScriptModule(entry, {platform: 'node', external: ['@langchain/core/messages'], tempDir: '.runtime/tmp'})));
const root = directory(resolve(process.argv[2]), 'paper-semantics');
const inputs = Array.from({length: 45}, (_, i) => {
  const path = join(baseline, `paper-${i}/output/artifacts/structured.json`), bytes = readFileSync(path);
  const receiptPath = join(baseline, `paper-${i}/receipt.json`), receiptBytes = readFileSync(receiptPath);
  const receipt = JSON.parse(receiptBytes);
  assert.equal(receipt.status, 'parsed');
  const pinned = prior.inputs[i];
  assert.equal(pinned.path, path); assert.equal(pinned.receiptPath, receiptPath);
  assert.equal(sha256(bytes), pinned.sha256); assert.equal(sha256(receiptBytes), pinned.receiptSha256);
  assert.equal(sha256(readFileSync(pinned.sourcePath)), pinned.sourceHash);
  assert.equal(sha256(readFileSync(pinned.resultPath)), pinned.resultSha256);
  return {...pinned, parsed: JSON.parse(bytes)};
});
const runs = [];
for (let trial = 0; trial < 2; trial++) {
  const started = performance.now(), rows = [];
  mkdirSync(join(root, `trial-${trial}`));
  for (const [i, input] of inputs.entries()) {
    const blocks = annotatePdfDocumentReading(input.parsed.blocks, input.parsed.pages);
    const selected = semantics.selectPaperSemanticSample(blocks);
    const enriched = await semantics.enrichPaperSemantics(blocks, selected.structure, null, new AbortController().signal);
    assert.deepEqual(enriched.structure, selected.structure);
    const identity = {paperId: input.paperId, parseId: 'saved-baseline', sourceHash: input.sourceHash};
    const chunks = paperBlocks(blocks, identity, enriched.structure);
    assert.deepEqual(chunks.map(c => ({id: c.semantic.blockId, kind: c.semantic.blockKind, text: c.content, locator: c.locator})),
      blocks.filter(b => b.text.trim()).map(({id, kind, text, locator}) => ({id, kind, text, locator})));
    assert.ok(selected.sample.length <= Math.min(8, Math.ceil(selected.eligibleBlocks * .25)));
    assert.ok(selected.inputBudgetTokens <= 6000);
    const {durationMs, ...observation} = enriched.observation;
    writeJson(join(root, `trial-${trial}/paper-${i}.json`), {sourceHash: input.sourceHash,
      sourceArtifactSha256: input.sha256, enrichment: enriched, sample: selected.sample});
    rows.push({paper: i, pages: input.parsed.pages.length, blocks: blocks.length,
      sourceDigest: enriched.sourceDigest, sampleDigest: hash(selected.sample), ...observation});
  }
  runs.push({elapsedMs: performance.now() - started, rows, deterministicHash: hash(rows)});
}
assert.equal(runs[0].deterministicHash, runs[1].deterministicHash);
for (const input of inputs) {
  assert.equal(sha256(readFileSync(input.path)), input.sha256);
  assert.equal(sha256(readFileSync(input.receiptPath)), input.receiptSha256);
  assert.equal(sha256(readFileSync(input.sourcePath)), input.sourceHash);
  assert.equal(sha256(readFileSync(input.resultPath)), input.resultSha256);
}
for (const [path, digest] of Object.entries(codeHashes)) assert.equal(sha256(readFileSync(join(ROOT, path))), digest);
const totals = runs[0].rows.reduce((all, row) => {
  for (const key of ['pages', 'blocks', 'eligibleBlocks', 'calls', 'inputBudgetTokens']) all[key] += row[key];
  all.selectedBlocks += row.selectedBlockIds.length;
  all.statuses[row.status] = (all.statuses[row.status] ?? 0) + 1;
  return all;
}, {papers: 45, pages: 0, blocks: 0, eligibleBlocks: 0, selectedBlocks: 0, calls: 0, inputBudgetTokens: 0, statuses: {}});
writeJson(join(root, 'report.json'), {kind: 'scientific-public-semantic-sampling-regression', status: 'verified-repeatable',
  workingDirectory: ROOT, command: process.argv, codeHashes, sourceReportSha256: sha256(readFileSync(sourceReport)),
  sourceStructureSummaryKind: summary.kind, inputs: inputs.map(({parsed: _parsed, ...row}) => row), totals, runs,
  limitations: ['Fixed saved original-PDF source sampling, budget and preservation replay; no fresh OCR.',
    'No configured provider call in this replay; unavailable observations remain explicit.',
    'Model application, failure, cancellation and persistence are exercised with controlled transport in tests.',
    'No semantic accuracy, human gold, scientific approval or measured model quality gain asserted.']});
console.log(JSON.stringify({root, status: 'verified-repeatable', totals}));
