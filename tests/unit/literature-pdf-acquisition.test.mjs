import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, writeFile, symlink, lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let resolver, downloader, acquisition;
before(async () => {
  [resolver, downloader, acquisition] = await Promise.all([
    importTypeScriptModule('src/main/plugins/research/pdf-source-resolver.ts', {platform: 'node', tempDir: '.runtime/tmp'}),
    importTypeScriptModule('src/main/plugins/research/pdf-download-service.ts', {platform: 'node', tempDir: '.runtime/tmp'}),
    importTypeScriptModule('src/main/plugins/research/literature-pdf-acquisition.ts', {platform: 'node', tempDir: '.runtime/tmp'})
  ]);
});

const candidate = (url, overrides = {}) => ({url, provider: 'openalex', version: 'publishedVersion', license: 'cc-by',
  doi: '10.5555/fixture', arxivId: null, openAlexId: 'W123', ...overrides});
const pdf = (() => {
  const value = Buffer.alloc(256, 0x20);
  Buffer.from('%PDF-1.7\n').copy(value);
  Buffer.from('%%EOF\n').copy(value, 240);
  return value;
})();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const stream = (...chunks) => ({async *[Symbol.asyncIterator]() {for (const chunk of chunks) yield chunk;}});

test('arXiv identifiers preserve explicit versions and omit an invented v0 suffix', async () => {
  const signal = new AbortController().signal;
  const unversioned = await resolver.resolvePdfSources({arxivId: '2301.01234'}, signal, {fetch: async () => {throw new Error('unexpected_fetch');}});
  const versioned = await resolver.resolvePdfSources({arxivId: '2301.01234v2'}, signal, {fetch: async () => {throw new Error('unexpected_fetch');}});
  assert.equal(unversioned[0].url, 'https://arxiv.org/pdf/2301.01234');
  assert.equal(unversioned[0].version, null);
  assert.equal(versioned[0].url, 'https://arxiv.org/pdf/2301.01234v2');
  assert.equal(versioned[0].version, 'v2');
});

test('resolver accepts only identity-matched, provider-designated OpenAlex PDF locations', async () => {
  const requests = [];
  const sources = await resolver.resolvePdfSources({doi: '10.5555/fixture'}, new AbortController().signal, {
    fetch: async url => {
      requests.push(url);
      if (url.hostname === 'api.openalex.org') return Response.json({
        id: 'https://openalex.org/W123', doi: 'https://doi.org/10.5555/fixture',
        best_oa_location: {pdf_url: 'https://repo.example/published.pdf', version: 'publishedVersion', license: 'cc-by'},
        locations: [{pdf_url: 'https://repo.example/published.pdf'}, {landing_page_url: 'https://repo.example/article'}]
      });
      return Response.json({});
    }
  });
  assert.deepEqual(sources.map(source => source.url), ['https://repo.example/published.pdf']);
  assert.equal(sources[0].version, 'publishedVersion');
  assert.equal(sources[0].license, 'cc-by');
  assert.equal(requests.length, 3, 'DOI lookup consults all configured metadata providers');
});

test('Europe PMC resolves open PMCID records without scraping landing pages', async () => {
  const sources = await resolver.resolvePdfSources({pmcid: 'PMC1234'}, new AbortController().signal, {
    fetch: async () => Response.json({resultList: {result: [{pmcid: 'PMC1234', isOpenAccess: 'Y', license: 'CC BY',
      fullTextUrlList: {fullTextUrl: [{documentStyle: 'html', url: 'https://pmc.example/article'},
        {documentStyle: 'pdf', url: 'https://pmc.example/article.pdf'}]}}]}})
  });
  assert.deepEqual(sources.map(source => source.url), [
    'https://pmc.ncbi.nlm.nih.gov/articles/PMC1234/pdf/', 'https://pmc.example/article.pdf'
  ]);
  assert.ok(sources.every(source => source.provider === 'europe_pmc'));
});

async function setupDownload(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'roc-literature-pdf-'));
  const workspace = await mkdtemp(join(tmpdir(), 'roc-literature-workspace-'));
  const calls = [];
  const service = new downloader.PdfDownloadService(root, {
    lookup: options.lookup ?? (async () => [{address: '93.184.216.34', family: 4}]),
    request: options.request ?? (async () => ({status: 200, headers: {'content-length': String(pdf.length), 'content-encoding': 'identity'},
      body: stream(pdf), cancel() {}})),
    maxBytes: options.maxBytes ?? 512, timeoutMs: options.timeoutMs ?? 1000,
    connectTimeoutMs: options.connectTimeoutMs ?? 1000, now: options.now
  });
  await service.initialize();
  const acquire = (overrides = {}) => service.acquire({jobId: `job_${randomUUID()}`, generation: 'generation',
    libraryItemId: 'library-item', title: 'PDF Fixture', year: 2024, workspacePath: workspace,
    candidates: [candidate(`https://fixture-${randomUUID()}.example/paper.pdf`)], signal: new AbortController().signal,
    requireCurrent() {}, notifyWorkspaceChanged(path, reason) {calls.push({path, reason});}, ...overrides});
  return {root, workspace, calls, service, acquire,
    dispose: async () => {await rm(root, {recursive: true, force: true}); await rm(workspace, {recursive: true, force: true});}};
}

test('bounded download publishes an intact PDF atomically and reuses identical content without overwriting', async () => {
  const f = await setupDownload();
  try {
    const first = await f.acquire();
    assert.equal(first.created, true);
    assert.equal(first.sha256, sha(pdf));
    assert.equal(first.bytes, pdf.length);
    assert.deepEqual(await readFile(join(f.workspace, first.relativePath)), pdf);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].reason, 'literature-pdf-published');
    const second = await f.acquire({candidates: [candidate(`https://duplicate-${randomUUID()}.example/paper.pdf`)]});
    assert.equal(second.created, false);
    assert.equal(second.sha256, first.sha256);
    assert.deepEqual(await readFile(join(f.workspace, second.relativePath)), pdf);
    assert.equal(f.calls.length, 1, 'reusing the same PDF does not publish another workspace change');
  } finally {await f.dispose();}
});

test('a connect timeout aborts the underlying request', async () => {
  let connectAborted = false;
  const f = await setupDownload({connectTimeoutMs: 20, request: (_url, _address, signal, connectSignal) => new Promise((_resolve, reject) => {
    const abort = () => {connectAborted = true; reject(signal.reason ?? new Error('request_aborted'));};
    signal.addEventListener('abort', abort, {once: true});
    connectSignal.addEventListener('abort', abort, {once: true});
  })});
  try {
    await assert.rejects(f.acquire(), /research_pdf_download_timeout/u);
    assert.equal(connectAborted, true);
  } finally {await f.dispose();}
});

test('mixed public/private DNS, unsafe redirects, oversized and invalid PDF bodies are rejected', async () => {
  const privateDns = await setupDownload({lookup: async () => [
    {address: '93.184.216.34', family: 4}, {address: '127.0.0.1', family: 4}
  ]});
  try {await assert.rejects(privateDns.acquire(), /research_pdf_address_rejected/u);}
  finally {await privateDns.dispose();}

  let cancelled = 0;
  const redirect = await setupDownload({request: async () => ({status: 302, headers: {location: 'http://127.0.0.1/private'},
    body: stream(), cancel() {cancelled++;}})});
  try {
    await assert.rejects(redirect.acquire(), /research_pdf_url_rejected/u);
    assert.equal(cancelled, 1, 'redirect response stream is cancelled');
  } finally {await redirect.dispose();}

  const tooLarge = await setupDownload({maxBytes: 200});
  try {await assert.rejects(tooLarge.acquire(), /research_pdf_size_invalid/u);}
  finally {await tooLarge.dispose();}

  const corrupt = Buffer.from(pdf); corrupt.fill(0x41, 0, 8);
  const invalid = await setupDownload({request: async () => ({status: 200, headers: {'content-length': String(corrupt.length)},
    body: stream(corrupt), cancel() {}})});
  try {await assert.rejects(invalid.acquire(), /research_pdf_content_invalid/u);}
  finally {await invalid.dispose();}
});

test('interrupted streams leave no partial PDF and changed content uses the same versioned path as publishExisting', async () => {
  const interrupted = await setupDownload({request: async () => ({status: 200, headers: {},
    body: {async *[Symbol.asyncIterator]() {yield pdf.subarray(0, 120); throw new Error('synthetic_disconnect');}}, cancel() {}})});
  try {
    await assert.rejects(interrupted.acquire(), /research_pdf_transport_failed/u);
    const files = await readdir(join(interrupted.workspace, 'papers', '2024')).catch(() => []);
    assert.deepEqual(files, []);
  } finally {await interrupted.dispose();}

  let changed = false;
  const content = Buffer.from(pdf); content[80] = 0x41;
  const collision = await setupDownload({request: async () => {
    const bytes = changed ? content : pdf;
    return {status: 200, headers: {'content-length': String(bytes.length)}, body: stream(bytes), cancel() {}};
  }});
  try {
    const saved = await collision.acquire();
    changed = true;
    const replacement = await collision.acquire({candidates: [candidate(`https://conflict-${randomUUID()}.example/paper.pdf`)]});
    assert.equal(replacement.relativePath, saved.relativePath.replace(/\.pdf$/u, `--${sha(content).slice(0, 16)}.pdf`));
    assert.equal(replacement.receipt.relativePath, replacement.relativePath);
    assert.deepEqual(await readFile(join(collision.workspace, replacement.relativePath)), content);
    assert.deepEqual(await readFile(join(collision.workspace, saved.relativePath)), pdf);
    const reused = await collision.service.publishExisting({jobId: 'reused', generation: 'generation',
      libraryItemId: 'library-item', title: 'PDF Fixture', year: 2024, workspacePath: collision.workspace,
      bytes: content, signal: new AbortController().signal, requireCurrent() {}, notifyWorkspaceChanged() {assert.fail('duplicate publication');}});
    assert.equal(reused.relativePath, replacement.relativePath);
    assert.equal(reused.created, false);
    assert.equal(collision.calls.length, 2);
  } finally {await collision.dispose();}
});

test('a corrupt stable destination is preserved and a conflict at the versioned path still fails closed', async () => {
  const f = await setupDownload();
  try {
    const saved = await f.acquire();
    await writeFile(join(f.workspace, saved.relativePath), Buffer.from('not a PDF'));
    const replacement = await f.acquire();
    assert.equal(replacement.relativePath, saved.relativePath.replace(/\.pdf$/u, `--${sha(pdf).slice(0, 16)}.pdf`));
    assert.equal(await readFile(join(f.workspace, saved.relativePath), 'utf8'), 'not a PDF');
    await writeFile(join(f.workspace, replacement.relativePath), Buffer.from('user content'));
    await assert.rejects(f.acquire(), /research_pdf_existing_file_conflict/u);
    assert.equal(await readFile(join(f.workspace, replacement.relativePath), 'utf8'), 'user content');
  } finally {await f.dispose();}
});

test('download failures retain safe provider and Retry-After across candidate aggregation', async () => {
  const f = await setupDownload({now: () => 1_000, request: async url => ({
    status: url.pathname === '/busy.pdf' ? 429 : 404,
    headers: {'retry-after': '120'}, body: stream(), cancel() {}
  })});
  try {
    await assert.rejects(f.acquire({candidates: [
      candidate(`https://busy-${randomUUID()}.example/busy.pdf?token=private-token`),
      candidate(`https://missing-${randomUUID()}.example/missing.pdf`, {provider: 'europe_pmc'})
    ]}), error => {
      assert.equal(error.message, 'research_pdf_http_retryable');
      assert.equal(error.provider, 'openalex');
      assert.equal(error.retryAfterMs, 120_000);
      assert.equal(error.cause, undefined, 'safe public failures never retain raw transport errors');
      assert.doesNotMatch(JSON.stringify(error), /private-token|https:/u);
      return true;
    });
  } finally {await f.dispose();}
});

test('Retry-After from a redirected 503 defers queued papers sharing that host across downloader instances', async () => {
  let now = Date.parse('2026-11-19T00:00:00Z'), requests = 0, releaseResponse;
  const host = `cooldown-${randomUUID()}.example`;
  const responseGate = new Promise(resolve => {releaseResponse = resolve;});
  const f = await setupDownload({now: () => now, timeoutMs: 3000, request: async url => {
    requests++;
    if (url.hostname !== host) return {status: 302, headers: {location: `https://${host}/signed.pdf?token=private-token`},
      body: stream(), cancel() {}};
    await responseGate;
    return {status: 503, headers: {'retry-after': new Date(now + 120_000).toUTCString()}, body: stream(), cancel() {}};
  }});
  let queuedDns;
  const dnsReached = new Promise(resolve => {queuedDns = resolve;});
  const other = await setupDownload({now: () => now, timeoutMs: 3000,
    lookup: async () => {queuedDns(); return [{address: '93.184.216.34', family: 4}];},
    request: async () => {assert.fail('cooling host must not be requested');}});
  try {
    const first = f.acquire({candidates: [candidate(`https://redirect-${randomUUID()}.example/paper.pdf`)]}).catch(error => error);
    // The first request holds the host's network lease while another paper queues for it.
    while (requests < 2) await new Promise(resolve => setImmediate(resolve));
    const queued = other.acquire({libraryItemId: 'second-paper',
      candidates: [candidate(`https://${host}/another.pdf`, {provider: 'europe_pmc'})]}).catch(error => error);
    await dnsReached;
    releaseResponse();
    const [firstError, queuedError] = await Promise.all([first, queued]);
    assert.equal(firstError.retryAfterMs, 120_000);
    assert.equal(queuedError.message, 'research_pdf_http_retryable');
    assert.equal(queuedError.retryAfterMs, 120_000);
    assert.equal(queuedError.provider, 'europe_pmc');
    assert.equal(requests, 2);
    now += 120_000;
    const healthy = await setupDownload({now: () => now});
    try {assert.equal((await healthy.acquire({candidates: [candidate(`https://${host}/recovered.pdf`)]})).created, true);}
    finally {await healthy.dispose();}
  } finally {releaseResponse(); await f.dispose(); await other.dispose();}
});

test('publication never follows stable-name symlinks and cancellation prevents versioned publication', async () => {
  const f = await setupDownload();
  try {
    const saved = await f.acquire(), destination = join(f.workspace, saved.relativePath);
    const outside = join(f.root, 'outside.pdf');
    await writeFile(outside, pdf);
    await rm(destination);
    await symlink(outside, destination);
    const versioned = await f.acquire();
    assert.notEqual(versioned.relativePath, saved.relativePath);
    assert.equal((await lstat(destination)).isSymbolicLink(), true);
    assert.deepEqual(await readFile(outside), pdf);
    const controller = new AbortController();
    await assert.rejects(f.acquire({signal: controller.signal, requireCurrent() {controller.abort(new Error('cancelled'));}}), /cancelled/u);
    assert.equal(f.calls.length, 2);
    assert.ok((await readdir(join(f.workspace, 'papers', '2024'))).every(name => !name.endsWith('.part')));
  } finally {await f.dispose();}
});

test('download Retry-After reaches the acquisition retry outcome without reducing ordinary backoff', async () => {
  const f = await setupDownload({now: () => 1000, request: async () => ({
    status: 429, headers: {'retry-after': '120'}, body: stream(), cancel() {}
  })});
  try {
    const worker = new acquisition.LiteraturePdfAcquisition({getProject: () => ({workspacePath: f.workspace})},
      {get: () => ({metadata: {publishedYear: 2024}})}, f.service, () => {}, {}, {now: () => 1000, random: () => 0});
    const job = {stage: 'download', projectId: 'project', libraryItemId: 'paper', id: 'job', generation: 'g',
      title: 'Paper', attempts: 0, source: {version: 1, candidates: [candidate(`https://scheduler-${randomUUID()}.example/paper.pdf`)]}};
    const result = await worker.process(job, new AbortController().signal, () => {});
    assert.equal(result.status, 'queued');
    assert.equal(result.errorCode, 'research_pdf_http_retryable');
    assert.equal(result.nextRetryAt, new Date(121_000).toISOString());
  } finally {await f.dispose();}
});

test('library metadata, provider records and identifier observations rebuild all supported identities', () => {
  const providerRecord = (source, externalId, doi = null) => ({source, externalId, doi});
  const item = {metadata: {source: 'pubmed', externalId: '12345', doi: null}, sources: [
    {providerRecord: providerRecord('openalex', 'W123')},
    {providerRecord: providerRecord('semantic_scholar', 'S123')},
    {providerRecord: providerRecord('europe_pmc', 'PMC:PMC9876')}
  ]};
  let pages = 0;
  const library = {get: () => item, getIdentifiers: request => {
    pages++;
    if (request.offset === 0) return {records: [{identifiers: [
      {kind: 'doi', value: 'https://doi.org/10.5555/observed'},
      {kind: 'arxiv', value: '2301.01234v2'}
    ]}], nextOffset: 50};
    return {records: [{identifiers: [{kind: 'pmid', value: '67890'}]}], nextOffset: null};
  }};
  assert.deepEqual(acquisition.pdfSourceInputForLibraryItem(library, 'paper'), {
    doi: '10.5555/observed', arxivId: '2301.01234', openAlexId: 'W123',
    semanticScholarId: 'S123', pmid: '12345', pmcid: 'PMC9876'
  });
  assert.equal(pages, 2, 'identifier observations are read to the end of their bounded pages');
});

test('an import-stage retry never invokes the PDF downloader again', async () => {
  let downloads = 0;
  const worker = new acquisition.LiteraturePdfAcquisition({getProject: () => ({workspacePath: '/tmp/project'})},
    {get: () => ({metadata: {publishedYear: 2024}})}, {acquire: async () => {downloads++;}}, () => {}, {});
  const result = await worker.process({stage: 'import', projectId: 'project', libraryItemId: 'paper', id: 'job', generation: 'g',
    title: 'Paper', attempts: 0, source: null}, new AbortController().signal, () => {});
  assert.deepEqual(result, {stage: 'import', status: 'blocked', errorCode: 'research_document_import_not_configured'});
  assert.equal(downloads, 0);
});

test('provider outages retry transiently while a validated empty result is unavailable', async () => {
  const common = {projectId: 'project', libraryItemId: 'paper', id: 'job', generation: 'g', title: 'Paper', source: null};
  const research = {getProject: () => ({workspacePath: '/tmp/project'})};
  const library = {get: () => ({metadata: {doi: '10.5555/example', publishedYear: 2024}, sources: []}),
    getIdentifiers: () => ({records: [], nextOffset: null})};
  const governor = {acquire: async () => () => {}, responseLimits() {}, success() {}, failure() {}};
  const failed = new acquisition.LiteraturePdfAcquisition(research, library, {}, () => {}, governor, {
    resolver: {fetch: async () => {throw new Error('provider_offline');}}, now: () => 1000, random: () => 0
  });
  const transient = await failed.process({...common, stage: 'resolve', attempts: 0}, new AbortController().signal, () => {});
  assert.equal(transient.status, 'queued');
  assert.equal(transient.errorCode, 'research_pdf_provider_unavailable');
  assert.equal(transient.nextRetryAt, new Date(31_000).toISOString());
  const limited = new acquisition.LiteraturePdfAcquisition(research, library, {}, () => {}, governor, {
    resolver: {fetch: async () => new Response('', {status: 429, headers: {'retry-after': '120'}})}, now: () => 1000, random: () => 0
  });
  const delayed = await limited.process({...common, stage: 'resolve', attempts: 0}, new AbortController().signal, () => {});
  assert.equal(delayed.nextRetryAt, new Date(121_000).toISOString());
  const exhausted = await failed.process({...common, stage: 'resolve', attempts: 2}, new AbortController().signal, () => {});
  assert.equal(exhausted.status, 'failed');
  assert.equal(exhausted.errorCode, 'research_pdf_provider_unavailable');

  const empty = new acquisition.LiteraturePdfAcquisition(research, library, {}, () => {}, governor, {
    resolver: {fetch: async () => Response.json({})}
  });
  const unavailable = await empty.process({...common, stage: 'resolve', attempts: 0}, new AbortController().signal, () => {});
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.errorCode, 'research_pdf_sources_unavailable');
});

test('domain PDF identities and opt-in Unpaywall preserve identity, version and privacy', async () => {
  const signal = new AbortController().signal;
  const official = await resolver.resolvePdfSources({aclId: '2025.acl-long.1',
    cvfId: 'content/CVPR2025/html/A_CVPR_2025_paper.html'}, signal);
  assert.deepEqual(official.map(value => value.provider), ['acl', 'cvf']);
  assert.equal(official[0].version, 'publishedVersion');
  let calls = 0;
  const fetch = async url => {
    calls++;
    assert.equal(url.hostname, 'api.unpaywall.org');
    assert.equal(url.searchParams.get('email'), 'contact@example.org');
    return Response.json({doi: '10.5555/paper', is_oa: true, oa_locations: [
      {url_for_pdf: 'https://repository.example/download?id=7', version: 'acceptedVersion', license: 'cc-by'},
      {url_for_pdf: 'http://127.0.0.1/private'}, {url: 'https://repository.example/landing'}]});
  };
  const options = {fetch, onlyDoiFallback: true};
  assert.deepEqual(await resolver.resolvePdfSources({doi: '10.5555/paper'}, signal, options), []);
  assert.equal(calls, 0);
  const result = await resolver.resolvePdfSources({doi: '10.5555/paper'}, signal, {...options, unpaywallEmail: 'contact@example.org'});
  assert.equal(result.length, 1); assert.equal(result[0].license, 'cc-by');
  assert.equal(result[0].provider, 'unpaywall'); assert.equal(result[0].version, 'acceptedVersion');
  let error;
  await resolver.resolvePdfSources({doi: '10.5555/paper'}, signal, {...options, unpaywallEmail: 'contact@example.org',
    fetch: async () => {throw new Error('URL contains contact@example.org');}, onProviderError: (_, value) => {error = value;}});
  assert.equal(error.message, 'research_unpaywall_unavailable');
  assert.equal(JSON.stringify(error).includes('contact@'), false);
});

test('download fallback survives task handoff, never loops and defers transient DOI failure', async () => {
  let lookups = 0, limited = false, failureCode = 'research_pdf_unavailable';
  const research = {getProject: () => ({workspacePath: '/tmp/project'})};
  const library = {get: () => ({metadata: {doi: '10.5555/paper', publishedYear: 2025}, sources: []}),
    getIdentifiers: () => ({records: [], nextOffset: null})};
  const governor = {acquire: async () => () => {}, responseLimits() {}, success() {}, failure() {}};
  const worker = new acquisition.LiteraturePdfAcquisition(research, library, {
    initialize: async () => {},
    acquire: async () => {throw Object.assign(new Error(failureCode), {provider: 'openalex', category: 'permanent'});}
  }, () => {}, governor, {now: () => 1000, random: () => 0,
    getSettings: () => ({versionPreference: 'published', unpaywallEmail: 'contact@example.org'}),
    resolver: {fetch: async () => {
      lookups++;
      return limited ? new Response('', {status: 429, headers: {'retry-after': '120'}}) :
        Response.json({doi: '10.5555/paper', is_oa: true, best_oa_location: {url_for_pdf: 'https://repo.example/fallback'}});
    }}});
  const job = {projectId: 'project', libraryItemId: 'paper', id: 'job', generation: 'g', title: 'Paper', stage: 'download', attempts: 0,
    source: {version: 1, candidates: [candidate('https://original.example/paper.pdf')]}};
  const first = await worker.process(job, new AbortController().signal, () => {});
  assert.equal(first.status, 'queued'); assert.equal(first.source.doiFallbackComplete, true);
  assert.equal(first.source.candidates[0].provider, 'unpaywall');
  assert.equal(first.source.lastFailure.provider, 'openalex');
  const second = await worker.process({...job, source: first.source}, new AbortController().signal, () => {});
  assert.equal(second.status, 'unavailable'); assert.equal(lookups, 1);
  limited = true;
  const retry = await worker.process(job, new AbortController().signal, () => {});
  assert.equal(retry.nextRetryAt, new Date(121000).toISOString());
  assert.notEqual(retry.source.doiFallbackComplete, true);
  const previousLookups = lookups;
  failureCode = 'research_pdf_publish_conflict';
  const storageFailure = await worker.process(job, new AbortController().signal, () => {});
  assert.equal(storageFailure.errorCode, failureCode);
  assert.equal(lookups, previousLookups);
});

test('URL and public address checks reject unsafe or special-use endpoints', () => {
  for (const value of ['http://example.org/paper.pdf', 'https://user:pass@example.org/paper.pdf',
    'https://example.org:444/paper.pdf', 'https://example.org./paper.pdf']) {
    assert.throws(() => downloader.requirePdfUrl(value), /research_pdf_(?:url_invalid|url_rejected)/u);
  }
  for (const address of ['0.0.0.0', '127.0.0.1', '169.254.1.2', '192.168.1.1', '224.0.0.1',
    '::1', 'fe80::1', 'fc00::1', '2001:db8::1', '::ffff:127.0.0.1']) {
    assert.equal(downloader.isPublicPdfAddress(address), false, address);
  }
  assert.equal(downloader.isPublicPdfAddress('93.184.216.34'), true);
  assert.equal(downloader.isPublicPdfAddress('2606:4700:4700::1111'), true);
});
