import assert from 'node:assert/strict';
import test from 'node:test';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
const {ReferenceCheckService, compareReference} = await importTypeScriptModule('src/main/plugins/research/reference-check-service.ts', {platform:'node'});
const {LiteratureSearchService} = await importTypeScriptModule('src/main/plugins/research/literature-service.ts', {platform:'node'});
const {referenceCheckReportSchema} = await importTypeScriptModule('src/shared/schemas/research-reference-check.ts');
const input = {doi:'10.1234/test', title:'A scientific study', authors:['Jane Smith'], year:2024};
const item = {id:'paper', revision:3, projectIds:['project'], bibliography:{...input, publishedYear:2024, citationKey:'Smith2024'}};
const repository = {getProject:()=>({id:'project'}), library:{get:()=>structuredClone(item)}};

test('DOI match is independent of wrong title/year; incomplete and CJK comparisons require review', () => {
  assert.equal(compareReference(input, input).verdict, 'consistent');
  const wrong = compareReference(input, {...input,title:'A different study',year:2023});
  assert.equal(wrong.identity, 'doi_match'); assert.equal(wrong.verdict, 'needs_review');
  assert.equal(wrong.fields.year, 'different');
  assert.equal(compareReference(input, {...input,authors:[]}).verdict, 'unknown');
  assert.equal(compareReference({...input,title:'研究甲'}, {...input,title:'研究乙'}).verdict, 'needs_review');
  assert.equal(compareReference(input, {...input,doi:'10.1234/other'}).identity, 'doi_mismatch');
});

test('real governed provider adapter retains hashes/cache/unknown retraction and never mutates bibliography', async () => {
  const urls=[];
  const providers = new LiteratureSearchService(async url => {
    urls.push(url);
    return Response.json(url.includes('crossref') ? {message:{DOI:input.doi,title:['Wrong title'],author:[{given:'Jane',family:'Smith'}],published:{'date-parts':[[2024]]}}} :
      {id:'https://openalex.org/W123',doi:input.doi,title:input.title,authorships:[{author:{display_name:'Jane Smith'}}],publication_year:2024});
  });
  try {
    const service = new ReferenceCheckService(repository, providers);
    const report = referenceCheckReportSchema.parse(await service.check({projectId:'project',ids:['paper']}));
    const [crossref,openalex] = report.results[0].observations;
    assert.equal(crossref.verdict,'needs_review'); assert.equal(openalex.verdict,'consistent');
    assert.equal(openalex.review.retraction.status,'unknown');
    assert.match(crossref.responseHash,/^[a-f0-9]{64}$/); assert.equal(urls.length,2);
    const second = await service.check({projectId:'project',ids:['paper']});
    assert.equal(second.results[0].observations[0].cache,'hit'); assert.equal(urls.length,2);
    assert.equal(item.bibliography.title,input.title);
    await assert.rejects(service.check({projectId:'foreign',ids:['paper']}), /project_mismatch/);
    assert.equal(urls.length,2);
  } finally {await providers.shutdown();}
});

test('missing DOI, provider failure and caller cancellation do not become passed checks', async () => {
  const providers = new LiteratureSearchService(async () => new Response('missing',{status:404}));
  try {
    const service=new ReferenceCheckService(repository,providers);
    const result=await service.check({projectId:'project',ids:['paper']});
    assert.equal(result.results[0].observations[0].status,'error');
    assert.equal(result.results[0].observations[0].verdict,'unknown');
    const missing=new ReferenceCheckService({...repository,library:{get:()=>({...item,metadata:{doi:null},bibliography:{...item.bibliography,doi:null}})}},providers);
    assert.equal((await missing.check({projectId:'project',ids:['paper']})).results[0].observations[0].errorCode,'doi_missing');
    const controller=new AbortController();controller.abort(new Error('test_cancelled'));
    await assert.rejects(service.check({projectId:'project',ids:['paper']},controller.signal),/test_cancelled/);
  } finally {await providers.shutdown();}
});

test('optional title lookup returns bounded review candidates and never confirms identity', async () => {
  const urls=[];
  const providers=new LiteratureSearchService(async url=>{
    urls.push(url);
    return Response.json(url.includes('crossref') ? {message:{items:Array.from({length:4},()=>({DOI:input.doi,title:[input.title],author:[{given:'Jane',family:'Smith'}],published:{'date-parts':[[2024]]}}))}} : {results:[]});
  });
  try {
    const service=new ReferenceCheckService({...repository,library:{get:()=>({...item,metadata:{doi:null},bibliography:{...item.bibliography,doi:null}})}},providers);
    const request={projectId:'project',ids:['paper']};
    await service.check(request); assert.equal(urls.length,0);
    const report=referenceCheckReportSchema.parse(await service.check({...request,titleSearch:true}));
    const observations=report.results[0].observations;
    assert.equal(observations.length,4);
    for(const candidate of observations.slice(0,3)) {
      assert.equal(candidate.lookup,'title_candidate'); assert.equal(candidate.identity,'unresolved');
      assert.equal(candidate.verdict,'needs_review'); assert.equal(candidate.titleSimilarity,1);
      assert.match(candidate.responseHash,/^[a-f0-9]{64}$/);
    }
    assert.equal(observations[3].errorCode,'no_candidates');
    assert.equal(observations[3].verdict,'unknown');
    assert.equal(new URL(urls[0]).searchParams.get('query.bibliographic'),`${input.title} Jane Smith`);
  } finally {await providers.shutdown();}
});
