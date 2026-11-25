/** Replay saved8bit inference as image sources without running or enabling the model. */
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {importTypeScriptModule} from '../lib/bundle-ts.mjs';

const {values} = parseArgs({options: {inference: {type: 'string'}, output: {type: 'string'}}, strict: true});
if (!values.inference || !values.output) throw new Error('--inference and --output are required');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = 'src/main/plugins/research/ovis-document-adapter.ts';
const {adaptOvisPage} = await importTypeScriptModule(source, {platform: 'node'});
const directory = values.inference;
const reportBytes = await readFile(join(directory, 'report.json')), report = JSON.parse(reportBytes);
assert.equal(report.variant, '8bit'); assert.equal(report.status, 'completed');
const model = {engine: 'ovisocr3-mlx', revision: report.revision, quantization: '8bit', groupSize: 64,
  visionPrecision: 'bfloat16', device: 'metal', installationReceiptSha256: report.receiptSha256,
  inferenceSha256: report.evaluatorSha256, promptSha256: report.promptSha256};
const pages = [];
for (const page of report.pages) {
  assert.match(page.id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
  assert.equal(hash(await readFile(page.image)), page.sha256);
  const raw = await readFile(join(directory, `${page.id}.raw.txt`));
  const tokenIds = JSON.parse(await readFile(join(directory, `${page.id}.tokens.json`), 'utf8'));
  const frame = {kind: 'image', page: 1, unit: 'raster-pixel', coordinateOrigin: 'TOPLEFT', width: page.width, height: page.height};
  const binding = {sourceHash: page.sha256, inputImageSha256: page.sha256, frame, model};
  const envelope = {protocolVersion: 1, sourceHash: page.sha256, inputImageSha256: page.sha256, page: 1,
    width: page.width, height: page.height, model, rawSha256: page.rawSha256,
    generation: {finishReason: page.termination.finishReason, generationTokens: page.generationTokens, tokenIds}};
  const result = adaptOvisPage(raw, envelope, binding);
  assert.equal(result.blocks.length, page.blockCount);
  assert.deepEqual(result.blocks.toSorted((a,b) => a.rawIndex-b.rawIndex)
    .map(b => ({bbox: b.candidateRegion.normalizedBox, category: b.category, content: b.rawContent})),
  JSON.parse(await readFile(join(directory, `${page.id}.parsed.json`), 'utf8')));
  assert.ok(result.blocks.every(b => b.verification === 'unverified' && b.citationLocations[0].bbox === null));
  pages.push({id: page.id, inputSha256: page.sha256, rawSha256: page.rawSha256, blocks: result.blocks.length,
    rawIndicesInSpatialOrder: result.blocks.map(b => b.rawIndex), allCitationsPageOnly: true});
}
assert.ok(pages.length > 0);
const result = {status: 'passed', scope: 'Replay saved8bit output as image sources; not production or PDF qualification',
  adapterSha256: hash(await readFile(source)), inferenceReportSha256: hash(reportBytes), pages};
await writeFile(values.output, JSON.stringify(result, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({status: result.status, pages: pages.length, blocks: pages.reduce((n,p) => n + p.blocks, 0)}));
