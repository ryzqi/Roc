import {mkdirSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {alignM3Evidence, extractM3PdfText, m3EvidenceContract, verifyM3EvidenceArtifact} from '../evaluation/adapters/scientific-public/m3sciqa-evidence.mjs';
import {defaultM3LabelsRoot, defaultM3PdfRoot, validateM3PdfInputs, verifyM3PdfSources} from '../evaluation/adapters/scientific-public/m3sciqa-pdf-sources.mjs';
import {publicPdfArtifactPath} from '../evaluation/adapters/scientific-public/pdf.mjs';
import {hash, readJson, writeJson} from '../evaluation/lib/common.mjs';

const {values} = parseArgs({options: {root: {type: 'string'}, 'labels-root': {type: 'string'},
  'output-root': {type: 'string'}, verify: {type: 'boolean'}}, allowPositionals: false, strict: true});
try {
  if (!values['output-root']) throw new Error('scientific_m3_evidence_output_required');
  const root = resolve(values.root ?? defaultM3PdfRoot), labelsRoot = resolve(values['labels-root'] ?? defaultM3LabelsRoot);
  const outputRoot = resolve(values['output-root']);
  const {labels, lock} = validateM3PdfInputs(labelsRoot);
  const sourceReport = verifyM3PdfSources({root, labelsRoot, lock});
  if (!values.verify) mkdirSync(outputRoot, {recursive: false, mode: 0o700});
  const save = (name, data) => {
    if (values.verify) verifyM3EvidenceArtifact(readJson(publicPdfArtifactPath(outputRoot, name)), data);
    else writeJson(join(outputRoot, name), data);
  };
  const rows = [], papers = [];
  for (const cohort of lock.cohort) {
    const selectedLabels = labels.filter(label => label.original.reference_arxiv_id === cohort.paperId);
    const pin = lock.sources[0].files.find(file => file.path === `${cohort.paperId}.pdf`);
    const document = pin ? await extractM3PdfText(readFileSync(publicPdfArtifactPath(root, pin.path)), pin.sha256) : null;
    if (document) {
      const artifact = `${cohort.paperId}.native.json`;
      save(artifact, document);
      papers.push({paperId: cohort.paperId, sourceHash: pin.sha256, pageCount: document.pageCount,
        artifact, artifactHash: hash(document)});
    } else papers.push({paperId: cohort.paperId, sourceHash: null, failure: cohort.failure});
    rows.push(...selectedLabels.map(label => alignM3Evidence(label, document)));
    console.log(JSON.stringify({paperId: cohort.paperId, questions: selectedLabels.length,
      pageCount: document?.pageCount ?? null, unique: rows.filter(row => row.referencePaperId === cohort.paperId
        && row.status === 'unique-normalized-text-match').length}));
  }
  // Keep every published row including questions outside the preselected cohort.
  const selectedIds = new Set(rows.map(row => row.id));
  for (const label of labels.filter(label => !selectedIds.has(label.id))) {
    rows.push({...alignM3Evidence(label, null), status: 'outside-cohort'});
  }
  rows.sort((a, b) => a.publishedRow - b.publishedRow);
  save('alignment.json', rows);
  const counts = {};
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  const unique = rows.filter(row => row.status === 'unique-normalized-text-match');
  const manifest = {schemaVersion: 1, kind: 'scientific-m3sciqa-original-pdf-text-alignment',
    contract: m3EvidenceContract, sourceLockHash: sourceReport.sourceLockHash, labelsHash: lock.labelsHash,
    publishedRows: labels.length, selectedRows: lock.publishedQuestions, counts,
    uniquePassages: new Set(unique.map(row => hash([row.referencePaperId, row.matches[0].page,
      row.matches[0].normalizedRange]))).size,
    alignmentHash: hash(rows), papers, scientificBaselineReady: false,
    limitations: [
      'Full reference evidence only; no fuzzy/partial matching or production parser predictions as gold.',
      'Original text-item order retained; no inferred cross-column or cross-page passage reconstruction.',
      'Font-metric regions cover whole text items, not independently human-reviewed glyph bounding boxes.',
      'Anchor table/figure crops still have no original-PDF object locators.',
      'Unversioned upstream paper IDs do not prove whole-PDF revision identity.',
      'All failed, unmatched, ambiguous, missing and outside-cohort rows retained.',
    ]};
  save('manifest.json', manifest);
  console.log(JSON.stringify({verified: Boolean(values.verify), counts, uniquePassages: manifest.uniquePassages,
    alignmentHash: manifest.alignmentHash, scientificBaselineReady: false}, null, 2));
} catch (error) {console.error(error.stack);process.exitCode = 1;}
