import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// Inventory of saved observations, not a new scorer or a release authorization.
const root = new URL('../', import.meta.url);
const sources = {};
function baseline(name) {
  const path = `evaluation/results/baseline/${name}.json`;
  const bytes = readFileSync(new URL(path, root)), report = JSON.parse(bytes);
  assert.equal(report.status, 'measured');
  assert.equal(report.scientificBaselineReady, false);
  sources[name] = {path, sha256: createHash('sha256').update(bytes).digest('hex'),
    limitations: report.limitations};
  return report.metrics;
}
const parser = baseline('parser'), objects = baseline('objects');
const retrieval = baseline('retrieval'), wiki = baseline('wiki');
const pilotPath = 'evaluation/results/scientific-agent-pilot.json';
const pilotBytes = readFileSync(new URL(pilotPath, root)), pilot = JSON.parse(pilotBytes);
assert.equal(pilot.status, 'Verified passing');
assert.equal(pilot.scientificAcceptance, false);
assert.equal(pilot.trials.length, 6);
sources.agentPilot = {path: pilotPath, sha256: createHash('sha256').update(pilotBytes).digest('hex'),
  limitations: pilot.limitations};
const quotePilotPath = 'evaluation/results/scientific-quote-pilot.json';
const quotePilotBytes = readFileSync(new URL(quotePilotPath, root)), quotePilot = JSON.parse(quotePilotBytes);
assert.equal(quotePilot.status, 'Verified passing');
assert.equal(quotePilot.scientificAcceptance, false);
assert.equal(quotePilot.trials.length, 3);
sources.quotePilot = {path: quotePilotPath, sha256: createHash('sha256').update(quotePilotBytes).digest('hex'),
  limitations: quotePilot.limitations};
const wholePilotPath = 'evaluation/results/scientific-whole-source-pilot.json';
const wholePilotBytes = readFileSync(new URL(wholePilotPath, root)), wholePilot = JSON.parse(wholePilotBytes);
assert.equal(wholePilot.status, 'Verified passing');
assert.equal(wholePilot.scientificAcceptance, false);
assert.equal(wholePilot.trials.length, 3);
assert.equal(wholePilot.wholeSourceSelectionsVerified, 9);
sources.wholeSourcePilot = {path: wholePilotPath, sha256: createHash('sha256').update(wholePilotBytes).digest('hex'),
  limitations: wholePilot.limitations};
const missing = reason => ({value: null, status: 'not_measured', reason});
const saved = (value, source, field) => {
  assert.ok(Number.isFinite(value), `missing saved observation: ${source}.${field}`);
  return {value, status: 'saved_component_observation', source, field};
};
const layer = (task, scope, metrics) => ({task: `evaluation/tasks/${task}/Task.md`, scope, metrics});
const matrix = {
  version: 1, kind: 'scientific-evaluation-inventory', scientificBaselineReady: false,
  fullSystemBenefitEstablished: false, realProjectAccepted: false,
  sources,
  layers: {
    parser: layer('scientific-parser', '46 public raster pages; custom frozen subset scorer', {
      cer: saved(parser.ocr.cer, 'parser', 'ocr.cer'),
      wer: saved(parser.ocr.wer, 'parser', 'ocr.wer'),
      layoutF1: saved(parser.layoutMicroF1, 'parser', 'layoutMicroF1')
    }),
    irChunk: layer('scientific-objects', 'Saved raster object detection; no independent full IR locator gold', {
      tableRecall: saved(objects.layout.table.tp / objects.layout.table.gold, 'objects', 'layout.table.tp / layout.table.gold'),
      figureRecall: saved(objects.layout.figure.tp / objects.layout.figure.gold, 'objects', 'layout.figure.tp / layout.figure.gold'),
      formulaRecall: saved(objects.layout.formula.tp / objects.layout.formula.gold, 'objects', 'layout.formula.tp / layout.formula.gold'),
      objectRecall: missing('Full IR object inventory and independently matched source regions unavailable'),
      locatorAccuracy: missing('Original-PDF caption/object locator gold not complete')
    }),
    retrieval: layer('scientific-retrieval', 'QASPER text BM25: 258 queries; 233 evidence / 25 unanswerable', {
      recallAt5: saved(retrieval.evidenceRecallAt5, 'retrieval', 'evidenceRecallAt5'),
      recallAt10: saved(retrieval.evidenceRecallAt10, 'retrieval', 'evidenceRecallAt10'),
      recallAt20: saved(retrieval.evidenceRecallAt20, 'retrieval', 'evidenceRecallAt20'),
      mrrAt10: saved(retrieval.mrrAt10, 'retrieval', 'mrrAt10'),
      ndcgAt10: saved(retrieval.ndcgAt10, 'retrieval', 'ndcgAt10')
    }),
    extraction: layer('scientific-fact-extraction', 'No independently scored model extraction trial', {
      entityF1: missing('Independent whole-paper entity inventory and matched model predictions missing'),
      factF1: missing('Independent conditioned fact inventory and matched model predictions missing'),
      evidenceCoverage: missing('Semantic support decisions over complete fact inventory missing')
    }),
    wiki: layer('scientific-wiki', '90 source-copy pages; explicit Evidence invalidation', {
      citationValidity: missing('Generated scientific claim entailment and original-PDF citation judgments missing'),
      sourceCopyCitationValidity: saved(wiki.sourceCopyCitationValidity, 'wiki', 'sourceCopyCitationValidity'),
      stalePropagation: saved(wiki.stalePropagation, 'wiki', 'stalePropagation')
    }),
    e2e: layer('scientific-e2e', 'Twelve real Agent diagnostic trials on three frozen text questions; provenance and exact excerpt/complete-source selections verified, full scientific scoring pending', {
      answerCorrectness: missing('Saved final answers available; frozen complete proposition judgments missing'),
      faithfulness: missing('Answer proposition entailment judgments missing'),
      evidenceRecall: missing('Gold support sets bound to actual Agent context reads missing'),
      correctRefusal: missing('Four saved labelled-unanswerable trials available; manuscript-version and full refusal adjudication pending')
    })
  }
};
for (const entry of Object.values(matrix.layers)) readFileSync(new URL(entry.task, root));
const output = new URL('results/scientific-evaluation-matrix.json', import.meta.url);
const serialized = `${JSON.stringify(matrix, null, 2)}\n`;
assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--check'), 'usage: node evaluation/scientific-matrix.mjs [--check]');
if (process.argv[2] === '--check') assert.equal(readFileSync(output, 'utf8'), serialized, 'saved matrix drift');
else writeFileSync(output, serialized);
console.log(JSON.stringify({path: fileURLToPath(output), layers: Object.keys(matrix.layers).length,
  check: process.argv[2] === '--check', scientificBaselineReady: false}));
