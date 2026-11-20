import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {build} from 'esbuild';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {importTypeScriptModule} from './lib/bundle-ts.mjs';
import {directory, hash, readJson, ROOT, sha256, writeJson} from '../evaluation/lib/common.mjs';
import {defaultPublicScientificRoot, publicScientificSourceLock, verifyPublicScientificSources}
  from '../evaluation/adapters/scientific-public/sources.mjs';
import {stableNativeFusionValue, verifyScientificNativeFusion, verifyScientificNativeTextSource} from '../evaluation/lib/scientific-native-fusion.mjs';
import {observeScientificPdfStructure} from '../evaluation/adapters/scientific-pdf.mjs';

// Selection is fixed before inference; historical complete baseline is read only.
const baselineRoot = join(ROOT, '.artifacts/scientific-rag/baselines/current-code-pair-01/public-pdf-2026-11-16T05-37-19.680Z-a15d7add');
const clean = text => text.normalize('NFC').replace(/\s+/gu, ' ').trim();
const root = directory(resolve(process.argv[2]), 'native-fusion');
const sources = verifyPublicScientificSources(), lock = readJson(publicScientificSourceLock);
const pins = lock.files.filter(pin => pin.path.endsWith('.pdf')).slice(0, 2);
const packages = readJson(join(ROOT, 'package.json'));
const entries = ['src/main/plugins/research/document-parser.ts', 'src/main/plugins/research/document-files.ts',
  'src/main/plugins/research/model-store.ts'];
const external = [...Object.keys(packages.dependencies), 'pdfjs-dist/legacy/build/pdf.mjs'];
const compiled = await build({entryPoints: entries, bundle: true, outdir: 'in-memory', format: 'esm', platform: 'node',
  external, write: false, metafile: true, logLevel: 'silent'});
const paths = [...new Set([...Object.keys(compiled.metafile.inputs), 'scripts/benchmark-scientific-native-fusion.mjs',
  'evaluation/lib/scientific-native-fusion.mjs', 'evaluation/adapters/scientific-pdf.mjs',
  'evaluation/lib/scientific-pdf-scoring.mjs', 'evaluation/adapters/scientific-public/pdf.mjs', 'pnpm-lock.yaml'])].sort();
const codeHashes = Object.fromEntries(paths.map(path => [path, sha256(readFileSync(join(ROOT, path)))]));
const modules = await Promise.all(entries.map(entry => importTypeScriptModule(entry,
  {platform: 'node', external, tempDir: 'evaluation/.runtime/imports'})));
const [{parseResearchDocument}, {collectDocumentContent}, {ResearchModelStore}] = modules;
const models = new ResearchModelStore(join(ROOT, '.runtime/research-models')), lease = await models.requireReady('complete');
const options = {tier: 'complete', device: 'cpu', pageRange: '1-2'};
const modelHashes = Object.fromEntries(Object.entries(lease.files).filter(([, path]) => path)
  .map(([key, path]) => [key, sha256(readFileSync(path))]));
writeJson(join(root, 'inputs.json'), {pins, options, sourceLockHash: sources.sourceLockHash, codeHashes, modelHashes,
  modelManifest: lease.manifest, baselineRoot});
const runs = [];
try {
  for (let trial = 0; trial < 2; trial++) {
    const rows = [];
    for (const [index, pin] of pins.entries()) {
      const outputDir = join(root, `trial-${trial}/paper-${index}`);
      const started = performance.now();
      const parsed = await parseResearchDocument({projectRoot: ROOT, sourcePath: join(defaultPublicScientificRoot, pin.path),
        outputDir, options, modelFiles: lease.files, modelManifest: lease.manifest});
      assert.equal(parsed.sourceHash, pin.sha256);
      const collected = await collectDocumentContent(ROOT, outputDir, parsed);
      assert.equal(collected.data.content.content, parsed.content);
      const structured = readJson(join(outputDir, parsed.artifacts.structuredContent));
      const loading = getDocument({data: new Uint8Array(readFileSync(join(defaultPublicScientificRoot, pin.path))),
        useSystemFonts: true, isEvalSupported: false, verbosity: 0});
      try {
        const pdf = await loading.promise;
        for (const page of structured.pages) {
          const actual = await pdf.getPage(page.page);
          verifyScientificNativeTextSource(page, await actual.getTextContent()); actual.cleanup();
        }
      } finally {await loading.destroy();}
      const observations = observeScientificPdfStructure({status: 'parsed', failure: null, pageCount: structured.pages.length,
        parserFingerprint: parsed.parserFingerprint, artifacts: parsed.assets}, structured);
      writeJson(join(outputDir, 'observations.json'), observations);
      const historical = readJson(join(baselineRoot, `paper-${index}/output/artifacts/structured.json`));
      const pageRows = structured.pages.map(page => {
        const native = page.nativeTextItems.filter(item => item.text.trim());
        const represented = new Set(page.fusion.provenance.flatMap(p => p.nativeItemIds));
        assert.ok(native.every(item => represented.has(item.id)));
        assert.ok(native.every(item => item.bbox && item.pdfBbox && item.pdfQuad && item.transform.length === 6));
        const pageBlocks = parsed.blocks.filter(block => block.locations[0]?.page === page.page);
        const verified = verifyScientificNativeFusion(page, pageBlocks);
        const before = historical.blocks.filter(block => block.locations[0]?.page === page.page).map(b => b.text).join('\n\n');
        const after = pageBlocks.map(b => b.text).join('\n\n');
        const oldPresent = native.filter(item => clean(before).includes(clean(item.text))).length;
        const newPresent = native.filter(item => clean(after).includes(clean(item.text))).length;
        return {page: page.page, nativeItems: native.length, representedItems: represented.size,
          originalTextItemPresenceBefore: oldPresent, originalTextItemPresenceAfter: newPresent,
          blocks: pageBlocks.length, rawOcrRegions: page.regions.length,
          disputes: page.fusion.provenance.filter(p => p.status === 'disputed').length,
          deterministicHash: verified.contentHash};
      });
      writeJson(join(outputDir, 'result.json'), parsed);
      rows.push({source: pin.path, sourceHash: pin.sha256, parseMode: parsed.parseMode,
        elapsedMs: performance.now() - started, pages: pageRows,
        deterministicHash: hash(stableNativeFusionValue({blocks: parsed.blocks, pages: structured.pages}))});
      console.error(`trial ${trial + 1}, ${pin.path}: ${parsed.blocks.length} blocks, ${pageRows.map(p =>
        `${p.originalTextItemPresenceBefore}->${p.originalTextItemPresenceAfter}/${p.nativeItems}`).join(', ')}`);
    }
    runs.push(rows);
  }
  assert.deepEqual(runs[0].map(r => r.deterministicHash), runs[1].map(r => r.deterministicHash));
  for (const rows of runs) for (const row of rows) for (const page of row.pages) {
    assert.ok(page.originalTextItemPresenceAfter >= page.originalTextItemPresenceBefore);
  }
  writeJson(join(root, 'report.json'), {kind: 'scientific-public-native-fusion-regression', status: 'verified-repeatable',
    workingDirectory: ROOT, command: process.argv, pins, options, codeHashes, modelHashes, modelManifest: lease.manifest,
    runs, sourceLockHash: sources.sourceLockHash,
    limitations: ['Fixed first two public PDFs, first two pages only.', 'Item presence is a substring preservation check, not scientific CER or glyph accuracy.',
      'Visual-region disagreements preserve native alternatives; confidence is raw model score, not calibrated probability.',
      'Raw PDF.js fontName retained; only its g_dN loading-task counter is excluded from deterministic content comparison.']});
  console.log(JSON.stringify({root, status: 'verified-repeatable', papers: pins.length, trials: 2}));
} finally {models.release(lease.pack);}
