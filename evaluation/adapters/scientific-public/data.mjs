import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDataset } from '../../lib/data.mjs';
import { hash, readJson, sha256 } from '../../lib/common.mjs';
import { publicScientificSourceLock } from './sources.mjs';

/** Replay the existing sealed adaptation; only public source paragraphs go to
 * production. Questions, answers and annotator identities stay with the scorer. */
export function loadPublicQasper(root) {
  const dataset = loadDataset(root);
  if (dataset.manifest.suite !== 'qasper' || dataset.qasperQualification?.status !== 'verified') {
    throw new Error('scientific_public_qasper_unqualified');
  }
  const originals = readJson(join(dataset.root, dataset.qasperQualification.sourceContract.source.member));
  const papers = new Map();
  for (const task of dataset.tasks) {
    const value = { title: task.visible.title, paragraphs: task.visible.paragraphs };
    if (papers.has(task.clusterId) && hash(papers.get(task.clusterId)) !== hash(value)) {
      throw new Error('scientific_public_paper_inconsistent');
    }
    papers.set(task.clusterId, value);
  }
  const documents = [...papers].sort(([a], [b]) => a.localeCompare(b)).map(([paperId, paper]) => {
    let content = '';
    const blocks = paper.paragraphs.map(paragraph => {
      if (content.length) content += '\n\n';
      const startOffset = content.length;
      content += paragraph.text;
      return { id: paragraph.id, startOffset, endOffset: content.length, section: paragraph.section };
    });
    return { id: `qasper:${paperId}`, projectId: 'scientific-public-qasper', sourceId: paperId,
      sourceVersion: 'qasper-v0.3-dev-text', parserVersion: 'qasper-official-paragraphs-v1',
      sourceUri: `https://arxiv.org/abs/${paperId}`, license: 'CC-BY-4.0', current: true,
      sourceType: 'literature', title: paper.title, content, contentSha256: sha256(content), blocks };
  });
  const tasks = dataset.tasks.filter(task => !task.unsupported).map(task => {
    const original = originals[task.clusterId].qas.find(qa => qa.question_id === task.id);
    if (!original) throw new Error('scientific_public_original_question_missing');
    return { ...task, publishedAnnotation: {
      kind: 'published-human-annotations', questionId: original.question_id,
      questionWriter: original.question_writer,
      annotations: original.answers.map(answer => ({
        annotationId: answer.annotation_id, workerId: answer.worker_id, originalAnswer: answer.answer
      }))
    } };
  });
  const lock = readJson(publicScientificSourceLock), cohort = new Set(lock.qasper.pdfCohort);
  return { dataset, documents, tasks, pdfCohortTasks: tasks.filter(task => cohort.has(task.clusterId)),
    sourceLockHash: sha256(readFileSync(publicScientificSourceLock)) };
}

// The production search request schema trims surrounding query whitespace.
// Preserve the published question in the annotation artifact, normalize only
// the request sent to production and its independent request verifier.
export function publicQasperSearchRequest(task, document) {
  const query = task.visible.question.trim();
  if (!query) throw new Error('scientific_public_question_empty');
  return { query, projectId: document.projectId, documentId: document.id,
    limit: 20, embeddingConfigId: null };
}

/** Full paragraph recovery: a paragraph may span several production child
 * chunks. Union intervals per document, never match another paper's text. */
export function scoreQasperRetrieval(task, result, state, document) {
  const chunks = new Map(state.chunks.map(chunk => [chunk.chunkId, chunk]));
  const ranges = result.hits.map(hit => {
    const chunk = chunks.get(hit.chunkId);
    if (!chunk || chunk.documentId !== document.id) throw new Error('scientific_public_retrieval_source_invalid');
    return [chunk.startOffset, chunk.endOffset];
  });
  const paragraphs = new Map(task.visible.paragraphs.map(paragraph => [paragraph.text,
    document.blocks.filter(block => document.content.slice(block.startOffset, block.endOffset) === paragraph.text)]));
  const answerableReferences = task.references.filter(reference => reference.evidence.length);
  if (!answerableReferences.length) return { evidenceRecallAt5: null, evidenceRecallAt10: null,
    evidenceRecallAt20: null, reciprocalRank: null, chunkRecallAt5: null, chunkRecallAt10: null,
    chunkRecallAt20: null, reciprocalRankAt10: null, ndcgAt10: null,
    unanswerable: true, returnedHits: ranges.length };
  if (answerableReferences.some(reference => reference.evidence.some(text => !paragraphs.get(text)?.length))) {
    throw new Error('scientific_public_evidence_unmapped');
  }
  const recovered = (block, selected) => {
    const intervals = selected.map(([start, end]) => [Math.max(start, block.startOffset), Math.min(end, block.endOffset)])
      .filter(([start, end]) => end > start).sort(([a], [b]) => a - b);
    let cursor = block.startOffset;
    for (const [start, end] of intervals) {
      if (start > cursor) return false;
      cursor = Math.max(cursor, end);
    }
    return cursor >= block.endOffset;
  };
  const recalls = [5, 10, 20].map(k => Math.max(...answerableReferences.map(reference =>
    reference.evidence.filter(text => (paragraphs.get(text) ?? []).some(block => recovered(block, ranges.slice(0, k)))).length
      / reference.evidence.length)));
  let first = null;
  for (let rank = 1; rank <= ranges.length; rank++) {
    if (answerableReferences.some(reference => reference.evidence.some(text =>
      (paragraphs.get(text) ?? []).some(block => recovered(block, ranges.slice(0, rank)))))) { first = rank; break; }
  }
  // Standard binary chunk relevance: any positive source-span overlap with a
  // published evidence paragraph. Score full-paragraph recovery separately.
  const chunkScores = answerableReferences.map(reference => {
    const goldBlocks = reference.evidence.flatMap(text => paragraphs.get(text));
    const relevant = new Set(state.chunks.filter(chunk => chunk.documentId === document.id
      && chunk.retrieved !== false && goldBlocks.some(block =>
        chunk.startOffset < block.endOffset && chunk.endOffset > block.startOffset)).map(chunk => chunk.chunkId));
    if (!relevant.size) throw new Error('scientific_public_evidence_not_indexed');
    const gains = result.hits.map(hit => Number(relevant.has(hit.chunkId)));
    const at = k => gains.slice(0, k).reduce((sum, gain) => sum + gain, 0) / relevant.size;
    const rank = gains.slice(0, 10).indexOf(1);
    const dcg = gains.slice(0, 10).reduce((sum, gain, i) => sum + gain / Math.log2(i + 2), 0);
    const ideal = Array.from({ length: Math.min(10, relevant.size) },
      (_, i) => 1 / Math.log2(i + 2)).reduce((sum, gain) => sum + gain, 0);
    return { chunkRecallAt5: at(5), chunkRecallAt10: at(10), chunkRecallAt20: at(20),
      reciprocalRankAt10: rank < 0 ? 0 : 1 / (rank + 1), ndcgAt10: dcg / ideal };
  });
  const best = key => Math.max(...chunkScores.map(score => score[key]));
  return { evidenceRecallAt5: recalls[0], evidenceRecallAt10: recalls[1], evidenceRecallAt20: recalls[2],
    reciprocalRank: first ? 1 / first : 0, chunkRecallAt5: best('chunkRecallAt5'),
    chunkRecallAt10: best('chunkRecallAt10'), chunkRecallAt20: best('chunkRecallAt20'),
    reciprocalRankAt10: best('reciprocalRankAt10'), ndcgAt10: best('ndcgAt10'),
    unanswerable: false, returnedHits: ranges.length };
}
