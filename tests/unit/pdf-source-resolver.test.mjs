import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let resolvePdfSources;
before(async () => {
  ({resolvePdfSources} = await importTypeScriptModule('src/main/plugins/research/pdf-source-resolver.ts',
    {platform: 'node', tempDir: '.runtime/tmp'}));
});

const doi = '10.5555/fixture';
const signal = () => new AbortController().signal;
const openAlexWork = overrides => ({id: 'https://openalex.org/W123', doi: `https://doi.org/${doi}`, ...overrides});
const fetchProviders = payloads => async url => Response.json(payloads[url.hostname] ?? {});

for (const [provider, payload] of [
  ['api.openalex.org', openAlexWork({best_oa_location: {
    pdf_url: 'https://repository.example/download/123', is_oa: true, version: 'publishedVersion', license: 'cc-by'
  }})],
  ['api.semanticscholar.org', {paperId: 'a'.repeat(40), externalIds: {DOI: doi},
    openAccessPdf: {url: 'https://repository.example/download/123', license: 'CCBY'}}],
  ['www.ebi.ac.uk', {resultList: {result: [{doi, isOpenAccess: 'Y', fullTextUrlList: {
    fullTextUrl: [{documentStyle: 'pdf', url: 'https://repository.example/download/123'}]
  }}]}}]
]) {
  test(`${provider} accepts an identity-matched, explicitly declared PDF without a PDF-shaped URL`, async () => {
    const candidates = await resolvePdfSources({doi}, signal(), {fetch: fetchProviders({[provider]: payload})});
    assert.deepEqual(candidates.map(candidate => candidate.url), ['https://repository.example/download/123']);
    assert.equal(candidates[0].doi, doi);
  });
}

test('all explicit OA locations are retained; landing pages, unsafe URLs and identity mismatches are rejected', async () => {
  const rejected = ['http://repo.example/download', 'https://127.0.0.1/download', 'https://[::1]/download',
    'https://localhost/download', 'https://repo.internal/download', 'https://repo.example:444/download',
    'https://repo.example/download#fragment', 'https://user@repo.example/download'];
  const work = openAlexWork({
    best_oa_location: {pdf_url: 'https://repo.example/best', is_oa: false},
    primary_location: {pdf_url: 'https://repo.example/primary', is_oa: true},
    locations: [
      {pdf_url: 'https://repo.example/primary', is_oa: true},
      {pdf_url: 'https://repo.example/accepted', is_oa: true, license: 'cc-by', version: 'acceptedVersion'},
      {pdf_url: 'https://repo.example/closed', is_oa: false},
      {pdf_url: 'https://repo.example/unknown'},
      {landing_page_url: 'https://repo.example/landing.pdf', is_oa: true},
      ...rejected.map(pdf_url => ({pdf_url, is_oa: true}))
    ]
  });
  const sources = await resolvePdfSources({doi}, signal(), {fetch: fetchProviders({'api.openalex.org': work})});
  assert.deepEqual(sources.map(source => source.url), ['https://repo.example/primary', 'https://repo.example/accepted']);
  assert.equal(sources[1].license, 'cc-by');
  const mismatch = await resolvePdfSources({doi}, signal(), {fetch: fetchProviders({
    'api.openalex.org': {...work, doi: '10.5555/different'}
  })});
  assert.deepEqual(mismatch, []);
});

test('version preference is deterministic and preserves an explicitly pinned arXiv revision', async () => {
  const payload = openAlexWork({best_oa_location: {pdf_url: 'https://repo.example/published', version: 'publishedVersion'},
    locations: [{pdf_url: 'https://repo.example/accepted', is_oa: true, version: 'acceptedVersion'}]});
  for (const preference of ['balanced', 'preprint', 'published']) {
    let evidence;
    const sources = await resolvePdfSources({doi, arxivId: '2501.01234v2'}, signal(), {
      fetch: fetchProviders({'api.openalex.org': payload}), versionPreference: preference, onResolution: value => {evidence = value;}
    });
    assert.equal(sources[0].provider, preference === 'published' ? 'openalex' : 'arxiv');
    assert.equal(sources.find(source => source.provider === 'arxiv').url, 'https://arxiv.org/pdf/2501.01234v2');
    assert.equal(evidence.preference, preference);
    assert.deepEqual(evidence.candidates.map(entry => entry.rank), [1, 2, 3]);
    assert.equal(evidence.candidates[0].reason, preference === 'published' ? 'published-version' :
      preference === 'preprint' ? 'arxiv-explicit-version' : 'provider-order');
  }
});

test('provider rate limits retain bounded Retry-After while another provider can still supply a PDF', async () => {
  const failures = [];
  const sources = await resolvePdfSources({doi}, signal(), {
    fetch: async url => url.hostname === 'api.openalex.org' ? new Response('', {status: 429, headers: {'retry-after': '120'}}) :
      url.hostname === 'api.semanticscholar.org' ? Response.json({externalIds: {DOI: doi}, openAccessPdf: {url: 'https://repo.example/download'}}) : Response.json({}),
    onProviderError: (provider, error) => failures.push({provider, retryAfterMs: error.retryAfterMs})
  });
  assert.deepEqual(failures, [{provider: 'openalex', retryAfterMs: 120000}]);
  assert.equal(sources[0].provider, 'semantic_scholar');
});
