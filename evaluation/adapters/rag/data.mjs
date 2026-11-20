import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CACHE, directory, fail, hash, sha256, writeJson } from '../../lib/common.mjs';
import { sealDataset } from '../../lib/data.mjs';

const text = z.string().trim().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const identifier = text.max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
export const ragCategories = ['single-paper', 'evidence-chain', 'unanswerable', 'cross-paper', 'conflict-stale'];
export const sourceLocatorSchema = z.strictObject({
  coordinateSystem: z.literal('utf16'), startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive(), section: z.string().nullable()
});
const evidenceSchema = z.strictObject({
  id: identifier, sourceId: identifier, sourceVersion: text, sourceSha256: digest,
  parserVersion: text, locator: sourceLocatorSchema, evidenceTextSha256: digest,
  relevance: z.number().int().min(1).max(3)
});
const reviewSchema = z.strictObject({
  status: z.enum(['draft', 'reviewed']),
  annotations: z.array(z.strictObject({
    reviewer: text, reviewedAt: z.iso.datetime(), contentHash: digest, judgmentHash: digest
  })),
  arbitration: z.strictObject({ reviewer: text, reviewedAt: z.iso.datetime(),
    contentHash: digest, resolution: text }).nullable()
});
export const ragCorpusSchema = z.strictObject({
  schemaVersion: z.literal(1), id: identifier, modality: z.literal('text-native'),
  provenance: z.strictObject({ kind: z.enum(['engineering_fixture', 'human_reviewed']), producer: text,
    createdAt: z.iso.datetime(), sourceRevision: text, license: text }),
  documents: z.array(z.strictObject({
    id: identifier, projectId: identifier.nullable(), sourceId: identifier, sourceVersion: text,
    sourceUri: text, license: text, parserVersion: text, current: z.boolean(),
    sourceType: z.enum(['literature', 'file', 'note', 'experiment']), title: text,
    content: text, contentSha256: digest,
    blocks: z.array(sourceLocatorSchema).min(1)
  })).min(1),
  tasks: z.array(z.strictObject({
    id: identifier, category: z.enum(ragCategories), split: z.enum(['development', 'holdout']),
    visible: z.strictObject({ question: text.max(32000), documentIds: z.array(identifier).min(1) }),
    expected: z.strictObject({ answerability: z.enum(['answerable', 'unanswerable']),
      answers: z.array(text), evidence: z.array(evidenceSchema),
      evidenceChains: z.array(z.array(identifier).min(1)) }),
    review: reviewSchema
  })).min(1)
});
function requireUnique(values, reason) {
  if (new Set(values).size !== values.length) fail('data', reason);
}
export function validateRagCorpus(value) {
  const corpus = ragCorpusSchema.parse(value);
  requireUnique(corpus.documents.map(d => d.id), 'rag_duplicate_document');
  requireUnique(corpus.tasks.map(t => t.id), 'rag_duplicate_task');
  const documents = new Map(corpus.documents.map(d => [d.id, d]));
  const currentSources = corpus.documents.filter(d => d.current).map(d => `${d.sourceId}\0${d.projectId}`);
  requireUnique(currentSources, 'rag_multiple_current_source_versions');
  for (const document of corpus.documents) {
    if (sha256(document.content) !== document.contentSha256) fail('data', 'rag_source_hash_mismatch');
    let previous = 0;
    for (const block of document.blocks) {
      if (block.startOffset < previous || block.endOffset <= block.startOffset || block.endOffset > document.content.length
        || !document.content.slice(block.startOffset, block.endOffset).trim()) fail('data', 'rag_source_locator_invalid');
      previous = block.endOffset;
    }
  }
  // Source-connected components are the independent units. A multi-paper question
  // joins its sources, including previous versions, before development/holdout split.
  const parents = new Map(corpus.documents.map(d => [d.sourceId, d.sourceId]));
  const root = id => {
    const parent = parents.get(id);
    if (parent !== id) parents.set(id, root(parent));
    return parents.get(id);
  };
  for (const task of corpus.tasks) {
    requireUnique(task.visible.documentIds, 'rag_duplicate_visible_document');
    const visible = task.visible.documentIds.map(id => documents.get(id));
    if (visible.some(d => !d)) fail('data', 'rag_visible_source_missing');
    const projectIds = new Set(visible.map(d => d.projectId).filter(id => id !== null));
    if (projectIds.size > 1) fail('data', 'rag_task_crosses_project_permissions');
    const ids = visible.map(d => d.sourceId).sort();
    for (const id of ids.slice(1)) parents.set(root(id), root(ids[0]));
    requireUnique(task.expected.evidence.map(e => e.id), 'rag_duplicate_gold_evidence');
    for (const evidence of task.expected.evidence) {
      const document = visible.find(d => d.sourceId === evidence.sourceId && d.sourceVersion === evidence.sourceVersion);
      if (!document || !document.current || document.contentSha256 !== evidence.sourceSha256
        || document.parserVersion !== evidence.parserVersion
        || evidence.locator.endOffset <= evidence.locator.startOffset || evidence.locator.endOffset > document.content.length
        || sha256(document.content.slice(evidence.locator.startOffset, evidence.locator.endOffset)) !== evidence.evidenceTextSha256) {
        fail('data', 'rag_gold_source_missing_or_changed');
      }
    }
    const answerable = task.expected.answerability === 'answerable';
    if (answerable !== Boolean(task.expected.answers.length) || answerable !== Boolean(task.expected.evidence.length)) {
      fail('data', 'rag_answerability_gold_mismatch');
    }
    for (const chain of task.expected.evidenceChains) {
      requireUnique(chain, 'rag_duplicate_chain_evidence');
      if (chain.some(id => !task.expected.evidence.some(e => e.id === id))) fail('data', 'rag_chain_gold_missing');
    }
    const contentHash = hash({ visible: task.visible, expected: task.expected });
    const review = task.review, reviewers = review.annotations.map(a => a.reviewer);
    requireUnique(reviewers, 'rag_duplicate_reviewer');
    if (review.status === 'reviewed') {
      if (corpus.provenance.kind !== 'human_reviewed' || reviewers.length < 2 || reviewers.includes(corpus.provenance.producer)
        || review.annotations.some(a => a.contentHash !== contentHash)) fail('data', 'rag_independent_reviews_required');
      if (new Set(review.annotations.map(a => a.judgmentHash)).size > 1 && (!review.arbitration
        || reviewers.includes(review.arbitration.reviewer) || review.arbitration.reviewer === corpus.provenance.producer
        || review.arbitration.contentHash !== contentHash)) fail('data', 'rag_review_arbitration_required');
    } else if (review.annotations.length || review.arbitration || task.split === 'holdout' || corpus.provenance.kind === 'human_reviewed') {
      fail('data', 'rag_unreviewed_holdout_or_claim');
    }
  }
  const splitByCluster = new Map();
  const tasks = corpus.tasks.map(task => {
    const sourceIds = task.visible.documentIds.map(id => documents.get(id).sourceId);
    const connected = root(sourceIds[0]), clusterId = `sources-${hash(connected).slice(0, 20)}`;
    if (splitByCluster.has(clusterId) && splitByCluster.get(clusterId) !== task.split) fail('data', 'rag_source_split_leakage');
    splitByCluster.set(clusterId, task.split);
    return { ...task, clusterId, unsupported: null };
  });
  return { ...corpus, tasks };
}
export async function prepareRag(value, { suite = 'rag-paper-qa', cacheRoot = CACHE } = {}) {
  if (!['rag-paper-qa', 'rag-retrieval'].includes(suite)) fail('policy', 'rag_dataset_suite_invalid');
  const bytes = typeof value === 'string' ? readFileSync(value) : Buffer.from(JSON.stringify(value));
  const corpus = validateRagCorpus(JSON.parse(bytes));
  const dir = directory(cacheRoot, `preparing-${suite}`);
  writeJson(join(dir, 'corpus.json'), { ...corpus, tasks: undefined });
  return sealDataset(dir, suite, { ...corpus.provenance, modality: corpus.modality,
    adaptation: 'roc-stable-source-locators-v1', originalSha256: sha256(bytes),
    review: { reviewed: corpus.tasks.filter(t => t.review.status === 'reviewed').length,
      draft: corpus.tasks.filter(t => t.review.status !== 'reviewed').length },
    split: 'source-connected-components-v1' }, corpus.tasks, cacheRoot);
}
