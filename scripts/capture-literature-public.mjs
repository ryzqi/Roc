import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {z} from 'zod';
import {importTypeScriptModule} from './lib/bundle-ts.mjs';

// Explicit live command; normal regression runs never require internet or contact details.
const [mode, corpusPath, target] = process.argv.slice(2);
if (!['--search', '--pdf'].includes(mode) || !corpusPath || !target || process.argv.length !== 5) {
  throw new Error('Usage: pnpm research:literature-capture <--search|--pdf> <corpus.json> <new-output-directory>');
}
const output = resolve(target);
const corpus = z.object({
  schemaVersion: z.literal(1), corpusId: z.string().min(1), asOf: z.iso.date(), annotationStatus: z.literal('unlabeled_seed_set'),
  limits: z.object({limit: z.number().int().min(20).max(30), maxPages: z.number().int().min(1).max(3)}),
  sources: z.array(z.string()).min(1),
  topics: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/u), queries: z.array(z.string().min(1)).min(3),
    sources: z.array(z.string()).optional(), collections: z.object({acl: z.string().optional(), cvf: z.string().optional()}).optional(),
    papers: z.array(z.object({id: z.string().regex(/^[a-z0-9-]+$/u), title: z.string().min(1), arxivId: z.string().regex(/^\d{4}\.\d{4,5}$/u)})).min(1)
  })).min(7)
}).parse(JSON.parse(await readFile(corpusPath, 'utf8')));
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const write = async (name, value) => writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600});
await mkdir(output, {recursive: false, mode: 0o700});
await write('protocol.json', {...corpus, corpusHash: hash(corpus), mode, startedAt: new Date().toISOString(),
  limitsNote: 'Unlabeled OA arXiv seed set; collection-local ACL/CVF; no closed/scanned-PDF representativeness claim.'});
const bundle = entry => importTypeScriptModule(entry, {platform: 'node', tempDir: '.runtime/tmp'});
if (mode === '--search') {
  const {LiteratureSearchService} = await bundle('src/main/plugins/research/literature-service.ts');
  const {literatureSearchPoolBodySchema} = await bundle('src/shared/schemas/literature-search-pool.ts');
  const {prepareLiteratureJudgmentPacket} = await bundle('src/main/plugins/research/literature-retrieval-evaluation.ts');
  const {fuseLiterature} = await bundle('src/main/plugins/research/literature-fusion.ts');
  // Use the service's own governor so bundled admission errors share class identity.
  const search = new LiteratureSearchService(globalThis.fetch);
  const captures = {schemaVersion: 1, corpusId: corpus.corpusId, minimumTopics: 7, queries: []};
  const coverage = [];
  try {
    for (const topic of corpus.topics) for (const [index, query] of topic.queries.entries()) {
      const queryId = `${topic.id}-${index + 1}`;
      const request = {query, sources: [...new Set([...corpus.sources, ...topic.sources ?? []])],
        ...corpus.limits, yearFrom: 2020, dateTo: corpus.asOf, ...(topic.collections ? {collections: topic.collections} : {})};
      const found = await search.searchDetailed(request);
      const body = literatureSearchPoolBodySchema.parse({schemaVersion: 1, executionId: randomUUID(),
        createdAt: new Date().toISOString(), request, strategy: null, status: found.status, sources: found.sources, records: found.records});
      const pool = {...body, contentHash: hash(body)};
      captures.queries.push({queryId, topicId: topic.id, pool});
      await write(`${queryId}.json`, pool);
      const observed = new Set(found.records.flatMap(record => record.identifiers.filter(value => value.kind === 'arxiv').map(value => value.value)));
      coverage.push({queryId, rawRecords: found.records.length, uniqueCandidates: fuseLiterature(found.records).length,
        missingSeedIds: topic.papers.filter(paper => !observed.has(paper.arxivId)).map(paper => paper.id),
        sourceCoverage: found.sources.map(source => ({source: source.source, status: source.status,
          returned: source.returnedCount, coverage: source.coverage, errorCode: source.errorCode, governance: source.governance})),
        warnings: found.warnings});
      console.log(JSON.stringify({queryId, status: found.status, records: found.records.length}));
    }
    await write('captures.json', captures);
    await write('annotation-packet.json', prepareLiteratureJudgmentPacket(captures));
    await write('coverage.json', {corpusId: corpus.corpusId, note: 'Missing seeds are inspection leads, not relevance judgments or recall estimates.', queries: coverage});
  } finally {await search.shutdown();}
} else {
  const {createLiteratureProviderGovernor} = await bundle('src/main/plugins/research/literature-provider-governor.ts');
  const governor = createLiteratureProviderGovernor();
  const {resolvePdfSources} = await bundle('src/main/plugins/research/pdf-source-resolver.ts');
  const {PdfDownloadService} = await bundle('src/main/plugins/research/pdf-download-service.ts');
  const {evaluateLiteratureAcquisition} = await bundle('src/main/plugins/research/literature-acquisition-evaluation.ts');
  const {getDocument} = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const papers = corpus.topics.flatMap(topic => topic.papers.map(paper => ({...paper, topicId: topic.id})));
  if (new Set(papers.map(paper => paper.id)).size !== papers.length) throw new Error('duplicate_paper_id');
  const workspace = join(output, 'workspace');
  await mkdir(workspace);
  const downloader = new PdfDownloadService(join(output, 'storage'), {maxBytes: 25 * 1024 * 1024, timeoutMs: 30000});
  await downloader.initialize();
  const evidence = {schemaVersion: 1, corpusId: corpus.corpusId, expectedPaperIds: papers.map(paper => paper.id),
    environment: 'public_network', samples: []};
  for (const paper of papers) {
    const startedAt = new Date().toISOString(), failures = [];
    const signal = AbortSignal.timeout(90000);
    let candidates = [], receipt = null, inspection = null;
    try {
      const options = {governor, unpaywallEmail: process.env.ROC_UNPAYWALL_EMAIL ?? null,
        onProviderError: (provider, error) => failures.push({provider, code: /^research_[a-z0-9_]+$/u.test(error.message) ? error.message : 'provider_unavailable'})};
      candidates = await resolvePdfSources({arxivId: paper.arxivId}, signal, options);
      const acquire = candidates => downloader.acquire({jobId: paper.id, generation: 'public-benchmark', libraryItemId: paper.id,
        title: paper.title, year: Number(`20${paper.arxivId.slice(0, 2)}`), workspacePath: workspace,
        candidates, signal, requireCurrent() {}, notifyWorkspaceChanged() {}});
      let downloaded;
      try {downloaded = await acquire(candidates);}
      catch (error) {
        if (!options.unpaywallEmail) throw error;
        const fallback = await resolvePdfSources({arxivId: paper.arxivId}, signal, {...options, onlyDoiFallback: true});
        const existing = new Set(candidates.map(candidate => candidate.url));
        const additional = fallback.filter(candidate => !existing.has(candidate.url));
        candidates.push(...additional);
        if (additional.length === 0) throw error;
        downloaded = await acquire(additional);
      }
      const bytes = await readFile(join(workspace, downloaded.relativePath));
      const task = getDocument({data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true});
      try {
        const document = await task.promise;
        const page = await document.getPage(1);
        const content = await page.getTextContent();
        const text = content.items.map(item => 'str' in item ? item.str : '').join(' ').toLowerCase();
        const terms = [...new Set(paper.title.toLowerCase().match(/[a-z0-9]{3,}/gu))];
        const titleTokenCoverage = terms.filter(term => text.includes(term)).length / terms.length;
        inspection = {pages: document.numPages, firstPageTextChars: text.length, titleTokenCoverage};
        if (titleTokenCoverage < 0.6 || text.length < 200) throw new Error('benchmark_pdf_identity_unverified');
        receipt = {...downloaded.receipt, id: randomUUID(), generation: 'public-benchmark', acquiredAt: new Date().toISOString()};
      } finally {await task.destroy();}
    } catch (error) {
      failures.push({provider: typeof error.provider === 'string' ? error.provider : 'pipeline',
        code: /^[a-z][a-z0-9_]+$/u.test(error.message) ? error.message : 'benchmark_transport_or_parse_failed'});
    }
    const sample = {paperId: paper.id, topicId: paper.topicId, expectedOpenAccess: true, startedAt,
      observedAt: new Date().toISOString(), discovered: candidates.length > 0, receipt,
      parsed: null, indexed: null, wiki: null, readyAt: null, recovery: null, failures};
    evidence.samples.push(sample);
    await write(`${paper.id}.json`, {sample, inspection, candidates});
    console.log(JSON.stringify({paperId: paper.id, discovered: sample.discovered, verified: receipt !== null}));
  }
  await write('evidence.json', evidence);
  await write('report.json', evaluateLiteratureAcquisition(evidence));
}
