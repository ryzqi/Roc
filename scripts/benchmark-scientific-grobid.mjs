import assert from 'node:assert/strict';
import {readFileSync, mkdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {build} from 'esbuild';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {importTypeScriptModule} from './lib/bundle-ts.mjs';
import {directory, hash, ROOT, sha256, writeJson} from '../evaluation/lib/common.mjs';

const lockPath = resolve(process.argv[2]), lockBytes = readFileSync(lockPath), lock = JSON.parse(lockBytes);
const output = directory(resolve(process.argv[3]), 'grobid-public');
const entries = ['src/main/plugins/research/grobid-adapter.ts', 'src/main/plugins/research/scholarly-parser-adapter.ts'];
const bundle = await build({entryPoints: entries, bundle: true, format: 'esm', platform: 'node',
  outdir: 'in-memory', write: false, metafile: true, logLevel: 'silent', packages: 'external'});
const paths = [...new Set([...Object.keys(bundle.metafile.inputs), 'scripts/benchmark-scientific-grobid.mjs', 'pnpm-lock.yaml'])].sort();
const codeHashes = Object.fromEntries(paths.map(path => [path, sha256(readFileSync(join(ROOT, path)))]));
const [grobid, scholarly] = await Promise.all(entries.map(entry => importTypeScriptModule(entry, {platform: 'node'})));
for (const row of lock.rows) {
  const bytes = readFileSync(row.path); assert.equal(bytes.length, row.size); assert.equal(sha256(bytes), row.sha256);
}
const pdf = lock.rows.find(row => row.upstreamPath.endsWith('/0807.3577.pdf'));
assert.ok(pdf, 'locked reference PDF is required');
const task = getDocument({data: new Uint8Array(readFileSync(pdf.path)), disableFontFace: true, useSystemFonts: true});
const document = await task.promise, blocks = [], nativePages = [];
try {
  for (let page = 1; page <= document.numPages; page++) {
    const content = await (await document.getPage(page)).getTextContent();
    const items = content.items.filter(item => 'str' in item);
    const text = items.map(item => item.str + (item.hasEOL ? '\n' : '')).join('').trim();
    nativePages.push({page, items: items.map(({str, hasEOL, transform, width, height}) => ({str, hasEOL, transform, width, height})), text});
    if (text) blocks.push({id: `native-page:${page}`, kind: 'paragraph', text, locator: `pdf-native-items:page:${page}`});
  }
} finally {await task.destroy();}
writeJson(join(output, 'reference-pdf-native-items.json'), {sourceHash: pdf.sha256, pages: nativePages});
const runs = [];
for (let trial = 0; trial < 2; trial++) {
  mkdirSync(join(output, `trial-${trial}`));
  const rows = [];
  for (const [index, source] of lock.rows.entries()) {
    if (!source.path.endsWith('.xml')) continue;
    let observation;
    try {
      const {fields, warnings} = grobid.parseGrobidTei(readFileSync(source.path, 'utf8'));
      const nominatedPair = source.upstreamPath.endsWith('/0807.3577.training.fulltext.tei.xml');
      observation = {index, status: 'parsed', sourceHash: source.sha256, fields, warnings,
        sourcePdf: nominatedPair ? {path: pdf.path, sha256: pdf.sha256} : null,
        resolutions: nominatedPair ? scholarly.crossValidateGrobid(fields, blocks) : []};
    } catch (error) {
      observation = {index, status: 'failed', sourceHash: source.sha256, failureCode: error.message,
        fields: null, warnings: [], sourcePdf: null, resolutions: []};
    }
    writeJson(join(output, `trial-${trial}/source-${index}.json`), observation); rows.push(observation);
  }
  runs.push({rows, deterministicHash: hash(rows)});
}
assert.equal(runs[0].deterministicHash, runs[1].deterministicHash);
// The existing 45-PDF cohort remains usable with the explicit disabled supplement and no service.
const semanticSummary = JSON.parse(readFileSync(join(ROOT, 'evaluation/results/scientific-paper-semantics-regression.json')));
const report = JSON.parse(readFileSync(join(ROOT, semanticSummary.savedReplay.report)));
assert.equal(sha256(readFileSync(join(ROOT, semanticSummary.savedReplay.report))), semanticSummary.artifactHashes[semanticSummary.savedReplay.report]);
const disabled = [];
for (const input of report.inputs) {
  assert.equal(sha256(readFileSync(input.sourcePath)), input.sourceHash);
  assert.equal(sha256(readFileSync(input.path)), input.sha256);
  const parsed = JSON.parse(readFileSync(input.path));
  const enriched = await scholarly.enrichScholarlyFields(readFileSync(input.sourcePath), input.sourceHash, parsed.blocks, null, new AbortController().signal);
  assert.equal(enriched.status, 'disabled');
  disabled.push({paperId: input.paperId, sourceHash: input.sourceHash, sourceBlocksDigest: enriched.sourceBlocksDigest,
    status: enriched.status, missingFields: enriched.missingFields});
}
for (const row of lock.rows) assert.equal(sha256(readFileSync(row.path)), row.sha256);
for (const [path, digest] of Object.entries(codeHashes)) assert.equal(sha256(readFileSync(join(ROOT, path))), digest);
writeJson(join(output, 'report.json'), {kind: 'scientific-public-grobid-source-replay', status: 'repeatable-awaiting-independent-readback',
  command: process.argv, workingDirectory: ROOT, sourceLock: lockPath, sourceLockSha256: sha256(lockBytes),
  codeHashes, pdfNativePages: nativePages.length, sourceCount: lock.rows.length, runs, disabled,
  limitations: ['Saved upstream test/training TEI, no live GROBID inference or scientific quality benefit measurement.',
    'One filename-nominated PDF pair mapped only by complete whitespace-normalized original native-text passages.',
    'Native-item locators are source observations, not Roc parse/block/coordinate locators.',
    'Unmatched, ambiguous, missing coordinates and unsupported TEI corpus remain explicit.',
    'Original full45-PDF cohort retained; all optional parser snapshots explicitly disabled.',
    'Dataset/document licenses and provenance are retained separately from repository code license.']});
console.log(JSON.stringify({output, repeats: runs.map(r => r.deterministicHash), tei: runs[0].rows.map(r =>
  ({index: r.index, status: r.status, sections: r.fields?.sections.length, references: r.fields?.references.length,
    markers: r.fields?.citationMarkers.length, matched: r.resolutions.filter(r => r.status === 'matched').length})), disabled: disabled.length}));
