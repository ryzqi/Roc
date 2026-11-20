import assert from 'node:assert/strict';
import {readFileSync, mkdirSync, statSync, writeFileSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {importTypeScriptModule} from './lib/bundle-ts.mjs';
import {directory, hash, sha256, writeJson} from '../evaluation/lib/common.mjs';
import {defaultPublicScientificRoot, publicScientificSourceLock} from '../evaluation/adapters/scientific-public/sources.mjs';

const summaryPaths = process.argv.slice(3).map(path => resolve(path));
assert.ok(summaryPaths.length, 'Provide saved public parser summaries after the output directory');
const output = directory(resolve(process.argv[2]), 'tables-public');
const entries = ['src/main/plugins/research/pdf-table-extractor.ts', 'src/main/plugins/research/index-files.ts',
  'src/main/plugins/research/document-files.ts'];
const bundle = await build({entryPoints: entries, bundle: true, format: 'esm', platform: 'node',
  outdir: 'in-memory', write: false, metafile: true, logLevel: 'silent', packages: 'external'});
const codePaths = [...new Set([...Object.keys(bundle.metafile.inputs), 'scripts/benchmark-scientific-tables.mjs',
  'evaluation/adapters/scientific-public/sources.mjs', 'pnpm-lock.yaml'])].sort();
const codeHashes = Object.fromEntries(codePaths.map(path => [path, sha256(readFileSync(path))]));
const [tables, indexing, publication] = await Promise.all(entries.map(entry => importTypeScriptModule(entry, {platform: 'node'})));
const pins = new Map();
function read(path, expected) {
  if (path instanceof URL) path = fileURLToPath(path);
  const bytes = readFileSync(path), digest = sha256(bytes), stat = statSync(path, {bigint: true});
  if (expected) assert.equal(digest, expected, path);
  pins.set(path, {path, size: bytes.length, sha256: digest, mtimeNs: stat.mtimeNs.toString()});
  return bytes;
}
const cohorts = summaryPaths.map(path => {
  const summary = JSON.parse(read(path)), root = resolve(summary.root), runPath = join(root, 'run.json');
  const run = JSON.parse(read(runPath));
  assert.equal(summary.sourceLockHash, run.sourceLockHash);
  const sourceLock = JSON.parse(read(publicScientificSourceLock));
  assert.equal(hash(sourceLock), run.sourceLockHash);
  for (const row of run.rows) {
    const pin = sourceLock.files.find(file => file.sha256 === row.sourceHash);
    assert.ok(pin, 'Every saved source must remain in its original public lock');
    assert.equal(resolve(defaultPublicScientificRoot, row.source ?? row.image),
      resolve(defaultPublicScientificRoot, pin.path));
  }
  return {path, root, runPath, run};
});
const runs = [];
for (let trial = 0; trial < 2; trial++) {
  mkdirSync(join(output, `trial-${trial}`));
  const rows = []; let published = false;
  for (const [cohortIndex, cohort] of cohorts.entries()) for (const [index, row] of cohort.run.rows.entries()) {
    const result = {cohortIndex, index, paperId: row.paperId ?? null, sourceHash: row.sourceHash,
      status: row.status, failure: row.failure, tables: [], indexedTables: [], publishedTables: null};
    read(resolve(defaultPublicScientificRoot, row.source ?? row.image), row.sourceHash);
    if (row.status === 'parsed') {
      const parsed = JSON.parse(read(join(cohort.root, row.result)));
      const structuredPath = join(cohort.root, row.structured), artifact = row.artifacts.find(a => a.path === 'artifacts/structured.json');
      assert.ok(artifact); const structured = JSON.parse(read(structuredPath, artifact.sha256));
      assert.deepEqual(structured.blocks, parsed.blocks);
      const blocks = tables.attachPaperTables(parsed.blocks, structured.pages);
      result.tables = blocks.filter(b => b.table).map(b => b.table);
      result.indexedTables = indexing.indexDocumentBlocks(blocks, {paperId: row.paperId ?? `raster:${index}`,
        parseId: `saved:${cohortIndex}:${index}`, sourceHash: row.sourceHash}, undefined, parsed.structure)
        .filter(chunk => chunk.semantic.table).map(chunk => ({content: chunk.content, locator: chunk.locator, table: chunk.semantic.table}));
      for (const table of result.tables) if (table.imagePath) {
        const asset = row.artifacts.find(a => a.path === table.imagePath); assert.ok(asset);
        read(join(dirname(dirname(structuredPath)), table.imagePath), asset.sha256);
      }
      // Exercise the real publication/asset mapping on an original public raster output copy.
      if (!published && result.tables.some(table => table.imagePath)) {
        const copy = join(output, `trial-${trial}`, `publication-${cohortIndex}-${index}`), originalOutput = dirname(dirname(structuredPath));
        mkdirSync(copy);
        for (const path of [...new Set([...parsed.assets.map(asset => asset.path), ...Object.values(parsed.artifacts)])]) {
          const target = join(copy, path); mkdirSync(dirname(target), {recursive: true});
          writeFileSync(target, read(join(originalOutput, path)), {flag: 'wx'});
        }
        const replay = {...parsed, parserVersion: 'roc-research-parser/6', blocks};
        writeFileSync(join(copy, parsed.artifacts.structuredContent), JSON.stringify({...structured, ...replay}));
        const collected = await publication.collectDocumentContent(output, copy, replay);
        result.publishedTables = collected.data.content.blocks.filter(block => block.table).map(block => ({
          table: block.table, asset: collected.data.content.assets.find(asset => asset.id === block.imageAssetId) ?? null
        }));
        assert.ok(result.publishedTables.every(value => !value.table.imagePath || value.asset));
        published = true;
      }
    }
    writeJson(join(output, `trial-${trial}/cohort-${cohortIndex}-row-${index}.json`), result);
    rows.push(result);
  }
  runs.push({rows, deterministicHash: hash(rows)});
}
assert.equal(runs[0].deterministicHash, runs[1].deterministicHash);
for (const pin of pins.values()) {
  assert.equal(sha256(readFileSync(pin.path)), pin.sha256);
  assert.equal(statSync(pin.path, {bigint: true}).mtimeNs.toString(), pin.mtimeNs);
}
const all = runs[0].rows.flatMap(row => row.tables);
const report = {schemaVersion: 1, kind: 'scientific-table-saved-artifact-regression', status: 'verified-repeatable',
  root: output, workingDirectory: process.cwd(), command: `node scripts/benchmark-scientific-tables.mjs OUTPUT ${summaryPaths.join(' ')}`,
  measuredAt: new Date().toISOString(), codeHashes, inputs: [...pins.values()],
  cohorts: cohorts.map(c => ({summary: c.path, run: c.runPath, sourceLockHash: c.run.sourceLockHash, rows: c.run.rows.length})),
  runs: runs.map(run => ({deterministicHash: run.deterministicHash, rows: run.rows.length})),
  counts: {tables: all.length, parsed: all.filter(t => t.status === 'parsed').length,
    missing: all.filter(t => t.status === 'missing').length, invalid: all.filter(t => t.status === 'invalid').length,
    cells: all.flatMap(t => t.rows.flatMap(r => r.cells)).length,
    indexedTables: runs[0].rows.flatMap(r => r.indexedTables).length,
    mappedCells: all.flatMap(t => t.rows.flatMap(r => r.cells)).filter(c => c.bbox).length},
  limitations: ['Saved predictions are reused without OCR inference.', 'No new table detection or scientific accuracy claim.',
    'Failed source rows remain in each fixed cohort.', 'Missing and invalid table structures remain explicit.']};
writeJson(join(output, 'report.json'), report);
console.log(JSON.stringify({root: output, counts: report.counts, deterministicHash: runs[0].deterministicHash}));
