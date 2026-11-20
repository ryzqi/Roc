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
const output = directory(resolve(process.argv[2]), 'captions-public');
const entries = ['src/main/plugins/research/pdf-table-extractor.ts', 'src/main/plugins/research/pdf-equation-extractor.ts', 'src/main/plugins/research/pdf-caption-linker.ts',
  'src/main/plugins/research/index-files.ts', 'src/main/plugins/research/document-files.ts'];
const bundle = await build({entryPoints: entries, bundle: true, format: 'esm', platform: 'node',
  outdir: 'in-memory', write: false, metafile: true, logLevel: 'silent', packages: 'external'});
const codePaths = [...new Set([...Object.keys(bundle.metafile.inputs), 'scripts/benchmark-scientific-captions.mjs',
  'evaluation/adapters/scientific-public/sources.mjs', 'pnpm-lock.yaml'])].sort();
const codeHashes = Object.fromEntries(codePaths.map(path => [path, sha256(readFileSync(path))]));
const [tables, equations, captions, indexing, publication] = await Promise.all(entries.map(entry => importTypeScriptModule(entry, {platform: 'node'})));
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
      status: row.status, failure: row.failure, visuals: [], indexedVisuals: [], publishedVisuals: null};
    read(resolve(defaultPublicScientificRoot, row.source ?? row.image), row.sourceHash);
    if (row.status === 'parsed') {
      const parsed = JSON.parse(read(join(cohort.root, row.result)));
      const structuredPath = join(cohort.root, row.structured), artifact = row.artifacts.find(a => a.path === 'artifacts/structured.json');
      assert.ok(artifact); const structured = JSON.parse(read(structuredPath, artifact.sha256));
      assert.deepEqual(structured.blocks, parsed.blocks);
      const blocks = captions.attachPaperVisuals(equations.attachPaperEquations(tables.attachPaperTables(parsed.blocks, structured.pages), structured.pages));
      result.visuals = blocks.filter(b => b.visual).map(b => b.visual);
      result.indexedVisuals = indexing.indexDocumentBlocks(blocks, {paperId: row.paperId ?? `raster:${index}`,
        parseId: `saved:${cohortIndex}:${index}`, sourceHash: row.sourceHash}, undefined, parsed.structure)
        .filter(chunk => chunk.semantic.visual).map(chunk => ({content: chunk.content, locator: chunk.locator, visual: chunk.semantic.visual}));
      for (const equation of result.visuals) if (equation.imagePath) {
        const asset = row.artifacts.find(a => a.path === equation.imagePath); assert.ok(asset);
        read(join(dirname(dirname(structuredPath)), equation.imagePath), asset.sha256);
      }
      if (!published && result.visuals.some(equation => equation.imagePath)) {
        const copy = join(output, `trial-${trial}`, `publication-${cohortIndex}-${index}`), originalOutput = dirname(dirname(structuredPath));
        mkdirSync(copy);
        for (const path of [...new Set([...parsed.assets.map(asset => asset.path), ...Object.values(parsed.artifacts)])]) {
          const target = join(copy, path); mkdirSync(dirname(target), {recursive: true});
          writeFileSync(target, read(join(originalOutput, path)), {flag: 'wx'});
        }
        const replay = {...parsed, parserVersion: 'roc-research-parser/8', blocks};
        const captured = {...structured, ...replay}, artifactPath = join(copy, parsed.artifacts.structuredContent);
        writeFileSync(artifactPath, JSON.stringify(captured));
        const collected = await publication.collectDocumentContent(output, copy, replay);
        result.publishedVisuals = collected.data.content.blocks.filter(block => block.visual).map(block => ({
          visual: block.visual, asset: collected.data.content.assets.find(asset => asset.id === block.imageAssetId) ?? null
        }));
        // Both returned and saved copies changing together cannot bypass raw-recognition reconstruction.
        const changed = structuredClone(captured), target = changed.blocks.find(b => b.visual);
        target.visual.objectNumber = '999';
        writeFileSync(artifactPath, JSON.stringify(changed));
        await assert.rejects(publication.collectDocumentContent(output, copy, {...replay, blocks: changed.blocks}), /visual_artifact_mismatch/);
        delete target.visual;
        writeFileSync(artifactPath, JSON.stringify(changed));
        await assert.rejects(publication.collectDocumentContent(output, copy, {...replay, blocks: changed.blocks}), /visual_artifact_mismatch/);
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
const all = runs[0].rows.flatMap(row => row.visuals);
const report = {schemaVersion: 1, kind: 'scientific-caption-saved-artifact-regression', status: 'verified-repeatable',
  root: output, workingDirectory: process.cwd(), command: process.argv.slice(1), measuredAt: new Date().toISOString(), codeHashes, inputs: [...pins.values()],
  cohorts: cohorts.map(c => ({summary: c.path, run: c.runPath, sourceLockHash: c.run.sourceLockHash, rows: c.run.rows.length})),
  runs: runs.map(run => ({deterministicHash: run.deterministicHash, rows: run.rows.length})),
  counts: {objects: all.length, figures: all.filter(v => v.kind === 'figure').length,
    tables: all.filter(v => v.kind === 'table').length,
    captions: all.flatMap(v => v.captions).length, linkedCaptions: all.flatMap(v => v.captions).filter(c => c.status === 'linked').length,
    candidateCaptions: all.flatMap(v => v.captions).filter(c => c.status === 'candidate').length,
    crossPageCaptions: all.flatMap(v => v.captions).filter(c => c.crossPage).length,
    references: all.flatMap(v => v.references).length, linkedReferences: all.flatMap(v => v.references).filter(r => r.status === 'linked').length,
    indexedVisuals: runs[0].rows.flatMap(r => r.indexedVisuals).length},
  limitations: ['Saved public parser blocks are reused without OCR inference or a new caption accuracy score.',
    'Unlinked objects, ambiguous/cross-page captions and failed source rows remain explicit.', 'Original caption/prose text and locations remain unchanged.',
    'One public raster copy exercises current parser8 publication rules with its original parser fingerprint.',
    'Agent acceptance does not supply human caption correspondence gold.']};
writeJson(join(output, 'report.json'), report);
console.log(JSON.stringify({root: output, counts: report.counts, deterministicHash: runs[0].deterministicHash}));
