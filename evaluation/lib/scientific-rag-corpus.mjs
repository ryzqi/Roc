import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { z } from 'zod';
import { hash, sha256 } from './common.mjs';

export const scientificPaperQuotas = Object.freeze({
  'two-column': 10, 'single-column': 5, 'formula-heavy': 5, 'table-heavy': 5,
  'figure-heavy': 5, scanned: 5, 'mixed-language': 5, 'long-appendix': 5
});
export const scientificQueryQuotas = Object.freeze({
  'paper-qa': 50, 'method-equation': 40, 'table-results': 40,
  'cross-paper': 30, figure: 20, unanswerable: 20
});

// Never trim gold text or questions: review digests and source spans bind the
// original annotation bytes, including meaningful whitespace.
const text = z.string().min(1).refine(value => value.trim().length > 0);
const id = text.max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const bbox = z.tuple([
  z.number().finite().nonnegative(), z.number().finite().nonnegative(),
  z.number().finite().positive(), z.number().finite().positive()
]);
const review = z.strictObject({
  status: z.enum(['draft', 'reviewed']),
  annotations: z.array(z.strictObject({
    reviewer: text, reviewedAt: z.iso.datetime(), contentHash: digest, judgmentHash: digest
  })),
  arbitration: z.strictObject({
    reviewer: text, reviewedAt: z.iso.datetime(), contentHash: digest, resolution: text
  }).nullable()
});

export const scientificManifestSchema = z.strictObject({
  schemaVersion: z.literal(1), id,
  provenance: z.strictObject({
    kind: z.enum(['pending', 'engineering_fixture', 'human_reviewed']),
    producer: text.nullable(), sourceRevision: text.nullable(), license: text.nullable()
  }),
  papers: z.array(z.strictObject({
    paperId: id, sourceHash: digest, category: z.enum(Object.keys(scientificPaperQuotas)),
    sourceUri: z.url(), license: text, pdfPath: text, annotationPath: text, annotationHash: digest
  })),
  queriesPath: text, queriesHash: digest.nullable()
});

// Human gold is independent of parser predictions. A parseRef is required when
// the annotation was made against a captured parse; PDF-only gold uses null.
export const scientificAnnotationSchema = z.strictObject({
  schemaVersion: z.literal(1), annotationVersion: z.literal('scientific-gold-v1'),
  paperId: id, sourceHash: digest,
  parseRef: z.strictObject({ parseId: id, parseHash: digest, parserFingerprint: digest }).nullable(),
  coordinateSystem: z.literal('TOPLEFT_NORMALIZED'),
  pages: z.array(z.strictObject({ page: z.number().int().positive(), transcript: z.string() })).min(1),
  blocks: z.array(z.strictObject({
    blockId: id, page: z.number().int().positive(),
    kind: z.enum(['heading', 'text', 'table', 'figure', 'equation', 'caption', 'reference', 'algorithm']),
    bbox, text: z.string(), readingOrder: z.number().int().nonnegative()
  })).min(1),
  expectedSections: z.array(z.strictObject({ id, title: text, blockIds: z.array(id).min(1) })),
  expectedTables: z.array(z.strictObject({
    id, blockId: id, html: text,
    cells: z.array(z.strictObject({
      row: z.number().int().nonnegative(), column: z.number().int().nonnegative(),
      rowSpan: z.number().int().positive(), columnSpan: z.number().int().positive(), text: z.string()
    })).min(1)
  })),
  expectedFigures: z.array(z.strictObject({ id, blockId: id, caption: text })),
  expectedEquations: z.array(z.strictObject({
    id, blockId: id, latex: text, normalizedLatex: text, normalizationVersion: text
  })),
  expectedCitations: z.array(z.strictObject({ id, blockId: id, target: text })),
  review
});

export const scientificQuerySchema = z.strictObject({
  id, category: z.enum(Object.keys(scientificQueryQuotas)),
  query: text.max(32000), targetPaperIds: z.array(id).min(1),
  targetBlockIds: z.array(id), targetTableIds: z.array(id),
  targetFigureIds: z.array(id), targetEquationIds: z.array(id),
  expectedEvidenceSpans: z.array(z.strictObject({
    id, paperId: id, sourceHash: digest, blockId: id, page: z.number().int().positive(),
    start: z.number().int().nonnegative(), end: z.number().int().positive(), quote: text,
    relevance: z.number().int().min(1).max(3)
  })),
  expectedAnswer: text.nullable(), answerable: z.boolean(),
  // Unanswerable/insufficient/condition-mismatch queries need a human rationale.
  unanswerableReason: text.nullable(), review
});

export function scientificReviewContentHash(value) {
  const { review: ignored, ...content } = value;
  return hash(content);
}

function requireCondition(condition, code) {
  if (!condition) throw new Error(code);
}
function unique(values, code) {
  requireCondition(new Set(values).size === values.length, code);
}
function checkReview(value, producer) {
  const record = value.review;
  requireCondition(record.status === 'reviewed', 'human_review_missing');
  const reviewers = record.annotations.map(entry => entry.reviewer);
  unique(reviewers, 'duplicate_reviewer');
  requireCondition(reviewers.length >= 2 && !reviewers.includes(producer), 'independent_reviews_required');
  const contentHash = scientificReviewContentHash(value);
  requireCondition(record.annotations.every(entry => entry.contentHash === contentHash), 'review_content_changed');
  if (new Set(record.annotations.map(entry => entry.judgmentHash)).size > 1) {
    requireCondition(record.arbitration && record.arbitration.contentHash === contentHash
      && !reviewers.includes(record.arbitration.reviewer) && record.arbitration.reviewer !== producer,
    'review_arbitration_required');
  } else if (record.arbitration) {
    requireCondition(record.arbitration.contentHash === contentHash
      && !reviewers.includes(record.arbitration.reviewer) && record.arbitration.reviewer !== producer,
    'review_arbitration_invalid');
  }
}

function readContained(root, path) {
  requireCondition(!isAbsolute(path), 'corpus_path_absolute');
  const candidate = resolve(root, path), lexical = relative(root, candidate);
  requireCondition(lexical !== '..' && !lexical.startsWith(`..${sep}`) && !isAbsolute(lexical),
    'corpus_path_outside_root');
  const target = realpathSync(candidate);
  const rel = relative(root, target);
  requireCondition(rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'corpus_path_outside_root');
  requireCondition(statSync(target).isFile(), 'corpus_path_not_file');
  return readFileSync(target);
}
function checkAnnotation(annotation, paper, pageCount, producer) {
  requireCondition(annotation.paperId === paper.paperId && annotation.sourceHash === paper.sourceHash,
    'annotation_source_mismatch');
  unique(annotation.pages.map(page => page.page), 'duplicate_page');
  requireCondition(annotation.pages.length === pageCount
    && annotation.pages.every(page => page.page <= pageCount), 'annotation_pages_incomplete');
  unique(annotation.blocks.map(block => block.blockId), 'duplicate_block');
  unique(annotation.blocks.map(block => `${block.page}:${block.readingOrder}`), 'duplicate_reading_order');
  const blocks = new Map(annotation.blocks.map(block => [block.blockId, block]));
  for (const block of annotation.blocks) {
    const [x0, y0, x1, y1] = block.bbox;
    requireCondition(block.page <= pageCount && x1 > x0 && y1 > y0 && x1 <= 1 && y1 <= 1,
      'annotation_locator_invalid');
  }
  requireCondition(annotation.expectedSections.length > 0, 'section_gold_missing');
  unique(annotation.expectedSections.map(section => section.id), 'duplicate_section');
  for (const section of annotation.expectedSections) {
    unique(section.blockIds, 'duplicate_section_block');
    requireCondition(section.blockIds.every(blockId => blocks.has(blockId)), 'section_block_missing');
  }
  const objectIds = [];
  for (const [key, kind] of [
    ['expectedTables', 'table'], ['expectedFigures', 'figure'],
    ['expectedEquations', 'equation'], ['expectedCitations', null]
  ]) {
    for (const object of annotation[key]) {
      objectIds.push(object.id);
      const block = blocks.get(object.blockId);
      requireCondition(block && (!kind || block.kind === kind), 'object_block_missing_or_wrong_kind');
      if (kind === 'table') {
        const occupied = new Set();
        for (const cell of object.cells) {
          // Reject overlapping merged cells without allocating a large grid.
          requireCondition(cell.rowSpan <= 1000 && cell.columnSpan <= 1000
            && cell.rowSpan * cell.columnSpan <= 10000, 'table_cell_span_invalid');
          for (let r = cell.row; r < cell.row + cell.rowSpan; r++) {
            for (let c = cell.column; c < cell.column + cell.columnSpan; c++) {
              const address = `${r}:${c}`;
              requireCondition(!occupied.has(address), 'table_cells_overlap');
              occupied.add(address);
            }
          }
        }
      }
    }
  }
  unique(objectIds, 'duplicate_object');
  for (const [category, key] of [
    ['formula-heavy', 'expectedEquations'], ['table-heavy', 'expectedTables'], ['figure-heavy', 'expectedFigures']
  ]) {
    requireCondition(paper.category !== category || annotation[key].length > 0, 'category_object_gold_missing');
  }
  checkReview(annotation, producer);
}

function checkQuery(query, papers, producer) {
  unique(query.targetPaperIds, 'duplicate_target_paper');
  requireCondition(query.targetPaperIds.every(paperId => papers.has(paperId)), 'query_paper_missing');
  requireCondition(query.category !== 'cross-paper' || query.targetPaperIds.length >= 2, 'cross_paper_targets_missing');
  requireCondition((query.category === 'unanswerable') === !query.answerable, 'query_answerability_category_mismatch');
  requireCondition(query.answerable
    ? query.expectedAnswer !== null && query.expectedEvidenceSpans.length > 0 && query.unanswerableReason === null
    : query.expectedAnswer === null && query.expectedEvidenceSpans.length === 0 && query.unanswerableReason !== null,
  'query_answerability_gold_mismatch');
  const targets = query.targetPaperIds.map(paperId => papers.get(paperId));
  for (const [key, annotationKey, identifierKey] of [
    ['targetBlockIds', 'blocks', 'blockId'], ['targetTableIds', 'expectedTables', 'id'],
    ['targetFigureIds', 'expectedFigures', 'id'], ['targetEquationIds', 'expectedEquations', 'id']
  ]) {
    unique(query[key], 'duplicate_query_target');
    requireCondition(query[key].every(targetId =>
      targets.some(target => target.annotation[annotationKey].some(object => object[identifierKey] === targetId))),
    'query_object_missing');
  }
  if (query.answerable) {
    requireCondition(query.targetBlockIds.length > 0, 'query_block_targets_missing');
    requireCondition(query.category !== 'table-results' || query.targetTableIds.length > 0, 'query_table_targets_missing');
    requireCondition(query.category !== 'figure' || query.targetFigureIds.length > 0, 'query_figure_targets_missing');
  }
  unique(query.expectedEvidenceSpans.map(span => span.id), 'duplicate_evidence');
  unique(query.expectedEvidenceSpans.map(span => `${span.paperId}:${span.blockId}:${span.start}:${span.end}`),
    'duplicate_evidence_span');
  const coveredPapers = new Set();
  for (const span of query.expectedEvidenceSpans) {
    const paper = papers.get(span.paperId);
    const block = paper?.annotation.blocks.find(candidate => candidate.blockId === span.blockId);
    requireCondition(query.targetPaperIds.includes(span.paperId) && paper?.sourceHash === span.sourceHash
      && query.targetBlockIds.includes(span.blockId) && block?.page === span.page
      && span.end > span.start && span.end <= block.text.length
      && block.text.slice(span.start, span.end) === span.quote, 'query_evidence_source_or_span_changed');
    coveredPapers.add(span.paperId);
  }
  if (query.answerable) {
    for (const [key, annotationKey] of [
      ['targetTableIds', 'expectedTables'], ['targetFigureIds', 'expectedFigures'],
      ['targetEquationIds', 'expectedEquations']
    ]) {
      requireCondition(query[key].every(targetId => targets.some(target => {
        const object = target.annotation[annotationKey].find(candidate => candidate.id === targetId);
        return object && query.expectedEvidenceSpans.some(span =>
          span.paperId === target.paperId && span.blockId === object.blockId);
      })), 'query_object_evidence_missing');
    }
  }
  requireCondition(query.category !== 'cross-paper' || coveredPapers.size >= 2, 'cross_paper_evidence_missing');
  checkReview(query, producer);
}

/** Qualification only: no model calls, production database access or quality scores. */
export async function checkScientificRagCorpus(manifestPath) {
  const issues = [];
  const issue = (subject, code) => issues.push({ subject, code });
  const paperCounts = Object.fromEntries(Object.keys(scientificPaperQuotas).map(key => [key, 0]));
  const queryCounts = Object.fromEntries(Object.keys(scientificQueryQuotas).map(key => [key, 0]));
  const files = [];
  const papers = new Map();
  let manifest = null, queries = [];
  try {
    const absolute = realpathSync(manifestPath), root = realpathSync(dirname(absolute));
    const manifestBytes = readFileSync(absolute);
    files.push({ path: 'manifest.json', sha256: sha256(manifestBytes) });
    manifest = scientificManifestSchema.parse(JSON.parse(manifestBytes));
    if (manifest.provenance.kind !== 'human_reviewed' || !manifest.provenance.producer
      || !manifest.provenance.sourceRevision || !manifest.provenance.license) {
      issue('manifest', 'human_reviewed_provenance_missing');
    }
    const seenIds = new Set(), seenHashes = new Set();
    for (const paper of manifest.papers) {
      try {
        requireCondition(!seenIds.has(paper.paperId), 'duplicate_paper');
        requireCondition(!seenHashes.has(paper.sourceHash), 'duplicate_pdf_source');
        seenIds.add(paper.paperId); seenHashes.add(paper.sourceHash);
        const pdfBytes = readContained(root, paper.pdfPath);
        files.push({ path: paper.pdfPath, sha256: sha256(pdfBytes) });
        requireCondition(sha256(pdfBytes) === paper.sourceHash, 'pdf_source_changed');
        let pdf;
        try {
          pdf = await PDFDocument.load(pdfBytes, { updateMetadata: false, throwOnInvalidObject: true });
        } catch (error) {
          throw new Error(error?.name === 'EncryptedPDFError' ? 'pdf_encrypted' : 'pdf_invalid');
        }
        requireCondition(pdf.getPageCount() > 0, 'pdf_pages_missing');
        const annotationBytes = readContained(root, paper.annotationPath);
        files.push({ path: paper.annotationPath, sha256: sha256(annotationBytes) });
        requireCondition(sha256(annotationBytes) === paper.annotationHash, 'annotation_file_changed');
        const annotation = scientificAnnotationSchema.parse(JSON.parse(annotationBytes));
        checkAnnotation(annotation, paper, pdf.getPageCount(), manifest.provenance.producer);
        papers.set(paper.paperId, { ...paper, annotation });
        paperCounts[paper.category]++;
      } catch (error) { issue(paper.paperId, failureCode(error)); }
    }
    try {
      const queryBytes = readContained(root, manifest.queriesPath);
      files.push({ path: manifest.queriesPath, sha256: sha256(queryBytes) });
      requireCondition(sha256(queryBytes) === manifest.queriesHash, 'queries_file_changed_or_unlocked');
      queries = z.array(scientificQuerySchema).parse(JSON.parse(queryBytes));
      const seenQueries = new Set(), seenQuestions = new Set();
      for (const query of queries) {
        try {
          requireCondition(!seenQueries.has(query.id), 'duplicate_query');
          seenQueries.add(query.id);
          const questionHash = hash({ query: query.query.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase(),
            papers: [...query.targetPaperIds].sort() });
          requireCondition(!seenQuestions.has(questionHash), 'duplicate_question');
          seenQuestions.add(questionHash);
          checkQuery(query, papers, manifest.provenance.producer);
          queryCounts[query.category]++;
        } catch (error) { issue(query.id, failureCode(error)); }
      }
    } catch (error) { issue('queries', failureCode(error)); }
  } catch (error) { issue('manifest', failureCode(error)); }
  for (const [category, minimum] of Object.entries(scientificPaperQuotas)) {
    if (paperCounts[category] < minimum) issue(category, `paper_quota_missing:${paperCounts[category]}/${minimum}`);
  }
  for (const [category, minimum] of Object.entries(scientificQueryQuotas)) {
    if (queryCounts[category] < minimum) issue(category, `query_quota_missing:${queryCounts[category]}/${minimum}`);
  }
  issues.sort((a, b) => a.subject.localeCompare(b.subject, 'en') || a.code.localeCompare(b.code, 'en'));
  return {
    schemaVersion: 1, kind: 'scientific-rag-corpus-readiness', corpusId: manifest?.id ?? null,
    status: issues.length ? 'blocked' : 'ready', corpusReady: issues.length === 0,
    // A successful data check is not a measured baseline or human authenticity proof.
    scientificBaselineReady: false,
    verifiedPapers: papers.size,
    verifiedQueries: Object.values(queryCounts).reduce((sum, count) => sum + count, 0),
    paperCounts, queryCounts, requiredPapers: scientificPaperQuotas, requiredQueries: scientificQueryQuotas,
    inputDigest: hash(files.sort((a, b) => a.path.localeCompare(b.path, 'en'))), issues
  };
}

function failureCode(error) {
  if (error instanceof z.ZodError) return 'schema_invalid';
  if (error instanceof SyntaxError) return 'json_invalid';
  if (error?.code === 'ENOENT') return 'file_missing';
  if (error?.code === 'EACCES') return 'file_unreadable';
  if (error?.name === 'EncryptedPDFError') return 'pdf_encrypted';
  if (/PDF|pdf/gu.test(error?.name ?? '')) return 'pdf_invalid';
  // Do not expose source text, absolute paths or parser/provider diagnostics.
  const code = error instanceof Error ? error.message : '';
  return /^[a-z][a-z0-9_]+$/u.test(code) ? code : 'input_invalid';
}
