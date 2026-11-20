import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
let api;
before(async () => {api=await loadResearchTestApi();});
after(() => api?.dispose());

test('production-style configuration polling regenerates without source notification and stops at shutdown', {timeout:5000}, async () => {
  const f = createResearchFixture(api,'reading'), cards = f.repository.paperCards;
  let revision = 'model1', calls = 0, generated;
  const changed = new Promise(resolve => {generated=resolve;});
  try {
    cards.start(async (_title,blocks) => {
      calls++;
      if (revision === 'model2') generated();
      return {sections:['problem','contribution','method','experimental_setup','results','limitations']
        .map(role => ({role,body:'Original reading.',chunkIds:[blocks[0].source.chunkId]}))};
    }, {versions:() => ({extractorVersion:'extractor1',promptVersion:'prompt1',modelRevision:revision,outputSchemaVersion:1}),pollMs:5});
    const source = {id:'source',projectId:f.project.id,sourceType:'file',sourceId:'source.pdf',title:'Original',
      content:'Original result.',embeddingPolicy:'none',chunks:[{content:'Original result.',locator:'PDF page 1',
        semantic:{paperId:'paper',parseId:'parse1',sourceHash:'a'.repeat(64),blockId:'original-page',
          sectionPath:['Results'],semanticRole:'results',blockKind:'paragraph',relatedBlockIds:[]}}]};
    f.repository.knowledge.upsertFromSource(source,{fileId:'document',parseId:'parse1',sourceHash:'a'.repeat(64)});
    f.repository.queueKnowledgeFromSource(source); f.repository.flushKnowledgeFromSource();
    await cards.idle();
    revision = 'model2';
    await changed; await cards.idle();
    assert.equal(calls,2);
    assert.equal(f.db.prepare('SELECT status FROM research_paper_cards').pluck().get(),'ready');
    await cards.shutdown();
    revision = 'model3'; cards.wake(); await cards.idle();
    assert.equal(calls,2);
    assert.throws(() => cards.start(async () => null),/wiki_paper_cards_closed/);
  } finally {await cards.shutdown(); await f.repository.wiki.shutdown(); f.close();}
});
