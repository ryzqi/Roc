import { hash, sha256 } from '../../lib/common.mjs';

// Original synthetic prose, deliberately Draft. These tasks exercise ingestion,
// source scopes, evidence chains and refusal; they are not a reviewed benchmark.
export function ragEngineeringCorpus() {
  const documents = [];
  function source(id, title, sections, { sourceId = id, version = 'v1', current = true, projectId = 'rag-fixture-project' } = {}) {
    const content = sections.join('\n\n');
    let offset = 0;
    const blocks = sections.map(section => {
      const block = { coordinateSystem: 'utf16', startOffset: offset, endOffset: offset + section.length, section: 'Results' };
      offset = block.endOffset + 2;
      return block;
    });
    const document = { id, projectId, sourceId, sourceVersion: version,
      sourceUri: `fixture:${id}`, license: 'CC0-1.0', parserVersion: 'synthetic-text-utf16-v1',
      current, sourceType: 'literature', title, content, contentSha256: sha256(content), blocks };
    documents.push(document);
    return document;
  }
  const orion = source('orion', 'Synthetic Orion', ['The Orion yield was 42 units.', 'The control label was blue.']);
  const nova = source('nova', 'Synthetic Nova', ['The Nova dose was 7 milligrams.']);
  const cedar = source('cedar', 'Synthetic Cedar', ['The Cedar follow-up enrolled 12 subjects.', 'The Cedar follow-up lasted 6 weeks.']);
  const lumen = source('lumen', 'Synthetic Lumen', ['The Lumen algorithm used linear interpolation.', 'The Lumen algorithm achieved 83 percent accuracy.']);
  const iris = source('iris', 'Synthetic Iris', ['The Iris mass was 14 grams.']);
  const hazel = source('hazel', 'Synthetic Hazel', ['The Hazel field site was at 18 metres elevation.']);
  const vegaA = source('vega-a', 'Synthetic Vega-A', ['The Vega-A capacity was 45 units.']);
  const vegaB = source('vega-b', 'Synthetic Vega-B', ['The Vega-B capacity was 51 units.']);
  const borealA = source('boreal-a', 'Synthetic Boreal-A', ['The Boreal-A efficiency was 70 percent.']);
  const borealB = source('boreal-b', 'Synthetic Boreal-B', ['The Boreal-B efficiency was 75 percent.']);
  const atlasOld = source('atlas-old', 'Synthetic Atlas obsolete', ['The Atlas pressure was 5 pascals.'], { sourceId: 'atlas', version: 'v0', current: false });
  const atlas = source('atlas', 'Synthetic Atlas current', ['The Atlas pressure was 9 pascals.']);
  const deltaOld = source('delta-old', 'Synthetic Delta obsolete', ['The Delta calibration used a copper reference.'], { sourceId: 'delta', version: 'v0', current: false });
  const delta = source('delta', 'Synthetic Delta current', ['The Delta calibration used a quartz reference.']);
  source('private-orion', 'Unauthorized synthetic Orion', ['The Orion yield was 999 units.'], { projectId: 'another-fixture-project' });
  function task(id, category, visible, gold) {
    const evidence = gold.map(([document, index], i) => {
      const locator = document.blocks[index];
      return { id: `${id}-e${i}`, sourceId: document.sourceId, sourceVersion: document.sourceVersion,
        sourceSha256: document.contentSha256, parserVersion: document.parserVersion, locator,
        evidenceTextSha256: sha256(document.content.slice(locator.startOffset, locator.endOffset)), relevance: 3 };
    });
    return { id, category, split: 'development', visible,
      expected: { answerability: gold.length ? 'answerable' : 'unanswerable',
        answers: gold.length ? [gold.map(([document, index]) => {
          const block = document.blocks[index]; return document.content.slice(block.startOffset, block.endOffset);
        }).join(' ')] : [], evidence, evidenceChains: evidence.length ? [evidence.map(e => e.id)] : [] },
      review: { status: 'draft', annotations: [], arbitration: null } };
  }
  return { schemaVersion: 1, id: 'roc-rag-engineering-v1', modality: 'text-native',
    provenance: { kind: 'engineering_fixture', producer: 'roc-engineering-fixture',
      createdAt: '2026-11-14T00:00:00Z', sourceRevision: 'synthetic-v1', license: 'CC0-1.0' }, documents,
    tasks: [
      task('orion-yield', 'single-paper', { question: 'For Orion, return the sentence about yield.', documentIds: [orion.id] }, [[orion, 0]]),
      task('nova-dose', 'single-paper', { question: 'For Nova, return the sentence about dose.', documentIds: [nova.id] }, [[nova, 0]]),
      task('cedar-follow-up', 'evidence-chain', { question: 'For Cedar, return all sentences about follow-up.', documentIds: [cedar.id] }, [[cedar, 0], [cedar, 1]]),
      task('lumen-algorithm', 'evidence-chain', { question: 'For Lumen, return all sentences about algorithm.', documentIds: [lumen.id] }, [[lumen, 0], [lumen, 1]]),
      task('iris-temperature', 'unanswerable', { question: 'For Iris, return all sentences about temperature.', documentIds: [iris.id] }, []),
      task('hazel-wavelength', 'unanswerable', { question: 'For Hazel, return all sentences about wavelength.', documentIds: [hazel.id] }, []),
      task('vega-capacity', 'cross-paper', { question: 'For Vega-A and Vega-B, return all sentences about capacity.', documentIds: [vegaA.id, vegaB.id] }, [[vegaA, 0], [vegaB, 0]]),
      task('boreal-efficiency', 'cross-paper', { question: 'For Boreal-A and Boreal-B, return all sentences about efficiency.', documentIds: [borealA.id, borealB.id] }, [[borealA, 0], [borealB, 0]]),
      task('atlas-current', 'conflict-stale', { question: 'For Atlas, return the current sentence about pressure.', documentIds: [atlas.id, atlasOld.id] }, [[atlas, 0]]),
      task('delta-current', 'conflict-stale', { question: 'For Delta, return the current sentence about calibration.', documentIds: [delta.id, deltaOld.id] }, [[delta, 0]])
    ] };
}
export function ragEngineeringCompletion(body) {
  const prompt = body.messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
  const question = prompt.split('Question:').at(-1).trim();
  const documentIds = JSON.parse(/Available document IDs: ([^\n]+)/u.exec(prompt)?.[1] ?? '[]');
  const subject = /sentences? about ([^.]+)\./u.exec(question)?.[1]?.toLowerCase();
  const tools = body.messages.filter(m => m.role === 'tool').map(m => ({ ...m, value: JSON.parse(m.content) }));
  const search = tools.find(m => Array.isArray(m.value.hits)), contexts = tools.filter(m => m.value.context);
  let message;
  if (!search) {
    message = { role: 'assistant', content: null, tool_calls: [{
      id: 'fixture-search', type: 'function', function: { name: 'research_search_knowledge',
        arguments: JSON.stringify({ query: question, limit: 20 }) }
    }] };
  } else if (search.value.hits.some(hit => documentIds.includes(hit.documentId)) && !contexts.length) {
    message = { role: 'assistant', content: null, tool_calls: search.value.hits.filter(hit => documentIds.includes(hit.documentId)).map((hit, index) => ({
      id: `fixture-context-${index}`, type: 'function', function: { name: 'research_read_knowledge_context',
        arguments: JSON.stringify({ chunkId: hit.chunkId, expectedIndexedVersion: hit.indexedVersion, maxChars: 6000, neighbors: false }) }
    })) };
  } else {
    const cited = contexts.map(m => ({ chunkId: m.value.context.chunkId,
      sentences: m.value.context.content.split(/(?<=\.)\s+/u).filter(sentence => subject && sentence.toLowerCase().includes(subject)) }))
      .filter(item => item.sentences.length);
    const answer = [...new Set(cited.flatMap(c => c.sentences))].join(' ') || 'Unanswerable';
    message = { role: 'assistant', content: JSON.stringify({ answer, evidence: [...new Set(cited.map(c => c.chunkId))], abstain: answer === 'Unanswerable' }) };
  }
  return { id: `rag-fixture-${hash(body.messages).slice(0, 16)}`, object: 'chat.completion', model: body.model, created: 0,
    choices: [{ index: 0, finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
}
