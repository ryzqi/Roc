import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importTypeScriptModule } from './lib/bundle-ts.mjs';
import { directory, hash, readJson, ROOT, sha256, writeJson } from '../evaluation/lib/common.mjs';
import { defaultPublicScientificRoot, publicScientificSourceLock,
  verifyPublicScientificSources } from '../evaluation/adapters/scientific-public/sources.mjs';

function artifacts(root, path = '') {
  return readdirSync(join(root, path), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => entry.isDirectory() ? artifacts(root, join(path, entry.name))
      : [{ path: join(path, entry.name), sha256: sha256(readFileSync(join(root, path, entry.name))) }]);
}

/** Exercise the unchanged production parser and real pinned CPU models.
 * Raw gold is never supplied to the parser. Scoring is a separate host step. */
export async function benchmarkScientificPublicParser(outputRoot, { limit = null } = {}) {
  const sources = verifyPublicScientificSources();
  const lock = readJson(publicScientificSourceLock);
  const imagePins = lock.files.filter(file => file.path.startsWith('omnidocbench/images/'));
  const pins = limit === null ? imagePins : imagePins.slice(0, limit);
  if (!pins.length || (limit !== null && (!Number.isInteger(limit) || limit <= 0))) {
    throw new Error('scientific_public_parser_limit_invalid');
  }
  const packages = readJson(join(ROOT, 'package.json'));
  const options = { platform: 'node', external: [...Object.keys(packages.dependencies),
    ...Object.keys(packages.devDependencies), 'pdfjs-dist/legacy/build/pdf.mjs'],
  tempDir: join(ROOT, 'evaluation/.runtime/imports') };
  const [{ parseResearchDocument }, { ResearchModelStore }] = await Promise.all([
    importTypeScriptModule(join(ROOT, 'src/main/plugins/research/document-parser.ts'), options),
    importTypeScriptModule(join(ROOT, 'src/main/plugins/research/model-store.ts'), options)
  ]);
  const models = new ResearchModelStore(resolve(ROOT, '.runtime/research-models'));
  const lease = await models.requireReady('compact');
  const root = directory(resolve(outputRoot), 'public-parser');
  const rows = [], parserOptions = { tier: 'compact', device: 'cpu', pageRange: '1' };
  const modelHashes = Object.fromEntries(Object.entries(lease.files).filter(([, path]) => path)
    .map(([key, path]) => [key, { path: relative(ROOT, path), sha256: sha256(readFileSync(path)) }]));
  writeJson(join(root, 'inputs.json'), { sourceLockHash: sources.sourceLockHash, pins, modelHashes,
    modelManifest: lease.manifest, parserOptions });
  try {
    for (const [i, pin] of pins.entries()) {
      const outputDir = join(root, `page-${i}`, 'output');
      const stages = [], started = performance.now();
      let peakRssBytes = process.memoryUsage().rss;
      const sample = () => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); };
      const timer = setInterval(sample, 20);
      let parsed = null, failure = null;
      try {
        parsed = await parseResearchDocument({ projectRoot: ROOT,
          sourcePath: join(defaultPublicScientificRoot, pin.path), outputDir,
          modelFiles: lease.files, modelManifest: lease.manifest, options: parserOptions,
          signal: AbortSignal.timeout(600_000), onStage: event => { sample(); stages.push(event); } });
      } catch (error) {
        failure = { code: error.code ?? error.message, message: error.message };
      } finally { clearInterval(timer); sample(); }
      if (parsed && (parsed.sourceHash !== pin.sha256 || parsed.pageCount !== 1 || parsed.device !== 'cpu')) {
        throw new Error('scientific_public_parser_source_invalid');
      }
      mkdirSync(join(root, `page-${i}`), { recursive: true });
      const files = existsSync(outputDir) ? artifacts(outputDir) : [];
      if (parsed) writeJson(join(root, `page-${i}`, 'result.json'), parsed);
      const row = { image: pin.path, sourceHash: pin.sha256, elapsedMs: performance.now() - started,
        peakRssBytes, status: parsed ? 'parsed' : 'failed', failure,
        parserFingerprint: parsed?.parserFingerprint ?? null, modelManifest: lease.manifest,
        parseMode: parsed?.parseMode ?? null, blocks: parsed?.blocks.length ?? null,
        result: parsed ? `page-${i}/result.json` : null,
        structured: parsed ? `page-${i}/output/${parsed.artifacts.structuredContent}` : null,
        artifactsHash: hash(files), artifacts: files, stages };
      writeJson(join(root, `page-${i}`, 'receipt.json'), row);
      rows.push(row);
      console.error(`Processed actual public page ${i + 1}/${pins.length}: ${row.status}, ${row.elapsedMs.toFixed(0)} ms${failure ? `, ${failure.code}` : ''}`);
    }
    const report = { schemaVersion: 1, kind: 'scientific-public-raster-parser-component-run',
      status: 'processed-unscored', root, workingDirectory: ROOT, command: process.argv,
      nodeVersion: process.version, measuredAt: new Date().toISOString(),
      sourceLockHash: sources.sourceLockHash, modelHashes, modelManifest: lease.manifest,
      parserOptions, pages: rows.length, failedPages: rows.filter(row => row.status === 'failed').length,
      cohortComplete: rows.length === imagePins.length,
      codeHashes: Object.fromEntries(['scripts/benchmark-scientific-public-parser.mjs',
        'src/main/plugins/research/document-parser.ts', 'src/main/plugins/research/model-store.ts',
        'src/main/plugins/research/model-catalog.ts', 'pnpm-lock.yaml']
        .map(path => [path, sha256(readFileSync(join(ROOT, path)))])),
      rows, scientificBaselineReady: false,
      limitations: ['Real public raster pages, not complete original PDF documents.',
        'Published assisted/human annotations have not yet been scored.',
        'Production image path does not emit PDF stage observations.',
        'RSS sampled in one sequential process; per-page peaks include retained runtime memory.'] };
    writeJson(join(root, 'run.json'), report);
    return report;
  } catch (error) {
    writeJson(join(root, 'failure.json'), { status: 'failed', code: error.code ?? error.message,
      root, completedPages: rows.length });
    throw error;
  } finally { models.release(lease.pack); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [output, limit] = process.argv.slice(2);
  if (!output) throw new Error('Usage: node scripts/benchmark-scientific-public-parser.mjs OUTPUT_PARENT [LIMIT]');
  mkdirSync(resolve(output), { recursive: true });
  benchmarkScientificPublicParser(resolve(output), { limit: limit === undefined ? null : Number(limit) })
    .then(report => console.log(JSON.stringify({ root: report.root, pages: report.pages, status: report.status })))
    .catch(error => { console.error(error.stack); process.exitCode = 1; });
}
