import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { hash, readJson, ROOT, sha256 } from '../lib/common.mjs';
import { scientificPaperQuotas, scientificQueryQuotas, scientificReviewContentHash } from '../lib/scientific-rag-corpus.mjs';
import { evaluateScientificPdfRun } from '../adapters/scientific-pdf.mjs';

// Entire fixture (PDFs, labels, reviewer identities, receipts) is fabricated
// engineering data in disposable directories. Never publish it as human gold.
const write = (path, value) => writeFileSync(path, JSON.stringify(value) + '\n');
const reviewed = value => ({ ...value, review: { status: 'reviewed',
  annotations: ['synthetic-reviewer-a', 'synthetic-reviewer-b'].map(reviewer => ({ reviewer,
    reviewedAt: '2026-11-16T00:00:00.000Z', contentHash: scientificReviewContentHash(value),
    judgmentHash: hash('synthetic-agreement') })), arbitration: null } });

async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'roc-full-pdf-adapter-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const goldRoot = join(root, 'corpus'), runRoot = join(root, 'run');
  for (const folder of ['papers', 'annotations', 'queries']) mkdirSync(join(goldRoot, folder), { recursive: true });
  mkdirSync(runRoot);
  const manifest = { schemaVersion: 1, id: 'synthetic-only-full-corpus',
    provenance: { kind: 'human_reviewed', producer: 'synthetic-producer', sourceRevision: 'test-v1', license: 'test-only' },
    papers: [], queriesPath: 'queries/gold.json', queriesHash: null };
  const annotations = [], rows = [], pins = [];
  for (const [category, count] of Object.entries(scientificPaperQuotas)) for (let n = 0; n < count; n++) {
    const i = rows.length, paperId = `synthetic-${i}`;
    const pdf = await PDFDocument.create(); pdf.setTitle(paperId); pdf.addPage([600, 800]);
    const bytes = await pdf.save(), sourceHash = sha256(bytes), pdfPath = `papers/${paperId}.pdf`;
    writeFileSync(join(goldRoot, pdfPath), bytes);
    const texts = [`Synthetic source ${i}`, 'A', 'Test figure', 'x=1'];
    const blocks = ['paragraph', 'table', 'figure', 'formula'].map((kind, j) => ({ id: `output-${i}-${j}`,
      kind, text: texts[j], imagePath: null,
      locations: [{ page: 1, bbox: [0, j * 200, 600, (j + 1) * 200], coordinateOrigin: 'TOPLEFT' }] }));
    const result = { sourceHash, parserFingerprint: hash('synthetic-parser'), modelManifest: '',
      pageCount: 1, parseMode: 'native-text', device: 'cpu', tier: 'complete', content: texts.join('\n\n'),
      blocks, assets: [], artifacts: { structuredContent: 'structured.json' } };
    const { sourceHash: unused, ...stored } = result;
    const structured = { ...stored, coordinateFrameContractVersion: 1, pages: [{ page: 1, text: 'Sidecar',
      coordinateFrame: { kind: 'pdf', page: 1, unit: 'raster-pixel', coordinateOrigin: 'TOPLEFT', width: 600, height: 800,
        viewport: { width: 600, height: 800, scale: 1, rotation: 0, userUnit: 1,
          viewBox: [0, 0, 600, 800], transform: [1, 0, 0, -1, 0, 800] } },
      regions: blocks.slice(1).map((b, j) => ({ id: b.id, type: b.kind, text: b.text, imagePath: null,
        bbox: b.locations[0].bbox, formula: j === 2 ? 'x=1' : null,
        tableMatches: j === 0 ? { fullHtml: '<table><tr><td>A</td></tr></table>' } : null })) }] };
    mkdirSync(join(runRoot, `paper-${i}/output`), { recursive: true });
    write(join(runRoot, `paper-${i}/result.json`), result);
    write(join(runRoot, `paper-${i}/output/structured.json`), structured);
    const artifacts = [{ path: 'structured.json', sha256: sha256(readFileSync(join(runRoot, `paper-${i}/output/structured.json`))) }];
    const row = { paperId, source: pdfPath, sourceHash, modelManifest: 'synthetic-models', status: 'parsed', failure: null,
      result: `paper-${i}/result.json`, structured: `paper-${i}/output/structured.json`, parserFingerprint: result.parserFingerprint,
      pageCount: 1, parseMode: 'native-text', blocks: 4, artifacts, artifactsHash: hash(artifacts) };
    write(join(runRoot, `paper-${i}/receipt.json`), row); rows.push(row);
    pins.push({ path: pdfPath, sha256: sourceHash, bytes: bytes.length });
    const annotation = reviewed({ schemaVersion: 1, annotationVersion: 'scientific-gold-v1', paperId, sourceHash,
      parseRef: null, coordinateSystem: 'TOPLEFT_NORMALIZED', pages: [{ page: 1, transcript: texts.join('\n\n') }],
      blocks: ['text', 'table', 'figure', 'equation'].map((kind, j) => ({ blockId: `gold-${i}-${kind}`,
        page: 1, kind, bbox: [0, j / 4, 1, (j + 1) / 4], text: texts[j], readingOrder: j })),
      expectedSections: [{ id: `section-${i}`, title: 'Synthetic', blockIds: [`gold-${i}-text`] }],
      expectedTables: [{ id: `table-${i}`, blockId: `gold-${i}-table`, html: '<table><tr><td>A</td></tr></table>',
        cells: [{ row: 0, column: 0, rowSpan: 1, columnSpan: 1, text: 'A' }] }],
      expectedFigures: [{ id: `figure-${i}`, blockId: `gold-${i}-figure`, caption: 'Test figure' }],
      expectedEquations: [{ id: `equation-${i}`, blockId: `gold-${i}-equation`, latex: 'x=1',
        normalizedLatex: 'x=1', normalizationVersion: 'latex-nfc-v1' }], expectedCitations: [] });
    annotations.push(annotation);
    const annotationPath = `annotations/${paperId}.json`; write(join(goldRoot, annotationPath), annotation);
    manifest.papers.push({ paperId, sourceHash, category, sourceUri: `https://fixture.invalid/${paperId}`, license: 'test-only',
      pdfPath, annotationPath, annotationHash: sha256(readFileSync(join(goldRoot, annotationPath))) });
  }
  const queries = [];
  for (const [category, count] of Object.entries(scientificQueryQuotas)) for (let n = 0; n < count; n++) {
    const targets = category === 'cross-paper' ? annotations.slice(0, 2) : [annotations[n % annotations.length]];
    const kind = category === 'table-results' ? 'table' : category === 'figure' ? 'figure' : 'text';
    const blocks = targets.map(g => g.blocks.find(b => b.kind === kind)), answerable = category !== 'unanswerable';
    queries.push(reviewed({ id: `synthetic-query-${queries.length}`, category, query: `Synthetic ${category} ${n}`,
      targetPaperIds: targets.map(g => g.paperId), targetBlockIds: blocks.map(b => b.blockId),
      targetTableIds: kind === 'table' ? targets.map(g => g.expectedTables[0].id) : [],
      targetFigureIds: kind === 'figure' ? targets.map(g => g.expectedFigures[0].id) : [], targetEquationIds: [],
      expectedEvidenceSpans: answerable ? targets.map((g, i) => ({ id: `span-${i}`, paperId: g.paperId,
        sourceHash: g.sourceHash, blockId: blocks[i].blockId, page: 1, start: 0, end: blocks[i].text.length,
        quote: blocks[i].text, relevance: 3 })) : [],
      expectedAnswer: answerable ? 'Synthetic answer' : null, answerable,
      unanswerableReason: answerable ? null : 'Synthetic insufficient evidence' }));
  }
  write(join(goldRoot, manifest.queriesPath), queries);
  manifest.queriesHash = sha256(readFileSync(join(goldRoot, manifest.queriesPath)));
  const manifestPath = join(goldRoot, 'manifest.json'); write(manifestPath, manifest);
  const inputs = { pins, sourceLockHash: hash('fixture-source-lock'), codeHashes: { synthetic: hash('fixture-code') },
    modelHashes: { synthetic: hash('fixture-model') }, modelManifest: 'synthetic-models', parserOptions: { tier: 'complete' } };
  const run = { ...inputs, status: 'processed-unscored', cohortComplete: true, papers: rows.length, rows, failedPapers: 0 };
  write(join(runRoot, 'inputs.json'), inputs); write(join(runRoot, 'run.json'), run);
  return { root, goldRoot, runRoot, manifestPath, run, inputs, manifest };
}

test('complete synthetic gold reaches scoring through real PDF/receipt verification and the CLI', async t => {
  const f = await fixture(t), options = { runRoot: f.runRoot, sourceRoot: f.goldRoot, manifestPath: f.manifestPath };
  const report = await evaluateScientificPdfRun(options);
  assert.equal(report.status, 'scored-draft-contract'); assert.equal(report.verified.length, 45);
  assert.equal(report.qualityMetrics.all.cer.value, 0); assert.equal(report.qualityMetrics.all.layoutMicroF1.value, 1);
  assert.equal(report.qualityMetrics.all.cellExactMatch.value, 1); assert.equal(report.qualityMetrics.all.teds.value, 1);
  assert.equal(report.qualityMetrics.all.normalizedLatexExactMatch.value, 1);
  assert.equal(Object.keys(report.qualityMetrics.categories).length, 8);
  assert.equal(report.scientificBaselineReady, false);
  const output = join(f.root, 'objects.json');
  const args = ['scripts/score-scientific-pdf.mjs', '--run', f.runRoot, '--source-root', f.goldRoot,
    '--manifest', f.manifestPath, '--output', output];
  const cli = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const saved = readJson(output);
  assert.equal(saved.deterministicObservationHash, report.deterministicObservationHash);
  assert.equal(saved.scoringContract.version, 2);
  const tables = saved.papers.flatMap(p => p.scores.flatMap(s => s.tables));
  assert.equal(tables.length, 45);
  for (const table of tables) {
    assert.equal(table.tedsDetails.status, 'scored'); assert.equal(table.tedsDetails.distance, 0);
    assert.equal(table.tedsDetails.denominator, 3);
    assert.deepEqual(table.tedsDetails.expectedTree, table.tedsDetails.actualTree);
    assert.equal(table.tedsDetails.expectedTree.children[0].children[0].tokens.join(''), 'A');
  }
  const original = readFileSync(output), overwrite = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  assert.equal(overwrite.status, 1); assert.match(overwrite.stderr, /EEXIST/); assert.deepEqual(readFileSync(output), original);
  f.inputs.pins[0].sha256 = hash('changed');
  write(join(f.runRoot, 'inputs.json'), f.inputs);
  await assert.rejects(evaluateScientificPdfRun(options), /gold_cohort_mismatch/);
});

test('observation mode has null quality, retains explicit failures, and rejects altered artifacts/links', async t => {
  const f = await fixture(t), options = { runRoot: f.runRoot, sourceRoot: f.goldRoot };
  const row = f.run.rows[0];
  Object.assign(row, { status: 'failed', failure: { code: 'synthetic-parser-failure' }, result: null,
    structured: null, pageCount: null, parseMode: null, blocks: null, parserFingerprint: null });
  f.run.failedPapers = 1;
  write(join(f.runRoot, 'paper-0/receipt.json'), row); write(join(f.runRoot, 'run.json'), f.run);
  const report = await evaluateScientificPdfRun(options);
  assert.equal(report.qualityMetrics, null); assert.equal(report.observations.length, 45);
  assert.equal(report.observations[0].failureCode, 'synthetic-parser-failure');
  assert.equal(report.verified[0].geometryVerified, false);
  const scored = await evaluateScientificPdfRun({ ...options, manifestPath: f.manifestPath });
  assert.equal(scored.qualityMetrics.all.failedPages, 1);
  assert.equal(scored.qualityMetrics.all.cellExactMatch.denominator, 45);
  assert.equal(scored.qualityMetrics.all.cellExactMatch.value, 44 / 45);
  const structured = join(f.runRoot, 'paper-1/output/structured.json');
  const original = readFileSync(structured); writeFileSync(structured, '{}');
  await assert.rejects(evaluateScientificPdfRun(options), /artifact_changed/);
  writeFileSync(structured, original);
  symlinkSync(f.runRoot, join(f.root, 'run-link'));
  await assert.rejects(evaluateScientificPdfRun({ ...options, runRoot: join(f.root, 'run-link') }), /directory_invalid/);
});

test('pending real manifest yields blocked CLI exit2 with null metrics before reading a run', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'roc-pdf-readiness-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'blocked.json');
  const cli = spawnSync(process.execPath, ['scripts/score-scientific-pdf.mjs', '--run', 'nonexistent',
    '--source-root', 'nonexistent', '--output', output], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(cli.status, 2, cli.stderr);
  const report = readJson(output);
  assert.equal(report.status, 'blocked'); assert.equal(report.qualityMetrics, null);
  assert.equal(report.corpusReadiness.corpusReady, false); assert.equal(report.scientificBaselineReady, false);
});
