import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

test('section search retrieves semantic synonyms, isolates projects and revisions, and never writes original evidence', async () => {
  const api = await loadResearchTestApi();
  const {ResearchEmbeddingService} = await importTypeScriptModule('src/main/plugins/research/embedding-service.ts', {platform: 'node'});
  const f = createResearchFixture(api, 'reading'), wiki = f.repository.wiki, knowledge = f.repository.knowledge;
  let calls = 0, fail = false, hold = null, started = null;
  const service = new ResearchEmbeddingService(knowledge, {embed: async ({texts}) => {
    calls++;
    if (fail) throw new Error('fixture_provider_unavailable');
    if (hold && texts.length === 1 && texts[0] === 'component usefulness') {started(); await hold;}
    return texts.map(text => /ablation|组件有效性|component usefulness/iu.test(text) ? [1, 0] : [0, 1]);
  }}, {secrets: {get: async () => 'fixture-key'}, logger: {warn() {}}});
  const config = {id: 'fixture', name: 'fixture', baseUrl: 'https://fixture.invalid', model: 'fixture', dimensions: 2, enabled: true};
  try {
    knowledge.upsertFromSource({id: 'original', projectId: f.project.id, sourceType: 'experiment', sourceId: 'original',
      title: 'Original', content: 'Exact original record.', chunks: [{content: 'Exact original record.', locator: 'row:1'}], embeddingPolicy: 'none'});
    const evidence = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'original:chunk:0'});
    let page = wiki.create({projectId: f.project.id, kind: 'topic', title: 'Component evaluation', evidenceIds: [evidence.id], claimIds: []});
    await wiki.idle(); page = wiki.read(f.project.id, page.page.id);
    const save = body => {
      page = wiki.save({projectId: f.project.id, pageId: page.page.id, expectedRevision: page.page.revision,
        expectedBasisDigest: page.basisDigest, section: {id: 'analysis', title: '实验预算', body,
          evidenceIds: [evidence.id], claimIds: [], links: []}}, 'assistant');
    };
    save('The ablation study evaluates whether each component is effective.');
    assert.equal((await wiki.search(f.project.id, '实验预算')).pages[0].matches[0].sectionId, 'analysis');
    assert.equal((await wiki.search(f.project.id, '组件有效性的消融证据')).degradation, 'config_missing');
    knowledge.saveEmbeddingConfig(config, 'fixture-key');
    wiki.configureSearch(service); await wiki.navigation.idle();
    let result = await wiki.search(f.project.id, '组件有效性的消融证据');
    assert.equal(result.mode, 'hybrid'); assert.equal(result.degradation, null);
    assert.equal(result.pages[0].id, page.page.id); assert.equal(result.pages[0].matches[0].sectionId, 'analysis');
    const previousCalls = calls;
    await wiki.search(f.project.id, '组件有效性的消融证据'); assert.equal(calls, previousCalls);
    const other = f.repository.createProject({title: 'Other', description: '', workspacePath: '/tmp/wiki-search-other'});
    assert.equal((await wiki.search(other.id, '组件有效性的消融证据')).pages.length, 0);
    knowledge.saveEmbeddingConfig({...config, model: 'next-model'}, 'fixture-key');
    result = await wiki.search(f.project.id, '组件有效性的消融证据');
    assert.equal(result.degradation, 'index_pending'); assert.equal(result.pages.length, 0);
    await wiki.navigation.idle();
    assert.equal((await wiki.search(f.project.id, '组件有效性的消融证据')).pages[0].id, page.page.id);
    fail = true;
    result = await wiki.search(f.project.id, 'ablation unavailable');
    assert.equal(result.degradation, 'embedding_failed'); assert.equal(result.mode, 'bm25');
    assert.equal(result.pages[0].id, page.page.id); fail = false;
    let release;
    hold = new Promise(resolve => {release = resolve;});
    const began = new Promise(resolve => {started = resolve;});
    const pending = wiki.search(f.project.id, 'component usefulness'); await began;
    save('Clinical cohort analysis with a new methodology.');
    release(); result = await pending;
    assert.equal(result.pages.length, 0);
    assert.equal((await wiki.search(f.project.id, 'ablation')).pages.some(hit => hit.id === page.page.id), false);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_evidence').pluck().get(), 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_knowledge_documents').pluck().get(), 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_evidence_relations').pluck().get(), 0);
  } finally {await wiki.shutdown(); await service.shutdown(); f.close(); api.dispose();}
});
