import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let domains, LiteratureSearchService, LiteratureProviderGovernor;
before(async () => {
  domains = await importTypeScriptModule('src/main/plugins/research/literature-domain-sources.ts', {platform: 'node', tempDir: '.runtime/tmp'});
  ({LiteratureSearchService} = await importTypeScriptModule('src/main/plugins/research/literature-service.ts', {platform: 'node', tempDir: '.runtime/tmp'}));
  ({LiteratureProviderGovernor} = await importTypeScriptModule('src/main/plugins/research/literature-provider-governor.ts', {platform: 'node', tempDir: '.runtime/tmp'}));
});
const timestamp = '2026-11-19T00:00:00.000Z';
const acl = `<collection id="2025.acl"><volume id="long"><meta><year>2025</year></meta>
  <paper id="1"><title><fixed-case>LLM</fixed-case> Agent Memory</title><author><first>Jane</first><last>Doe</last></author><doi>10.18653/v1/2025.acl-long.1</doi><pdf/></paper>
  <paper id="2"><title>Agent Security</title><abstract>LLM safety</abstract><pdf/></paper></volume></collection>`;
const cvf = `<dl><dt class="ptitle"><a href="/content/CVPR2025/html/A_Agent_CVPR_2025_paper.html">Visual Agent</a></dt>
  <dd><input name="query_author" value="Jane Doe"></dd><dd><a href="/content/CVPR2025/papers/A_Agent_CVPR_2025_paper.pdf">pdf</a></dd></dl>`;
const note = {id: 'abc', forum: 'abc', readers: ['everyone'], signatures: ['author'], invitations: ['ICLR/-/Submission'],
  pdate: Date.parse('2025-05-01'), content: {title: {value: 'Agent Memory'}, authors: {value: ['Jane Doe']}, pdf: {value: '/pdf/abc.pdf'}}};

test('ACL official XML preserves inline title text, authors, DOI and PDF identity; rejects collection mismatch and entities', () => {
  const records = domains.readAclCollection(acl, '2025.acl', timestamp);
  assert.equal(records[0].title, 'LLM Agent Memory');
  assert.deepEqual(records[0].authors, ['Jane Doe']);
  assert.equal(records[0].openAccessUrl, 'https://aclanthology.org/2025.acl-long.1.pdf');
  assert.throws(() => domains.readAclCollection(acl, '2024.acl', timestamp));
  assert.throws(() => domains.readAclCollection('<!DOCTYPE collection [<!ENTITY x "x">]>' + acl, '2025.acl', timestamp));
});

test('CVF accepts only official matching collection pages and explicitly linked PDFs', () => {
  const [record] = domains.readCvfCollection(cvf, 'CVPR2025', timestamp);
  assert.equal(record.title, 'Visual Agent');
  assert.deepEqual(record.authors, ['Jane Doe']);
  assert.equal(record.openAccessUrl, 'https://openaccess.thecvf.com/content/CVPR2025/papers/A_Agent_CVPR_2025_paper.pdf');
  assert.equal(domains.readCvfCollection(cvf.replace('/papers/', '/supplemental/'), 'CVPR2025', timestamp)[0].openAccessUrl, null);
  assert.throws(() => domains.readCvfCollection(cvf, 'CVPR2024', timestamp));
  assert.throws(() => domains.readCvfCollection('<html>challenge</html>', 'CVPR2025', timestamp));
});

test('OpenReview uses public forums and rejects replies or restricted fields', async () => {
  let url;
  const read = async value => {url = new URL(value); return JSON.stringify({notes: [note], count: 2});};
  const page = await domains.searchDomainSource('openreview', {query: 'agent', limit: 1}, 0, read, () => timestamp);
  assert.equal(url.searchParams.get('source'), 'forum');
  assert.equal(page.nextOffset, 1);
  assert.equal(page.records[0].openAccessUrl, 'https://openreview.net/pdf/abc.pdf');
  const structuredAuthors = await domains.searchDomainSource('openreview', {query: 'agent', limit: 1}, 0,
    async () => JSON.stringify({notes: [{...note, content: {...note.content,
      authors: {value: [{fullname: 'Jane Doe', username: '~Jane_Doe1'}]}}}]}), () => timestamp);
  assert.deepEqual(structuredAuthors.records[0].authors, ['Jane Doe']);
  for (const value of [{...note, replyto: 'parent'}, {...note, readers: ['authors']},
    {...note, content: {...note.content, title: {value: 'secret', readers: ['authors']}}}]) {
    await assert.rejects(domains.searchDomainSource('openreview', {query: 'agent', limit: 1}, 0,
      async () => JSON.stringify({notes: [value]}), () => timestamp));
  }
});

test('DBLP normalizes single-author responses and rejects anti-bot HTML instead of claiming an empty result', async () => {
  const read = async () => JSON.stringify({result: {hits: {'@total': '1', hit: [{info: {key: 'conf/x/p', title: 'Agent',
    authors: {author: {text: 'Jane Doe'}}, year: '2025', doi: '10.1234/ABC', url: 'https://dblp.org/rec/conf/x/p'}}]}}});
  const page = await domains.searchDomainSource('dblp', {query: 'agent', limit: 1}, 0, read, () => timestamp);
  assert.equal(page.records[0].doi, '10.1234/abc');
  assert.deepEqual(page.records[0].authors, ['Jane Doe']);
  assert.equal(page.records[0].openAccessUrl, null);
  await assert.rejects(domains.searchDomainSource('dblp', {query: 'agent', limit: 1}, 0, async () => '<html>challenge</html>', () => timestamp));
});

test('real search service paginates collection matches from one audited cached snapshot', async () => {
  let calls = 0;
  const service = new LiteratureSearchService(async () => {calls++; return new Response(acl);});
  try {
    const result = await service.searchDetailed({query: 'agent', sources: ['acl'], collections: {acl: '2025.acl'}, limit: 1, maxPages: 2});
    assert.equal(calls, 1);
    assert.deepEqual(result.records.map(record => record.rank), [1, 2]);
    assert.equal(result.sources[0].coverage.state, 'reported_end');
    assert.equal(result.sources[0].pages[1].cache.state, 'hit');
    assert.ok(result.warnings.some(warning => warning.includes('2025.acl')));
    assert.equal(result.records[0].record.source, 'acl');
  } finally {await service.shutdown();}
});

test('failure cache suppresses repeated missing endpoints and retains failure status', async () => {
  let calls = 0;
  const service = new LiteratureSearchService(async () => {calls++; return new Response('', {status: 404});});
  try {
    const request = {query: 'agent', sources: ['dblp']};
    const first = await service.searchDetailed(request);
    const second = await service.searchDetailed(request);
    assert.equal(first.status, 'failed'); assert.equal(second.status, 'failed');
    assert.equal(second.sources[0].requests.length, 0); assert.equal(calls, 1);
    assert.ok(second.sources[0].retryAfterMs > 0);
  } finally {await service.shutdown();}
});

test('governor honors Retry-After without occupying worker, caps probe pages and recovers pacing above server floor', async () => {
  let now = 0;
  const governor = new LiteratureProviderGovernor({host: {minIntervalMs: 100, maxRequests: 10, windowMs: 100000,
    failureThreshold: 3, cooldownMs: 1000}}, () => now, async ms => {now += ms;});
  governor.responseLimits('host', new Headers({'x-rate-limit-limit': '2', 'x-rate-limit-interval': '1s'}));
  governor.failure('host', 10000);
  assert.equal(governor.pageBudget('host', 3), 1);
  await assert.rejects(governor.acquire('host', new AbortController().signal), {code: 'literature_provider_cooldown'});
  assert.equal(now, 0);
  now = 10001;
  (await governor.acquire('host', new AbortController().signal))();
  for (let i = 0; i < 10; i++) governor.success('host');
  assert.equal(governor.observe('host').minIntervalMs, 500);
  assert.equal(governor.pageBudget('host', 3), 3);
});
