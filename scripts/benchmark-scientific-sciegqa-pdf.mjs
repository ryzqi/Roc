import {existsSync, lstatSync, mkdirSync, readFileSync, readdirSync} from 'node:fs';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {importTypeScriptModule} from './lib/bundle-ts.mjs';
import {directory, hash, readJson, ROOT, sha256, writeJson} from '../evaluation/lib/common.mjs';
import {loadSciegqaPdfCohort, sciegqaCorpusRoot} from '../evaluation/adapters/scientific-public/sciegqa-pdf.mjs';
import {publicPdfArtifactPath} from '../evaluation/adapters/scientific-public/pdf.mjs';

function artifactHashes(root, path = '') {
  return readdirSync(join(root, path), {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => entry.isDirectory() ? artifactHashes(root, join(path, entry.name))
      : [{path: join(path, entry.name),
        sha256: sha256(readFileSync(publicPdfArtifactPath(root, join(path, entry.name))))}]);
}

export async function benchmarkSciegqaPdf(outputParent) {
  outputParent = resolve(outputParent);
  const contains = (parent, child) => {
    const rel = relative(parent, child);
    return !rel || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  if (contains(sciegqaCorpusRoot, outputParent) || contains(outputParent, sciegqaCorpusRoot)) {
    throw new Error('scientific_sciegqa_pdf_output_overlaps_input');
  }
  for (let current = outputParent;; current = resolve(current, '..')) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error('scientific_sciegqa_pdf_output_link');
    }
    if (resolve(current, '..') === current) break;
  }
  const source = loadSciegqaPdfCohort(), pins = source.cohort.papers.map(p => p.pdf);
  const packages = readJson(join(ROOT, 'package.json'));
  const external = [...Object.keys(packages.dependencies), ...Object.keys(packages.devDependencies),
    'pdfjs-dist/legacy/build/pdf.mjs'];
  const entries = ['src/main/plugins/research/document-parser.ts', 'src/main/plugins/research/model-store.ts'];
  const compiled = await build({entryPoints: entries.map(path => join(ROOT, path)), bundle: true,
    outdir: 'scientific-evaluation-in-memory', format: 'esm', target: 'node22',
    platform: 'node', external, write: false, metafile: true, logLevel: 'silent'});
  const codePaths = [...new Set(['scripts/benchmark-scientific-sciegqa-pdf.mjs',
    'scripts/lib/bundle-ts.mjs', 'scripts/prepare-scientific-sciegqa.py',
    'scripts/prepare-scientific-sciegqa-sources.py',
    'evaluation/adapters/scientific-public/sciegqa-pdf.mjs',
    'evaluation/adapters/scientific-public/sciegqa-cohort.mjs',
    'evaluation/adapters/scientific-public/pdf.mjs', 'evaluation/lib/common.mjs',
    'package.json', 'pnpm-lock.yaml', ...Object.keys(compiled.metafile.inputs)])].sort();
  const codeHashes = Object.fromEntries(codePaths.map(path => [path, sha256(readFileSync(join(ROOT, path)))]));
  const options = {platform: 'node', external, tempDir: join(ROOT, 'evaluation/.runtime/imports')};
  const [{parseResearchDocument}, {ResearchModelStore}] = await Promise.all(entries.map(path =>
    importTypeScriptModule(join(ROOT, path), options)));
  const models = new ResearchModelStore(join(ROOT, '.runtime/research-models'));
  const lease = await models.requireReady('complete'), rows = [];
  let root;
  try {
    root = directory(outputParent, 'sciegqa-pdf');
    const parserOptions = {tier: 'complete', device: 'cpu', pageRange: ''};
    const modelHashes = Object.fromEntries(Object.entries(lease.files).filter(([, path]) => path)
      .map(([key, path]) => [key, {path: relative(ROOT, path), sha256: sha256(readFileSync(path))}]));
    writeJson(join(root, 'inputs.json'), {sourceLockHash: source.cohort.sourceLockHash,
      cohortHash: source.cohortHash, manifestHash: source.manifestHash, pins,
      modelHashes, modelManifest: lease.manifest, parserOptions, codeHashes,
      compiledBundleHashes: compiled.outputFiles.map(file => ({name: file.path.split('/').at(-1),
        sha256: sha256(file.contents)}))});
    for (const [i, pin] of pins.entries()) {
      const paperId = source.cohort.papers[i].docName, outputDir = join(root, `paper-${i}/output`);
      const started = performance.now(), stages = [];
      let peakRssBytes = process.memoryUsage().rss, parsed = null, failure = null;
      const sample = () => {peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);};
      const timer = setInterval(sample, 20);
      try {
        parsed = await parseResearchDocument({projectRoot: ROOT,
          sourcePath: publicPdfArtifactPath(sciegqaCorpusRoot, pin.path), outputDir,
          modelFiles: lease.files, modelManifest: lease.manifest, options: parserOptions,
          signal: AbortSignal.timeout(600_000), onStage: event => {
            sample(); stages.push(event);
            if (event.stage === 'native-text') console.error(`SciEGQA PDF ${i + 1}/45 ${paperId}, page ${event.page}`);
          }});
      } catch (error) {
        failure = {code: error?.code ?? error?.message ?? String(error),
          message: error?.message ?? String(error)};
      }
      finally {clearInterval(timer); sample();}
      if (parsed && (parsed.sourceHash !== pin.sha256 || parsed.device !== 'cpu'
        || ![lease.manifest, ''].includes(parsed.modelManifest)
        || (parsed.modelManifest === '' && parsed.parseMode !== 'native-text'))) {
        throw new Error('scientific_sciegqa_pdf_source_invalid');
      }
      mkdirSync(join(root, `paper-${i}`), {recursive: true});
      const artifacts = existsSync(outputDir) ? artifactHashes(outputDir) : [];
      if (parsed) writeJson(join(root, `paper-${i}/result.json`), parsed);
      const row = {paperId, datasetPaperId: source.cohort.papers[i].id,
        source: pin.path, sourceHash: pin.sha256, status: parsed ? 'parsed' : 'failed', failure,
        elapsedMs: performance.now() - started, peakRssBytes, pageCount: parsed?.pageCount ?? null,
        parseMode: parsed?.parseMode ?? null, blocks: parsed?.blocks.length ?? null,
        parserFingerprint: parsed?.parserFingerprint ?? null, modelManifest: lease.manifest,
        result: parsed ? `paper-${i}/result.json` : null,
        structured: parsed ? `paper-${i}/output/${parsed.artifacts.structuredContent}` : null,
        artifactsHash: hash(artifacts), artifacts, stages};
      writeJson(join(root, `paper-${i}/receipt.json`), row); rows.push(row);
      console.error(`Processed SciEGQA PDF ${i + 1}/45: ${paperId} ${row.status}, ${row.elapsedMs.toFixed(0)} ms`);
    }
    const report = {schemaVersion: 1, kind: 'scientific-sciegqa-full-pdf-parser-component-run',
      status: 'processed-unscored', root, workingDirectory: ROOT, command: process.argv,
      nodeVersion: process.version, measuredAt: new Date().toISOString(),
      sourceLockHash: source.cohort.sourceLockHash, cohortHash: source.cohortHash,
      codeHashes, modelHashes, modelManifest: lease.manifest, parserOptions,
      papers: rows.length, questions: source.cohort.questionCount, cohortComplete: true,
      failedPapers: rows.filter(row => row.status === 'failed').length, rows, scientificBaselineReady: false};
    writeJson(join(root, 'run.json'), report);
    return report;
  } catch (error) {
    if (root) writeJson(join(root, 'failure.json'), {status: 'failed', code: error?.code ?? error?.message ?? String(error),
      root, completedPapers: rows.length});
    throw error;
  } finally {models.release(lease.pack);}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/benchmark-scientific-sciegqa-pdf.mjs OUTPUT_PARENT');
  benchmarkSciegqaPdf(process.argv[2]).then(run => console.log(JSON.stringify({
    root: run.root, papers: run.papers, failedPapers: run.failedPapers, status: run.status
  }, null, 2))).catch(error => {console.error(error.stack); process.exitCode = 1;});
}
