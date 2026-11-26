import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadScientificSearchApi} from './fixtures/scientific-search-fixture.mjs';
import {scientificWikiFixture, wikiModelFactory, wikiExplanationFixture} from './fixtures/scientific-wiki-fixture.mjs';

let api, services, pages, synthesis, structured, schemas;
before(async () => {
  [api, services, pages, synthesis, structured, schemas] = await Promise.all([loadScientificSearchApi(),
    ...['src/main/plugins/research/scientific-extraction-service.ts', 'src/main/plugins/research/wiki-scientific-pages.ts',
      'src/main/plugins/research/wiki-synthesis.ts', 'src/main/plugins/research/wiki-scientific-synthesis.ts',
      'src/shared/schemas/research-wiki-pages.ts'].map(path => importTypeScriptModule(path,
      {platform: 'node', external: ['@napi-rs/canvas'], tempDir: '.runtime/tmp'}))]);
});
after(() => api?.dispose());
const targets = page => page.current.sections.filter(section => section.id.startsWith('scientific:'));
async function create(f, kind = 'topic') {
  const job = await f.publishKnowledge();
  const created = await f.wiki.createCurrent({projectId: f.project.id, title: 'Attention Mechanism', kind,
    evidenceIds: [], claimIds: [], paperKnowledgeSources: [{documentId: f.document.id, generationId: job.id}]});
  await f.wiki.idle();
  return f.wiki.readCurrent(f.project.id, created.page.id);
}

test('a real scientific Topic seeds all nine source-bound sections and fills three through existing model/publication contracts', async () => {
  const f = await scientificWikiFixture(api, services);
  try {
    let page = await create(f);
    assert.equal(page.page.kind, 'topic');
    assert.deepEqual(targets(page).map(({id, title}) => ({id, title})), pages.scientificTopicTargets);
    const basis = {knowledge: [await f.readKnowledge()]};
    for (const section of targets(page)) {
      assert.equal(section.owner, 'assistant'); assert.equal(section.status, 'stale');
      assert.deepEqual(section.scientificStatements, [{kind: 'unknown'}]);
      assert.equal(section.dependencies[0].kind, 'paper_knowledge');
      structured.assertScientificWikiSection(section, basis);
    }
    const original = f.wiki.revision(f.project.id, page.page.id, page.page.revision);
    f.wiki.configureSynthesis(synthesis.createWikiSynthesizer(wikiModelFactory(async call => {
      const explanation = wikiExplanationFixture(call); if (explanation) return explanation;
      const input = JSON.parse(call.messages[1].content);
      return {sections: input.targets.map(target => ({id: target.id, goal: `Explain ${target.title}`, statements: [input.entries.find(entry =>
        target.id === 'scientific:mathematical' ? entry.kind === 'object' && entry.ref.objectType === 'Equation' :
        target.id === 'scientific:methods' ? entry.kind === 'entity' && entry.value.entityType === 'Method' :
        entry.kind === 'fact' && entry.value.factType === 'experimental_result').ref]}))};
    })));
    page = await f.wiki.resynthesize(f.synthesisInput(page,
      ['scientific:methods', 'scientific:mathematical', 'scientific:experiments']));
    assert.equal(targets(page).filter(section => section.status === 'current').length, 3);
    assert.match(targets(page).find(section => section.id === 'scientific:experiments').body, /原始数值：90/);
    assert.equal(targets(page).find(section => section.id === 'scientific:mathematical').body.includes(
      f.ir.equations[0].data.rawLatex), true);
    assert.deepEqual(f.wiki.revision(f.project.id, page.page.id, original.revision), original);
  } finally {await f.finish();}
});

test('recompilation preserves stable Topic identities, human content and historical bytes while source changes stale assistant content', async () => {
  const f = await scientificWikiFixture(api, services);
  try {
    let page = await create(f);
    const note = {...targets(page)[0], body: 'Human overview kept exactly.'};
    for (const key of ['owner', 'status', 'dependencies', 'scientificStatements']) delete note[key];
    page = api.withResearchHumanContext({capability: 'research.wiki.save', projectId: f.project.id, windowId: 42},
      () => f.wiki.save(f.saveInput(page, note), 'human'));
    const original = f.wiki.revision(f.project.id, page.page.id, page.page.revision);
    const job = await f.publishKnowledge(true);
    await f.wiki.idle();
    page = await f.wiki.readCurrent(f.project.id, page.page.id);
    assert.equal(targets(page).length, 9);
    assert.equal(targets(page).find(section => section.id === note.id).owner, 'human');
    assert.equal(targets(page).find(section => section.id === note.id).body, note.body);
    assert.equal(targets(page).filter(section => section.owner === 'assistant').every(section => section.status === 'stale'), true);
    assert.equal(page.current.sections.find(section => section.id.startsWith('knowledge:')).paperKnowledgeSources[0].generationId, job.id);
    assert.deepEqual(f.wiki.revision(f.project.id, page.page.id, original.revision), original);
    f.wiki.recompile(f.project.id, page.page.id, page.page.revision); await f.wiki.idle();
    assert.equal(targets(await f.wiki.readCurrent(f.project.id, page.page.id)).length, 9);
  } finally {await f.finish();}
});

test('scientific comparison/dispute retain their existing kinds and source sections; old revisions remain schema-readable', async () => {
  for (const kind of ['comparison', 'dispute']) {
    const f = await scientificWikiFixture(api, services);
    try {
      const page = await create(f, kind);
      assert.equal(page.page.kind, kind); assert.equal(targets(page).length, kind === 'comparison' ? 3 : 0);
      const source = page.current.sections.find(section => section.id.startsWith('knowledge:'));
      assert.ok(source); assert.equal(source.status, 'current');
      assert.equal(schemas.wikiRevisionSchema.safeParse(page.current).success, true);
      assert.equal(schemas.wikiSectionInputSchema.safeParse({
        id: 'old', title: 'Old draft', body: 'Original old content', evidenceIds: [], claimIds: [], links: []
      }).success, true);
      assert.equal(schemas.wikiCreateSchema.safeParse({projectId: f.project.id, title: 'New kind',
        kind: 'method', evidenceIds: ['e'], claimIds: []}).success, false);
    } finally {await f.finish();}
  }
});
