import {createHash} from 'node:crypto';
import {literatureRetrievalEvaluationSchema, literatureRetrievalCaptureSetSchema} from '../../../shared/schemas/literature-retrieval-evaluation';
import type {LiteratureSearchPool} from '../../../shared/schemas/literature-search-pool';
import {fuseLiterature, literatureSourcePriority} from './literature-fusion';

type Metrics = {recall20: number; ndcg10: number; duplicateRate20: number | null;
  retrieved20: number; duplicates20: number; falseMerges20: number};
type QueryReport = {queryId: string; topicId: string; executionId: string; poolHash: string;
  sourceStatus: 'complete' | 'partial' | 'failed'; baseline: Metrics; rrf: Metrics};
type PacketRecord = Pick<LiteratureSearchPool['records'][number]['record'],
  'title' | 'authors' | 'abstract' | 'publishedYear' | 'doi' | 'url' | 'openAccessUrl'> & {
    recordHash: string; identifiers: Array<{kind: 'doi' | 'arxiv' | 'pmid'; value: string}>
  };
export type LiteratureJudgmentPacket = {
  schemaVersion: 1; kind: 'unlabeled_packet'; rankingsIncluded: false; corpusId: string;
  minimumTopics: number; contentHash: string; queries: Array<{
    queryId: string; topicId: string; executionId: string; poolHash: string; question: string;
    yearFrom: number | null; yearTo: number | null; records: PacketRecord[]
  }>;
};
export type LiteratureRetrievalReport = {
  schemaVersion: 1; corpusId: string; corpusHash: string; implementationCommit: string | null; implementationBundleHash: string;
  protocol: {identityPipeline: 'current_declared_identity'; baseline: 'source_priority_then_rank';
    candidate: 'rrf_v1_k60_equal_weights'; recallCutoff: 20; ndcgCutoff: 10; duplicateCutoff: 20;
    gain: '2^grade-1'; discount: 'log2(rank+1)'; relevanceAveraging: 'equal_topics';
    duplicateAveraging: 'pooled_top20_slots'};
  annotationAssurance: 'engineering_only' | 'declared_independent_human';
  sampleStatus: 'engineering_only' | 'insufficient' | 'meets_declared_minimum';
  queryCount: number; topicCount: number; minimumTopics: number;
  failedQueries: number; partialQueries: number; queries: QueryReport[];
  summary: {baseline: Metrics; rrf: Metrics};
};
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function verifyPool(pool: LiteratureSearchPool): void {
  const {contentHash, ...body} = pool;
  if (hash(body) !== contentHash) throw new Error('literature_eval_pool_integrity_invalid');
  for (const source of pool.sources) {
    if (pool.records.filter(item => item.record.source === source.source).length !== source.returnedCount) {
      throw new Error('literature_eval_pool_incomplete');
    }
  }
  const sources = new Set<string>(pool.sources.map(source => source.source));
  if (sources.size !== pool.sources.length || sources.size !== new Set(pool.request.sources).size ||
      pool.request.sources.some(source => !sources.has(source)) || pool.records.some(item => !sources.has(item.record.source))) {
    throw new Error('literature_eval_pool_source_mismatch');
  }
  const ranks = pool.records.map(item => `${item.record.source}:${item.rank}`);
  if (new Set(ranks).size !== ranks.length) throw new Error('literature_eval_pool_rank_conflict');
}

/** Unlabeled metadata packet: no ranking, source rank, candidate grouping or relevance guesses. */
export function prepareLiteratureJudgmentPacket(input: unknown): LiteratureJudgmentPacket {
  const captures = literatureRetrievalCaptureSetSchema.parse(input);
  const queryIds = new Set<string>(), executions = new Set<string>();
  const queries = captures.queries.map(query => {
    if (queryIds.has(query.queryId) || executions.has(query.pool.executionId)) throw new Error('literature_eval_query_duplicate');
    queryIds.add(query.queryId); executions.add(query.pool.executionId);
    verifyPool(query.pool);
    const records = new Map<string, PacketRecord>();
    for (const item of query.pool.records) {
      const recordHash = hash(item.record);
      const current = records.get(recordHash);
      const identifiers = [...new Map([...(current?.identifiers ?? []),
        ...item.identifiers.map(value => ({kind: value.kind, value: value.value}))]
        .map(value => [JSON.stringify(value), value])).values()]
        .sort((left, right) => compare(left.kind, right.kind) || compare(left.value, right.value));
      records.set(recordHash, {recordHash, title: item.record.title, authors: item.record.authors,
        abstract: item.record.abstract, publishedYear: item.record.publishedYear, doi: item.record.doi,
        url: item.record.url, openAccessUrl: item.record.openAccessUrl, identifiers});
    }
    return {queryId: query.queryId, topicId: query.topicId, executionId: query.pool.executionId,
      poolHash: query.pool.contentHash, question: query.pool.strategy !== null && 'researchQuestion' in query.pool.strategy
        ? query.pool.strategy.researchQuestion : query.pool.request.query,
      yearFrom: query.pool.request.yearFrom ?? null, yearTo: query.pool.request.yearTo ?? null,
      records: [...records.values()].sort((left, right) => compare(left.recordHash, right.recordHash))};
  });
  const packet = {schemaVersion: 1 as const, kind: 'unlabeled_packet' as const, rankingsIncluded: false as const,
    corpusId: captures.corpusId, minimumTopics: captures.minimumTopics, queries};
  return {...packet, contentHash: hash(packet)};
}

/** Offline only. Human identity/provenance is declared by the supplied corpus, not certified here. */
export function evaluateLiteratureRetrieval(input: unknown, implementationCommit: string | null, implementationBundleHash: string): LiteratureRetrievalReport {
  if (implementationCommit !== null && !/^[a-f0-9]{40}$/u.test(implementationCommit)) throw new Error('literature_eval_commit_required');
  if (!/^[a-f0-9]{64}$/u.test(implementationBundleHash)) throw new Error('literature_eval_bundle_hash_required');
  const corpus = literatureRetrievalEvaluationSchema.parse(input);
  if (corpus.kind === 'human_reviewed' && implementationCommit === null) throw new Error('literature_eval_source_commit_required');
  if (corpus.annotation !== null) {
    const reviewers = new Set(corpus.annotation.reviewerIds);
    if (reviewers.size !== corpus.annotation.reviewerIds.length ||
        corpus.annotation.producerIds.some(id => reviewers.has(id))) throw new Error('literature_eval_independence_conflict');
  }
  const queryIds = new Set<string>();
  const executions = new Set<string>();
  const queries = corpus.queries.map(query => {
    if (queryIds.has(query.queryId) || executions.has(query.pool.executionId)) throw new Error('literature_eval_query_duplicate');
    queryIds.add(query.queryId); executions.add(query.pool.executionId);
    const {contentHash} = query.pool;
    verifyPool(query.pool);
    if (corpus.kind === 'human_reviewed' && query.pool.request.limit < 20) throw new Error('literature_eval_candidate_cutoff_mismatch');
    const papers = new Map<string, typeof query.papers[number]>();
    const recordPapers = new Map<string, string>();
    for (const paper of query.papers) {
      if (papers.has(paper.paperId)) throw new Error('literature_eval_paper_duplicate');
      papers.set(paper.paperId, paper);
      for (const fingerprint of paper.recordHashes) {
        if (recordPapers.has(fingerprint)) throw new Error('literature_eval_judgment_duplicate');
        recordPapers.set(fingerprint, paper.paperId);
      }
    }
    const captured = new Set(query.pool.records.map(item => hash(item.record)));
    if ([...captured].some(fingerprint => !recordPapers.has(fingerprint)) ||
        [...recordPapers.keys()].some(fingerprint => !captured.has(fingerprint))) throw new Error('literature_eval_judgment_missing');
    const relevant = [...papers.values()].filter(paper => paper.grade > 0);
    if (relevant.length === 0) throw new Error('literature_eval_relevance_denominator_missing');
    const candidates = fuseLiterature(query.pool.records).filter(candidate =>
      (query.pool.request.yearFrom === undefined && query.pool.request.yearTo === undefined) ||
      candidate.record.publishedYear !== null &&
      (query.pool.request.yearFrom === undefined || candidate.record.publishedYear >= query.pool.request.yearFrom) &&
      (query.pool.request.yearTo === undefined || candidate.record.publishedYear <= query.pool.request.yearTo));
    const rrf = candidates.map(candidate => {
      const identities = [...new Set(candidate.origins.map(origin => recordPapers.get(origin.metadataHash)!))];
      return {candidate, paperId: identities.length === 1 ? identities[0] : null};
    });
    const baseline = [...rrf].sort((left, right) =>
      literatureSourcePriority.indexOf(left.candidate.origins[0].source) - literatureSourcePriority.indexOf(right.candidate.origins[0].source) ||
      left.candidate.origins[0].rank - right.candidate.origins[0].rank || compare(left.candidate.identity, right.candidate.identity));
    const ideal = relevant.map(paper => paper.grade).sort((left, right) => right - left).slice(0, 10)
      .reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
    const measure = (ranking: typeof rrf): Metrics => {
      const seen = new Set<string>();
      let duplicates = 0, falseMerges = 0, retrievedRelevant = 0, dcg = 0;
      for (const [index, item] of ranking.slice(0, 20).entries()) {
        if (item.paperId === null) {falseMerges++; continue;}
        if (seen.has(item.paperId)) {duplicates++; continue;}
        seen.add(item.paperId);
        const grade = papers.get(item.paperId)!.grade;
        if (grade > 0) retrievedRelevant++;
        if (index < 10) dcg += (2 ** grade - 1) / Math.log2(index + 2);
      }
      const count = Math.min(20, ranking.length);
      return {recall20: retrievedRelevant / relevant.length, ndcg10: dcg / ideal,
        duplicateRate20: count === 0 ? null : duplicates / count, retrieved20: count,
        duplicates20: duplicates, falseMerges20: falseMerges};
    };
    return {queryId: query.queryId, topicId: query.topicId, executionId: query.pool.executionId,
      poolHash: contentHash, sourceStatus: query.pool.status, baseline: measure(baseline), rrf: measure(rrf)};
  });
  const topics = [...new Set(queries.map(query => query.topicId))];
  return {schemaVersion: 1, corpusId: corpus.corpusId, corpusHash: hash(corpus), implementationCommit, implementationBundleHash,
    protocol: {identityPipeline: 'current_declared_identity', baseline: 'source_priority_then_rank',
      candidate: 'rrf_v1_k60_equal_weights', recallCutoff: 20, ndcgCutoff: 10, duplicateCutoff: 20,
      gain: '2^grade-1', discount: 'log2(rank+1)', relevanceAveraging: 'equal_topics',
      duplicateAveraging: 'pooled_top20_slots'},
    annotationAssurance: corpus.kind === 'engineering_fixture' ? 'engineering_only' : 'declared_independent_human',
    sampleStatus: corpus.kind === 'engineering_fixture' ? 'engineering_only' :
      topics.length < corpus.minimumTopics ? 'insufficient' : 'meets_declared_minimum',
    queryCount: queries.length, topicCount: topics.length, minimumTopics: corpus.minimumTopics,
    failedQueries: queries.filter(query => query.sourceStatus === 'failed').length,
    partialQueries: queries.filter(query => query.sourceStatus === 'partial').length, queries,
    summary: {baseline: summarize(queries, topics, 'baseline'), rrf: summarize(queries, topics, 'rrf')}};
}

function summarize(queries: QueryReport[], topics: string[], method: 'baseline' | 'rrf'): Metrics {
  const macro = (field: 'recall20' | 'ndcg10'): number => topics.reduce((sum, topic) => {
    const values = queries.filter(query => query.topicId === topic);
    return sum + values.reduce((total, query) => total + query[method][field], 0) / values.length;
  }, 0) / topics.length;
  const count = queries.reduce((sum, query) => sum + query[method].retrieved20, 0);
  const duplicates = queries.reduce((sum, query) => sum + query[method].duplicates20, 0);
  return {recall20: macro('recall20'), ndcg10: macro('ndcg10'),
    duplicateRate20: count === 0 ? null : duplicates / count, retrieved20: count, duplicates20: duplicates,
    falseMerges20: queries.reduce((sum, query) => sum + query[method].falseMerges20, 0)};
}
