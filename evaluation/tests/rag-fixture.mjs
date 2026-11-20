import { hash, sha256 } from '../lib/common.mjs';

export function ragFixture() {
  const content = 'Orion experiment\nThe measured Orion yield was 42 units.\nThe unrelated control used a blue label.';
  const document = { id: 'orion', projectId: 'project-one', sourceId: 'paper-orion', sourceVersion: 'v1',
    sourceUri: 'fixture:paper-orion', license: 'CC0-1.0', parserVersion: 'fixture-text-v1',
    current: true, sourceType: 'literature', title: 'Orion experiment', content, contentSha256: sha256(content),
    blocks: [{ coordinateSystem: 'utf16', startOffset: 0, endOffset: content.length, section: 'Results' }] };
  const quote = 'The measured Orion yield was 42 units.', startOffset = content.indexOf(quote);
  const evidence = { id: 'orion-yield', sourceId: document.sourceId, sourceVersion: document.sourceVersion,
    sourceSha256: document.contentSha256, parserVersion: document.parserVersion,
    locator: { coordinateSystem: 'utf16', startOffset, endOffset: startOffset + quote.length, section: 'Results' },
    evidenceTextSha256: sha256(quote), relevance: 3 };
  const task = { id: 'orion-yield', category: 'single-paper', split: 'development',
    visible: { question: 'What was the measured Orion yield?', documentIds: [document.id] },
    expected: { answerability: 'answerable', answers: ['42 units'], evidence: [evidence],
      evidenceChains: [[evidence.id]] }, review: { status: 'draft', annotations: [], arbitration: null } };
  return { schemaVersion: 1, id: 'rag-engineering-unit', modality: 'text-native',
    provenance: { kind: 'engineering_fixture', producer: 'roc-evaluator-tests',
      createdAt: '2026-11-14T00:00:00Z', sourceRevision: 'fixture-v1', license: 'CC0-1.0' },
    documents: [document], tasks: [task] };
}

// This controlled transport reads only the actual model-visible tool messages.
// It receives neither the dataset nor Task.expected and tests wiring, not model quality.
export function ragFixtureCompletion(body) {
  const tools = body.messages.filter(message => message.role === 'tool').map(message => ({
    ...message, value: JSON.parse(message.content)
  }));
  const search = tools.find(message => Array.isArray(message.value.hits));
  const contexts = tools.filter(message => message.value.context);
  let message;
  if (!search) {
    const prompt = body.messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
    const question = prompt.split('Question:').at(-1).trim();
    message = { role: 'assistant', content: null, tool_calls: [{
      id: 'fixture-rag-search', type: 'function',
      function: { name: 'research_search_knowledge', arguments: JSON.stringify({ query: question, limit: 20 }) }
    }] };
  } else if (search.value.hits.length && !contexts.length) {
    message = { role: 'assistant', content: null, tool_calls: search.value.hits.map((hit, index) => ({
      id: `fixture-rag-context-${index}`, type: 'function',
      function: { name: 'research_read_knowledge_context', arguments: JSON.stringify({
        chunkId: hit.chunkId, expectedIndexedVersion: hit.indexedVersion, maxChars: 6000, neighbors: false
      }) }
    })) };
  } else {
    const text = contexts.map(m => m.value.context.content).join('\n');
    const answer = /The measured Orion yield was ([^.]+)\./u.exec(text)?.[1] ?? 'Unanswerable';
    message = { role: 'assistant', content: JSON.stringify({
      answer, evidence: answer === 'Unanswerable' ? [] : contexts.map(m => m.value.context.chunkId),
      abstain: answer === 'Unanswerable'
    }) };
  }
  return { id: `fixture-${hash(body.messages).slice(0, 16)}`, object: 'chat.completion', created: 0, model: body.model,
    choices: [{ index: 0, finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
}
