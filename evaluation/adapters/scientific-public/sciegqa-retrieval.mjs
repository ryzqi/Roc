import Database from 'better-sqlite3';
import {lstatSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileInventory, hash, readJson, ROOT, sha256} from '../../lib/common.mjs';
import {publicPdfArtifactPath} from './pdf.mjs';
import {sciegqaEvidenceContract} from './sciegqa-evidence.mjs';

/** Revalidate every stored observation against the previously repeated,
 * independently reconstructed inventory; reconstruct labels from observations. */
export function loadSciegqaCorrespondence(root, manifest, labels) {
  const observed = readJson(publicPdfArtifactPath(root, 'manifest.json'));
  const baseline = readJson(join(ROOT, 'evaluation/results/baseline/sciegqa-correspondence.json'));
  const alignment = readJson(publicPdfArtifactPath(root, 'alignment.json'));
  if (observed.sourceLockHash !== manifest.sourceLockHash || observed.labelsHash !== manifest.labelsHash
    || observed.exporterHash !== manifest.exporterHash
    || hash(observed.contract) !== hash(sciegqaEvidenceContract)
    || observed.runnerHash !== sha256(readFileSync(join(ROOT, 'scripts/align-scientific-sciegqa-evidence.mjs')))
    || observed.alignmentHash !== hash(alignment) || observed.publishedRows !== labels.length
    || observed.alignmentHash !== baseline.alignmentHash
    || observed.papers.length !== manifest.papers.length) {
    throw new Error('scientific_sciegqa_correspondence_inputs_changed');
  }
  const regionById = new Map();
  for (const [i, paper] of manifest.papers.entries()) {
    const pin = observed.papers[i];
    const value = readJson(publicPdfArtifactPath(root, pin.artifact));
    if (pin.id !== paper.id || value.id !== paper.id || value.sourceHash !== paper.pdf?.sha256
      || pin.artifactHash !== hash(value)) throw new Error('scientific_sciegqa_correspondence_paper_changed');
    for (const page of value.pages) for (const region of page.regions) {
      if (region.id !== hash([paper.id, page.page, region.normalizedBbox])) {
        throw new Error('scientific_sciegqa_correspondence_region_changed');
      }
      regionById.set(region.id, region);
    }
  }
  const rebuilt = labels.map(label => {
    const evidence = label.evidence.map(region => {
      const id = hash([label.paperId, region.page, region.normalizedBbox]);
      return {publishedRegionId: region.id, observationId: id,
        status: regionById.get(id)?.status ?? 'source-region-unavailable'};
    });
    return {id: label.id, publishedRow: label.publishedRow, paperId: label.paperId, evidence,
      status: label.status === 'published-image-regions-verified' && evidence.length > 0
        && evidence.every(e => e.status === 'visual-correspondence-candidate')
        ? 'all-published-regions-visual-candidates' : 'unqualified-source-correspondence',
      humanLocatorReview: false};
  });
  if (hash(rebuilt) !== hash(alignment)
    || hash(fileInventory(root).map(f => f.path).sort())
      !== hash(['manifest.json', 'alignment.json', ...observed.papers.map(p => p.artifact)].sort())) {
    throw new Error('scientific_sciegqa_correspondence_alignment_changed');
  }
  return {alignment, alignmentHash: hash(alignment), manifestHash: hash(observed),
    inventoryHash: hash(fileInventory(root))};
}

export const sciegqaRegionRetrievalContract = {
  version: 'sciegqa-published-region-block-retrieval-observation/1',
  minRegionIou: 0.5, typeCompatible: true,
  textKinds: ['paragraph', 'heading', 'caption', 'list', 'reference'],
  imageKinds: ['figure'], tableKinds: ['table'],
  evidence: 'original-published-semantic-region',
  metric: 'candidate-region-block-hit-recall',
  granularity: 'any-verified-child-text-from-region-matched-parent-block',
  humanLocatorReview: false, scientificBaselineReady: false,
};

/** Independent SQL/source-span verification. No production indexing imports. */
export function readSciegqaIndex(path, sources, projectId) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('scientific_sciegqa_index_not_regular');
  const db = new Database(path, {readonly: true, fileMustExist: true});
  try {
    if (db.pragma('quick_check', {simple: true}) !== 'ok' || db.pragma('foreign_key_check').length) {
      throw new Error('scientific_sciegqa_index_corrupt');
    }
    const documents = db.prepare('SELECT * FROM research_knowledge_documents ORDER BY id').all();
    const chunks = db.prepare(`SELECT c.*,s.parent_chunk_id,s.start_utf16,s.end_utf16,
      s.section,m.metadata_json AS semantic_json FROM research_knowledge_chunks c
      LEFT JOIN research_knowledge_chunk_structure s ON s.chunk_id=c.id
      LEFT JOIN research_knowledge_chunk_semantics m ON m.chunk_id=c.id ORDER BY c.id`).all();
    const sourceById = new Map(sources.map(s => [s.id, s]));
    if (sourceById.size !== sources.length || sources.some(s =>
      hash(s.parsed) !== s.resultHash || s.parseId !== `evaluation-sciegqa:${s.resultHash}`)) {
      throw new Error('scientific_sciegqa_index_source_changed');
    }
    const chunkById = new Map(chunks.map(c => [c.id, c])), versionDocuments = new Map();
    if (documents.length !== sources.length) throw new Error('scientific_sciegqa_index_document_missing');
    for (const document of documents) {
      const source = sourceById.get(document.id), metadata = JSON.parse(document.metadata_json);
      const content = source?.parsed.blocks.filter(b => b.text.trim()).map(b => b.text).join('\n\n');
      if (!source || source.parsed.sourceHash !== source.sourceHash
        || document.content !== content || document.content_hash !== sha256(content)
        || document.project_id !== projectId || document.source_id !== source.id
        || document.source_type !== 'file' || document.title !== source.title
        || metadata.sourceHash !== source.sourceHash || metadata.contentSha256 !== sha256(content)
        || metadata.parseId !== source.parseId || metadata.sourceVersion !== source.resultHash
        || metadata.parserVersion !== source.parsed.parserVersion
        || metadata.parserFingerprint !== source.parsed.parserFingerprint
        || metadata.sourceUri !== source.sourceUri || metadata.license !== null) {
        throw new Error('scientific_sciegqa_index_source_changed');
      }
      versionDocuments.set(document.id, {document_hash: document.content_hash, document_project: document.project_id,
        title: document.title, source_type: document.source_type, source_id: document.source_id,
        metadata_json: document.metadata_json});
      const parents = chunks.filter(c => c.document_id === document.id && c.parent_chunk_id === null);
      const blockIds = parents.map(c => JSON.parse(c.semantic_json).blockId);
      if (hash([...blockIds].sort()) !== hash(source.parsed.blocks.filter(b => b.text.trim()).map(b => b.id).sort())) {
        throw new Error('scientific_sciegqa_index_parent_missing');
      }
    }
    const mapped = chunks.map(chunk => {
      const source = sourceById.get(chunk.document_id);
      const parent = chunk.parent_chunk_id ? chunkById.get(chunk.parent_chunk_id) : chunk;
      if (!source || !parent || parent.parent_chunk_id !== null || parent.document_id !== chunk.document_id) {
        throw new Error('scientific_sciegqa_index_parent_changed');
      }
      const semantic = JSON.parse(chunk.semantic_json), parentSemantic = JSON.parse(parent.semantic_json);
      const block = source.parsed.blocks.find(b => b.id === semantic.blockId);
      const child = chunk.parent_chunk_id !== null;
      const expectedLocator = child
        ? `${parent.locator ?? 'text'}; UTF-16 ${chunk.start_utf16 + 1}-${chunk.end_utf16}` : block?.locator;
      if (!block || semantic.blockId !== parentSemantic.blockId
        || semantic.sourceHash !== source.sourceHash || semantic.parseId !== source.parseId
        || semantic.paperId !== source.id || semantic.blockKind !== block.kind
        || parentSemantic.sourceHash !== source.sourceHash || parentSemantic.parseId !== source.parseId
        || parentSemantic.paperId !== source.id || parentSemantic.blockKind !== block.kind
        || parent.content !== block.text || parent.locator !== block.locator
        || chunk.project_id !== projectId || chunk.content_hash !== sha256(chunk.content)
        || !Number.isInteger(chunk.start_utf16) || !Number.isInteger(chunk.end_utf16)
        || chunk.start_utf16 < 0 || chunk.end_utf16 > block.text.length
        || chunk.end_utf16 <= chunk.start_utf16
        || (!child && (chunk.start_utf16 !== 0 || chunk.end_utf16 !== block.text.length))
        || block.text.slice(chunk.start_utf16, chunk.end_utf16) !== chunk.content
        || chunk.locator !== expectedLocator) throw new Error('scientific_sciegqa_index_span_changed');
      const fields = {document_id: chunk.document_id, content_hash: chunk.content_hash,
        locator: chunk.locator, project_id: chunk.project_id};
      return {chunkId: chunk.id, parentChunkId: parent.id, documentId: source.id, projectId,
        paperId: source.id, sourceId: source.id, sourceSha256: source.sourceHash, parseId: source.parseId,
        blockId: block.id, blockKind: block.kind, startOffset: chunk.start_utf16, endOffset: chunk.end_utf16,
        contentChars: chunk.content.length, locator: chunk.locator, chunkHash: chunk.content_hash,
        indexedVersion: sha256(JSON.stringify({...fields, ...versionDocuments.get(source.id), semantic})),
        retrieved: !chunks.some(c => c.parent_chunk_id === chunk.id)};
    });
    if (db.prepare('SELECT count(*) FROM research_knowledge_embeddings').pluck().get() !== 0) {
      throw new Error('scientific_sciegqa_bm25_unexpected_embeddings');
    }
    return {schemaVersion: 1, documents: documents.map(d => ({id: d.id, projectId,
      sourceId: d.source_id, contentHash: d.content_hash, metadataHash: sha256(d.metadata_json)})),
    chunks: mapped, embeddings: []};
  } finally {db.close();}
}

export function sciegqaRegionIou(a, b) {
  for (const box of [a, b]) if (!Array.isArray(box) || box.length !== 4 || box.some(v => !Number.isFinite(v))
    || box[0] < 0 || box[1] < 0 || box[2] > 1 || box[3] > 1 || box[2] <= box[0] || box[3] <= box[1]) {
    throw new Error('scientific_sciegqa_region_bbox_invalid');
  }
  const intersection = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
    * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const area = box => (box[2] - box[0]) * (box[3] - box[1]);
  return intersection / (area(a) + area(b) - intersection);
}

/** Mechanical region/block candidates, never complete text-span recall or
 * an assertion that OCR preserved the scientific answer. Missing blocks stay. */
export function mapSciegqaRegions(question, correspondence, source, structured) {
  if (correspondence.id !== question.id || correspondence.paperId !== question.paperId
    || source && source.id !== question.paperId) throw new Error('scientific_sciegqa_region_source_changed');
  const observations = new Map(correspondence.evidence.map(e => [e.publishedRegionId, e]));
  const frames = new Map(structured?.pages.map(p => [p.page, p.coordinateFrame]) ?? []);
  return question.evidence.map(region => {
    const qualified = observations.get(region.id)?.status === 'visual-correspondence-candidate';
    const matches = [];
    if (source && qualified) for (const block of source.parsed.blocks.filter(b => b.text.trim())) {
      const kinds = sciegqaRegionRetrievalContract[`${region.kind}Kinds`];
      if (!kinds?.includes(block.kind)) continue;
      let best = 0;
      for (const location of block.locations ?? []) {
        if (location.page !== region.page) continue;
        const frame = frames.get(location.page);
        if (!frame || frame.kind !== 'pdf' || location.coordinateOrigin !== 'TOPLEFT') {
          throw new Error('scientific_sciegqa_region_frame_missing');
        }
        // Use the actual noninteger viewport, not rounded raster allocation.
        const bbox = location.bbox.map((v, i) => v / (i % 2 ? frame.viewport.height : frame.viewport.width));
        // Parser locations may include the rounded outer edge of its raster.
        const clamped = bbox.map(v => Math.min(1, Math.max(0, v)));
        best = Math.max(best, sciegqaRegionIou(region.normalizedBbox, clamped));
      }
      if (best >= sciegqaRegionRetrievalContract.minRegionIou) matches.push({blockId: block.id, iou: best});
    }
    return {regionId: region.id, page: region.page, kind: region.kind, sourceCorrespondenceCandidate: qualified,
      status: !qualified ? 'unqualified-source-correspondence' : !source ? 'production-parse-failed'
        : matches.length ? 'candidate-blocks-mapped' : 'no-compatible-production-block',
      matches: matches.sort((a, b) => a.blockId.localeCompare(b.blockId))};
  });
}

export function scoreSciegqaRegionRetrieval(mapping, result, state, paperId) {
  if (mapping.some(r => !r.sourceCorrespondenceCandidate)) {
    return {status: 'unqualified-source-correspondence', metrics: null, regions: mapping.length};
  }
  const byId = new Map(state.chunks.map(c => [c.chunkId, c]));
  const unique = [...new Map(mapping.map(r => [r.regionId, r])).values()];
  const recovered = k => unique.filter(r => result.hits.slice(0, k).some(hit => {
    const chunk = byId.get(hit.chunkId);
    return chunk?.documentId === paperId && r.matches.some(m => m.blockId === chunk.blockId);
  })).length;
  const metrics = Object.fromEntries([5, 10, 20].map(k =>
    [`candidateRegionBlockRecallAt${k}`, unique.length ? recovered(k) / unique.length : null]));
  return {status: 'scored-mechanical-region-candidates', metrics, regions: unique.length,
    mappedRegions: unique.filter(r => r.matches.length).length};
}
