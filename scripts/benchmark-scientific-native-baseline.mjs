import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, extname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {fileInventory, hash, ROOT, sha256, writeJson} from '../evaluation/lib/common.mjs';

const options = {tier: 'compact', device: 'cpu', pageRange: ''};
const entry = 'src/main/plugins/research/document-parser.ts';
const ownPath = 'scripts/benchmark-scientific-native-baseline.mjs';
// document-parser.ts applies this same source limit before native parsing.
// It is private there; this runner also bounds every streaming hash read.
const maxSourceBytes = 512 * 1024 * 1024;

function inside(root, path) {
  const name = relative(root, path);
  return name !== '' && name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name);
}

async function sourceDigest(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('scientific_native_pdf_required');
  if (stat.size > maxSourceBytes) throw new Error('research_source_too_large');
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path, {highWaterMark: 1024 * 1024})) {
    bytes += chunk.length;
    if (bytes > maxSourceBytes) throw new Error('research_source_too_large');
    digest.update(chunk);
  }
  return {sha256: digest.digest('hex'), bytes};
}

/** Hash exactly the bytes esbuild consumes, then fence every captured input before execution. */
export async function buildScientificNativeSnapshot({root, entryPoints, external, auxiliaryPaths}) {
  const codeHashes = Object.fromEntries(auxiliaryPaths.map(path => [path, sha256(readFileSync(join(root, path)))]));
  const loaders = {'.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx',
    '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.json': 'json'};
  const compiled = await build({absWorkingDir: root, entryPoints: entryPoints.map(path => join(root, path)), bundle: true,
    format: 'esm', platform: 'node', target: 'node22', external, write: false, metafile: true, logLevel: 'silent',
    plugins: [{name: 'scientific-native-source-snapshot', setup(builder) {
      builder.onLoad({filter: /./, namespace: 'file'}, args => {
        const loader = loaders[extname(args.path)];
        if (!loader) throw new Error('scientific_native_source_loader_unsupported');
        const bytes = readFileSync(args.path), path = relative(root, args.path), digest = sha256(bytes);
        if (codeHashes[path] && codeHashes[path] !== digest) throw new Error('scientific_native_code_changed');
        codeHashes[path] = digest;
        return {contents: bytes, loader, resolveDir: dirname(args.path)};
      });
    }}]});
  for (const path of Object.keys(compiled.metafile.inputs)) {
    if (!codeHashes[path]) throw new Error('scientific_native_source_not_captured');
  }
  const paths = Object.keys(codeHashes).sort();
  if (paths.some(path => sha256(readFileSync(join(root, path))) !== codeHashes[path])) {
    throw new Error('scientific_native_code_changed');
  }
  return {compiled, codePaths: paths, codeHashes: Object.fromEntries(paths.map(path => [path, codeHashes[path]]))};
}

/** Observe one hash-pinned original PDF through the production native parser.
 * No provider/model, scientific scores or implicit acceptance of external gold. */
export async function benchmarkScientificNativeBaseline({source, sourceHash, output}) {
  const root = realpathSync(ROOT), sourcePath = resolve(root, source), outputRoot = resolve(root, output);
  if (!/^[a-f0-9]{64}$/u.test(sourceHash)) throw new Error('scientific_native_source_hash_required');
  if (!inside(root, sourcePath) || !inside(root, outputRoot) || inside(outputRoot, sourcePath)
    || sourcePath === outputRoot) throw new Error('scientific_native_path_invalid');
  for (const path of [sourcePath, outputRoot]) {
    for (let current = path; current !== root; current = dirname(current)) {
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('scientific_native_path_link');
    }
  }
  if (existsSync(outputRoot)) throw new Error('scientific_native_output_exists');
  if (!sourcePath.toLowerCase().endsWith('.pdf') || !lstatSync(sourcePath).isFile()) {
    throw new Error('scientific_native_pdf_required');
  }
  const sourceIdentity = await sourceDigest(sourcePath);
  if (sourceIdentity.sha256 !== sourceHash) throw new Error('scientific_native_source_changed');
  const packageBytes = readFileSync(join(root, 'package.json'));
  const packages = JSON.parse(packageBytes.toString('utf8'));
  const external = [...Object.keys(packages.dependencies), ...Object.keys(packages.devDependencies),
    'pdfjs-dist/legacy/build/pdf.mjs'];
  const {compiled, codePaths, codeHashes} = await buildScientificNativeSnapshot({root, entryPoints: [entry], external,
    auxiliaryPaths: [ownPath, 'evaluation/lib/common.mjs', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json']});
  if (codeHashes['package.json'] !== sha256(packageBytes)) throw new Error('scientific_native_code_changed');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--', ...codePaths],
    {cwd: root, encoding: 'utf8'}).trim() !== '';
  mkdirSync(dirname(outputRoot), {recursive: true, mode: 0o700});
  mkdirSync(outputRoot, {mode: 0o700});
  const bundle = join(outputRoot, 'runtime.mjs'), outputDir = join(outputRoot, 'parsed');
  writeFileSync(bundle, compiled.outputFiles[0].contents, {flag: 'wx', mode: 0o600});
  const started = performance.now(), stages = [];
  let parsed = null, failure = null;
  try {
    const {parseResearchDocument} = await import(pathToFileURL(bundle).href);
    parsed = await parseResearchDocument({projectRoot: root, sourcePath, outputDir,
      modelFiles: null, modelManifest: '', options, timeoutMs: 60_000,
      signal: AbortSignal.timeout(65_000), onStage: event => stages.push(event)});
    assert.equal(parsed.sourceHash, sourceHash);
    assert.equal(parsed.parseMode, 'native-text');
    assert.equal(parsed.modelManifest, '');
    const currentSource = await sourceDigest(sourcePath);
    if (currentSource.sha256 !== sourceHash || currentSource.bytes !== sourceIdentity.bytes) {
      throw new Error('scientific_native_source_changed');
    }
    if (codePaths.some(path => sha256(readFileSync(join(root, path))) !== codeHashes[path])) {
      throw new Error('scientific_native_code_changed');
    }
    writeJson(join(outputRoot, 'result.json'), parsed);
  } catch (error) {
    failure = {code: error?.code ?? error?.message ?? String(error), message: error?.message ?? String(error)};
    parsed = null;
    // This invocation created the output directory; failed artifacts are never a usable parse.
    rmSync(outputDir, {recursive: true, force: true});
  } finally {
    rmSync(bundle, {force: true});
  }
  const report = {schemaVersion: 1, kind: 'scientific-native-pdf-component-baseline',
    status: failure ? 'failed' : 'processed-unscored', measuredAt: new Date().toISOString(),
    workingDirectory: '.', command: ['node', ownPath, relative(root, sourcePath), sourceHash, relative(root, outputRoot)],
    source: {path: relative(root, sourcePath), sha256: sourceHash, bytes: sourceIdentity.bytes},
    code: {revision, dirty, hashes: codeHashes, sourceHash: hash(codeHashes),
      bundleHash: sha256(compiled.outputFiles[0].contents)},
    runtime: {nodeVersion: process.version, platform: process.platform, arch: process.arch},
    configuration: {options, modelFiles: null, modelManifest: '', timeoutMs: 60_000},
    configurationHash: hash({options, modelFiles: null, modelManifest: '', timeoutMs: 60_000}),
    providerCalls: 0, ocrModelCalls: 0, elapsedMs: performance.now() - started,
    pageCount: parsed?.pageCount ?? null, blocks: parsed?.blocks.length ?? null,
    contentCharacters: parsed?.content.length ?? null, parseMode: parsed?.parseMode ?? null,
    parserFingerprint: parsed?.parserFingerprint ?? null, warnings: parsed?.warnings ?? [], stages,
    artifacts: fileInventory(outputRoot), failure, qualityMetrics: null, scientificBaselineReady: false,
    limitations: ['One explicitly selected source; no cohort-level quality estimate.',
      'Native text only, without OCR, embeddings, reranker or LLM; no semantic or object recognition score.',
      'Hash identity does not establish source permission, independent gold or scientific validity.',
      'Cooperative timeout includes cleanup and may exceed its nominal duration.']};
  writeJson(join(outputRoot, 'report.json'), report);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5) {
    console.error(`Usage: node ${ownPath} PDF EXPECTED_SHA256 NEW_OUTPUT_DIRECTORY`);
    process.exitCode = 1;
  } else {
    benchmarkScientificNativeBaseline({source: process.argv[2], sourceHash: process.argv[3], output: process.argv[4]})
      .then(report => {
        console.log(JSON.stringify({status: report.status, source: report.source, pageCount: report.pageCount,
          blocks: report.blocks, elapsedMs: report.elapsedMs, failure: report.failure}, null, 2));
        if (report.failure) process.exitCode = 1;
      }).catch(error => {console.error(error.stack); process.exitCode = 1;});
  }
}
