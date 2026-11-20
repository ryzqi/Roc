import assert from 'node:assert/strict';
import {readFileSync, mkdirSync, statSync, writeFileSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {importTypeScriptModule} from './lib/bundle-ts.mjs';
import {directory, hash, sha256, writeJson} from '../evaluation/lib/common.mjs';
import {defaultPublicScientificRoot, publicScientificSourceLock} from '../evaluation/adapters/scientific-public/sources.mjs';

const summaryPaths = process.argv.slice(3).map(path => resolve(path));
assert.ok(summaryPaths.length);
const output = directory(resolve(process.argv[2]), 'equations-public');
const entries = ['src/main/plugins/research/pdf-table-extractor.ts', 'src/main/plugins/research/pdf-equation-extractor.ts',
  'src/main/plugins/research/index-files.ts', 'src/main/plugins/research/document-files.ts'];
const bundle = await build({entryPoints: entries, bundle: true, format: 'esm', platform: 'node',
  outdir: 'in-memory', write: false, metafile: true, logLevel: 'silent', packages: 'external'});
const codePaths = [...new Set([...Object.keys(bundle.metafile.inputs), 'scripts/benchmark-scientific-equations.mjs',
  'evaluation/adapters/scientific-public/sources.mjs', 'pnpm-lock.yaml'])].sort();
const codeHashes = Object.fromEntries(codePaths.map(path => [path, sha256(readFileSync(path))]));
const [tables, equations, indexing, publication] = await Promise.all(entries.map(entry => importTypeScriptModule(entry, {platform: 'node'})));
const pins = new Map();
function read(path, expected) {
  if (path instanceof URL) path = fileURLToPath(path);
  const bytes = readFileSync(path), digest = sha256(bytes), stat = statSync(path, {bigint: true});
  if (expected) assert.equal(digest, expected, path);
  pins.set(path, {path, size: bytes.length, sha256: digest, mtimeNs: stat.mtimeNs.toString()});
  return bytes;
}
const sourceLock = JSON.parse(read(publicScientificSourceLock));
const cohorts = summaryPaths.map(path => {
  const summary = JSON.parse(read(path)), root = resolve(summary.root), runPath = join(root, 'run.json');
  const run = JSON.parse(read(runPath));
  assert.equal(summary.sourceLockHash, run.sourceLockHash); assert.equal(hash(sourceLock), run.sourceLockHash);
  for (const row of run.rows) {
    const pin = sourceLock.files.find(file => file.sha256 === row.sourceHash); assert.ok(pin);
    assert.equal(resolve(defaultPublicScientificRoot, row.source ?? row.image), resolve(defaultPublicScientificRoot, pin.path));
  }
  return {path, root, runPath, run};
});
const runs = [];
for (let trial = 0; trial < 2; trial++) {
  mkdirSync(join(output, `trial-${trial}`));
  const rows = []; let published = false;
  for (const [cohortIndex, cohort] of cohorts.entries()) for (const [index, row] of cohort.run.rows.entries()) {
    const result = {cohortIndex, index, paperId: row.paperId ?? null, sourceHash: row.sourceHash,
      status: row.status, failure: row.failure, equations: [], indexedEquations: [], publishedEquations: null};
    read(resolve(defaultPublicScientificRoot, row.source ?? row.image), row.sourceHash);
    if (row.status === 'parsed') {
      const parsed = JSON.parse(read(join(cohort.root, row.result)));
      const structuredPath = join(cohort.root, row.structured), artifact = row.artifacts.find(a => a.path === 'artifacts/structured.json');
      assert.ok(artifact); const structured = JSON.parse(read(structuredPath, artifact.sha256));
      assert.deepEqual(structured.blocks, parsed.blocks);
      const blocks = equations.attachPaperEquations(tables.attachPaperTables(parsed.blocks, structured.pages), structured.pages);
      result.equations = blocks.filter(b => b.equation).map(b => b.equation);
      result.indexedEquations = indexing.indexDocumentBlocks(blocks, {paperId: row.paperId ?? `raster:${index}`,
        parseId: `saved:${cohortIndex}:${index}`, sourceHash: row.sourceHash}, undefined, parsed.structure)
        .filter(chunk => chunk.semantic.equation).map(chunk => ({content: chunk.content, locator: chunk.locator, equation: chunk.semantic.equation}));
      for (const equation of result.equations) if (equation.imagePath) {
        const asset = row.artifacts.find(a => a.path === equation.imagePath); assert.ok(asset);
        read(join(dirname(dirname(structuredPath)), equation.imagePath), asset.sha256);
      }
      if (!published && result.equations.some(equation => equation.imagePath)) {
        const copy = join(output, `trial-${trial}`, `publication-${cohortIndex}-${index}`), originalOutput = dirname(dirname(structuredPath));
        mkdirSync(copy);
        for (const path of [...new Set([...parsed.assets.map(asset => asset.path), ...Object.values(parsed.artifacts)])]) {
          const target = join(copy, path); mkdirSync(dirname(target), {recursive: true});
          writeFileSync(target, read(join(originalOutput, path)), {flag: 'wx'});
        }
        const replay = {...parsed, parserVersion: 'roc-research-parser/7', blocks};
        const captured = {...structured, ...replay}, artifactPath = join(copy, parsed.artifacts.structuredContent);
        writeFileSync(artifactPath, JSON.stringify(captured));
        const collected = await publication.collectDocumentContent(output, copy, replay);
        result.publishedEquations = collected.data.content.blocks.filter(block => block.equation).map(block => ({
          equation: block.equation, asset: collected.data.content.assets.find(asset => asset.id === block.imageAssetId) ?? null
        }));
        // Both returned and saved copies changing together cannot bypass raw-recognition reconstruction.
        const changed = structuredClone(captured), target = changed.blocks.find(b => b.equation);
        target.equation.rawLatex = 'forged'; target.equation.normalizedLatex = 'forged';
        writeFileSync(artifactPath, JSON.stringify(changed));
        await assert.rejects(publication.collectDocumentContent(output, copy, {...replay, blocks: changed.blocks}), /equation_artifact_mismatch/);
        delete target.equation;
        writeFileSync(artifactPath, JSON.stringify(changed));
        await assert.rejects(publication.collectDocumentContent(output, copy, {...replay, blocks: changed.blocks}), /equation_artifact_mismatch/);
        writeFileSync(artifactPath, JSON.stringify(captured));
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
const all = runs[0].rows.flatMap(row => row.equations);
const report = {schemaVersion: 1, kind: 'scientific-equation-saved-artifact-regression', status: 'verified-repeatable',
  root: output, workingDirectory: process.cwd(), command: process.argv.slice(1), measuredAt: new Date().toISOString(), codeHashes, inputs: [...pins.values()],
  cohorts: cohorts.map(c => ({summary: c.path, run: c.runPath, sourceLockHash: c.run.sourceLockHash, rows: c.run.rows.length})),
  runs: runs.map(run => ({deterministicHash: run.deterministicHash, rows: run.rows.length})),
  counts: {equations: all.length, parsed: all.filter(e => e.status === 'parsed').length,
    missing: all.filter(e => e.status === 'missing').length, invalid: all.filter(e => e.status === 'invalid').length,
    numbered: all.filter(e => e.equationNumber).length, contexts: all.flatMap(e => e.contexts).length,
    references: all.flatMap(e => e.references).length, variables: all.flatMap(e => e.variables).length,
    indexedEquations: runs[0].rows.flatMap(r => r.indexedEquations).length},
  limitations: ['Saved FormulaNet predictions are reused without OCR inference or a new recognition score.',
    'Missing/invalid recognitions and failed source rows remain explicit.', 'Only whitespace and line endings are normalized.',
    'One public raster copy exercises current parser7 publication rules with its original parser fingerprint.',
    'Agent acceptance does not supply human formula/variable gold.']};
writeJson(join(output, 'report.json'), report);
console.log(JSON.stringify({root: output, counts: report.counts, deterministicHash: runs[0].deterministicHash}));
