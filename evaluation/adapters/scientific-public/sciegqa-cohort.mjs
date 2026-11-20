import {hash} from '../../lib/common.mjs';

export const sciegqaCohortSelection = {
  version: 'sciegqa-balanced-published-cohort/1', papers: 45, questionsPerPaper: 5,
  paperOrder: 'arxiv-id-ascending-within-domain-then-round-robin-lexicographic-domain',
  questionOrder: 'original-published-row-ascending',
  selectionUses: ['original-paper-id', 'original-domain', 'original-published-row'],
  selectionExcludes: ['parser-output', 'image-correspondence-outcome', 'retrieval-result', 'download-success'],
};

/** Public human QA and semantic-region evidence, with no invented plan category
 * or reviewer. Select before production inference and retain unavailable rows. */
export function selectSciegqaCohort(manifest, labels) {
  if (manifest.tasks !== labels.length || !Array.isArray(manifest.papers)
    || new Set(manifest.papers.map(p => p.id)).size !== manifest.papers.length
    || new Set(labels.map(q => q.id)).size !== labels.length) {
    throw new Error('scientific_sciegqa_cohort_inputs_invalid');
  }
  const domains = [...new Set(manifest.papers.map(p => p.domain))].sort();
  const groups = domains.map(domain => manifest.papers.filter(p => p.domain === domain)
    .sort((a, b) => a.docName.localeCompare(b.docName)));
  const selected = [];
  for (let rank = 0; selected.length < sciegqaCohortSelection.papers; rank++) {
    let found = false;
    for (const group of groups) if (group[rank]) {
      found = true; selected.push(group[rank]);
      if (selected.length === sciegqaCohortSelection.papers) break;
    }
    if (!found) throw new Error('scientific_sciegqa_cohort_insufficient_papers');
  }
  const papers = selected.map(paper => {
    const questions = labels.filter(q => q.paperId === paper.id)
      .sort((a, b) => a.publishedRow - b.publishedRow)
      .slice(0, sciegqaCohortSelection.questionsPerPaper);
    if (questions.length !== sciegqaCohortSelection.questionsPerPaper) {
      throw new Error('scientific_sciegqa_cohort_insufficient_questions');
    }
    return {id: paper.id, domain: paper.domain, docName: paper.docName, pdf: paper.pdf,
      paperLayoutCategory: null,
      questions: questions.map(q => ({id: q.id, publishedRow: q.publishedRow, queryCategory: null,
        publishedRegionIds: q.evidence.map(e => e.id)}))};
  });
  return {schemaVersion: 1, kind: 'scientific-sciegqa-preselected-public-cohort',
    selection: sciegqaCohortSelection, sourceLockHash: manifest.sourceLockHash,
    sourceRevision: manifest.sourceRevision, labelsHash: manifest.labelsHash,
    annotationProvenance: manifest.annotationProvenance, license: manifest.license,
    papers, questionCount: papers.reduce((n, p) => n + p.questions.length, 0),
    scientificBaselineReady: false};
}

export function verifySciegqaCohort(actual, manifest, labels) {
  const reconstructed = selectSciegqaCohort(manifest, labels);
  if (hash(actual) !== hash(reconstructed)) throw new Error('scientific_sciegqa_cohort_changed');
  return reconstructed;
}
