import assert from 'node:assert/strict';
import {fork, execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {copyFile, readFile} from 'node:fs/promises';
import {cpus, totalmem} from 'node:os';
import {dirname, extname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import Database from 'better-sqlite3';
import {load} from 'sqlite-vec';
import {checkScientificRagCorpus} from '../evaluation/lib/scientific-rag-corpus.mjs';

const ownPath = fileURLToPath(import.meta.url), repo = realpathSync(resolve(dirname(ownPath), '..'));
const digest = value => createHash('sha256').update(value).digest('hex');
const hash = value => digest(JSON.stringify(value));
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600});
const inside = (root, path) => {
  const name = relative(root, path);
  return name !== '' && name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name);
};
const assertNoLinks = path => {
  for (let current = path; current !== repo; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('scientific_p5_path_link');
  }
};

async function snapshot(output) {
  const packages = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  const hashes = {}, loaders = {'.ts': 'ts', '.tsx': 'tsx', '.mjs': 'js', '.js': 'js', '.json': 'json', '.md': 'text', '.c': 'text'};
  const compiled = await build({absWorkingDir: repo, entryPoints: ['evaluation/runtime/scientific-p5-api.ts'],
    bundle: true, format: 'esm', platform: 'node', target: 'node22', write: false, logLevel: 'silent',
    external: [...Object.keys(packages.dependencies), ...Object.keys(packages.devDependencies)],
    plugins: [{name: 'scientific-p5-source-snapshot', setup(builder) {
      builder.onLoad({filter: /./, namespace: 'file'}, args => {
        const loader = loaders[extname(args.path)];
        if (!loader) throw new Error('scientific_p5_source_loader_unsupported');
        const bytes = readFileSync(args.path); hashes[relative(repo, args.path)] = digest(bytes);
        return {contents: bytes, loader, resolveDir: dirname(args.path)};
      });
    }}]});
  for (const path of ['scripts/benchmark-scientific-p5.mjs', 'scripts/verify-scientific-p5.mjs', 'package.json', 'pnpm-lock.yaml',
    'evaluation/lib/scientific-rag-corpus.mjs', 'evaluation/lib/common.mjs',
    'evaluation/corpora/scientific-rag/manifest.json', 'evaluation/corpora/scientific-rag/queries/queries.json']) {
    hashes[path] = digest(readFileSync(join(repo, path)));
  }
  const assertCurrent = () => {
    for (const [path, expected] of Object.entries(hashes)) assert.equal(digest(readFileSync(join(repo, path))), expected,
      `scientific_p5_code_changed:${path}`);
  };
  assertCurrent();
  const path = join(output, 'runtime.mjs');
  writeFileSync(path, compiled.outputFiles[0].contents, {flag: 'wx', mode: 0o600});
  return {path, hashes, bundleHash: digest(compiled.outputFiles[0].contents), assertCurrent};
}

async function trial(source, expectedHash, output, bundle, query) {
  const scratch = join(output, 'scratch'); mkdirSync(scratch, {mode: 0o700});
  const controller = new AbortController(), onMessage = message => {
    if (message?.kind === 'cancel') controller.abort(new Error('scientific_p5_cancelled'));
  };
  process.on('message', onMessage);
  const started = performance.now(), rss = [];
  const sample = phase => rss.push({phase, elapsedMs: performance.now() - started, rssBytes: process.memoryUsage().rss});
  const timer = setInterval(() => sample('interval'), 50); timer.unref();
  let db, agentDb, repository, embeddings, failure = null, observation = null, phase = 'startup';
  try {
    const api = await import(pathToFileURL(bundle).href), now = () => new Date().toISOString();
    db = new Database(':memory:'); agentDb = new Database(':memory:');
    db.pragma('foreign_keys=ON'); agentDb.pragma('foreign_keys=ON');
    api.applyResearchDatabaseSchema(db, now); api.applyAgentDatabaseSchema(agentDb); load(db);
    repository = new api.ResearchRepository(db, new api.ResearchTaskRepository(agentDb, now), now);
    const project = repository.createProject({title: 'Original PDF engineering acceptance',
      description: 'Isolated production services without model or gold.', workspacePath: scratch});
    const local = join(scratch, 'source.pdf'); await copyFile(source, local);
    const bytes = await readFile(local); assert.equal(digest(bytes), expectedHash);
    const timestamp = now(), title = 'Hash-pinned original PDF', metadata = {id: 'p5-paper', source: 'local',
      externalId: 'p5-paper', doi: null, title, authors: [], abstract: null, publishedYear: null,
      citationCount: null, url: null, openAccessUrl: null, importedAt: timestamp, updatedAt: timestamp};
    const bibliography = {citationKey: 'p5-source', entryType: 'article', fields: {title}, preambles: [],
      csl: null, title, authors: [], doi: null, publishedYear: null, abstract: null, url: null};
    const document = repository.documents.import({id: 'p5-document', libraryItemId: null, projectId: project.id,
      filename: 'source.pdf', mediaType: 'application/pdf', sourcePath: 'source.pdf', sourceHash: expectedHash,
      size: bytes.length, entry: {metadata, bibliography}}, false).document;
    const parseStarted = performance.now(); phase = 'parse'; sample('parse-start'); process.send?.({kind: 'parse-started'});
    const parsed = await api.parseResearchDocument({projectRoot: scratch, sourcePath: local, outputDir: join(scratch, 'parser'),
      modelFiles: null, modelManifest: '', options: {tier: 'compact', device: 'cpu', pageRange: ''},
      timeoutMs: 60_000, signal: controller.signal});
    assert.equal(parsed.sourceHash, expectedHash); assert.equal(parsed.parseMode, 'native-text'); sample('parse-end');
    phase = 'index';
    const parseMs = performance.now() - parseStarted, indexStarted = performance.now();
    const {data, coordinates} = await api.collectDocumentContent(scratch, join(scratch, 'parser'), parsed, controller.signal);
    const parseId = 'p5-parse'; repository.documents.begin(document.id, parseId);
    const ir = repository.documents.buildPaperIR(document.id, parseId, data);
    data.paperIR = await new api.PaperIRRepository(scratch).publish(ir);
    const generation = repository.scientificIndex.begin({ir, paperIR: data.paperIR, projectId: null,
      source: {kind: 'library'}, embedding: null, policy: {tableTokens: 64}});
    repository.scientificIndex.publish(generation.id, () => ({paperIR: data.paperIR, embedding: null}),
      () => repository.documents.complete(document.id, parseId, data, coordinates));
    let providerCalls = 0;
    embeddings = new api.ResearchEmbeddingService(repository.knowledge, {embed: async () => {
      providerCalls++; throw new Error('scientific_p5_unexpected_provider');
    }}, {secrets: {get: async () => null}, logger: {info() {}, warn() {}, error() {}}});
    const router = new api.ScientificRetrievalRouter(repository, embeddings, {library: scratch, index: null},
      new api.ScholarlyRelationsRepository(db, repository));
    const service = new api.ScientificQueryOrchestrator(router, embeddings);
    const indexMs = performance.now() - indexStarted;
    const request = {projectId: project.id, query, documentIds: [document.id], embeddingConfigId: null,
      rerank: 'none', limit: 10, candidateLimit: 50};
    const queries = []; phase = 'query';
    let first;
    for (const cache of ['first-query', 'repeated-query']) {
      const queryStarted = performance.now(), result = await service.search(request, controller.signal);
      queries.push({cache, elapsedMs: performance.now() - queryStarted, hitCount: result.hits.length,
        sourceRefs: result.sourceRefs.length, receiptId: result.retrievalReceiptId,
        hitHash: hash(result.hits.map(hit => [hit.id, hit.contentHash]))});
      assert.ok(result.hits.length && result.sourceRefs.length, 'original PDF keyword query must recover real sources');
      assert.ok(result.sourceRefs.every(ref => ref.sourceHash === expectedHash && ref.generationId === generation.id));
      assert.equal(result.legacy, null, 'explicit paper scope must not call broad fallback');
      if (!first) {first = result; write(join(output, 'query.json'), result);}
      sample(cache);
    }
    assert.equal(queries[0].hitHash, queries[1].hitHash);
    phase = 'context';
    const search = first.rounds[0], context = await router.readContext({search, candidateIds: [],
      budget: {maxTokens: 8000}}, controller.signal);
    assert.ok(context.evidence.length, 'retrieved sources must survive context reconstruction');
    const evidence = context.evidence.find(item => item.passages.length);
    assert.ok(evidence, 'original text passage must be exposed by the production context');
    const passage = evidence.passages[0];
    const checked = await router.validateEvidence({search, context, statements: [{id: 'original-quote', kind: 'quote',
      evidenceId: evidence.id, sourceLocator: passage.sourceLocator, start: 0, end: passage.text.length, text: passage.text}]}, controller.signal);
    assert.equal(checked.sourceStatus, 'valid'); assert.equal(checked.answerStatus, 'supported');
    const forged = await router.validateEvidence({search, context, statements: [{id: 'forged-quote', kind: 'quote',
      evidenceId: evidence.id, sourceLocator: passage.sourceLocator, start: 0, end: passage.text.length, text: 'invented source quotation'}]}, controller.signal);
    assert.equal(forged.canAnswerAsFacts, false);
    write(join(output, 'context.json'), context); write(join(output, 'evidence.json'), {checked, forged});
    const cancelled = new AbortController(); cancelled.abort(new Error('scientific_p5_query_cancelled'));
    await assert.rejects(service.search(request, cancelled.signal), /scientific_p5_query_cancelled/);
    assert.equal(providerCalls, 0); assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.equal(digest(await readFile(local)), expectedHash); assert.equal(digest(await readFile(source)), expectedHash);
    observation = {parseMode: parsed.parseMode, pageCount: parsed.pageCount, blocks: parsed.blocks.length,
      parseMs, indexMs, irHash: data.paperIR.sha256, irBlocks: ir.blocks.length,
      indexedChunks: repository.scientificIndex.chunks(generation.id, null).length,
      queries, contextObjects: context.evidence.length, contextTokens: context.usage.tokens,
      originalQuoteValidated: true, forgedQuoteRejected: true, preAbortedQueryRejected: true,
      providerCalls, modelTokens: 0};
  } catch (error) {
    failure = {code: error?.code ?? error?.message ?? String(error), message: error?.message ?? String(error), phase};
  } finally {
    clearInterval(timer); process.removeListener('message', onMessage);
    await embeddings?.shutdown();
    if (repository) await Promise.all([repository.knowledgeJobs.shutdown(), repository.paperCards.shutdown(), repository.wiki.shutdown()]);
    db?.close(); agentDb?.close(); rmSync(scratch, {recursive: true, force: true}); sample('closed');
  }
  const report = {schemaVersion: 1, status: failure ? controller.signal.aborted ? 'cancelled' : 'failed' : 'verified-engineering',
    observation, failure, elapsedMs: performance.now() - started, processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
    rss, isolatedScratchRemoved: !existsSync(scratch)};
  write(join(output, 'trial.json'), report);
  if (process.connected) process.disconnect();
  return report;
}

async function child(source, sourceHash, output, bundle, query, cancel) {
  mkdirSync(output, {mode: 0o700});
  const started = performance.now(); let cancelSent = false, timedOut = false;
  const worker = fork(ownPath, ['--worker', source, sourceHash, output, bundle, query], {
    cwd: repo, env: {...process.env, LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false'},
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
  let diagnostics = '';
  for (const stream of [worker.stdout, worker.stderr]) stream.on('data', bytes => {
    diagnostics = (diagnostics + bytes.toString()).slice(-16000);
  });
  worker.on('message', message => {
    if (cancel && message?.kind === 'parse-started') {cancelSent = true; worker.send({kind: 'cancel'});}
  });
  const timeout = setTimeout(() => {timedOut = true; worker.kill('SIGKILL');}, 120_000);
  const exit = await new Promise((resolve, reject) => {
    worker.once('error', reject); worker.once('exit', (code, signal) => resolve({code, signal}));
  }).finally(() => {
    clearTimeout(timeout);
    // This path belongs solely to this trial; spawn failure or a killed worker leaves no parser outputs.
    rmSync(join(output, 'scratch'), {recursive: true, force: true});
  });
  const reportPath = join(output, 'trial.json');
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
  const outcome = {exit, timedOut, cancelSent, wallMs: performance.now() - started, report, diagnostics,
    childExited: worker.exitCode !== null || worker.signalCode !== null, scratchRemoved: !existsSync(join(output, 'scratch'))};
  write(join(output, 'process.json'), outcome);
  return outcome;
}

async function main(sourceArgument, sourceHash, outputArgument, query = 'data science') {
  const source = resolve(repo, sourceArgument), output = resolve(repo, outputArgument);
  if (!inside(repo, source) || !inside(repo, output) || inside(output, source) || source === output) throw new Error('scientific_p5_path_invalid');
  assertNoLinks(source); assertNoLinks(output);
  assert.match(sourceHash, /^[a-f0-9]{64}$/u);
  assert.ok(source.toLowerCase().endsWith('.pdf') && lstatSync(source).isFile());
  assert.ok(lstatSync(source).size <= 512 * 1024 * 1024, 'scientific_p5_source_too_large');
  assert.equal(digest(readFileSync(source)), sourceHash);
  assert.ok(!existsSync(output), 'scientific_p5_output_exists');
  mkdirSync(dirname(output), {recursive: true}); mkdirSync(output, {mode: 0o700});
  const compiled = await snapshot(output), command = ['node', relative(repo, ownPath), sourceArgument, sourceHash, outputArgument, query];
  try {
    const normal = await child(source, sourceHash, join(output, 'production-e2e'), compiled.path, query, false);
    const cancelled = await child(source, sourceHash, join(output, 'cancelled-parse'), compiled.path, query, true);
    const corpus = await checkScientificRagCorpus(join(repo, 'evaluation/corpora/scientific-rag/manifest.json'));
    write(join(output, 'corpus-readiness.json'), corpus); compiled.assertCurrent();
    assert.equal(digest(readFileSync(source)), sourceHash);
    const engineeringPassed = normal.report?.status === 'verified-engineering' && normal.exit.code === 0 &&
      cancelled.report?.status === 'cancelled' && cancelled.report.failure?.phase === 'parse' &&
      cancelled.report.failure?.code === 'research_process_cancelled' && cancelled.exit.code === 0 && cancelled.cancelSent &&
      [normal, cancelled].every(row => row.childExited && row.scratchRemoved && row.report?.isolatedScratchRemoved && !row.timedOut);
    const report = {schemaVersion: 1, kind: 'scientific-p5-original-pdf-engineering', measuredAt: new Date().toISOString(),
      status: engineeringPassed ? 'verified-engineering-quality-pending' : 'failed', command, workingDirectory: '.',
      source: {path: relative(repo, source), sha256: sourceHash, bytes: lstatSync(source).size},
      artifactHashes: Object.fromEntries(['production-e2e/trial.json', 'production-e2e/process.json', 'production-e2e/query.json',
        'production-e2e/context.json', 'production-e2e/evidence.json', 'cancelled-parse/trial.json',
        'cancelled-parse/process.json', 'corpus-readiness.json'].filter(path => existsSync(join(output, path)))
        .map(path => [path, digest(readFileSync(join(output, path)))])),
      code: {revision: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repo, encoding: 'utf8'}).trim(),
        hashes: compiled.hashes, bundleHash: compiled.bundleHash},
      hardware: {platform: process.platform, arch: process.arch, node: process.version,
        cpu: cpus()[0]?.model ?? null, logicalCpus: cpus().length, totalMemoryBytes: totalmem()},
      observation: normal.report?.observation ?? null,
      resource: {processPeakRssBytes: normal.report?.processPeakRssBytes ?? null,
        cancellationWallMs: cancelled.wallMs, cancelledChildExited: cancelled.childExited,
        scratchRemoved: normal.scratchRemoved && cancelled.scratchRemoved},
      corpusReady: corpus.corpusReady, scientificQualityMetrics: null, releaseAccepted: false,
      pending: ['Independent reviewed frozen scientific gold and real model configuration.',
        'Twenty-paper synthesis, full Agent writing/revision, and semantic support judgments.',
        'OCR, embedding, reranker and generation model load/unload, sustained resource trials.'],
      limitations: ['One original native-text PDF; exact-source engineering evidence is not semantic quality.',
        'First/repeated queries share a process; neither clears operating-system caches.',
        'Peak RSS is the entire child process including bundled services and SQLite; 50ms samples can miss brief peaks.',
        'Controlled IPC cancels a real native parser; no external model process is started.',
        'Temporary PDF copies, parser artifacts, IR files and runtime bundle are removed; source and selected receipts remain.']};
    write(join(output, 'report.json'), report);
    console.log(JSON.stringify({status: report.status, observation: report.observation, resource: report.resource,
      corpusReady: report.corpusReady, releaseAccepted: report.releaseAccepted}, null, 2));
    if (!engineeringPassed) process.exitCode = 1;
  } finally {rmSync(compiled.path, {force: true});}
}

if (process.argv[2] === '--worker') {
  trial(...process.argv.slice(3)).then(result => {if (result.status === 'failed') process.exitCode = 1;})
    .catch(error => {console.error(error.stack); process.exitCode = 1; if (process.connected) process.disconnect();});
} else if (![5, 6].includes(process.argv.length)) {
  console.error('Usage: node scripts/benchmark-scientific-p5.mjs PDF EXPECTED_SHA256 NEW_OUTPUT_DIRECTORY [QUERY]'); process.exitCode = 1;
} else main(...process.argv.slice(2)).catch(error => {console.error(error.stack); process.exitCode = 1;});
