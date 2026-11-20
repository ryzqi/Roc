import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadScientificSearchApi} from './fixtures/scientific-search-fixture.mjs';
import {scientificWikiFixture, scientificWikiCandidates} from './fixtures/scientific-wiki-fixture.mjs';
import {scientificComparisonFixture} from './fixtures/scientific-comparison-fixture.mjs';

let api, services;
before(async () => {
  [api, services] = await Promise.all([loadScientificSearchApi(),
    importTypeScriptModule('src/main/plugins/research/scientific-extraction-service.ts',
      {platform: 'node', external: ['@napi-rs/canvas'], tempDir: '.runtime/tmp'})]);
});
after(() => api?.dispose());
const request = (f, kind, fields = {}) => ({projectId: f.project.id, kind, ...fields});
const publish = async (f, candidates) => {
  let job = await f.service.enqueue({projectId: f.project.id, documentId: f.document.id});
  job = f.repository.scientificExtraction.enqueue(job.snapshot, f.ir, true);
  f.repository.scientificExtraction.claim(job.id, f.project.id);
  return f.repository.scientificExtraction.publish(job.id, f.project.id, candidates, f.ir, () => job.snapshot);
};

test('exact normalized names and aliases lead substring matches; paging retains each original candidate', async () => {
  const f = await scientificWikiFixture(api, services);
  try {
    const first = await f.publishKnowledge(), target = f.repository.scientificExtraction.bundle(first.id, f.project.id).entities[0];
    f.repository.scientificExtraction.putAlias({id: 'explicit-name', projectId: f.project.id, entityType: 'Method',
      alias: 'Original baseline', targetEntityId: target.id, canonicalName: target.canonicalName,
      revision: 1, createdBy: 'fixture-human'}, target);
    const candidates = scientificWikiCandidates(f.ir);
    candidates.entities.splice(1, 0, {...structuredClone(candidates.entities[0]), id: 'second-method'});
    const job = await publish(f, candidates), before = f.db.serialize(), bytes = await readFile(f.source);
    const query = request(f, 'entity', {query: 'ＯＲＩＧＩＮＡＬ ＢＡＳＥＬＩＮＥ', entityTypes: ['Method'], limit: 1});
    const page1 = await f.service.search(query);
    const page2 = await f.service.search({...query, offset: page1.nextOffset, basisDigest: page1.basisDigest});
    assert.equal(page1.hits[0].exactMatch, true);
    assert.equal(page2.hits[0].exactMatch, true);
    assert.deepEqual([page1.hits[0].value.candidateId, page2.hits[0].value.candidateId], ['method', 'second-method']);
    assert.equal(page1.hits[0].value.id, page2.hits[0].value.id);
    assert.equal(page2.nextOffset, null);
    assert.equal(page2.basisDigest, page1.basisDigest);
    const substring = await f.service.search(request(f, 'entity', {query: 'baseline'}));
    assert.equal(substring.hits.length, 3); assert.ok(substring.hits.every(hit => !hit.exactMatch));
    assert.deepEqual(substring.hits[0].source, {documentId: f.document.id, generationId: job.id});
    assert.deepEqual(f.db.serialize(), before); assert.deepEqual(await readFile(f.source), bytes);
    const fact = await f.service.search(request(f, 'fact', {factTypes: ['experimental_result']}));
    assert.equal(new Set(fact.hits[0].entities.map(entity => entity.id)).size, fact.hits[0].entities.length);
    assert.equal(fact.hits[0].value.value.raw, '90');
    const injection = await f.service.search(request(f, 'entity', {query: "' OR 1=1 --"}));
    assert.deepEqual(injection.hits, []);
  } finally {await f.finish();}
});

test('condition filters preserve complete raw Fact values, units, condition evidence and original locators', async () => {
  const f = await scientificComparisonFixture(api, services);
  try {
    const before = f.db.serialize(), knowledge = await f.readAll(), fact = knowledge[0].knowledge.facts[0];
    const result = await f.service.search(request(f, 'fact', {factTypes: ['experimental_result'],
      datasetId: fact.conditions.datasetId, metricId: fact.conditions.metricId, baselineId: fact.conditions.baselineId,
      datasetVersion: 'v1', split: 'test'}));
    assert.equal(result.hits.length, 3);
    assert.deepEqual(result.hits.map(hit => hit.value.value.raw).sort(), ['89', '90', '91']);
    assert.deepEqual(result.hits.find(hit => hit.source.documentId === f.papers[0].document.id).value, fact);
    assert.ok(result.hits[0].value.evidence[0].locator);
    assert.equal(result.hits[0].value.evidence[0].identity.documentId, result.hits[0].source.documentId);
    const method = knowledge[1].knowledge.entities.find(entity => entity.entityType === 'Model');
    const filtered = await f.service.search(request(f, 'fact', {methodId: method.id, query: 'METHOD B'}));
    assert.equal(filtered.hits.length, 1); assert.equal(filtered.hits[0].exactMatch, true);
    assert.equal(filtered.hits[0].value.value.raw, '90');
    for (const fields of [{split: 'train'}, {datasetVersion: 'v2'}, {methodId: fact.conditions.metricId}]) {
      assert.deepEqual((await f.service.search(request(f, 'fact', fields))).hits, []);
    }
    assert.deepEqual(f.db.serialize(), before);
  } finally {await f.finish();}
});

test('typed relations support endpoint direction and meaningful paginated neighbors', async () => {
  const f = await scientificWikiFixture(api, services);
  try {
    const job = await f.publishKnowledge(), bundle = f.repository.scientificExtraction.bundle(job.id, f.project.id);
    const relation = bundle.relations[0];
    const result = await f.service.search(request(f, 'relation', {relationTypes: ['EVALUATES_WITH'],
      entityId: relation.fromEntityId, query: 'F1', limit: 1}));
    assert.equal(result.hits.length, 1); assert.deepEqual(result.hits[0].value, relation);
    assert.equal(result.hits[0].exactMatch, true); assert.equal(result.hits[0].entities.length, 2);
    assert.deepEqual((await f.service.search(request(f, 'relation', {fromEntityId: relation.toEntityId}))).hits, []);
    assert.deepEqual((await f.service.search(request(f, 'relation', {relationTypes: ['USES']}))).hits, []);
  } finally {await f.finish();}
});

test('project, membership, archive and retired-publication boundaries isolate search', async () => {
  const f = await scientificWikiFixture(api, services);
  try {
    await f.publishKnowledge();
    const other = f.repository.createProject({title: 'Other project', description: '', workspacePath: '/tmp/knowledge-search-other'});
    assert.deepEqual((await f.service.search({...request(f, 'entity'), projectId: other.id})).hits, []);
    await assert.rejects(() => f.service.search({...request(f, 'entity'), projectId: other.id,
      documentIds: [f.document.id]}), /scope_invalid/);
    const result = await f.service.search(request(f, 'entity', {limit: 1}));
    f.db.prepare('DELETE FROM research_library_projects WHERE item_id=? AND project_id=?').run(f.document.libraryItemId, f.project.id);
    await assert.rejects(() => f.service.search(request(f, 'entity', {offset: 1, limit: 1, basisDigest: result.basisDigest})), /basis_changed/);
    assert.deepEqual((await f.service.search(request(f, 'entity'))).hits, []);
    f.db.prepare('INSERT INTO research_library_projects(item_id,project_id) VALUES (?,?)').run(f.document.libraryItemId, f.project.id);
    f.db.prepare("UPDATE research_paper_extraction_jobs SET publication='retired' WHERE document_id=?").run(f.document.id);
    assert.deepEqual((await f.service.search(request(f, 'entity'))).hits, []);
    f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    await assert.rejects(() => f.service.search(request(f, 'entity')), /archived|scope_invalid/);
  } finally {await f.finish();}
});

test('pagination refuses changed model, Alias, generation and selection bases; stale facts are explicit', async () => {
  const f = await scientificWikiFixture(api, services);
  try {
    await f.publishKnowledge();
    const query = request(f, 'entity', {limit: 1}), first = await f.service.search(query);
    await assert.rejects(() => f.service.search({...query, query: 'F1', offset: 1, basisDigest: first.basisDigest}), /basis_changed/);
    await f.publishKnowledge(true);
    await assert.rejects(() => f.service.search({...query, offset: 1, basisDigest: first.basisDigest}), /basis_changed/);
    const current = await f.service.search(query);
    f.switchModel();
    await assert.rejects(() => f.service.search({...query, offset: 1, basisDigest: current.basisDigest}), /basis_changed/);
    const stale = await f.service.search(request(f, 'fact'));
    assert.deepEqual(stale.hits, []); assert.equal(stale.unavailable[0].state, 'stale');
  } finally {await f.finish();}
});

test('independent human aliases resolve names and invalidate the captured pagination basis', async () => {
  const f = await scientificWikiFixture(api, services);
  try {
    const job = await f.publishKnowledge(), target = f.repository.scientificExtraction.bundle(job.id, f.project.id).entities[0];
    const first = await f.service.search(request(f, 'entity', {limit: 1}));
    const alias = {id: 'independent-alias', projectId: f.project.id, entityType: target.entityType,
      alias: 'Reviewed method name', targetEntityId: target.id, canonicalName: target.canonicalName,
      revision: 1, createdBy: 'fixture-human'};
    f.repository.scientificExtraction.putAlias(alias, target);
    await assert.rejects(() => f.service.search(request(f, 'entity',
      {limit: 1, offset: 1, basisDigest: first.basisDigest})), /basis_changed/);
    // Alias changes require a fresh extraction resolution; never return the old facts as current.
    const stale = await f.service.search(request(f, 'entity', {query: alias.alias}));
    assert.deepEqual(stale.hits, []); assert.equal(stale.unavailable[0].state, 'stale');
    await f.publishKnowledge(true);
    const resolved = await f.service.search(request(f, 'entity', {query: 'ＲＥＶＩＥＷＥＤ ＭＥＴＨＯＤ ＮＡＭＥ'}));
    assert.equal(resolved.hits.length, 1); assert.equal(resolved.hits[0].value.id, target.id);
    assert.equal(resolved.hits[0].exactMatch, true);
    const captured = resolved.basisDigest;
    f.repository.scientificExtraction.putAlias({...alias, revision: 2, alias: 'New reviewed name'}, resolved.hits[0].value);
    await assert.rejects(() => f.service.search(request(f, 'entity',
      {query: 'ＲＥＶＩＥＷＥＤ ＭＥＴＨＯＤ ＮＡＭＥ', basisDigest: captured})), /basis_changed/);
  } finally {await f.finish();}
});

test('explicit authorized documents without extraction or current index return missing and stale receipts', async () => {
  const f = await scientificWikiFixture(api, services);
  try {
    const input = request(f, 'fact', {documentIds: [f.document.id]});
    const missing = await f.service.search(input);
    assert.deepEqual(missing.hits, []);
    assert.deepEqual(missing.unavailable, [{documentId: f.document.id, state: 'missing', configurationError: null}]);
    await f.publishKnowledge();
    assert.equal((await f.service.search(input)).hits.length, 2);
    f.repository.scientificIndex.retireSource(null, f.document.id);
    const stale = await f.service.search(input);
    assert.deepEqual(stale.hits, []);
    assert.deepEqual(stale.unavailable, [{documentId: f.document.id, state: 'stale', configurationError: null}]);
    await assert.rejects(() => f.service.search({...input, basisDigest: missing.basisDigest}), /basis_changed/);
  } finally {await f.finish();}
});

test('cancellation during original source reads settles without returning data or writing state', async () => {
  const f = await scientificWikiFixture(api, services);
  try {
    await f.publishKnowledge();
    const read = f.service.read.bind(f.service), controller = new AbortController(), before = f.db.serialize();
    let release, entered;
    const pending = new Promise(resolve => {release = resolve;}), started = new Promise(resolve => {entered = resolve;});
    f.service.read = async (...args) => {entered(); await pending; return read(...args);};
    const search = f.service.search(request(f, 'fact'), controller.signal);
    await started;
    controller.abort(new Error('cancel-during-source-read'));
    release();
    await assert.rejects(() => search, /cancel-during-source-read/);
    assert.deepEqual(f.db.serialize(), before);
  } finally {await f.finish();}
});

test('original PDF changes during an asynchronous read and corrupt stored bundles refuse publication', async () => {
  const f = await scientificWikiFixture(api, services);
  try {
    const job = await f.publishKnowledge(), read = f.service.read.bind(f.service);
    let calls = 0;
    f.service.read = async (...args) => {
      const result = await read(...args);
      if (++calls === 1) await writeFile(f.source, Buffer.from(f.bytes).fill(0));
      return result;
    };
    await assert.rejects(() => f.service.search(request(f, 'fact')), /source_changed/);
    f.service.read = read; await writeFile(f.source, f.bytes);
    f.db.prepare("UPDATE research_paper_facts SET snapshot_hash=? WHERE generation_id=?").run('0'.repeat(64), job.id);
    await assert.rejects(() => f.service.search(request(f, 'fact')), /result_invalid/);
  } finally {await f.finish();}
});

test('changing an earlier original PDF after the last later-paper read still refuses all results', async () => {
  const f = await scientificComparisonFixture(api, services);
  try {
    const read = f.service.read.bind(f.service);
    let calls = 0;
    f.service.read = async (...args) => {
      const result = await read(...args);
      if (++calls === 6) await writeFile(f.papers[0].sourcePath, Buffer.from(f.papers[0].bytes).fill(0));
      return result;
    };
    await assert.rejects(() => f.service.search(request(f, 'fact')), /source_changed|basis_changed/);
  } finally {await f.finish();}
});

test('actual capability and SDK tools bind scope, carry cancellation and stay read-only in plan mode', async () => {
  const f = await scientificWikiFixture(api, services);
  try {
    await f.publishKnowledge();
    const registry = new api.CapabilityRegistry();
    for (const descriptor of api.researchWikiCapabilities) registry.declare('research', descriptor);
    api.registerResearchWikiCapabilities({pluginId: 'research', capabilities: registry}, f.wiki, f.repository.paperCards, f.service);
    const controller = new AbortController();
    const tools = api.createWikiTools({projectId: f.project.id, signal: controller.signal, capabilities: registry});
    const before = f.db.serialize(), visible = api.filterPlanModeModelTools(tools).map(tool => tool.name);
    for (const kind of ['entities', 'facts', 'relations']) {
      const name = `research_wiki_search_${kind}`, tool = tools.find(item => item.name === name);
      assert.ok(visible.includes(name));
      const call = args => tool.invoke({type: 'tool_call', id: 'search-test', name, args});
      const result = JSON.parse((await call({})).content);
      assert.equal(result.projectId, f.project.id); assert.equal(result.scientificApproval, 'unreviewed');
      await assert.rejects(() => call({projectId: 'foreign'}));
    }
    const adapter = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => registry.invoke(name, input)});
    const input = request(f, 'fact', {documentIds: [f.document.id]});
    const parsed = api.parseIpcRequestArgs('roc:research:wiki-knowledge-search', [input]);
    assert.equal(parsed[0].projectId, f.project.id); assert.equal(parsed[0].kind, 'fact');
    assert.throws(() => api.parseIpcRequestArgs('roc:research:wiki-knowledge-search', [{...input, entityTypes: ['Method']}]));
    assert.throws(() => api.parseIpcRequestArgs('roc:research:wiki-knowledge-search', [input, 42]));
    const bridge = await adapter.invoke('research.searchWikiKnowledge', [input], 42);
    assert.equal(bridge.ok, true); assert.equal(bridge.data.hits.length, 2);
    assert.equal(bridge.data.kind, 'fact'); assert.equal(bridge.data.projectId, f.project.id);
    assert.deepEqual(f.db.serialize(), before);
    controller.abort(new Error('cancel-knowledge-search'));
    await assert.rejects(() => tools.find(tool => tool.name === 'research_wiki_search_entities').invoke({}), /cancel-knowledge-search/);
  } finally {await f.finish();}
});
