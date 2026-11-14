import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, hash, readJson, sha256, writeJson } from '../../lib/common.mjs';
import { durableJson, inspectTrialSeal } from '../../lib/lifecycle.mjs';
import { openRagEnvironment } from './environment.mjs';
import { verifyRagComponent } from './verification.mjs';

export function researchReference(dataset, task, directory, retrievalProvider = { embedding: null, reranker: null }) {
  const sources = readJson(join(dataset.root, 'corpus.json')).documents;
  const projectId = sources.find(source => task.visible.documentIds.includes(source.id) && source.projectId !== null)?.projectId
    ?? 'evaluation-project';
  return { projectId, databasePath: join(directory, 'research.sqlite'), sources, retrievalProvider };
}
export function componentRequest(task, research) {
  return { query: task.visible.question, projectId: research.projectId, limit: 20, embeddingConfigId: null };
}
// All three model call kinds share one host-owned run budget. Production
// embedding/rerank clients do not expose usage, so their measurements stay null.
export function budgetRetrievalTransport(transport, execution, trial) {
  if (!transport) return undefined;
  let request = 0;
  const invoke = async (kind, input, signal, call) => {
    const configured = kind === 'embedding' ? transport.identity.embedding : transport.identity.reranker;
    if (!configured) fail('environment', `rag_${kind}_configuration_missing`);
    const requestId = `${kind}-${trial.traceId}-${++request}`, requestHash = hash({ kind, input });
    const providerId = kind === 'embedding' ? configured.id : 'roc-reranker';
    const correlation = { trialId: trial.trialId, requestId, requestHash };
    execution.budget.reserve({ ...correlation, kind, providerId, model: configured.model,
      inputTokens: Buffer.byteLength(JSON.stringify(input)) + 64, outputTokens: 0 });
    signal.throwIfAborted();
    execution.budget.dispatch(requestId, correlation);
    try {
      const raw = await call(correlation);
      const value = kind === 'rerank' ? { ...raw, correlation } : raw;
      execution.budget.settle(requestId, { inputTokens: null, outputTokens: 0 });
      const responseHash = hash(value);
      let evidence;
      if (kind === 'rerank') {
        // Retain the small score response once. The event carries ordered input
        // hashes, so the verifier can reconstruct it from frozen source text.
        const artifact = `rag-artifacts/${responseHash}.json`;
        writeJson(join(execution.root, trial.trialId, artifact), value);
        evidence = { artifact, artifactHash: responseHash, receipt: value.receipt,
          inputEvidence: { queryHash: hash(input.query), documentHashes: input.documents.map(sha256) },
          timeoutMs: configured.timeoutMs };
      }
      execution.lifecycle.record(trial, { type: 'retrieval_model_completed', ...correlation, kind,
        responseHash, usage: null, providerId, model: configured.model,
        configurationHash: configured.configurationHash, ...evidence });
      return value;
    } catch (error) {
      const state = execution.budget.snapshot({ trialId: trial.trialId }).reservations.find(value => value.requestId === requestId)?.state;
      if (state === 'dispatched') execution.budget.unknown(requestId, 'retrieval_transport_failed');
      if (error.failureClass) throw error;
      fail('provider', error.code ?? 'rag_retrieval_transport_failed');
    }
  };
  return { identity: transport.identity,
    embed: (texts, signal) => invoke('embedding', { texts }, signal, correlation => transport.embed(texts, signal, correlation)),
    rerank: (query, documents, signal) => invoke('rerank', { query, documents }, signal,
      correlation => transport.rerank(query, documents, signal, correlation)) };
}
export async function executeRagComponent({ dataset, task, directory, config, capability, transport, signal, record, lifecycle }) {
  durableJson(join(directory, 'component-schema.json'), capability.schemas);
  lifecycle('dispatched');
  const research = await openRagEnvironment({ dataset, task, directory, config, transport, signal, record });
  const request = componentRequest(task, research);
  try { await research.invoke('research.knowledge.search', request, 'component-search', signal); lifecycle('completed'); }
  finally { await research.close(); writeJson(join(directory, 'component-cleanup.json'), { hostClosed: true }); }
  const verified = verifyRagComponent({ directory, research, request });
  writeJson(join(directory, 'rag-verification.json'), verified.report);
  if (verified.report.status !== 'verified') fail('harness', `rag_component_evidence_invalid:${verified.report.reason}`);
  const metadata = { schemaVersion: 1, request, requests: 0, toolSchemaHash: hash(capability.schemas),
    ragVerification: { status: 'verified', contractHash: verified.report.contract.hash,
      evidenceHash: sha256(readFileSync(join(directory, 'rag-verification.json'))) } };
  durableJson(join(directory, 'component-result.json'), metadata);
  return { ...metadata, ragEvidence: verified.evidence };
}
export function recoverRagComponent({ dataset, task, directory, capability, retrievalProvider }) {
  inspectTrialSeal(directory, 'verified-evidence.json');
  const research = researchReference(dataset, task, directory, retrievalProvider), request = componentRequest(task, research);
  const metadata = readJson(join(directory, 'component-result.json'));
  const verified = verifyRagComponent({ directory, research, request });
  if (hash(request) !== hash(metadata.request) || verified.report.status !== 'verified'
    || hash(readJson(join(directory, 'component-schema.json'))) !== hash(capability.schemas)
    || metadata.toolSchemaHash !== hash(capability.schemas)
    || verified.report.contract.hash !== metadata.ragVerification?.contractHash
    || sha256(readFileSync(join(directory, 'rag-verification.json'))) !== metadata.ragVerification.evidenceHash) fail('state', 'resume_component_evidence_invalid');
  return { ...metadata, ragEvidence: verified.evidence };
}
