import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {acquireExpertPublicSources, verifyExpertPublicSources} from './expert-sources.mjs';
import {publicPdfArtifactPath} from './pdf.mjs';
import {EVAL_ROOT, hash, readJson, sha256} from '../../lib/common.mjs';

export const m3PdfSourceLock = new URL('../../corpora/scientific-rag/m3sciqa-pdf-sources.lock.json', import.meta.url);
export const defaultM3PdfRoot = join(EVAL_ROOT, 'local/sources/scientific-m3sciqa-pdfs');
export const defaultM3LabelsRoot = join(EVAL_ROOT, 'local/corpora/scientific-m3sciqa-v1');
export const m3PdfSelection = 'top45-reference-question-count-desc-arxiv-id-asc-before-download-and-mapping';

/** Published labels are separately byte-pinned; the PDF cohort never depends on
 * parser predictions or which evidence passages happen to align. */
export function validateM3PdfInputs(labelsRoot, lock = readJson(m3PdfSourceLock)) {
  const bytes = readFileSync(publicPdfArtifactPath(labelsRoot, 'labels.json'));
  const expert = readJson(new URL('../../corpora/scientific-rag/expert-sources.lock.json', import.meta.url));
  const source = expert.sources.find(row => row.id === 'm3sciqa');
  if (lock.schemaVersion !== 1 || lock.id !== 'scientific-m3sciqa-reference-pdfs-v1'
    || lock.datasetRevision !== source.revision || lock.selection !== m3PdfSelection
    || lock.labelsHash !== '2404fe96496310c6b3c46e41276516d7a7c0cef401fb4c9327506ac374da9330'
    || sha256(bytes) !== lock.labelsHash) throw new Error('scientific_m3_pdf_labels_changed');
  const labels = JSON.parse(bytes), counts = new Map();
  if (!Array.isArray(labels) || labels.length !== source.expectedRows
    || labels.some((row, i) => row.id !== `m3sciqa:validation:${i}` || row.publishedRow !== i
      || typeof row.original?.evidence_reference !== 'string'
      || !/^\d{4}\.\d{4,5}$/u.test(row.original?.reference_arxiv_id))) {
    throw new Error('scientific_m3_pdf_labels_invalid');
  }
  for (const row of labels) {
    const id = row.original.reference_arxiv_id;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  validateM3PdfCohort(counts, lock);
  return {labels, lock};
}

export function validateM3PdfCohort(counts, lock) {
  const selected = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, 45);
  const files = lock.sources?.[0]?.files;
  if (lock.sources?.length !== 1 || !Array.isArray(files) || !Array.isArray(lock.cohort)
    || hash(lock.cohort.map(row => [row.paperId, row.publishedQuestions])) !== hash(selected)
    || lock.publishedQuestions !== selected.reduce((sum, [, count]) => sum + count, 0)
    || files.length !== lock.cohort.filter(row => row.status === 'downloaded').length
    || new Set(files.map(file => file.path)).size !== files.length) {
    throw new Error('scientific_m3_pdf_cohort_changed');
  }
  for (const row of lock.cohort) {
    const pin = files.find(file => file.path === `${row.paperId}.pdf`);
    if (row.status === 'failed') {
      if (!row.failure || pin) throw new Error('scientific_m3_pdf_failure_invalid');
      continue;
    }
    if (row.status !== 'downloaded' || !pin || row.failure !== null
      || pin.url !== `https://arxiv.org/pdf/${row.paperId}` || pin.license !== null
      || !Number.isSafeInteger(pin.bytes) || pin.bytes <= 0 || pin.bytes > 32 * 1024 * 1024
      || pin.revisionCorrespondence !== 'unversioned-upstream-id-byte-pinned-at-acquisition') {
      throw new Error('scientific_m3_pdf_pin_invalid');
    }
  }
}

export function verifyM3PdfSources({root = defaultM3PdfRoot, labelsRoot = defaultM3LabelsRoot,
  lock = readJson(m3PdfSourceLock)} = {}) {
  validateM3PdfInputs(labelsRoot, lock);
  const report = verifyExpertPublicSources(root, lock);
  for (const pin of lock.sources[0].files) {
    if (readFileSync(publicPdfArtifactPath(root, pin.path)).subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new Error('scientific_m3_pdf_signature_invalid');
    }
  }
  return {...report, root: resolve(root), cohort: lock.cohort, publishedQuestions: lock.publishedQuestions,
    downloadedPapers: report.files.length, failedPapers: lock.cohort.filter(row => row.status === 'failed').length,
    scientificBaselineReady: false};
}

export async function acquireM3PdfSources({root = defaultM3PdfRoot, labelsRoot = defaultM3LabelsRoot,
  offline = false} = {}) {
  const {lock} = validateM3PdfInputs(labelsRoot);
  await acquireExpertPublicSources({root, offline, lock});
  return verifyM3PdfSources({root, labelsRoot, lock});
}
