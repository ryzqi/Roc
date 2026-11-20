import {createHash, randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {
  researchDocumentAnnotationCreateRequestSchema, researchDocumentAnnotationTargetSchema,
  researchDocumentAnnotationSchema, researchDocumentAnnotationListRequestSchema,
  researchDocumentAnnotationGetRequestSchema, researchDocumentAnnotationCaptureRequestSchema,
  researchDocumentAnnotationCaptureSchema,
  type ResearchDocumentAnnotationTarget, type ResearchDocumentAnnotationCreateRequest,
  type ResearchDocumentAnnotation, type ResearchDocumentAnnotationInspection,
  type ResearchDocumentAnnotationCapture, type ResearchDocumentAnnotationCaptureRequest
} from '../../../shared/schemas/research-document-annotations';
import {researchRelationReviewerSchema, type ResearchRelationReviewer} from '../../../shared/schemas/research-evidence-relations';
import type {ResearchRepository} from './repository';
import {relationSourceDigest} from './evidence-relation-repository';

type AnnotationRow = {
  id: string; project_id: string; document_id: string; parse_id: string; request_id: string;
  snapshot_json: string; snapshot_hash: string; created_at: string
};
type CaptureRow = {
  id: string; project_id: string; annotation_id: string; request_id: string; evidence_id: string;
  snapshot_json: string; snapshot_hash: string; created_at: string
};

/** Immutable user notes and exact source locations. Capturing a block never reviews a scientific claim. */
export class ResearchDocumentAnnotationRepository {
  constructor(private readonly db: Database, private readonly repository: ResearchRepository, private readonly now: () => string) {}

  create(input: ResearchDocumentAnnotationCreateRequest, createdBy: ResearchRelationReviewer): ResearchDocumentAnnotationInspection {
    const request = researchDocumentAnnotationCreateRequestSchema.parse(input);
    const actor = researchRelationReviewerSchema.parse(createdBy);
    return this.db.transaction(() => {
      this.requireWritableProject(request.target.projectId);
      const block = this.requireTarget(request.target);
      const requestHash = hash(JSON.stringify(request));
      const existing = this.db.prepare('SELECT * FROM research_document_annotations WHERE project_id=? AND request_id=?')
        .get(request.target.projectId, request.requestId) as AnnotationRow | undefined;
      if (existing !== undefined) {
        const annotation = this.readAnnotation(existing);
        if (annotation.requestHash !== requestHash || annotation.actor.id !== actor.id) {
          throw new Error('research_annotation_request_conflict');
        }
        return this.inspect(existing);
      }
      const annotation = researchDocumentAnnotationSchema.parse({
        id: `document_annotation_${randomUUID()}`, request, requestHash, block, actor, recordedAt: this.now()
      });
      this.db.prepare(`INSERT INTO research_document_annotations
        (id,project_id,document_id,parse_id,request_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(annotation.id, request.target.projectId, request.target.documentId, request.target.parseId, request.requestId,
          JSON.stringify(annotation), hash(JSON.stringify(annotation)), annotation.recordedAt);
      return this.get({projectId: request.target.projectId, annotationId: annotation.id});
    })();
  }

  list(input: {projectId: string; documentId: string; parseId: string}): ResearchDocumentAnnotationInspection[] {
    const request = researchDocumentAnnotationListRequestSchema.parse(input);
    this.requireDocument(request.projectId, request.documentId);
    this.repository.documents.parsed(request.documentId, request.parseId);
    const rows = this.db.prepare('SELECT * FROM research_document_annotations WHERE project_id=? AND document_id=? AND parse_id=? ORDER BY rowid')
      .all(request.projectId, request.documentId, request.parseId) as AnnotationRow[];
    return rows.map(row => this.inspect(row));
  }

  get(input: {projectId: string; annotationId: string}): ResearchDocumentAnnotationInspection {
    const request = researchDocumentAnnotationGetRequestSchema.parse(input);
    const row = this.db.prepare('SELECT * FROM research_document_annotations WHERE id=?').get(request.annotationId) as AnnotationRow | undefined;
    if (row === undefined) throw new Error('research_annotation_not_found');
    if (row.project_id !== request.projectId) throw new Error('research_annotation_project_mismatch');
    this.requireDocument(request.projectId, row.document_id);
    return this.inspect(row);
  }

  capture(input: ResearchDocumentAnnotationCaptureRequest, capturedBy: ResearchRelationReviewer): ResearchDocumentAnnotationInspection {
    const request = researchDocumentAnnotationCaptureRequestSchema.parse(input);
    const actor = researchRelationReviewerSchema.parse(capturedBy);
    return this.db.transaction(() => {
      this.requireWritableProject(request.projectId);
      const selected = {projectId: request.projectId, annotationId: request.annotationId};
      const inspection = this.get(selected);
      if (inspection.annotationHash !== request.expectedAnnotationHash) throw new Error('research_annotation_changed');
      const requestHash = hash(JSON.stringify(request));
      const replay = this.db.prepare('SELECT * FROM research_document_annotation_captures WHERE project_id=? AND request_id=?')
        .get(request.projectId, request.requestId) as CaptureRow | undefined;
      if (replay !== undefined) {
        const capture = this.readCapture(replay);
        if (capture.requestHash !== requestHash || capture.actor.id !== actor.id) throw new Error('research_annotation_request_conflict');
        return inspection;
      }
      if (inspection.capture !== null) throw new Error('research_annotation_already_captured');
      const target = inspection.annotation.request.target;
      const block = this.requireTarget(target);
      if (block === null || !block.text.trim()) throw new Error('research_annotation_block_required');
      const document = this.repository.documents.get(target.documentId);
      if (document.currentParseId !== target.parseId) throw new Error('research_annotation_parse_stale');
      const content = this.repository.documents.parsed(target.documentId, target.parseId).data.content;
      const blockIndex = content.blocks.filter(value => value.text.trim()).findIndex(value => value.id === block.id);
      // Read an actual indexed chunk; historical parsed text alone cannot mint Evidence.
      const chunk = this.db.prepare(`SELECT id,content,locator,content_hash FROM research_knowledge_chunks
        WHERE document_id=? AND chunk_index=?`).get(`document:${target.parseId}`, blockIndex) as {
          id: string; content: string; locator: string; content_hash: string
        } | undefined;
      if (chunk === undefined || chunk.content !== block.text || chunk.locator !== block.locator ||
          chunk.content_hash !== hash(block.text)) throw new Error('research_annotation_index_changed');
      const evidence = this.repository.evidence.capture({projectId: request.projectId, chunkId: chunk.id});
      const source = this.repository.evidence.inspectEvidence(evidence.id, request.projectId);
      const locator = source.sourceLocator;
      if (source.referenceStatus !== 'recorded' || locator === null || locator.documentId !== target.documentId ||
          locator.parseId !== target.parseId || locator.sourceHash !== target.sourceHash || locator.parseHash !== target.parseHash ||
          locator.parserFingerprint !== target.parserFingerprint || locator.blockId !== target.blockId ||
          evidence.excerpt !== block.text || evidence.locator !== block.locator) throw new Error('research_annotation_capture_changed');
      const capture = researchDocumentAnnotationCaptureSchema.parse({
        id: `document_annotation_capture_${randomUUID()}`, request, requestHash, actor,
        source, sourceDigest: relationSourceDigest(source), recordedAt: this.now()
      });
      this.db.prepare(`INSERT INTO research_document_annotation_captures
        (id,project_id,annotation_id,request_id,evidence_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(capture.id, request.projectId, request.annotationId, request.requestId, evidence.id,
          JSON.stringify(capture), hash(JSON.stringify(capture)), capture.recordedAt);
      return this.get(selected);
    })();
  }

  /** Revalidate exact parse/page/block and sealed basis synchronously at the write boundary. */
  requireTarget(input: ResearchDocumentAnnotationTarget): ResearchDocumentAnnotation['block'] {
    const target = researchDocumentAnnotationTargetSchema.parse(input);
    const document = this.requireDocument(target.projectId, target.documentId);
    const content = this.repository.documents.parsed(target.documentId, target.parseId).data.content;
    if (document.sourceHash !== target.sourceHash || content.sourceHash !== target.sourceHash ||
        hash(JSON.stringify(content)) !== target.parseHash || content.parserFingerprint !== target.parserFingerprint) {
      throw new Error('research_annotation_source_changed');
    }
    if (target.page > content.pageCount) throw new Error('research_annotation_page_invalid');
    const coordinates = this.repository.documents.coordinates(target.documentId, target.parseId);
    const frame = coordinates?.snapshot.pages.find(value => value.page === target.page)?.frame;
    const basis = coordinates !== null && frame?.kind === 'pdf' ? {snapshotHash: coordinates.snapshotHash, frame} : null;
    if (JSON.stringify(basis) !== JSON.stringify(target.coordinateBasis)) throw new Error('research_annotation_basis_changed');
    if (target.blockId === null) return null;
    const blocks = content.blocks.filter(block => block.id === target.blockId);
    if (blocks.length !== 1 || !blocks[0].locations.some(location => location.page === target.page)) {
      throw new Error('research_annotation_block_changed');
    }
    return blocks[0];
  }

  private requireDocument(projectId: string, documentId: string) {
    this.repository.getProject(projectId);
    const document = this.repository.documents.get(documentId);
    if (!this.repository.library.get(document.libraryItemId).projectIds.includes(projectId)) {
      throw new Error('research_document_project_mismatch');
    }
    return document;
  }

  private requireWritableProject(projectId: string): void {
    if (this.repository.getProject(projectId).status === 'archived') throw new Error('research_project_archived');
  }

  private readAnnotation(row: AnnotationRow): ResearchDocumentAnnotation {
    const annotation = researchDocumentAnnotationSchema.parse(JSON.parse(row.snapshot_json));
    const target = annotation.request.target;
    if (hash(JSON.stringify(annotation)) !== row.snapshot_hash || hash(JSON.stringify(annotation.request)) !== annotation.requestHash ||
        annotation.id !== row.id || target.projectId !== row.project_id || target.documentId !== row.document_id ||
        target.parseId !== row.parse_id || annotation.request.requestId !== row.request_id || annotation.recordedAt !== row.created_at) {
      throw new Error('research_annotation_snapshot_invalid');
    }
    return annotation;
  }

  private readCapture(row: CaptureRow): ResearchDocumentAnnotationCapture {
    const capture = researchDocumentAnnotationCaptureSchema.parse(JSON.parse(row.snapshot_json));
    if (hash(JSON.stringify(capture)) !== row.snapshot_hash || hash(JSON.stringify(capture.request)) !== capture.requestHash ||
        relationSourceDigest(capture.source) !== capture.sourceDigest || capture.id !== row.id ||
        capture.request.projectId !== row.project_id || capture.request.annotationId !== row.annotation_id ||
        capture.request.requestId !== row.request_id || capture.source.evidence.id !== row.evidence_id ||
        capture.recordedAt !== row.created_at) throw new Error('research_annotation_snapshot_invalid');
    return capture;
  }

  private inspect(row: AnnotationRow): ResearchDocumentAnnotationInspection {
    const annotation = this.readAnnotation(row);
    const captureRow = this.db.prepare('SELECT * FROM research_document_annotation_captures WHERE annotation_id=?')
      .get(row.id) as CaptureRow | undefined;
    const capture = captureRow === undefined ? null : this.readCapture(captureRow);
    if (capture !== null && (capture.request.expectedAnnotationHash !== row.snapshot_hash ||
        capture.request.projectId !== annotation.request.target.projectId ||
        capture.source.sourceLocator?.documentId !== annotation.request.target.documentId ||
        capture.source.sourceLocator.parseId !== annotation.request.target.parseId ||
        capture.source.sourceLocator.blockId !== annotation.request.target.blockId ||
        capture.source.sourceLocator.sourceHash !== annotation.request.target.sourceHash ||
        capture.source.sourceLocator.parseHash !== annotation.request.target.parseHash)) {
      throw new Error('research_annotation_snapshot_invalid');
    }
    return {annotation, annotationHash: row.snapshot_hash, capture,
      capturedReferenceStatus: capture === null ? null :
        this.repository.evidence.inspectEvidence(capture.source.evidence.id, row.project_id).referenceStatus};
  }
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
