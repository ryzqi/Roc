import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

// Three separate offline commands: freeze first, original-PDF readback second,
// production component replay last. No parser/model/database is instantiated.
const ROOT = realpathSync(resolve(dirname(new URL(import.meta.url).pathname), '..'));
const [mode, target] = process.argv.slice(2);
assert.ok(['--prelock', '--raw-source', '--run'].includes(mode) && target,
  'usage: node scripts/benchmark-scientific-parser-ir-ablation.mjs --prelock|--raw-source|--run OUTPUT');
const root = resolve(target);
const allowed = join(ROOT, '.artifacts/scientific-rag/phase8-parser-ir-ablation-01');
assert.ok(root === allowed || root.startsWith(allowed + '/'), 'output outside authorized directory');
mkdirSync(root, {recursive: true});
assert.ok(realpathSync(root) === root, 'output symlink');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path));
function write(path, value) {
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, JSON.stringify(value), {flag: 'wx'});
  return {path: relative(root, path), sha256: sha(readFileSync(path)), bytes: statSync(path).size};
}
const irReportPath = join(ROOT, '.artifacts/scientific-rag/phase2-public-01/paper-ir-public-2026-11-16T13-36-53.200Z-2fc98ebd/report.json');
const fusionReportPath = join(ROOT, '.artifacts/scientific-rag/phase1-public-02/native-fusion-2026-11-16T11-06-45.055Z-dc9bd098/report.json');
const sourceRoot = join(ROOT, 'evaluation/local/sources/scientific-public');
const entries = ['paper-ir', 'paper-ir-builder', 'paper-ir-repository', 'pdf-table-extractor',
  'pdf-equation-extractor', 'pdf-caption-linker', 'pdf-quality-assessor', 'pdf-layout-merge']
  .map(name => `src/main/plugins/research/${name}.ts`);
const protocolPath = join(root, 'protocol.json');

if (mode === '--prelock') {
  assert.ok(!existsSync(protocolPath), 'prelock already exists; use a fresh child directory');
  const pins = new Map();
  function pin(path, expected = null, mtime = null) {
    path = resolve(path);
    assert.ok(!path.startsWith(root + '/'), 'original input points into candidate output');
    const bytes = readFileSync(path), digest = sha(bytes), stat = statSync(path, {bigint: true});
    if (expected) assert.equal(digest, expected, path);
    if (mtime) assert.equal(stat.mtimeNs.toString(), mtime, path);
    const snapshot = `inputs/${digest}`;
    if (!existsSync(join(root, snapshot))) {
      mkdirSync(join(root, 'inputs'), {recursive: true});
      writeFileSync(join(root, snapshot), bytes, {flag: 'wx'});
    }
    const value = {path, sha256: digest, bytes: bytes.length, mtimeNs: stat.mtimeNs.toString(), snapshot};
    pins.set(path, value);
    return value;
  }
  const irReport = json(irReportPath), fusionReport = json(fusionReportPath);
  pin(irReportPath); pin(fusionReportPath);
  for (const input of irReport.inputs) pin(input.path, input.sha256, input.mtimeNs);
  const lockPath = join(ROOT, 'evaluation/corpora/scientific-rag/public-sources.lock.json');
  const lock = json(lockPath); pin(lockPath);
  const rows = [];
  for (const [cohort, old] of irReport.cohorts.entries()) {
    const runPath = resolve(old.run), run = json(runPath); pin(runPath);
    assert.equal(run.rows.length, old.rows);
    assert.equal(run.sourceLockHash, fusionReport.sourceLockHash);
    for (const [index, source] of run.rows.entries()) {
      const name = source.source ?? source.image;
      const originalPin = lock.files.find(p => p.path === name);
      assert.ok(originalPin && originalPin.sha256 === source.sourceHash, 'source lock mismatch');
      const original = pin(join(sourceRoot, name), source.sourceHash);
      const row = {ordinal: rows.length, cohort, index, source: name, sourceHash: source.sourceHash,
        paperId: source.paperId ?? `raster:${index}`, status: source.status, failure: source.failure,
        original, run: pin(runPath), originalRow: source, parsed: null, structured: null,
        artifacts: [], fusionDiagnosis: null};
      // Preserve every original artifact, including files retained on failed rows.
      const output = source.status === 'parsed' ? dirname(source.structured).replace(/\/artifacts$/u, '')
        : `${cohort === 0 ? 'page' : 'paper'}-${index}/output`;
      for (const artifact of source.artifacts ?? []) {
        row.artifacts.push({originalPath: artifact.path,
          pin: pin(join(run.root, output, artifact.path), artifact.sha256)});
      }
      const receiptPath = join(run.root, `${cohort === 0 ? 'page' : 'paper'}-${index}/receipt.json`);
      if (existsSync(receiptPath)) row.receipt = pin(receiptPath);
      if (source.status === 'parsed') {
        row.parsed = pin(join(run.root, source.result));
        row.structured = pin(join(run.root, source.structured),
          source.artifacts.find(a => a.path === 'artifacts/structured.json').sha256);
        const structured = json(row.structured.path), parsed = json(row.parsed.path);
        assert.deepEqual(parsed.blocks, structured.blocks);
        assert.equal(parsed.sourceHash, row.sourceHash);
        row.fusionDiagnosis = structured.pages.map(page => ({page: page.page,
          nativeTextStringSaved: typeof page.text === 'string',
          nativeItemsSaved: Array.isArray(page.nativeTextItems), regions: page.regions.length,
          status: 'unavailable', reason: Array.isArray(page.nativeTextItems)
            ? 'production_fusion_off_switch_absent' : 'same_parse_native_items_not_saved'}));
      } else {
        assert.equal(typeof source.failure?.code, 'string');
        row.fusionDiagnosis = [{page: null, status: 'unavailable', reason: 'original_parser_failure',
          objectDenominator: null}];
      }
      rows.push(row);
    }
  }
  assert.equal(rows.length, 91);
  const nativeRows = [];
  const fusionRoot = dirname(fusionReportPath);
  // Every saved row of the fixed accepted two-paper replay, both original trials.
  // They are supplemental observations, never replacements for the 91 primary rows.
  for (const [trial, run] of fusionReport.runs.entries()) for (const [index, source] of run.entries()) {
    const dir = join(fusionRoot, `trial-${trial}/paper-${index}`);
    const parsed = pin(join(dir, 'result.json'));
    const structured = pin(join(dir, 'artifacts/structured.json'));
    const saved = json(structured.path);
    const artifactPins = [];
    for (const path of ['artifacts/middle.json', 'artifacts/document.md',
      ...saved.assets.map(asset => asset.path)]) {
      if (existsSync(join(dir, path))) artifactPins.push({originalPath: path, pin: pin(join(dir, path))});
    }
    const original = pin(join(sourceRoot, source.source), source.sourceHash);
    for (const page of saved.pages) {
      assert.ok(Array.isArray(page.nativeTextItems));
      nativeRows.push({ordinal: nativeRows.length, originalTrial: trial, index,
        source: source.source, sourceHash: source.sourceHash, original, parsed, structured,
        artifacts: artifactPins, page: page.page, status: 'available_current_fusion_only',
        unavailableArm: 'production_fusion_off_switch_absent'});
    }
  }
  assert.equal(nativeRows.length, 8);
  const bundle = await build({entryPoints: entries, bundle: true, write: false, metafile: true,
    outdir: 'in-memory', format: 'esm', platform: 'node', packages: 'external', logLevel: 'silent'});
  const codePaths = [...new Set([...Object.keys(bundle.metafile.inputs),
    'src/main/plugins/research/document-parser.ts',
    'scripts/benchmark-scientific-parser-ir-ablation.mjs',
    'scripts/verify-scientific-parser-ir-ablation.py', 'scripts/verify-scientific-tables.py',
    'pnpm-lock.yaml', 'package.json', 'node_modules/pdfjs-dist/package.json',
    'node_modules/pdfjs-dist/legacy/build/pdf.mjs', 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
    'node_modules/esbuild/package.json'])].sort();
  const code = codePaths.map(path => pin(join(ROOT, path)));
  const protocol = {version: 1, kind: 'scientific-parser-ir-same-source-engineering-ablation',
    createdAt: new Date().toISOString(), workingDirectory: ROOT, command: process.argv,
    runtime: {node: process.version, platform: process.platform, arch: process.arch},
    sourceLockHash: fusionReport.sourceLockHash,
    originalReports: [pin(irReportPath), pin(fusionReportPath)],
    historicalRuntimePins: {cohorts: irReport.cohorts.map(c => {
      const r = json(resolve(c.run));
      return {run: resolve(c.run), parserOptions: r.parserOptions, modelHashes: r.modelHashes,
        modelManifest: r.modelManifest, codeHashes: r.codeHashes};
    }), native: {options: fusionReport.options, modelHashes: fusionReport.modelHashes,
      modelManifest: fusionReport.modelManifest, codeHashes: fusionReport.codeHashes}},
    inputs: [...pins.values()], code, entries, rows, nativeRows, repeats: 3,
    arms: {A: {
      current: {entry: 'fusePdfPage', status: 'available_on_saved_native_supplement',
        input: 'unchanged saved nativeTextItems and original pre-fusion region payloads'},
      fusionOff: {entry: null, status: 'unavailable', reason: 'production_fusion_off_switch_absent'}
    }, B: {
      blockIR: {entry: 'paperBlocks', version: 'existing production block-derived IR'},
      paperIRv2: {entry: 'buildPaperIR + PaperIRRepository.publish/read',
        version: 'roc-paper-ir/2.1'}
    }},
    controls: {network: 'denied_by_sandbox', newModels: 0, ocrCalls: 0, database: 'none',
      randomSeed: null, stochasticOperations: 0, timeoutSeconds: 300,
      sourceHashAndMtime: 'before and after', inputIsolation: 'content-addressed byte snapshots',
      candidateGold: false, oldReportSubtraction: false,
      pairedBInput: 'same freshly enriched saved parse, shared before both arms'},
    engineeringMetrics: ['source object and raw payload retention', 'locator/source binding',
      'representation inventory', 'component elapsedMs', 'serialized bytes', 'repeatability'],
    quality: {CER: null, WER: null, LayoutF1: null, ReadingOrder: null,
      ObjectRecall: null, LocatorAccuracy: null,
      reason: 'No independent complete same-source scientific gold; outputs are observations only'},
    failurePolicy: 'Keep all rows and failures per arm/repeat; unknown object denominators stay null',
    acceptance: 'Complete source denominator, immutable inputs, actual component paths, independent raw readback. No scientific-quality or resource-superiority claim.',
    limits: ['A is unavailable as a paired experiment: current production has no off switch.',
      '91-row legacy cohort lacks saved per-item native geometry; fresh PDF readback cannot retrofit it.',
      'Native supplement is two original PDFs, first two pages, two historical input captures.',
      'B compares current production block IR and current v2 on identical saved parses, not historical whole-system Baseline.',
      'Only conversion/publish/read timings are measured; no parser, OCR, retrieval or answer benchmark.']};
  write(protocolPath, protocol);
  console.log(JSON.stringify({status: 'prelocked', rows: rows.length, nativeRows: nativeRows.length,
    inputs: protocol.inputs.length, protocolSha256: sha(readFileSync(protocolPath))}));
} else {
  const protocolBytes = readFileSync(protocolPath), protocolHash = sha(protocolBytes);
  const protocol = JSON.parse(protocolBytes);
  function checkOriginals() {
    for (const pin of protocol.inputs) {
      assert.equal(sha(readFileSync(pin.path)), pin.sha256, pin.path);
      assert.equal(statSync(pin.path, {bigint: true}).mtimeNs.toString(), pin.mtimeNs, pin.path);
      assert.equal(sha(readFileSync(join(root, pin.snapshot))), pin.sha256, pin.snapshot);
    }
    assert.equal(sha(readFileSync(protocolPath)), protocolHash);
  }
  const saved = pin => json(join(root, pin.snapshot));
  checkOriginals();
  if (mode === '--raw-source') {
    // This mode imports no production module. PDF.js rereads original PDF bytes;
    // raw items/styles are saved verbatim, separately from projected parser items.
    const {getDocument} = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const unique = new Map();
    for (const row of protocol.nativeRows) unique.set(`${row.sourceHash}:${row.page}`, row);
    const rows = [];
    for (const row of unique.values()) {
      const bytes = readFileSync(row.original.path);
      assert.equal(sha(bytes), row.sourceHash);
      const loading = getDocument({data: new Uint8Array(bytes), useSystemFonts: true,
        isEvalSupported: false, verbosity: 0});
      try {
        const pdf = await loading.promise, page = await pdf.getPage(row.page);
        const content = await page.getTextContent();
        const raw = write(join(root, 'raw-source', `${row.sourceHash}-${row.page}.json`),
          {sourceHash: row.sourceHash, page: row.page, pdfPageCount: pdf.numPages,
            view: page.view, rotate: page.rotate, userUnit: page.userUnit, content});
        rows.push({sourceHash: row.sourceHash, page: row.page, raw});
        page.cleanup();
      } finally {await loading.destroy();}
    }
    checkOriginals();
    write(join(root, 'raw-source.json'), {protocolHash, command: process.argv, rows,
      productionImports: [], ocrCalls: 0, networkCalls: 0});
    console.log(JSON.stringify({status: 'raw-source-readback', pages: rows.length}));
  } else {
    const rawReadback = json(join(root, 'raw-source.json'));
    assert.equal(rawReadback.protocolHash, protocolHash);
    // All compiled outputs stay in the authorized artifact directory. The
    // existing production source is bundled unchanged with installed packages.
    const modules = [];
    for (const [index, entry] of entries.entries()) {
      const compiled = await build({entryPoints: [entry], bundle: true, write: false, format: 'esm',
        platform: 'node', packages: 'external', target: 'node22', logLevel: 'silent'});
      const path = join(root, 'compiled', `${index}.mjs`);
      mkdirSync(dirname(path), {recursive: true});
      writeFileSync(path, compiled.outputFiles[0].contents, {flag: 'wx'});
      modules.push(await import(pathToFileURL(path).href));
    }
    const [legacy, builder, repository, tables, equations, visuals, quality, fusion] = modules;
    const trials = [];
    const stable = [];
    for (let repeat = 0; repeat < protocol.repeats; repeat++) {
      const trial = {repeat, B: [], A: []};
      for (const row of protocol.rows) {
        const dir = join(root, `trial-${repeat}`, `row-${row.ordinal}`);
        const record = {ordinal: row.ordinal, sourceHash: row.sourceHash, status: row.status,
          failure: row.failure, content: null, preparationFailure: null, arms: {}};
        let content = null;
        if (row.status === 'parsed') {
          try {
            const parsed = saved(row.parsed), structured = saved(row.structured);
            const blocks = visuals.attachPaperVisuals(equations.attachPaperEquations(
              tables.attachPaperTables(parsed.blocks, structured.pages), structured.pages));
            content = {...parsed, blocks, quality: quality.assessPdfQuality({pages: structured.pages, blocks})};
            record.content = write(join(dir, 'shared-content.json'), content);
          } catch (error) {record.preparationFailure = {code: error.code ?? error.message, message: error.message};}
        }
        const identity = {paperId: row.paperId, documentId: row.paperId, knowledgeDocumentId: row.paperId,
          parseId: `paired:${row.cohort}:${row.index}`, sourceHash: row.sourceHash,
          parserFingerprint: content?.parserFingerprint};
        for (const arm of (repeat % 2 ? ['paperIRv2', 'blockIR'] : ['blockIR', 'paperIRv2'])) {
          if (!content) {
            record.arms[arm] = {status: 'failed', failure: record.preparationFailure ?? row.failure,
              output: null, objectDenominator: null}; continue;
          }
          const start = performance.now();
          let result = null, receipt = null, failure = null;
          try {
            if (arm === 'blockIR') result = legacy.paperBlocks(content.blocks, identity, content.structure);
            else {
              result = builder.buildPaperIR({identity, content});
              const store = new repository.PaperIRRepository(dir);
              receipt = await store.publish(result);
              assert.deepEqual(await new repository.PaperIRRepository(dir).read(receipt, identity), result);
            }
          } catch (error) {failure = {code: error.code ?? error.message, message: error.message};}
          const elapsedMs = performance.now() - start;
          record.arms[arm] = {status: failure ? 'failed' : 'converted', failure, elapsedMs,
            receipt, output: result ? write(join(dir, `${arm}.json`), result) : null};
        }
        trial.B.push(record);
        if (row.ordinal % 20 === 0) console.error(`repeat ${repeat + 1} B ${row.ordinal + 1}/91`);
      }
      for (const row of protocol.nativeRows) {
        const structured = saved(row.structured);
        const page = structured.pages.find(p => p.page === row.page);
        // Pre-fusion blocks are reconstructed only from original region fields.
        // Fused blocks are never used as the original OCR input.
        const kind = type => type === 'table' ? 'table' : ['formula', 'equation'].includes(type) ? 'formula'
          : ['figure', 'image', 'chart'].includes(type) ? 'figure'
          : ['title', 'doc_title', 'paragraph_title'].includes(type) ? 'heading' : 'paragraph';
        const clean = text => text.replace(/\u0000/gu, '').replace(/[ \t]+/gu, ' ')
          .replace(/\n{3,}/gu, '\n\n').trim();
        const regions = page.regions.map(region => ({score: Number.isFinite(region.score) ? region.score : null,
          block: {id: region.id, kind: kind(region.type), label: region.label?.trim() || kind(region.type),
            text: clean(region.text), locator: `page ${row.page}`, imagePath: region.imagePath,
            locations: [{page: row.page, bbox: region.bbox, coordinateOrigin: 'TOPLEFT'}]}}));
        const input = {page: row.page, width: page.coordinateFrame.width,
          nativeItems: page.nativeTextItems, regions};
        const inputArtifact = write(join(root, `trial-${repeat}`, `native-${row.ordinal}-input.json`), input);
        const start = performance.now();
        let result = null, failure = null;
        try {result = fusion.fusePdfPage(input);}
        catch (error) {failure = {code: error.code ?? error.message, message: error.message};}
        const elapsedMs = performance.now() - start;
        trial.A.push({ordinal: row.ordinal, sourceHash: row.sourceHash, page: row.page, input: inputArtifact,
          current: {status: failure ? 'failed' : 'fused', failure, elapsedMs,
            output: result ? write(join(root, `trial-${repeat}`, `native-${row.ordinal}-current.json`), result) : null},
          fusionOff: {status: 'unavailable', reason: 'production_fusion_off_switch_absent', output: null}});
      }
      trials.push(write(join(root, `trial-${repeat}`, 'observations.json'), trial));
      stable.push(sha(JSON.stringify({B: trial.B.map(r => ({ordinal: r.ordinal, status: r.status,
        failure: r.failure, preparationFailure: r.preparationFailure, content: r.content?.sha256,
        arms: Object.fromEntries(Object.entries(r.arms).sort(([a], [b]) => a.localeCompare(b)).map(([name, a]) =>
          [name, {status: a.status, failure: a.failure, hash: a.output?.sha256}]))})),
      A: trial.A.map(r => ({ordinal: r.ordinal, current: r.current.output?.sha256, failure: r.current.failure}))})));
    }
    assert.ok(stable.every(h => h === stable[0]), 'repeat drift');
    checkOriginals();
    write(join(root, 'report.json'), {version: 1, kind: protocol.kind, protocolHash, command: process.argv,
      completedAt: new Date().toISOString(), trials, deterministicHashes: stable,
      rawSource: {path: 'raw-source.json', sha256: sha(readFileSync(join(root, 'raw-source.json')))},
      A: {status: 'unavailable_as_paired_ablation', primaryRows: 91, retainedOriginalFailures: 2,
        supplementalInputCaptures: 8, uniqueOriginalPages: 4, reason: 'production_fusion_off_switch_absent'},
      B: {status: 'executed_engineering_only', selectedRows: 91, repeats: 3},
      scientificQuality: protocol.quality, fullSystemBenefitEstablished: false});
    console.log(JSON.stringify({status: 'executed-engineering-only', rows: 91, repeats: 3,
      A: 'unavailable-as-paired-ablation', report: join(root, 'report.json')}));
  }
}
