import { basename, dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { hash, readJson, sha256 } from '../../lib/common.mjs';
import { readEvents } from '../../lib/lifecycle.mjs';
import { artifactValue, ragContract, ragRetrievalContract, readRagState, verifyRagContext, verifyRagSearch } from './evidence.mjs';

const parseContent = value => {
  if (typeof value !== 'string') throw new Error('rag_tool_content_invalid');
  return JSON.parse(value);
};
// Reconstruct rerank inputs from independently verified source spans, then bind
// the original provider response to the final ranking and durable host budget.
// Neither provider text nor score arrays need to be copied into the journal.
export function verifyRerankerTransport({ directory, research, index, state, observations }) {
  const artifact = 'reranker-transport-receipts.json', path = join(directory, artifact);
  const receipts = readJson(path);
  if (!Array.isArray(receipts) || hash(index.retrievalProvider) !== hash(research.retrievalProvider)) {
    throw new Error('rag_retrieval_provider_binding_invalid');
  }
  const searches = observations.filter(value => value.name === 'research.knowledge.search');
  if (index.configuration.rerank === 'none') {
    if (receipts.length || searches.some(value => value.result.ranking.reranker.status !== 'not_requested')) {
      throw new Error('rag_unrequested_reranker_evidence');
    }
  } else {
    const configured = index.retrievalProvider.reranker;
    if (!configured || receipts.length !== searches.length) throw new Error('rag_reranker_evidence_missing');
    const events = readEvents(join(dirname(directory), 'events.jsonl'));
    const completions = events.filter(event => event.type === 'retrieval_model_completed'
      && event.kind === 'rerank' && event.trialId === basename(directory));
    if (completions.length !== receipts.length) throw new Error('rag_reranker_journal_binding_invalid');
    const chunks = new Map(state.chunks.map(chunk => [chunk.chunkId, chunk]));
    const sources = new Map(research.sources.map(source => [source.id, source]));
    const used = new Set();
    for (const [ordinal, receipt] of receipts.entries()) {
      const binding = receipt.correlation;
      const event = completions.find(value => value.requestId === binding?.requestId);
      const observation = searches.find(value => !used.has(value)
        && hash(value.result.ranking.reranker) === hash(receipt.receipt)
        && event?.inputEvidence?.queryHash === hash(value.request.query)
        && Array.isArray(event.inputEvidence.documentHashes)
        && hash([...event.inputEvidence.documentHashes].sort()) === hash(value.result.ranking.candidates.map(candidate => {
          const chunk = chunks.get(candidate.chunkId), source = sources.get(chunk?.documentId);
          if (!chunk || !source) throw new Error('rag_reranker_candidate_missing');
          return sha256(`Document: ${source.title}\n${source.content.slice(chunk.startOffset, chunk.endOffset).slice(0, 6000)}`);
        }).sort()));
      if (receipt.schemaVersion !== 1 || receipt.kind !== 'rerank' || receipt.sequence !== ordinal + 1
        || receipt.providerId !== 'roc-reranker' || receipt.configurationHash !== configured.configurationHash
        || receipt.timeoutMs !== configured.timeoutMs || receipt.usage !== null
        || receipt.receipt.model !== configured.model || receipt.receipt.configHash !== configured.configurationHash
        || !Number.isFinite(receipt.receipt.elapsedMs) || receipt.receipt.elapsedMs < 0
        || binding?.trialId !== basename(directory) || binding.requestHash !== receipt.requestHash
        || !event || !observation || event.requestHash !== receipt.requestHash || event.usage !== null
        || event.providerId !== receipt.providerId || event.model !== configured.model
        || event.configurationHash !== configured.configurationHash || event.timeoutMs !== configured.timeoutMs
        || hash(event.receipt) !== hash(receipt.receipt)
        || event.artifact !== `rag-artifacts/${event.responseHash}.json` || event.artifactHash !== event.responseHash) {
        throw new Error('rag_reranker_receipt_binding_invalid');
      }
      used.add(observation);
      const dispatches = events.filter(value => value.type === 'budget_dispatched'
        && value.requestId === binding.requestId && value.trialId === binding.trialId);
      const settlement = events.find(value => ['budget_settled', 'budget_unknown'].includes(value.type)
        && value.requestId === binding.requestId && value.sequence > dispatches[0]?.sequence
        && value.sequence < event.sequence);
      if (dispatches.length !== 1 || dispatches[0].kind !== 'rerank'
        || dispatches[0].requestHash !== receipt.requestHash || dispatches[0].providerId !== receipt.providerId
        || dispatches[0].model !== configured.model || !settlement) throw new Error('rag_reranker_budget_binding_invalid');
      const response = artifactValue(join(directory, event.artifact), event.artifactHash);
      if (hash(response.correlation) !== hash(binding) || hash(response.receipt) !== hash(receipt.receipt)
        || (response.scores !== null) !== (receipt.receipt.status === 'succeeded')
        || (response.scores !== null && (!Array.isArray(response.scores)
          || response.scores.some(score => !Number.isFinite(score) || score < 0 || score > 1)))) {
        throw new Error('rag_reranker_response_binding_invalid');
      }
      const candidates = observation.result.ranking.candidates.map(candidate => {
        const chunk = chunks.get(candidate.chunkId), source = sources.get(chunk?.documentId);
        if (!chunk || !source) throw new Error('rag_reranker_candidate_missing');
        const text = `Document: ${source.title}\n${source.content.slice(chunk.startOffset, chunk.endOffset).slice(0, 6000)}`;
        return { candidate, text, documentHash: sha256(text) };
      });
      const documentHashes = event.inputEvidence?.documentHashes;
      if (!Array.isArray(documentHashes) || documentHashes.length !== candidates.length
        || receipt.documentCount !== candidates.length || event.inputEvidence.queryHash !== hash(observation.request.query)
        || (response.scores !== null && response.scores.length !== candidates.length)) {
        throw new Error('rag_reranker_input_binding_invalid');
      }
      const remaining = [...candidates], documents = documentHashes.map((documentHash, position) => {
        // Identical source text is interchangeable; consume one matching score
        // binding at a time rather than inventing an identity for duplicates.
        const score = response.scores?.[position] ?? null;
        const match = remaining.findIndex(value => value.documentHash === documentHash
          && value.candidate.rerankScore === score);
        if (match < 0) throw new Error('rag_reranker_score_binding_invalid');
        return remaining.splice(match, 1)[0].text;
      });
      if (hash({ kind: 'rerank', input: { query: observation.request.query, documents } }) !== receipt.requestHash) {
        throw new Error('rag_reranker_input_hash_invalid');
      }
      if (response.scores !== null && candidates.some(({ candidate }, position) => {
        const previous = candidates[position - 1]?.candidate;
        return previous && (candidate.rerankScore > previous.rerankScore
          || candidate.rerankScore === previous.rerankScore && candidate.score > previous.score);
      })) throw new Error('rag_reranker_order_invalid');
    }
  }
  return { artifact, sha256: sha256(readFileSync(path)), receiptsHash: hash(receipts), requests: receipts.length };
}
// Component runs have no model or checkpoint. Bind their one host request to
// the persisted capability receipt and validate the index directly with SQL.
export function verifyRagComponent({ directory, research, request }) {
  const report = { schemaVersion: 1, contract: ragRetrievalContract, status: 'invalid', checks: [] };
  const check = (id, passed) => report.checks.push({ id, passed: Boolean(passed) });
  try {
    const state = readRagState(research.databasePath, research.sources), index = readJson(join(directory, 'rag-index.json'));
    const receipts = readJson(join(directory, 'rag-receipts.json'));
    const final = readJson(join(directory, 'rag-final-index.json'));
    check('component-contract', hash(index.contract) === hash(ragRetrievalContract));
    check('unchanged-source-index', hash(state) === index.indexHash && hash(index.state) === index.indexHash
      && final.unchanged === true && final.indexHash === index.indexHash);
    check('closed-component-host', readJson(join(directory, 'component-cleanup.json')).hostClosed === true);
    if (receipts.length !== 1 || receipts[0].name !== 'research.knowledge.search'
      || hash(receipts[0].request) !== hash(request) || receipts[0].toolCallId !== 'component-search') throw new Error('rag_component_request_invalid');
    const receipt = receipts[0];
    if (receipt.requestHash !== hash({ name: receipt.name, request, toolCallId: receipt.toolCallId })
      || receipt.indexHash !== index.indexHash) throw new Error('rag_receipt_request_invalid');
    const value = artifactValue(join(directory, receipt.artifact), receipt.artifactHash);
    verifyRagSearch(value, state, request, research.projectId);
    check('host-request-receipt-source-ranking-binding', true);
    report.rerankerEvidence = verifyRerankerTransport({ directory, research, index, state,
      observations: [{ ...receipt, result: value }] });
    check('provider-budget-source-reranker-binding', true);
    if (report.checks.every(c => c.passed)) {
      report.status = 'verified'; report.stateHash = hash(state); report.receiptsHash = hash(receipts);
      return { report, evidence: { state, observations: [{ ...receipt, result: value }], visibleSpans: [] } };
    }
    report.reason = report.checks.filter(c => !c.passed).map(c => c.id).join(',');
  } catch (error) { report.reason = String(error.message ?? error).slice(0, 320); }
  return { report, evidence: null };
}
export function searchView(result) {
  const versions = new Map(result.ranking.candidates.map(c => [c.chunkId, c.indexedVersion]));
  return { query: result.query, generatedAt: result.generatedAt, coverage: result.ranking.coverage,
    degradation: result.ranking.degradation ?? null, route: result.ranking.route, reranker: result.ranking.reranker.status,
    hits: result.hits.map(hit => ({ chunkId: hit.chunkId, documentId: hit.documentId, title: hit.title,
      content: hit.content.slice(0, 2000), contentChars: hit.content.length, semantic: hit.semantic,
      locator: hit.locator, sourceType: hit.sourceType, sourceId: hit.sourceId,
      indexedVersion: versions.get(hit.chunkId), score: hit.rrfScore })) };
}
function modelTools(directory) {
  const replies = readFileSync(join(directory, 'responses.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const requests = readFileSync(join(directory, 'transcript.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.type === 'request');
  const proposed = replies.flatMap(r => r.body.choices[0].message.tool_calls ?? []);
  if (new Set(proposed.map(t => t.id)).size !== proposed.length) throw new Error('rag_duplicate_proposed_tool_id');
  return { proposed, delivered: requests.flatMap(r => r.body.messages.filter(m => m.role === 'tool')),
    requests, replies };
}
export function verifyRagApplication({ directory, research }) {
  const report = { schemaVersion: 1, contract: ragContract, status: 'invalid', checks: [] };
  const check = (id, passed, observed) => report.checks.push({ id, passed: Boolean(passed), observed });
  try {
    const state = readRagState(research.databasePath, research.sources), index = readJson(join(directory, 'rag-index.json'));
    const receipts = readJson(join(directory, 'rag-receipts.json'));
    check('unchanged-source-index', hash(state) === index.indexHash && hash(index.state) === index.indexHash
      && readJson(join(directory, 'rag-final-index.json')).unchanged === true);
    const transport = modelTools(directory);
    const db = new Database(join(directory, 'worker/agent.sqlite'), { readonly: true, fileMustExist: true });
    let toolMessages;
    try {
      const checkpoint = db.prepare("SELECT checkpoint_blob FROM langgraph_checkpoints WHERE checkpoint_ns='' ORDER BY checkpoint_id DESC LIMIT 1").get();
      const messages = JSON.parse(checkpoint.checkpoint_blob.toString('utf8')).channel_values.messages;
      toolMessages = messages.filter(m => m?.lc === 1 && m.type === 'constructor'
        && hash(m.id) === hash(['langchain_core', 'messages', 'ToolMessage'])).map(m => m.kwargs);
    } finally { db.close(); }
    const observations = [], visibleSpans = [];
    const byId = new Map(state.chunks.map(c => [c.chunkId, c]));
    for (const receipt of receipts) {
      const tool = transport.proposed.find(t => t.id === receipt.toolCallId), args = tool ? JSON.parse(tool.function.arguments) : null;
      const expectedName = receipt.name === 'research.knowledge.search' ? 'research_search_knowledge' : 'research_read_knowledge_context';
      if (!args || tool.function.name !== expectedName) throw new Error('rag_receipt_proposal_missing');
      const expectedRequest = receipt.name === 'research.knowledge.search'
        ? { query: args.query.trim(), projectId: research.projectId, limit: args.limit ?? 6,
          ...(args.documentId ? { documentId: args.documentId } : {}), embeddingConfigId: null }
        : { chunkId: args.chunkId, expectedIndexedVersion: args.expectedIndexedVersion,
          maxChars: args.maxChars ?? 6000, neighbors: args.neighbors ?? true, projectId: research.projectId };
      const value = artifactValue(join(directory, receipt.artifact), receipt.artifactHash);
      if (hash(receipt.request) !== hash(expectedRequest) || receipt.requestHash !== hash({ name: receipt.name,
        request: receipt.request, toolCallId: receipt.toolCallId }) || receipt.indexHash !== index.indexHash) throw new Error('rag_receipt_request_invalid');
      const messages = toolMessages.filter(m => m.tool_call_id === receipt.toolCallId);
      const delivered = transport.delivered.filter(m => m.tool_call_id === receipt.toolCallId);
      const view = receipt.name === 'research.knowledge.search' ? searchView(value) : value;
      if (messages.length !== 1 || !delivered.length || hash(parseContent(messages[0].content)) !== hash(view)
        || delivered.some(m => hash(parseContent(m.content)) !== hash(view))
        || (receipt.name === 'research.knowledge.search' && hash(messages[0].artifact) !== hash(value.ranking))) throw new Error('rag_tool_checkpoint_transport_mismatch');
      if (receipt.name === 'research.knowledge.search') {
        verifyRagSearch(value, state, receipt.request, research.projectId);
        for (const hit of view.hits) {
          const chunk = byId.get(hit.chunkId);
          visibleSpans.push({ ...chunk, providedBy: receipt.toolCallId, startOffset: chunk.startOffset,
            endOffset: chunk.startOffset + hit.content.length });
        }
      } else {
        verifyRagContext(value, state, research.sources, receipt.request, research.projectId);
        for (const item of [value.context, ...value.neighbors]) {
          const parent = byId.get(item.parentChunkId);
          visibleSpans.push({ ...parent, chunkId: item.chunkId, providedBy: receipt.toolCallId,
            startOffset: parent.startOffset + item.start, endOffset: parent.startOffset + item.end });
        }
      }
      observations.push({ ...receipt, result: value });
    }
    check('unique-tool-receipts', new Set(receipts.map(r => r.toolCallId)).size === receipts.length
      && receipts.length === transport.proposed.length && toolMessages.length === receipts.length);
    check('proposal-receipt-checkpoint-model-binding', true, { receipts: receipts.length, toolMessages: toolMessages.length });
    report.rerankerEvidence = verifyRerankerTransport({ directory, research, index, state, observations });
    check('provider-budget-source-reranker-binding', true);
    if (report.checks.every(c => c.passed)) {
      report.status = 'verified'; report.stateHash = hash(state); report.receiptsHash = hash(receipts);
      return { report, evidence: { state, observations, visibleSpans } };
    }
    report.reason = report.checks.filter(c => !c.passed).map(c => c.id).join(',');
  } catch (error) {
    report.reason = String(error.message ?? error).slice(0, 320);
  }
  return { report, evidence: null };
}
