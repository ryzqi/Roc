import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {importTypeScriptModule} from './lib/bundle-ts.mjs';
import {directory, hash, sha256, writeJson} from '../evaluation/lib/common.mjs';
import {defaultPublicScientificRoot, publicScientificSourceLock} from '../evaluation/adapters/scientific-public/sources.mjs';

const output = directory(resolve(process.argv[2]), 'paper-ir-public');
mkdirSync(join(output, 'sources'));
const names = ['paper-ir-builder', 'paper-ir-repository', 'pdf-table-extractor', 'pdf-equation-extractor',
  'pdf-caption-linker', 'pdf-quality-assessor'];
const entries = names.map(name => `src/main/plugins/research/${name}.ts`);
const [builder, repository, tables, equations, visuals, quality] =
  await Promise.all(entries.map(entry => importTypeScriptModule(entry, {platform: 'node'})));
const bundle = await build({entryPoints: entries, bundle: true, format: 'esm', platform: 'node',
  outdir: 'in-memory', write: false, metafile: true, logLevel: 'silent', packages: 'external'});
const codeHashes = Object.fromEntries([...new Set([...Object.keys(bundle.metafile.inputs),
  'scripts/benchmark-scientific-paper-ir.mjs', 'pnpm-lock.yaml'])].sort().map(path => [path, sha256(readFileSync(path))]));
const pins = new Map();
function read(path, expected) {
  if (path instanceof URL) path = fileURLToPath(path);
  const bytes = readFileSync(path), digest = sha256(bytes), stat = statSync(path, {bigint: true});
  if (expected) assert.equal(digest, expected, path);
  pins.set(path, {path, sha256: digest, mtimeNs: stat.mtimeNs.toString()});
  return bytes;
}
const lock = JSON.parse(read(publicScientificSourceLock));
const cohorts = process.argv.slice(3).map(path => {
  const summary = JSON.parse(read(resolve(path))), runPath = join(summary.root, 'run.json'), data = JSON.parse(read(runPath));
  assert.equal(hash(lock), data.sourceLockHash);
  assert.equal(summary.sourceLockHash, data.sourceLockHash);
  return {summary: resolve(path), run: runPath, rows: data.rows.length, sourceLockHash: data.sourceLockHash, data};
});
assert.ok(cohorts.length);
const trials = [], store = new repository.PaperIRRepository(output);
let counts;
for (let trial = 0; trial < 2; trial++) {
  const rows = [];
  const totals = {sources: 0, failedSources: 0, blocks: 0, sections: 0, tables: 0, cells: 0, figures: 0,
    equations: 0, algorithms: 0, citations: 0, references: 0, relations: 0};
  for (const [cohort, entry] of cohorts.entries()) for (const [index, source] of entry.data.rows.entries()) {
    const sourcePath = resolve(defaultPublicScientificRoot, source.source ?? source.image);
    const pin = lock.files.find(file => file.sha256 === source.sourceHash);
    assert.ok(pin); assert.equal(sourcePath, resolve(defaultPublicScientificRoot, pin.path));
    read(sourcePath, source.sourceHash);
    const row = {cohort, index, status: source.status, sourceHash: source.sourceHash, failure: source.failure,
      contentPath: null, receipt: null};
    totals.sources++;
    if (source.status === 'parsed') {
      const parsed = JSON.parse(read(join(entry.data.root, source.result)));
      const artifact = source.artifacts.find(a => a.path === 'artifacts/structured.json'); assert.ok(artifact);
      const structured = JSON.parse(read(join(entry.data.root, source.structured), artifact.sha256));
      assert.deepEqual(parsed.blocks, structured.blocks);
      const blocks = visuals.attachPaperVisuals(equations.attachPaperEquations(
        tables.attachPaperTables(parsed.blocks, structured.pages), structured.pages));
      const content = {...parsed, blocks, quality: quality.assessPdfQuality({pages: structured.pages, blocks})};
      row.contentPath = `sources/cohort-${cohort}-row-${index}.json`;
      if (trial === 0) writeFileSync(join(output, row.contentPath), JSON.stringify(content), {flag: 'wx'});
      else assert.deepEqual(JSON.parse(readFileSync(join(output, row.contentPath))), content);
      const paperId = source.paperId ?? `raster:${index}`, parseId = `saved:${cohort}:${index}`;
      const ir = builder.buildPaperIR({identity: {paperId, documentId: paperId, knowledgeDocumentId: paperId,
        parseId, sourceHash: source.sourceHash, parserFingerprint: parsed.parserFingerprint}, content});
      row.receipt = await store.publish(ir);
      assert.deepEqual(await new repository.PaperIRRepository(output).read(row.receipt, {paperId, parseId}), ir);
      assert.equal(row.receipt.identity.parseHash, sha256(readFileSync(join(output, row.contentPath))));
      for (const key of ['blocks', 'sections', 'tables', 'figures', 'equations', 'algorithms', 'citations', 'references', 'relations']) {
        totals[key] += ir[key].length;
      }
      totals.cells += ir.tables.reduce((sum, table) => sum + table.cells.length, 0);
    } else {
      assert.equal(typeof source.failure?.code, 'string');
      totals.failedSources++;
    }
    rows.push(row);
  }
  if (trial === 0) counts = totals;
  else assert.deepEqual(totals, counts);
  writeJson(join(output, `trial-${trial}.json`), rows);
  trials.push({rows: rows.length, deterministicHash: hash(rows)});
}
assert.equal(trials[0].deterministicHash, trials[1].deterministicHash);
for (const pin of pins.values()) {
  assert.equal(sha256(readFileSync(pin.path)), pin.sha256);
  assert.equal(statSync(pin.path, {bigint: true}).mtimeNs.toString(), pin.mtimeNs);
}
const report = {schemaVersion: 1, kind: 'scientific-paper-ir-saved-artifact-regression', root: output,
  workingDirectory: process.cwd(), command: process.argv.slice(1), codeHashes, inputs: [...pins.values()],
  cohorts: cohorts.map(({data, ...entry}) => entry), trials, counts,
  limitations: ['Saved parser outputs reused without OCR inference or recognition-gain claims.',
    'Historical failures remain in the selected denominator. Missing cell geometry stays page-only.',
    'Exact numbered and matched GROBID references only; complex author-year/range markers are not inferred.',
    'Agent acceptance does not supply new human scientific gold.']};
writeJson(join(output, 'report.json'), report);
console.log(JSON.stringify({root: output, counts, trials}));
