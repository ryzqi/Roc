import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {build} from 'esbuild';
import {importTypeScriptModule} from './lib/bundle-ts.mjs';
import {directory, hash, sha256, writeJson} from '../evaluation/lib/common.mjs';

const reportPath = resolve(process.argv[3]), reportBytes = readFileSync(reportPath);
const previous = JSON.parse(reportBytes), output = directory(resolve(process.argv[2]), 'scientific-chunks-public');
const entries = ['src/main/plugins/research/scientific-chunks.ts', 'src/main/plugins/research/paper-ir-repository.ts'];
const [chunks, irs] = await Promise.all(entries.map(p => importTypeScriptModule(p, {platform: 'node'})));
const bundle = await build({entryPoints: entries, bundle: true, format: 'esm', platform: 'node',
  outdir: 'in-memory', write: false, metafile: true, packages: 'external', logLevel: 'silent'});
const codeHashes = Object.fromEntries([...new Set([...Object.keys(bundle.metafile.inputs),
  'scripts/benchmark-scientific-chunks.mjs', 'pnpm-lock.yaml'])].sort().map(p => [p, sha256(readFileSync(p))]));
const inputs = new Map();
function pin(path, expected) {
  const bytes = readFileSync(path), sha = sha256(bytes), stat = statSync(path, {bigint: true});
  if (expected) assert.equal(sha, expected, path);
  inputs.set(path, {path, sha256: sha, mtimeNs: stat.mtimeNs.toString()});
  return bytes;
}
pin(reportPath, sha256(reportBytes));
for (const input of previous.inputs) {
  pin(input.path, input.sha256);
  assert.equal(inputs.get(input.path).mtimeNs, input.mtimeNs);
}
const rows = JSON.parse(pin(join(previous.root, 'trial-0.json')));
assert.equal(rows.length, previous.counts.sources);
const store = new irs.PaperIRRepository(previous.root), trials = [];
let counts;
for (let trial = 0; trial < 2; trial++) {
  mkdirSync(join(output, `trial-${trial}`));
  const observations = [], totals = {sources: rows.length, failedSources: 0, chunks: 0, retrieval: 0,
    oversized: 0, sourceParts: 0, types: {}};
  for (const [index, row] of rows.entries()) {
    const entry = {index, status: row.status, failure: row.failure, sourceHash: row.sourceHash, ir: row.receipt,
      path: null, sha256: null};
    if (row.status !== 'parsed') {totals.failedSources++; observations.push(entry); continue;}
    pin(join(previous.root, row.receipt.path), row.receipt.sha256);
    const ir = await store.read(row.receipt), result = chunks.buildScientificChunks(ir);
    entry.path = `trial-${trial}/source-${index}.json`;
    const bytes = Buffer.from(JSON.stringify(result)); entry.sha256 = sha256(bytes);
    writeFileSync(join(output, entry.path), bytes, {flag: 'wx'});
    totals.chunks += result.length;
    for (const chunk of result) {
      totals.types[chunk.chunkType] = (totals.types[chunk.chunkType] ?? 0) + 1;
      totals.retrieval += Number(chunk.retrieval); totals.oversized += Number(chunk.oversized);
      totals.sourceParts += chunk.sources.length;
    }
    observations.push(entry);
  }
  if (trial === 0) counts = totals; else assert.deepEqual(totals, counts);
  const deterministicHash = hash(observations.map(({path, ...row}) => row));
  writeJson(join(output, `trial-${trial}.json`), observations);
  trials.push({rows: observations.length, deterministicHash});
}
assert.equal(trials[0].deterministicHash, trials[1].deterministicHash);
for (const input of inputs.values()) {
  assert.equal(sha256(readFileSync(input.path)), input.sha256);
  assert.equal(statSync(input.path, {bigint:true}).mtimeNs.toString(), input.mtimeNs);
}
writeJson(join(output, 'report.json'), {schemaVersion: 1, kind: 'scientific-chunks-saved-ir-regression',
  root: output, irRoot: previous.root, sourceReport: {path: reportPath, sha256: sha256(reportBytes)},
  workingDirectory: process.cwd(), command: process.argv.slice(1), codeHashes, inputs: [...inputs.values()],
  counts, trials, limitations: ['Saved source-bound IR reused; no OCR, embeddings or recognition-gain measurement.',
    'Oversized indivisible equations, rows and steps remain complete; provider batching is a subsequent part.',
    'This component has no active index switch or scientific-gold quality claim.']});
console.log(JSON.stringify({root: output, counts, trials}));
