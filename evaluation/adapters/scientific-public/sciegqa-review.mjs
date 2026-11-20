import {relative, resolve, sep} from 'node:path';
import {hash} from '../../lib/common.mjs';
import {verifySciegqaCohort} from './sciegqa-cohort.mjs';

const materialKind = 'sciegqa-original-source-review-materials';
const worklistKind = 'sciegqa-unreviewed-worklist';
const paperDecisions = ['paperLayoutCategory', 'fullStructureAnnotation', 'review'];
const queryDecisions = ['queryCategory', 'targetPaperIds', 'targetBlockIds', 'targetTableIds',
  'targetFigureIds', 'targetEquationIds', 'expectedEvidenceSpans', 'expectedAnswer',
  'answerable', 'unanswerableReason', 'review'];
const emptyDecisions = keys => Object.fromEntries(keys.map(key => [key, null]));
const same = (actual, expected) => {
  if (hash(actual) !== hash(expected)) throw new Error('scientific_sciegqa_review_materials_changed');
};

/** A source-only work packet. Published answers/regions never become local gold. */
export function createSciegqaReviewMaterials(inputs) {
  const {manifest, labels, cohort, correspondence, correspondencePapers, sourcePins} = inputs;
  verifySciegqaCohort(cohort, manifest, labels);
  const paperById = new Map(manifest.papers.map(p => [p.id, p]));
  const labelById = new Map(labels.map(q => [q.id, q]));
  const alignmentById = new Map(correspondence.alignment.map(q => [q.id, q]));
  const materials = {
    schemaVersion: 1, kind: materialKind, cohortHash: hash(cohort), sourcePins,
    sourceRevision: manifest.sourceRevision, sourceLockHash: manifest.sourceLockHash,
    labelsByteHash: manifest.labelsHash, annotationProvenance: manifest.annotationProvenance,
    license: manifest.license, humanReviewed: false, scientificBaselineReady: false,
    papers: cohort.papers.map(paper => ({
      publishedPaper: paperById.get(paper.id),
      correspondenceArtifact: correspondencePapers.get(paper.id),
      questions: paper.questions.map(q => ({
        publishedLabel: labelById.get(q.id), sourceCorrespondence: alignmentById.get(q.id),
      })),
    })),
  };
  const worklist = {
    schemaVersion: 1, kind: worklistKind, materialsHash: hash(materials),
    humanReviewed: false, scientificBaselineReady: false,
    papers: materials.papers.map(p => ({
      paperId: p.publishedPaper.id, sourceHash: p.publishedPaper.pdf?.sha256 ?? null,
      sourceRecordHash: hash(p), ...emptyDecisions(paperDecisions),
    })),
    queries: materials.papers.flatMap(p => p.questions.map(q => ({
      id: q.publishedLabel.id, paperId: q.publishedLabel.paperId,
      sourceHash: p.publishedPaper.pdf?.sha256 ?? null,
      sourceRecordHash: hash(q), ...emptyDecisions(queryDecisions),
    }))),
  };
  verifySciegqaReviewMaterials(materials, worklist, inputs);
  return {materials, worklist};
}

/** Readback compares each source record directly with published inputs and the
 * pre-inference lock, including ordering and unqualified rows. No model output. */
export function verifySciegqaReviewMaterials(materials, worklist, inputs) {
  const {manifest, labels, cohort, correspondence, correspondencePapers, sourcePins} = inputs;
  verifySciegqaCohort(cohort, manifest, labels);
  const {papers, ...header} = materials;
  same(header, {
    schemaVersion: 1, kind: materialKind, cohortHash: hash(cohort), sourcePins,
    sourceRevision: manifest.sourceRevision, sourceLockHash: manifest.sourceLockHash,
    labelsByteHash: manifest.labelsHash, annotationProvenance: manifest.annotationProvenance,
    license: manifest.license, humanReviewed: false, scientificBaselineReady: false,
  });
  same(papers.map(p => p.publishedPaper.id), cohort.papers.map(p => p.id));
  let candidateQuestions = 0, unqualifiedQuestions = 0, regionReferences = 0;
  const regionKinds = {};
  for (const [i, paper] of papers.entries()) {
    const selected = cohort.papers[i];
    same(Object.keys(paper).sort(), ['correspondenceArtifact', 'publishedPaper', 'questions']);
    same(paper.publishedPaper, manifest.papers.find(p => p.id === selected.id));
    same(paper.correspondenceArtifact, correspondencePapers.get(selected.id));
    same(paper.questions.map(q => q.publishedLabel.id), selected.questions.map(q => q.id));
    for (const question of paper.questions) {
      same(Object.keys(question).sort(), ['publishedLabel', 'sourceCorrespondence']);
      const id = question.publishedLabel.id;
      const label = labels.find(q => q.id === id);
      const observed = correspondence.alignment.find(q => q.id === id);
      if (!label || !observed || label.paperId !== selected.id || observed.paperId !== selected.id) {
        throw new Error('scientific_sciegqa_review_source_missing');
      }
      same(question.publishedLabel, label);
      same(question.sourceCorrespondence, observed);
      if (observed.humanLocatorReview !== false) throw new Error('scientific_sciegqa_review_human_claim');
      if (observed.status === 'all-published-regions-visual-candidates') candidateQuestions++;
      else if (observed.status === 'unqualified-source-correspondence') unqualifiedQuestions++;
      else throw new Error('scientific_sciegqa_review_status_invalid');
      for (const region of label.evidence) {
        regionReferences++;
        regionKinds[region.kind] = (regionKinds[region.kind] ?? 0) + 1;
      }
    }
  }
  const {papers: paperWork, queries: queryWork, ...workHeader} = worklist;
  same(workHeader, {schemaVersion: 1, kind: worklistKind, materialsHash: hash(materials),
    humanReviewed: false, scientificBaselineReady: false});
  same(paperWork, papers.map(p => ({
    paperId: p.publishedPaper.id, sourceHash: p.publishedPaper.pdf?.sha256 ?? null,
    sourceRecordHash: hash(p), ...emptyDecisions(paperDecisions),
  })));
  same(queryWork, papers.flatMap(p => p.questions.map(q => ({
    id: q.publishedLabel.id, paperId: q.publishedLabel.paperId,
    sourceHash: p.publishedPaper.pdf?.sha256 ?? null,
    sourceRecordHash: hash(q), ...emptyDecisions(queryDecisions),
  }))));
  return {papers: papers.length, questions: queryWork.length, candidateQuestions,
    unqualifiedQuestions, regionReferences, regionKinds, humanReviewed: false,
    scientificBaselineReady: false};
}

function fenced(value, language = 'text') {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

function localLink(outputRoot, document, sourceRoot, pin, label) {
  if (!pin) return '来源未提供';
  const target = relative(resolve(outputRoot, document, '..'), resolve(sourceRoot, pin.path))
    .split(sep).map(part => encodeURIComponent(part)).join('/');
  return `[${label}](<${target}>)`;
}

/** Static Markdown only; source text is fenced so it cannot create executable
 * HTML, extra review controls, or misleading links. Assets stay in place. */
export function renderSciegqaReviewDocuments(materials, outputRoot, sourceRoot, correspondenceRoot) {
  const documents = new Map();
  const index = [
    '# SciEGQA 原始来源核对材料',
    '固定 45 篇／225 题；原题、原答案和图片区域来自公开发布标签。',
    '来源对应状态是机械观测；未合格项保留。原始领域不是方案的布局或问题类别。',
    'materials.json 保存完整来源记录和校验 pin；WORKLIST.json 是全部决策为 null 的空白工作表。',
    '请复制 WORKLIST.json 到单独的本地审核目录后记录真实人工判断。此包不直接导入 gold。',
    '逐题核对原始 PNG 与原 PDF，记录完整证据及 UTF-16 spans；论文结构、转录和对象须独立标注。',
    '审核记录遵循 evaluation/corpora/scientific-rag/{annotations,queries}/README.md。',
    '材料包不含生产 Parser、检索排名或模型答案。原始 PDF／PNG 不复制，不再分发。',
    '| 顺序 | 论文 | 原始领域 | 题数 | 全区域候选 / 未合格 |',
    '| --- | --- | --- | ---: | ---: |',
  ];
  for (const [i, paper] of materials.papers.entries()) {
    const name = `papers/paper-${String(i + 1).padStart(3, '0')}.md`;
    const p = paper.publishedPaper;
    const candidates = paper.questions.filter(q =>
      q.sourceCorrespondence.status === 'all-published-regions-visual-candidates').length;
    index.push(`| ${i + 1} | [${p.docName}](${name}) | ${p.domain} | ${paper.questions.length}`
      + ` | ${candidates} / ${paper.questions.length - candidates} |`);
    const lines = [
      `# ${p.docName}`, `[返回集合](../index.md)`,
      `原始领域：${p.domain}；布局类别／人审：待核对。`,
      localLink(outputRoot, name, sourceRoot, p.pdf, '原始 PDF'),
      `PDF SHA256：${p.pdf?.sha256 ?? '来源未提供'}`,
      localLink(outputRoot, name, correspondenceRoot, paper.correspondenceArtifact, '来源对应观测 JSON'),
    ];
    for (const {publishedLabel: q, sourceCorrespondence: observed} of paper.questions) {
      lines.push(`## ${q.id}`, `原始发布行号：${q.publishedRow}`,
        `来源状态：${observed.status}；尚无本地人工 PDF locator 审核。`,
        '原题：', fenced(q.original.query), '发布答案：', fenced(q.original.answer));
      for (const region of q.evidence) {
        const status = observed.evidence.find(e => e.publishedRegionId === region.id)?.status;
        lines.push(`### ${region.id}`, `页 ${region.page}；发布区域类型：${region.kind}`,
          localLink(outputRoot, name, sourceRoot, region.pageImage, '原始 PNG'),
          `对应状态：${status}`,
          fenced({coordinateSystem: region.coordinateSystem, normalizedBbox: region.normalizedBbox,
            pixelBbox: region.pixelBbox, imageSha256: region.pageImage?.sha256 ?? null}, 'json'));
      }
      lines.push('完整原始发布字段：', fenced(q.original, 'json'));
    }
    documents.set(name, lines.join('\n\n') + '\n');
  }
  // Tables need contiguous rows; prose remains separated by blank lines.
  documents.set('index.md', index.slice(0, 8).join('\n\n') + '\n\n' + index.slice(8).join('\n') + '\n');
  return documents;
}
