import {createHash, randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {
  prepareWritingContextRequestSchema, writingContextRequestSchema, writingContextReceiptSchema,
  writingContextResultSchema, writingGroundingResultSchema, writingImpactResultSchema,
  type PrepareWritingContextRequest, type WritingContextRequest, type WritingContextReceipt,
  type WritingContextResult, type WritingGroundingResult, type WritingGroundingIssue, type WritingImpactResult
} from '../../../shared/schemas/research-writing-context';
import {scientificSearchRequestSchema, type ScientificSearchRequest, type ScientificSearchResult} from '../../../shared/schemas/research-scientific-search';
import {scientificQueryResultSchema, type ScientificQueryResult} from '../../../shared/schemas/research-scientific-query';
import type {ScientificKnowledgeReadRequest, ScientificKnowledgeRead} from '../../../shared/schemas/research-scientific-extraction';
import type {ScientificSourceRef} from '../../../shared/schemas/research-scientific-source-ref';
import type {ResearchRepository} from './repository';
import type {ResearchArtifact, ResearchClaim} from '../../../shared/types';
import {checkWritingClaim, writingIssue} from './writing-grounding';
import {indexedPaperBlocks} from './paper-ir';
import {readWritingContextReceipt, writingContextBasis, type WritingContextRecord} from './writing-context-receipt';

export type WritingContextDependencies = {
  query(request: ScientificSearchRequest, signal?: AbortSignal): Promise<ScientificQueryResult>;
  assertCurrent(search: ScientificSearchResult, signal?: AbortSignal): Promise<void>;
  readKnowledge?(request: ScientificKnowledgeReadRequest, signal?: AbortSignal): Promise<ScientificKnowledgeRead>;
  /** Separate effective identities; callers must not include unrelated configuration revisions. */
  configIdentity?(): {retrieval: unknown; knowledge: unknown};
};
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unique = <T>(values: T[]): T[] => [...new Map(values.map(value => [hash(value), value])).values()];
const errorCode = (error: unknown): string => error instanceof Error ? error.message.split(':')[0] : 'unknown';
const anchorChanged = '写作材料锚点状态或内容已改变。';
const goalChanged = '项目研究目标已改变。';
const durableAnchorDigest = (artifact: ResearchArtifact): string => {
  // Creating paragraphs updates a draft's timestamp as part of the expected writing flow.
  // Preparation's in-flight guard still compares the complete artifact; approved inputs stay strict.
  const {updatedAt: _updatedAt, ...identity} = artifact;
  return hash(artifact.status === 'draft' ? identity : artifact);
};
const factSources = (fact: WritingContextReceipt['facts'][number]) => [...fact.evidence,
  ...fact.conditionEvidence.flatMap(condition => condition.evidence), ...fact.value?.unitEvidence ?? []];

/** A durable, source-checked preparation receipt. Claims and the manuscript remain their existing owners. */
export class WritingContextService {
  constructor(private readonly repository: ResearchRepository, private readonly dependencies: WritingContextDependencies,
    private readonly db: Database, private readonly now: () => string = () => new Date().toISOString()) {}

  async prepare(input: PrepareWritingContextRequest, signal = new AbortController().signal): Promise<WritingContextResult> {
    const request = prepareWritingContextRequestSchema.parse(input);
    const artifact = this.anchor(request, true), artifactDigest = hash(artifact), config = this.config();
    const project = this.repository.getProject(request.projectId);
    const projectGoal = [project.title, project.description].filter(Boolean).join('\n');
    const guard = (): void => {
      signal.throwIfAborted();
      if (hash(this.anchor(request, true)) !== artifactDigest ||
        hash([this.repository.getProject(request.projectId).title, this.repository.getProject(request.projectId).description]) !==
        hash([project.title, project.description])) throw new Error('research_writing_artifact_changed');
      if (hash(this.config()) !== hash(config)) throw new Error('research_writing_config_changed');
    };
    guard();
    const wiki: WritingContextReceipt['wiki'] = [], gaps: string[] = [], limitations: string[] = [];
    const navigation = await this.repository.wiki.search(request.projectId, request.sectionTitle.slice(0, 300), 0,
      {kinds: ['topic', 'comparison', 'dispute']});
    guard();
    for (const entry of navigation.pages.slice(0, 8)) {
      const page = await this.repository.wiki.readCurrent(request.projectId, entry.id, signal);
      guard();
      wiki.push({pageId: entry.id, revision: page.page.revision, basisDigest: page.basisDigest});
      if (page.current?.sections.some(section => section.status === 'stale')) gaps.push(`wiki_stale: ${entry.title}`);
    }
    if (!wiki.length) limitations.push('未找到相关 Topic Wiki；本次材料由原文检索提供。');
    const query = `${request.sectionTitle}\n${request.sectionGoal}\n研究目标：${projectGoal}`.slice(0, 3800);
    const retrievals: ScientificQueryResult[] = [];
    for (const text of [query, `${query}\nlimitations counterevidence negative results 局限性 反面证据`]) {
      retrievals.push(scientificQueryResultSchema.parse(await this.dependencies.query(scientificSearchRequestSchema.parse({
        projectId: request.projectId, query: text, documentIds: request.documentIds, limit: 20, candidateLimit: 100
      }), signal)));
      guard();
    }
    const refs = unique(retrievals.flatMap(result => result.sourceRefs));
    for (const result of retrievals) {
      if (result.projectId !== request.projectId || result.rounds.some(round => round.plan.scope.projectId !== request.projectId)) {
        throw new Error('research_writing_project_mismatch');
      }
      if (result.degradation.length) limitations.push(...result.degradation.map(item => `retrieval: ${item}`));
      if (result.stopReason !== 'complete' && result.stopReason !== 'no_gain') gaps.push(`retrieval_budget: ${result.stopReason}`);
    }
    if (!refs.length) gaps.push('source_missing: 没有可定位的原文来源。');
    for (const documentId of request.documentIds) if (!refs.some(ref => ref.documentId === documentId)) {
      gaps.push(`source_coverage: ${documentId}`);
    }
    this.authorize(request.projectId, refs);
    const facts: WritingContextReceipt['facts'] = [];
    for (const documentId of [...new Set(refs.map(ref => ref.documentId))]) {
      const knowledge = await this.dependencies.readKnowledge?.({projectId: request.projectId, documentId, generationId: null}, signal);
      guard();
      this.authorize(request.projectId, refs);
      if (!knowledge || knowledge.state !== 'current' || knowledge.configurationError || !knowledge.knowledge || !knowledge.publishedJob ||
        !refs.some(ref => ref.documentId === documentId && ref.paperIrHash === knowledge.currentPaperIR?.sha256)) {
        gaps.push(`knowledge_missing: ${documentId}`);
        continue;
      }
      const matched = knowledge.knowledge.facts.filter(fact => fact.status === 'source_validated' && fact.generationId === knowledge.publishedJob!.id &&
        factSources(fact).every(source => source.locator !== null && refs.some(ref =>
          sameOriginalBlock(ref, source.locator!) && ref.documentId === documentId)));
      const remaining = 200 - facts.length;
      facts.push(...matched.slice(0, remaining));
      if (!matched.length) gaps.push(`facts_missing: ${documentId}`);
      if (matched.length > remaining) gaps.push('fact_budget: 部分事实超出写作上下文上限。');
    }
    // Recheck canonical bytes, scope and generation after all asynchronous work, before any evidence write.
    for (const retrieval of retrievals) for (const round of retrieval.rounds) await this.dependencies.assertCurrent(round, signal);
    guard();
    return this.db.transaction(() => {
      guard();
      this.authorize(request.projectId, refs);
      this.assertFactsCurrent(request.projectId, facts);
      for (const page of wiki) {
        const current = this.repository.wiki.read(request.projectId, page.pageId);
        if (current.page.revision !== page.revision || current.basisDigest !== page.basisDigest) throw new Error('research_writing_wiki_changed');
      }
      const bindings: WritingContextReceipt['bindings'] = [];
      for (const source of refs) {
        if (!retrievals.some(result => result.rounds.some(round => round.snapshot.generations.some(generation =>
          generation.generationId === source.generationId && generation.paperIR.sha256 === source.paperIrHash)))) {
          throw new Error('research_writing_source_mismatch');
        }
        const chunkId = this.originalChunk(source);
        if (chunkId === null) {gaps.push(`evidence_unbound: ${source.documentId}/${source.objectId}`); continue;}
        const evidence = this.repository.evidence.capture({projectId: request.projectId, chunkId});
        const inspected = this.repository.evidence.inspectEvidence(evidence.id, request.projectId);
        if (inspected.sourceLocator === null || !sameOriginalBlock(source, inspected.sourceLocator)) {
          throw new Error('research_writing_source_mismatch');
        }
        bindings.push({source, evidenceId: evidence.id});
      }
      const claims = this.repository.evidence.listClaims({projectId: request.projectId, artifactId: request.artifactId}).slice(0, 500);
      const originalEvidenceIds = [...new Set(bindings.map(binding => binding.evidenceId))];
      const supportingClaims = claims.filter(claim => claim.evidenceIds.some(id => originalEvidenceIds.includes(id)) &&
        this.reviewed(claim)).map(claim => claim.id);
      if (!supportingClaims.length) gaps.push('claims_unreviewed: 尚无人工确认的正式支持主张。');
      const reviewedEvidence = new Set(claims.filter(claim => supportingClaims.includes(claim.id)).flatMap(claim => claim.evidenceIds));
      if (facts.some(fact => factSources(fact).some(source => !bindings.some(binding =>
        source.locator !== null && sameOriginalBlock(binding.source, source.locator) && reviewedEvidence.has(binding.evidenceId))))) {
        gaps.push('facts_unreviewed: 部分事实尚未绑定人工审核的正式支持主张。');
      }
      const relations = this.repository.evidence.relations.list({projectId: request.projectId, claimId: null});
      const counterEvidence = unique([
        ...facts.filter(fact => fact.factType === 'limitation').map(fact => fact.predicate),
        ...relations.filter(relation => ['contradicts', 'qualifies'].includes(relation.kind) &&
          ['proposed', 'confirmed'].includes(relation.status) && originalEvidenceIds.includes(relation.evidenceId))
          .map(relation => {this.repository.evidence.relations.assertCurrent(relation); return `${relation.evidenceId}: ${relation.condition ?? relation.source.evidence.excerpt}`;})
      ]);
      if (!counterEvidence.length) gaps.push('counterevidence_missing: 定向检索未找到可验证的反面证据，不能据此宣称不存在。');
      if (facts.length) limitations.push('抽取事实仅通过原文校验；scientificApproval 为 unreviewed，正式论断仍须人工确认支持关系。');
      const result = writingContextResultSchema.parse({contextId: `writing-context:${randomUUID()}`, basisDigest: '0'.repeat(64),
        projectId: request.projectId, artifactId: request.artifactId, sourcePapers: refs,
        relevantFacts: facts.map(fact => `${fact.id}: ${fact.predicate}${fact.value ? ` (${fact.value.raw}${fact.value.rawUnit ? ` ${fact.value.rawUnit}` : ''})` : ''}`),
        originalEvidenceIds, supportingClaims, counterEvidence, knowledgeGaps: unique(gaps), limitations: unique(limitations),
        status: gaps.length ? 'incomplete' : 'ready'});
      const receipt = writingContextReceiptSchema.parse({version: 'roc-writing-context/1', result, request, projectGoal,
        artifactDigest: durableAnchorDigest(artifact), config, retrievals, wiki, facts, bindings, claims,
        manuscriptDigest: this.manuscriptDigest(request.artifactId),
        relationsDigest: hash(this.repository.evidence.relations.forArtifact(request.artifactId, request.projectId)), createdAt: this.now()});
      receipt.result.basisDigest = writingContextBasis(receipt);
      const serialized = JSON.stringify(receipt);
      if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) throw new Error('research_writing_receipt_budget');
      const eventId = randomUUID();
      this.db.prepare(`INSERT INTO research_workflow_events (id,project_id,stage,type,message,payload_json,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(eventId, request.projectId, artifact.stage, 'writing_context_prepared', request.sectionTitle,
        JSON.stringify({contextId: result.contextId, artifactId: artifact.id, basisDigest: receipt.result.basisDigest}), receipt.createdAt);
      if (artifact.status === 'draft') {
        this.repository.addProvenance({projectId: request.projectId, artifactId: request.artifactId, subjectType: 'artifact',
          subjectId: request.artifactId, sourceType: 'workflow_event', sourceId: eventId,
          locator: result.contextId, excerpt: serialized});
      } else {
        // An approved upstream input is an immutable preparation anchor, not a writable manuscript.
        // Append only this service's checked receipt/event; the general provenance write gate stays intact.
        guard();
        this.db.prepare(`INSERT INTO research_provenance
          (id,project_id,artifact_id,subject_type,subject_id,source_type,source_id,locator,excerpt,created_at)
          VALUES (?,?,?,'artifact',?,'workflow_event',?,?,?,?)`).run(randomUUID(), request.projectId, artifact.id,
          artifact.id, eventId, result.contextId, serialized, receipt.createdAt);
      }
      return receipt.result;
    })();
  }

  async checkGrounding(input: WritingContextRequest, signal = new AbortController().signal): Promise<WritingGroundingResult> {
    const request = writingContextRequestSchema.parse(input), receipt = this.read(request);
    const issues: WritingGroundingIssue[] = [];
    const impacts = await this.currentImpacts(receipt, request, signal);
    for (const impact of impacts) if (['source', 'configuration', 'wiki'].includes(impact.kind) ||
      impact.kind === 'artifact' && [anchorChanged, goalChanged].includes(impact.reason)) {
      issues.push(writingIssue(impact.kind === 'source' ? 'source_stale' : 'context_changed', impact.reason,
        {documentId: impact.kind === 'source' ? impact.id : null}));
    }
    const manuscript = this.repository.manuscripts.getManuscript(request.artifactId);
    if (manuscript === null) issues.push(writingIssue('manuscript_missing', '先保存正文段落，才能检查实际写作内容。'));
    else {
      try {this.repository.manuscripts.inspectBundle(request);}
      catch (error) {issues.push(writingIssue('manuscript_stale', errorCode(error)));}
    }
    const checkedClaimIds: string[] = [];
    for (const [sectionIndex, section] of (manuscript?.sections ?? []).entries()) for (const [paragraphIndex, claimId] of section.claimIds.entries()) {
      const claim = this.repository.evidence.getClaim(claimId);
      if (claim.projectId !== request.projectId || claim.artifactId !== request.artifactId) throw new Error('research_writing_project_mismatch');
      checkedClaimIds.push(claim.id);
      const location = {claimId, sectionIndex, sectionTitle: section.title, paragraphIndex};
      issues.push(...checkWritingClaim(this.repository, claim, receipt, location));
      const sourceProblems = impacts.filter(impact => impact.kind === 'source' && impact.claimIds.includes(claimId));
      issues.push(...sourceProblems.map(impact => writingIssue('source_stale', impact.reason, {...location, documentId: impact.id})));
    }
    for (const gap of receipt.result.knowledgeGaps.filter(gap => !gap.startsWith('claims_unreviewed:') && !gap.startsWith('facts_unreviewed:'))) {
      issues.push(writingIssue('context_incomplete', gap));
    }
    this.artifact(request, false);
    this.authorize(request.projectId, receipt.result.sourcePapers);
    signal.throwIfAborted();
    return writingGroundingResultSchema.parse({...request, basisDigest: receipt.result.basisDigest,
      status: issues.length ? 'incomplete' : 'ready', issues, checkedClaimIds});
  }

  async reviewImpact(input: WritingContextRequest, signal = new AbortController().signal): Promise<WritingImpactResult> {
    const request = writingContextRequestSchema.parse(input), receipt = this.read(request);
    const impacts = await this.currentImpacts(receipt, request, signal);
    return writingImpactResultSchema.parse({...request, basisDigest: receipt.result.basisDigest,
      status: impacts.length ? 'changed' : 'current', impacts, requiresHumanRevision: impacts.length > 0});
  }

  private async currentImpacts(receipt: WritingContextReceipt, request: WritingContextRequest,
    signal: AbortSignal): Promise<WritingImpactResult['impacts']> {
    const impacts: WritingImpactResult['impacts'] = [];
    this.artifact(request, false);
    this.authorize(request.projectId, receipt.result.sourcePapers);
    const currentClaims = this.repository.evidence.listClaims({projectId: request.projectId, artifactId: request.artifactId});
    const manuscript = this.repository.manuscripts.getManuscript(request.artifactId);
    const currentState = hash([currentClaims, manuscript]);
    const add = (kind: WritingImpactResult['impacts'][number]['kind'], id: string, reason: string, evidenceIds: string[] = [], ids: string[] = []): void => {
      const claimIds = unique([...ids, ...currentClaims.filter(claim => claim.evidenceIds.some(evidenceId => evidenceIds.includes(evidenceId))).map(claim => claim.id)]);
      impacts.push({kind, id, reason, claimIds, sectionIndexes: (manuscript?.sections ?? []).flatMap((section, index) =>
        section.claimIds.some(claimId => claimIds.includes(claimId)) ? [index] : [])});
    };
    if (hash(this.config()) !== hash(receipt.config)) add('configuration', receipt.result.contextId, '写作上下文使用的有效检索或知识配置已改变。');
    if (durableAnchorDigest(this.anchor(receipt.request, false)) !== receipt.artifactDigest) add('artifact', receipt.request.artifactId, anchorChanged);
    const project = this.repository.getProject(request.projectId);
    if ([project.title, project.description].filter(Boolean).join('\n') !== receipt.projectGoal) {
      add('artifact', request.artifactId, goalChanged, [], currentClaims.map(claim => claim.id));
    }
    if (hash(this.repository.evidence.relations.forArtifact(receipt.request.artifactId, request.projectId)) !== receipt.relationsDigest) {
      add('artifact', request.artifactId, '证据关系或人工审核决定已改变。', [], currentClaims.map(claim => claim.id));
    }
    for (const documentId of new Set(receipt.facts.map(fact => fact.documentId))) {
      const facts = receipt.facts.filter(fact => fact.documentId === documentId);
      let knowledge: ScientificKnowledgeRead | undefined;
      try {knowledge = await this.dependencies.readKnowledge?.({projectId: request.projectId, documentId, generationId: null}, signal);}
      catch (error) {
        signal.throwIfAborted();
        this.authorize(request.projectId, receipt.result.sourcePapers);
        add('source', documentId, errorCode(error), receipt.bindings.filter(binding => binding.source.documentId === documentId).map(binding => binding.evidenceId));
      }
      if (!knowledge || knowledge.state !== 'current' || knowledge.configurationError ||
        facts.some(fact => !knowledge.knowledge?.facts.some(current => hash(current) === hash(fact)))) {
        add('source', documentId, '知识事实的来源、配置或发布版本已改变。',
          receipt.bindings.filter(binding => binding.source.documentId === documentId).map(binding => binding.evidenceId));
      }
    }
    for (const retrieval of receipt.retrievals) for (const round of retrieval.rounds) {
      try {await this.dependencies.assertCurrent(round, signal);}
      catch (error) {
        signal.throwIfAborted();
        this.authorize(request.projectId, receipt.result.sourcePapers);
        for (const generation of round.snapshot.generations) add('source', generation.paperIR.identity.documentId, errorCode(error),
          receipt.bindings.filter(binding => binding.source.documentId === generation.paperIR.identity.documentId).map(binding => binding.evidenceId));
      }
    }
    for (const page of receipt.wiki) {
      try {
        const current = await this.repository.wiki.readCurrent(request.projectId, page.pageId, signal);
        if (current.page.revision !== page.revision || current.basisDigest !== page.basisDigest ||
          current.current?.sections.some(section => section.status === 'stale')) add('wiki', page.pageId, 'Wiki 来源或修订已改变。');
      } catch (error) {signal.throwIfAborted(); this.authorize(request.projectId, receipt.result.sourcePapers); add('wiki', page.pageId, errorCode(error));}
    }
    for (const evidenceId of receipt.result.originalEvidenceIds) {
      try {
        const evidence = this.repository.evidence.inspectEvidence(evidenceId, request.projectId);
        if (evidence.referenceStatus !== 'recorded') add('evidence', evidenceId, '证据引用已失效。', [evidenceId]);
      } catch (error) {add('evidence', evidenceId, errorCode(error), [evidenceId]);}
    }
    for (const claim of receipt.claims.filter(claim => claim.artifactId === request.artifactId)) {
      const current = currentClaims.find(candidate => candidate.id === claim.id);
      if (!current || hash(current) !== hash(claim)) add('claim', claim.id, '正式主张已改变。', [], [claim.id]);
    }
    if (this.manuscriptDigest(request.artifactId) !== receipt.manuscriptDigest) add('paragraph', request.artifactId,
      '正文段落或主张映射已改变。', [], manuscript?.sections.flatMap(section => section.claimIds) ?? []);
    this.artifact(request, false);
    this.anchor(receipt.request, false);
    this.authorize(request.projectId, receipt.result.sourcePapers);
    try {this.assertFactsCurrent(request.projectId, receipt.facts);}
    catch (error) {
      for (const documentId of new Set(receipt.facts.map(fact => fact.documentId))) add('source', documentId, errorCode(error),
        receipt.bindings.filter(binding => binding.source.documentId === documentId).map(binding => binding.evidenceId));
    }
    if (hash(this.config()) !== hash(receipt.config)) add('configuration', receipt.result.contextId, '写作上下文使用的有效检索或知识配置已改变。');
    if (durableAnchorDigest(this.anchor(receipt.request, false)) !== receipt.artifactDigest) add('artifact', receipt.request.artifactId, anchorChanged);
    const finalProject = this.repository.getProject(request.projectId);
    if ([finalProject.title, finalProject.description].filter(Boolean).join('\n') !== receipt.projectGoal) {
      add('artifact', request.artifactId, goalChanged, [], currentClaims.map(claim => claim.id));
    }
    if (hash([this.repository.evidence.listClaims({projectId: request.projectId, artifactId: request.artifactId}),
      this.repository.manuscripts.getManuscript(request.artifactId)]) !== currentState) throw new Error('research_writing_artifact_changed');
    signal.throwIfAborted();
    return unique(impacts);
  }

  private read(request: WritingContextRequest): WritingContextReceipt {
    this.artifact(request, false);
    const row = this.db.prepare(`SELECT p.project_id,p.artifact_id,p.locator,p.excerpt,e.payload_json FROM research_provenance p
      JOIN research_workflow_events e ON e.id=p.source_id AND e.project_id=p.project_id
      WHERE p.project_id=? AND p.subject_type='artifact' AND p.subject_id=p.artifact_id
      AND p.source_type='workflow_event' AND p.locator=? AND e.type='writing_context_prepared'`).get(
      request.projectId, request.contextId) as WritingContextRecord | undefined;
    if (!row) throw new Error('research_writing_context_not_found');
    const receipt = readWritingContextReceipt(row);
    this.anchor(receipt.request, false);
    return receipt;
  }
  private anchor(request: Pick<WritingContextRequest, 'projectId' | 'artifactId'>, preparing: boolean) {
    const project = this.repository.getProject(request.projectId), artifact = this.repository.getArtifact(request.artifactId);
    if (artifact.projectId !== request.projectId) throw new Error('research_writing_project_mismatch');
    if (!['draft', 'approved'].includes(artifact.status) || !this.repository.getWorkflow(project.id).stages.some(stage =>
      stage.stage === artifact.stage && stage.artifactIds.includes(artifact.id))) throw new Error('research_writing_anchor_stale');
    if (preparing) {
      if (project.status === 'archived') throw new Error('research_project_archived');
      if (artifact.status !== 'approved') this.artifact(request, true);
    }
    return artifact;
  }
  private artifact(request: Pick<WritingContextRequest, 'projectId' | 'artifactId'>, editable: boolean) {
    this.repository.getProject(request.projectId);
    const artifact = editable ? this.repository.requireEditableArtifact(request.artifactId) : this.repository.getArtifact(request.artifactId);
    if (artifact.projectId !== request.projectId) throw new Error('research_writing_project_mismatch');
    if (artifact.kind !== 'manuscript') throw new Error('research_manuscript_artifact_required');
    return artifact;
  }
  private authorize(projectId: string, refs: ScientificSourceRef[]): void {
    for (const documentId of new Set(refs.map(ref => ref.documentId))) this.repository.scientificExtraction.authorizeDocument(projectId, documentId);
  }
  private config(): WritingContextReceipt['config'] {
    const identity = this.dependencies.configIdentity?.() ?? {retrieval: null, knowledge: null};
    return {retrieval: hash(identity.retrieval), knowledge: hash(identity.knowledge)};
  }
  private manuscriptDigest(artifactId: string): string | null {
    const manuscript = this.repository.manuscripts.getManuscript(artifactId);
    return manuscript === null ? null : hash(manuscript);
  }
  private reviewed(claim: ResearchClaim): boolean {
    try {this.repository.evidence.assertReviewedSupport(claim); return true;} catch {return false;}
  }
  private originalChunk(source: ScientificSourceRef): string | null {
    if (!this.db.prepare('SELECT 1 FROM research_documents WHERE id=?').get(source.documentId)) return null;
    const parsed = this.repository.documents.parsed(source.documentId, source.parseId);
    if (parsed.data === null) return null;
    const blocks = indexedPaperBlocks(parsed.data.content.blocks);
    const index = blocks.findIndex(block => block.id === source.locator.blockId);
    if (index < 0) return null;
    const block = blocks[index];
    if (!block.text.trim()) return null;
    const row = this.db.prepare(`SELECT id FROM research_knowledge_chunks WHERE document_id=? AND chunk_index=?
      AND content=? AND locator=?`).get(source.knowledgeDocumentId, index, block.text, block.locator) as {id: string} | undefined;
    return row?.id ?? null;
  }
  private assertFactsCurrent(projectId: string, facts: WritingContextReceipt['facts']): void {
    for (const generationId of new Set(facts.map(fact => fact.generationId))) {
      const selected = facts.filter(fact => fact.generationId === generationId);
      if (this.repository.scientificExtraction.active(projectId, selected[0].documentId)?.id !== generationId) {
        throw new Error('research_writing_knowledge_changed');
      }
      const current = this.repository.scientificExtraction.bundle(generationId, projectId);
      if (selected.some(fact => !current.facts.some(candidate => hash(candidate) === hash(fact)))) {
        throw new Error('research_writing_knowledge_changed');
      }
    }
  }
}

function sameOriginalBlock(source: ScientificSourceRef, locator: ScientificSourceRef['locator']): boolean {
  return ['documentId', 'parseId', 'knowledgeDocumentId', 'sourceHash', 'parseHash', 'parserFingerprint', 'blockId']
    .every(key => source.locator[key as keyof typeof locator] === locator[key as keyof typeof locator]);
}
