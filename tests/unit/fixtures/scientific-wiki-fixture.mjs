import {scientificSearchFixture} from './scientific-search-fixture.mjs';

export function scientificWikiCandidates(ir) {
  const table = ir.tables[0], cell = text => {
    const value = table.cells.find(item => item.text === text);
    return {kind: 'table_cell', tableId: table.id, cellId: value.id, raw: value.text};
  };
  const conditions = {datasetId: null, datasetVersion: 'unknown', split: 'unknown', metricId: null,
    baselineId: null, budget: 'unknown', other: {}};
  return {
    entities: [
      {id: 'method', entityType: 'Method', canonicalName: 'Original baseline', aliases: [],
        attributes: {description: null}, evidence: [cell('Original baseline')]},
      {id: 'metric', entityType: 'Metric', canonicalName: 'F1', aliases: [],
        attributes: {definition: null, direction: 'unknown', unit: '%'}, evidence: [cell('F1 (%)')]},
      {id: 'experiment', entityType: 'Experiment', canonicalName: 'Original baseline', aliases: [],
        attributes: {configuration: null, conditions: {}}, evidence: [cell('Original baseline')]}
    ],
    facts: [
      {id: 'result', factType: 'experimental_result', subjectEntityId: 'method', predicate: 'Reported F1',
        objectEntityId: null, value: {raw: '90', unit: null, unitEvidence: []},
        conditions: {...conditions, metricId: 'metric'}, table: {tableId: table.id, row: 1, cellId: cell('90').cellId},
        conditionEvidence: [{field: 'metricId', key: null, evidence: [cell('F1 (%)')]}],
        evidence: [cell('90'), cell('Original baseline')], confidence: .8},
      {id: 'component', factType: 'method_component', subjectEntityId: 'method', predicate: 'Original baseline',
        objectEntityId: null, value: null, conditions, conditionEvidence: [], table: null,
        evidence: [cell('Original baseline')], confidence: .8}
    ],
    relations: [{id: 'evaluates', type: 'EVALUATES_WITH', fromEntityId: 'experiment', toEntityId: 'metric',
      factIds: ['result'], evidence: [cell('Original baseline'), cell('F1 (%)')]}]
  };
}
export async function scientificWikiFixture(api, services) {
  const f = await scientificSearchFixture(api, {embedded: false, image: true});
  let selected = 'selected-model/1', revision = 'handle/1';
  f.service = new services.ScientificExtractionService(f.repository, {library: f.root, index: null}, async () => ({
    config: {extractorVersion: 'roc-scientific-knowledge/1', promptVersion: 'prompt/1',
      model: {provider: 'fixture', modelId: 'fixture', model: 'fixture', revision}, inputTokens: 16000, batchTokens: 8000},
    invoke: async () => {throw new Error('no extraction inference in Wiki synthesis tests');}
  }), () => selected, {pollMs: 60000});
  f.wiki = f.repository.wiki;
  f.wiki.configureKnowledge({
    state: (projectId, documentId) => f.service.wikiKnowledgeState(projectId, documentId),
    read: (projectId, ref, signal) => f.service.readPaperCard({projectId, ...ref}, signal)
  });
  f.switchModel = () => {selected = 'selected-model/2'; revision = 'handle/2';};
  f.publishKnowledge = async (force = false) => {
    let job = await f.service.enqueue({projectId: f.project.id, documentId: f.document.id});
    if (force) job = f.repository.scientificExtraction.enqueue(job.snapshot, f.ir, true);
    f.repository.scientificExtraction.claim(job.id, f.project.id);
    return f.repository.scientificExtraction.publish(job.id, f.project.id, scientificWikiCandidates(f.ir), f.ir, () => job.snapshot);
  };
  f.readKnowledge = () => f.service.readPaperCard({projectId: f.project.id, documentId: f.document.id, generationId: null});
  f.saveInput = (page, section) => ({projectId: f.project.id, pageId: page.page.id,
    expectedRevision: page.page.revision, expectedBasisDigest: page.basisDigest, section});
  f.synthesisInput = (page, sectionIds = ['results']) => ({projectId: f.project.id, pageId: page.page.id,
    expectedRevision: page.page.revision, expectedBasisDigest: page.basisDigest, sectionIds});
  f.stalePage = async (sectionIds = ['results']) => {
    const job = await f.publishKnowledge();
    let page = await f.wiki.createCurrent({projectId: f.project.id, title: 'Scientific topic', kind: 'topic',
      evidenceIds: [], claimIds: [], paperKnowledgeSources: [{documentId: f.document.id, generationId: job.id}]});
    await f.wiki.idle(); page = await f.wiki.readCurrent(f.project.id, page.page.id);
    for (const id of sectionIds) page = await f.wiki.saveCurrent(f.saveInput(page, {
      id, title: id, body: 'Old unreviewed interpretation 9999 must not be model evidence.',
      evidenceIds: [], claimIds: [], links: [], paperKnowledgeSources: page.current.sections[0].paperKnowledgeSources
    }), 'assistant');
    page = api.withResearchHumanContext({capability: 'research.wiki.save', projectId: f.project.id, windowId: 42},
      () => f.wiki.save(f.saveInput(page, {id: 'human', title: 'Human note', body: 'Keep the human note.',
        evidenceIds: [], claimIds: [], links: []}), 'human'));
    f.oldRevision = page.page.revision;
    f.oldBytes = f.db.prepare('SELECT snapshot_json FROM research_wiki_revisions WHERE page_id=? AND revision=?')
      .pluck().get(page.page.id, f.oldRevision);
    await f.publishKnowledge(true); await f.wiki.idle();
    return await f.wiki.readCurrent(f.project.id, page.page.id);
  };
  f.finish = async () => {
    await f.service.shutdown(); await f.repository.paperCards.shutdown(); await f.wiki.shutdown(); await f.close();
  };
  return f;
}
export function wikiModelFactory(invoke, {contextWindowTokens = 32000, maxOutputTokens = 4000, stamp} = {}) {
  return {
    ...(stamp ? {defaultChatModelStamp: stamp} : {}),
    createDefaultChatModel: async () => ({
      runtime: {contextWindowTokens, maxOutputTokens},
      model: {withStructuredOutput: (schema, options) => ({invoke: async (messages, {signal}) =>
        await invoke({schema, options, messages, signal})})}
    })
  };
}

/** Controlled provider responses exercise the host protocol; they are not model quality evidence. */
export function wikiExplanationFixture(call, kind = 'paraphrase') {
  const input = JSON.parse(call.messages[1].content);
  if (call.options.name === 'wiki_scientific_explanation') return {sections: input.plan.sections.map(section => ({
    id: section.id, statements: [{text: '此解释依据所选原始来源，科学结论仍需人工核验。', kind, references: section.statements}]
  }))};
  if (call.options.name === 'wiki_scientific_support') return {reviews: input.draft.sections.flatMap(section =>
    section.statements.map((_, statementIndex) => ({sectionId: section.id, statementIndex, support: 'uncertain'})))};
  return null;
}
