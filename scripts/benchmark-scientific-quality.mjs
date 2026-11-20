import assert from 'node:assert/strict';
import {readFileSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {importTypeScriptModule} from './lib/bundle-ts.mjs';
import {directory, hash, sha256, writeJson} from '../evaluation/lib/common.mjs';
import {defaultPublicScientificRoot, publicScientificSourceLock} from '../evaluation/adapters/scientific-public/sources.mjs';

const output = directory(resolve(process.argv[2]), 'quality-public');
const entries = ['pdf-quality-assessor', 'pdf-table-extractor', 'pdf-equation-extractor', 'pdf-caption-linker']
  .map(name => `src/main/plugins/research/${name}.ts`);
const modules = await Promise.all(entries.map(entry => importTypeScriptModule(entry, {platform: 'node'})));
const bundle = await build({entryPoints: entries, bundle: true, format: 'esm', platform: 'node',
  outdir: 'in-memory', write: false, metafile: true, logLevel: 'silent', packages: 'external'});
const codeHashes = Object.fromEntries([...new Set([...Object.keys(bundle.metafile.inputs),
  'scripts/benchmark-scientific-quality.mjs', 'pnpm-lock.yaml'])].sort().map(path => [path, sha256(readFileSync(path))]));
const inputs = new Map();
function read(path, expected) {
  if (path instanceof URL) path = fileURLToPath(path);
  const bytes = readFileSync(path), sha = sha256(bytes), stat = statSync(path, {bigint: true});
  if (expected) assert.equal(sha, expected, path);
  inputs.set(path, {path, sha256: sha, mtimeNs: stat.mtimeNs.toString()});
  return bytes;
}
const lock = JSON.parse(read(publicScientificSourceLock));
const cohorts = process.argv.slice(3).map(path => {
  const summary = JSON.parse(read(resolve(path))), runPath = join(summary.root, 'run.json'), run = JSON.parse(read(runPath));
  assert.equal(hash(lock), run.sourceLockHash); assert.equal(summary.sourceLockHash, run.sourceLockHash);
  return {summary: resolve(path), run: runPath, rows: run.rows.length, sourceLockHash: run.sourceLockHash, data: run};
});
assert.ok(cohorts.length);
const trials = [];
for (let trial = 0; trial < 2; trial++) {
  const rows = [];
  for (const [cohort, entry] of cohorts.entries()) for (const [index, source] of entry.data.rows.entries()) {
    const sourcePath = resolve(defaultPublicScientificRoot, source.source ?? source.image);
    const pin = lock.files.find(file => file.sha256 === source.sourceHash);
    assert.ok(pin); assert.equal(sourcePath, resolve(defaultPublicScientificRoot, pin.path));
    read(sourcePath, source.sourceHash);
    let quality;
    if (source.status === 'parsed') {
      const parsed = JSON.parse(read(join(entry.data.root, source.result)));
      const artifact = source.artifacts.find(a => a.path === 'artifacts/structured.json'); assert.ok(artifact);
      const structured = JSON.parse(read(join(entry.data.root, source.structured), artifact.sha256));
      assert.deepEqual(parsed.blocks, structured.blocks);
      const blocks = modules[3].attachPaperVisuals(modules[2].attachPaperEquations(
        modules[1].attachPaperTables(parsed.blocks, structured.pages), structured.pages));
      quality = modules[0].assessPdfQuality({pages: structured.pages, blocks});
} else {
      assert.equal(typeof source.failure?.code, 'string');
      quality = modules[0].assessPdfQuality({pages: [], blocks: [], failure: source.failure.code});
    }
    rows.push({cohort, index, status: source.status, sourceHash: source.sourceHash, failure: source.failure, quality});
  }
  writeJson(join(output, `trial-${trial}.json`), rows); trials.push({rows, hash: hash(rows)});
}
assert.equal(trials[0].hash, trials[1].hash);
for (const pin of inputs.values()) {
  assert.equal(sha256(readFileSync(pin.path)), pin.sha256);
  assert.equal(statSync(pin.path, {bigint: true}).mtimeNs.toString(), pin.mtimeNs);
}
const pages = trials[0].rows.flatMap(row => row.quality.pages);
const report = {schemaVersion: 1, kind: 'scientific-quality-saved-artifact-regression', root: output,
  workingDirectory: process.cwd(), command: process.argv.slice(1), codeHashes, inputs: [...inputs.values()],
  cohorts: cohorts.map(({data, ...entry}) => entry), repeatHashes: trials.map(trial => trial.hash),
  counts: {sources: trials[0].rows.length, failedSources: trials[0].rows.filter(r => r.status !== 'parsed').length,
    pages: pages.length, good: pages.filter(p => p.status === 'good').length, review: pages.filter(p => p.status === 'review').length,
    nativeCoverageUnknown: pages.filter(p => p.nativeTextCoverage === null).length,
    duplicateCountUnknown: pages.filter(p => p.duplicatedRegionCount === null).length,
    tableWarnings: pages.reduce((sum, p) => sum + p.tableWarnings, 0), formulaWarnings: pages.reduce((sum, p) => sum + p.formulaWarnings, 0)},
  limitations: ['Original saved public pages lack native-item/fusion observations; missing fields remain null.',
    'Area coverage is not OCR accuracy or original evidence recall.', 'Historical failures remain explicit; no OCR inference repeated.']};
writeJson(join(output, 'report.json'), report);
console.log(JSON.stringify({root: output, counts: report.counts, repeatHashes: report.repeatHashes}));
