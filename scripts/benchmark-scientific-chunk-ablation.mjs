import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {build} from 'esbuild';
import {importTypeScriptModule} from './lib/bundle-ts.mjs';
import {directory, hash, sha256, writeJson} from '../evaluation/lib/common.mjs';

assert.equal(process.argv.length, 4, 'usage: output-root saved-paper-ir-report');
const sourcePath = resolve(process.argv[3]), previous = JSON.parse(readFileSync(sourcePath));
const root = directory(resolve(process.argv[2]), 'chunk-ablation');
const entries = ['knowledge-source-plan', 'paper-ir', 'scientific-chunks', 'paper-ir-repository']
  .map(name => `src/main/plugins/research/${name}.ts`);
const [legacy, blocks, scientific, repository] = await Promise.all(entries.map(entry =>
  importTypeScriptModule(entry, {platform: 'node'})));
const bundle = await build({entryPoints: entries, bundle: true, format: 'esm', platform: 'node',
  write: false, outdir: 'in-memory', metafile: true, packages: 'external', logLevel: 'silent'});
const codeHashes = Object.fromEntries([...new Set([...Object.keys(bundle.metafile.inputs),
  'scripts/benchmark-scientific-chunk-ablation.mjs', 'scripts/verify-scientific-chunk-ablation.py',
  'scripts/lib/bundle-ts.mjs', 'evaluation/lib/common.mjs', 'pnpm-lock.yaml'])].sort()
  .map(path => [path, sha256(readFileSync(path))]));
const inputs = new Map();
function pin(path, expected) {
  const bytes = readFileSync(path), sha = sha256(bytes), stat = statSync(path, {bigint: true});
  if (expected) assert.equal(sha, expected, path);
  inputs.set(path, {path, sha256: sha, mtimeNs: stat.mtimeNs.toString()});
  return bytes;
}
pin(sourcePath);
for (const item of previous.inputs) {
  pin(item.path, item.sha256); assert.equal(inputs.get(item.path).mtimeNs, item.mtimeNs);
}
const rows = JSON.parse(pin(join(previous.root, 'trial-0.json')));
assert.equal(rows.length, previous.counts.sources);
for (const row of rows) if (row.status === 'parsed') {
  pin(join(previous.root, row.receipt.path), row.receipt.sha256);
  pin(join(previous.root, row.contentPath), row.receipt.identity.parseHash);
}
const protocol = {version: 1, kind: 'scientific-chunk-component-ablation', createdAt: new Date().toISOString(),
  sourceReport: {path: sourcePath, sha256: sha256(readFileSync(sourcePath))}, irRoot: previous.root,
  codeHashes, inputs: [...inputs.values()], repeats: 3,
  selection: rows.map(({cohort, index, status, sourceHash, failure, receipt, contentPath}) =>
    ({cohort, index, status, sourceHash, failure, receipt, contentPath})),
  arms: {
    legacy: {entry: 'planKnowledgeSource(paperBlocks(content))', tokens: 512},
    structured512: {entry: 'buildScientificChunks', paragraphTokens: 512, tableTokens: 512, algorithmTokens: 512},
    structured450: {entry: 'buildScientificChunks', ...scientific.scientificChunkDefaults}
  },
  metrics: ['retrievalChunks', 'tableCellTextCoverage', 'wholeEquationTextCoverage', 'linkedFigureCaptionCoverage'],
  resourceMetrics: ['elapsedMs', 'outputBytes'],
  failurePolicy: 'Keep all selected parser failures; do not invent unknown object denominators',
  scientificQuality: false, acceptance: 'Source integrity and repeatability only; no quality/resource superiority threshold',
  limitations: ['Current generic path on identical saved parses, not the pre-optimization whole RAG.',
    '512 comparison isolates chunk representation; 450 additionally changes token budget.',
    'Object text availability is not query Recall@K, semantic correctness or independent gold recall.']};
const protocolPath = join(root, 'protocol.json');
writeJson(protocolPath, protocol);
const protocolHash = sha256(readFileSync(protocolPath));
const store = new repository.PaperIRRepository(previous.root), trials = [];
for (let repeat = 0; repeat < protocol.repeats; repeat++) {
  const trialRoot = join(root, `trial-${repeat}`); mkdirSync(trialRoot);
  const records = [];
  for (const [ordinal, row] of rows.entries()) {
    const record = {ordinal, sourceHash: row.sourceHash, status: row.status, failure: row.failure, arms: null};
    if (row.status !== 'parsed') {records.push(record); continue;}
    const ir = await store.read(row.receipt);
    const content = JSON.parse(readFileSync(join(previous.root, row.contentPath)));
    const input = {id: ir.identity.knowledgeDocumentId, content: content.content,
      chunks: blocks.paperBlocks(content.blocks, {paperId: ir.identity.paperId,
        parseId: ir.identity.parseId, sourceHash: ir.identity.sourceHash}, content.structure)};
    const arms = {};
    const names = Object.keys(protocol.arms);
    // Rotate order between matched repeats; retain all individual resource samples.
    for (const name of [...names.slice(repeat), ...names.slice(0, repeat)]) {
      const startedAt = new Date().toISOString(), start = performance.now();
      const chunks = name === 'legacy' ? legacy.planKnowledgeSource(input, ir.identity) :
        scientific.buildScientificChunks(ir, name === 'structured512' ?
          {paragraphTokens: 512, tableTokens: 512, algorithmTokens: 512} : {});
      const elapsedMs = performance.now() - start;
      const path = join(trialRoot, `${ordinal}-${name}.json`);
      writeJson(path, chunks);
      const bytes = readFileSync(path);
      arms[name] = {path, sha256: sha256(bytes), bytes: bytes.length, startedAt, elapsedMs};
    }
    record.arms = arms; records.push(record);
  }
  const path = join(trialRoot, 'observations.json'); writeJson(path, records);
  trials.push({path, sha256: sha256(readFileSync(path)),
    outputHash: hash(records.map(r => ({...r, arms: r.arms && Object.fromEntries(
      Object.keys(protocol.arms).map(name => [name, r.arms[name].sha256]))})))});
}
assert.ok(trials.every(t => t.outputHash === trials[0].outputHash));
for (const input of inputs.values()) {
  assert.equal(sha256(readFileSync(input.path)), input.sha256);
  assert.equal(statSync(input.path, {bigint: true}).mtimeNs.toString(), input.mtimeNs);
}
for (const [path, sha] of Object.entries(codeHashes)) assert.equal(sha256(readFileSync(path)), sha);
assert.equal(sha256(readFileSync(protocolPath)), protocolHash);
writeJson(join(root, 'report.json'), {version: 1, root, protocol: {path: protocolPath, sha256: protocolHash},
  completedAt: new Date().toISOString(), trials, fullSystemBenefitEstablished: false});
console.log(JSON.stringify({root, trials}));
