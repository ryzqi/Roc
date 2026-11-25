import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let api;
before(async () => {api = await importTypeScriptModule('src/main/plugins/research/ovis-document-adapter.ts', {platform: 'node'});});
const hash = value => createHash('sha256').update(value).digest('hex');
const model = {engine: 'ovisocr3-mlx', revision: '5b252386ba615bd464a5a26597560eaba87dae5c',
  quantization: '8bit', groupSize: 64, visionPrecision: 'bfloat16', device: 'metal',
  installationReceiptSha256: 'a'.repeat(64), inferenceSha256: 'b'.repeat(64),
  promptSha256: '1b6139ec72888e087c8af75f2e2dfb78b425e15ae1c1529940b96137613d1db1'};
const imageFrame = {kind: 'image', page: 3, unit: 'raster-pixel', coordinateOrigin: 'TOPLEFT', width: 1200, height: 2000};
const block = (category = 'text', content = 'Original text', bbox = [100, 200, 300, 400]) => ({category, content, bbox});
function fixture(raw = JSON.stringify([block()]), frame = imageFrame) {
  const bytes = Buffer.from(raw), sourceHash = 'c'.repeat(64), inputImageSha256 = 'd'.repeat(64);
  return {bytes, binding: {sourceHash, inputImageSha256, frame, model}, envelope: {
    protocolVersion: 1, sourceHash, inputImageSha256, page: frame.page, width: frame.width, height: frame.height,
    model, rawSha256: hash(bytes), generation: {finishReason: 'stop', generationTokens: 2, tokenIds: [100, 248046]}
  }};
}
const adapt = f => api.adaptOvisPage(f.bytes, f.envelope, f.binding);

test('raw formula/table/visual content stays exact and every generated location remains unverified', () => {
  const raw = JSON.stringify([block('display_formula', '$$x_{i} = \\alpha$$'),
    block('table', '<table><tr><td rowspan="2">42</td></tr></table>', [400, 200, 600, 400]),
    block('image', '![](../../private/data.png)', [100, 500, 300, 700]),
    block('figure_title', 'Fig. 1. Original caption', [100, 710, 300, 750])]);
  const f = fixture(raw), result = adapt(f);
  assert.equal(result.raw, raw); assert.equal(result.rawSha256, hash(f.bytes));
  assert.deepEqual(result.model, model); assert.deepEqual(result.generation, f.envelope.generation);
  assert.deepEqual(result.blocks.map(b => b.kind), ['formula', 'table', 'figure', 'paragraph']);
  assert.deepEqual(result.blocks.map(b => b.rawContent), JSON.parse(raw).map(b => b.content));
  assert.deepEqual(result.blocks[0].candidateRegion.bbox, [120, 400, 360, 800]);
  for (const b of result.blocks) {
    assert.equal(b.verification, 'unverified');
    assert.deepEqual(b.citationLocations, [{page: 3, bbox: null, coordinateOrigin: null}]);
    assert.equal(b.candidateRegion.pdfBox, null); assert.equal('imagePath' in b, false);
  }
  assert.deepEqual(result.warnings, ['research_ovis_content_unverified']);
});

test('projection uses the captured crop, UserUnit and rotation without promoting a candidate to a citation', () => {
  const transforms = [
    {rotation: 0, width: 400, height: 600, transform: [2, 0, 0, -2, -20, 640], expected: [30, 200, 70, 260]},
    {rotation: 90, width: 600, height: 400, transform: [0, 2, 2, 0, -40, -20], expected: [50, 50, 90, 110]},
    {rotation: 180, width: 400, height: 600, transform: [-2, 0, 0, 2, 420, -40], expected: [150, 80, 190, 140]},
    {rotation: 270, width: 600, height: 400, transform: [0, -2, -2, 0, 640, 420], expected: [130, 230, 170, 290]}
  ];
  for (const t of transforms) {
    const frame = {...imageFrame, kind: 'pdf', width: t.width, height: t.height,
      viewport: {width: t.width, height: t.height, scale: 1, rotation: t.rotation, userUnit: 2,
        viewBox: [10, 20, 210, 320], transform: t.transform}};
    const result = adapt(fixture(undefined, frame)).blocks[0];
    assert.deepEqual(result.candidateRegion.pdfBox, t.expected);
    assert.equal(result.citationLocations[0].bbox, null);
  }
});

test('double-column ordering uses geometry while raw indices preserve original generation order', () => {
  const input = [block('text', 'R2', [550, 400, 950, 500]), block('text', 'L1', [50, 200, 450, 300]),
    block('text', 'R1', [550, 200, 950, 300]), block('text', 'L2', [50, 400, 450, 500]),
    block('doc_title', 'Title', [50, 20, 950, 100])];
  const result = adapt(fixture(JSON.stringify(input)));
  assert.deepEqual(result.blocks.map(b => b.rawContent), ['Title', 'L1', 'L2', 'R1', 'R2']);
  assert.deepEqual(result.blocks.map(b => b.rawIndex), [4, 1, 3, 2, 0]);
  assert.equal(result.blocks[0].id, 'page-3-ovis-5');
});

test('malformed JSON, escaped duplicate keys, extra fields and invalid boxes reject the whole page without repairs', () => {
  for (const raw of [
    '```json\n[]\n```', '[', '{"blocks":[]}', '\ufeff[]',
    '[{"category":"text","content":"old","content":"new","bbox":[1,2,3,4]}]',
    '[{"category":"text","content":"old","cont\\u0065nt":"new","bbox":[1,2,3,4]}]',
    '[{"category":"text","content":"x","bbox":[1,2,NaN,4]}]',
    '[{"category":"text","content":"x","bbox":[1.0,2,3,4]}]',
    '[{"category":"text","content":"x","bbox":[1e0,2,3,4]}]',
    JSON.stringify([block(), {...block(), confidence: 1}]),
    JSON.stringify([block('unknown')]), JSON.stringify([block('text', {})]),
    ...[[0, 0, 1000, 999], [1, 2, 1, 4], [1, 4, 3, 2], [-1, 0, 1, 1], [0.5, 0, 1, 1], ['1', 2, 3, 4], [true, 2, 3, 4]]
      .map(bbox => JSON.stringify([block(), block('text', 'x', bbox)]))
  ]) assert.throws(() => adapt(fixture(raw)), undefined, raw);
  const escaped = 'literal "content": "same", { key }, \\ quoted, 中文';
  assert.equal(adapt(fixture(JSON.stringify([block('text', escaped)]))).blocks[0].rawContent, escaped);
});

test('completion requires token-count evidence and a final official EOS even when raw JSON is valid', () => {
  for (const generation of [
    {finishReason: 'length', generationTokens: 2, tokenIds: [100, 248046]},
    {finishReason: 'stop', generationTokens: 2, tokenIds: [100, 200]},
    {finishReason: 'stop', generationTokens: 3, tokenIds: [100, 248046]},
    {finishReason: 'stop', generationTokens: 3, tokenIds: [248046, 100, 248046]},
    {finishReason: 'stop', generationTokens: 0, tokenIds: []}
  ]) {
    const f = fixture(); f.envelope.generation = generation;
    assert.throws(() => adapt(f));
  }
  const f = fixture(); f.envelope.generation.tokenIds[1] = 248044;
  assert.equal(adapt(f).generation.tokenIds.at(-1), 248044);
});

test('source, image, page, measured dimensions, model and raw bytes are bound independently', () => {
  for (const mutation of [
    {sourceHash: 'e'.repeat(64)}, {inputImageSha256: 'e'.repeat(64)}, {page: 2}, {width: 1199}, {height: 1999},
    {model: {...model, inferenceSha256: 'e'.repeat(64)}}, {model: {...model, installationReceiptSha256: 'e'.repeat(64)}},
    {model: {...model, quantization: '4bit'}}, {rawSha256: 'e'.repeat(64)}, {protocolVersion: 0}, {extra: true}
  ]) {
    const f = fixture(); Object.assign(f.envelope, mutation); assert.throws(() => adapt(f));
  }
  const f = fixture(); f.bytes = Buffer.concat([f.bytes, Buffer.from(' ')]);
  assert.throws(() => adapt(f), /raw_changed/u);
});

test('invalid UTF8 and oversized raw output fail without substitution or generated blocks', () => {
  const f = fixture(); f.bytes = Buffer.from([0x5b, 0x22, 0xff, 0x22, 0x5d]); f.envelope.rawSha256 = hash(f.bytes);
  assert.throws(() => adapt(f), /encoded data/u);
  f.bytes = Buffer.alloc(4 * 1024 * 1024 + 1, 32);
  assert.throws(() => adapt(f), /output_limit/u);
  const empty = adapt(fixture('[]')); assert.deepEqual(empty.blocks, []); assert.deepEqual(empty.warnings, []);
});

test('normalized coordinate999 remains inside the raster rather than stretching to its edge', () => {
  const result = adapt(fixture(JSON.stringify([block('text', 'edge', [0, 0, 999, 999])])));
  assert.deepEqual(result.blocks[0].candidateRegion.bbox, [0, 0, 1198.8, 1998]);
});
