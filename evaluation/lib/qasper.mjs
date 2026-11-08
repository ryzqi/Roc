import { readFileSync } from 'node:fs';
import { hash } from './common.mjs';

// Native QASPER normalization/metrics, from allenai/qasper-led-baseline/scripts/evaluator.py.
// Kept as a small independent implementation; fixtures test parity with upstream examples.
const normalize = text => text.toLowerCase().replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, '').replace(/\b(a|an|the)\b/g, ' ').trim().split(/\s+/u).filter(Boolean);
export function answerF1(predicted, expected) {
  const a = normalize(predicted), b = normalize(expected), counts = new Map();
  b.forEach(token => counts.set(token, (counts.get(token) ?? 0) + 1));
  let common = 0;
  for (const token of a) if ((counts.get(token) ?? 0) > 0) { common++; counts.set(token, counts.get(token) - 1); }
  return common === 0 ? 0 : 2 * common / (a.length + b.length);
}
export function evidenceF1(predicted, expected) {
  if (predicted.length === 0 && expected.length === 0) return 1;
  const common = [...new Set(predicted)].filter(item => new Set(expected).has(item)).length;
  return common === 0 ? 0 : 2 * common / (predicted.length + expected.length);
}
function reference(annotation) {
  const a = annotation.answer;
  if (a.unanswerable) return { answer: 'Unanswerable', evidence: [], type: 'none' };
  const answer = a.extractive_spans?.length ? a.extractive_spans.join(', ') : a.free_form_answer ? a.free_form_answer
    : typeof a.yes_no === 'boolean' ? (a.yes_no ? 'Yes' : 'No') : null;
  if (answer === null || !Array.isArray(a.evidence) || a.evidence.some(s => typeof s !== 'string')) throw new Error('qasper_annotation_invalid');
  return { answer, evidence: a.evidence, type: a.extractive_spans?.length ? 'extractive' : a.free_form_answer ? 'abstractive' : 'boolean' };
}
export function importQasper(data) {
  const tasks = [], ids = new Set();
  for (const [paperId, paper] of Object.entries(data)) {
    if (!Array.isArray(paper.full_text) || !Array.isArray(paper.qas) || typeof paper.title !== 'string') throw new Error('qasper_paper_invalid');
    const paragraphs = [{ section: 'Abstract', text: paper.abstract ?? '' }, ...paper.full_text.flatMap(section =>
      section.paragraphs.map(text => ({ section: section.section_name, text })))];
    if (paragraphs.some(p => typeof p.text !== 'string')) throw new Error('qasper_paragraph_invalid');
    const visibleParagraphs = paragraphs.filter(p => p.text.length > 0).map((p, index) => ({ id: `p${index}`, ...p }));
    // Grouped public holdout. Every question from the same paper stays together.
    const split = parseInt(hash(paperId).slice(0, 8), 16) % 5 === 0 ? 'holdout' : 'development';
    for (const qa of paper.qas) {
      if (typeof qa.question_id !== 'string' || ids.has(qa.question_id) || typeof qa.question !== 'string'
        || !Array.isArray(qa.answers) || qa.answers.length === 0) throw new Error('qasper_question_invalid');
      ids.add(qa.question_id);
      const references = qa.answers.map(reference);
      const textSet = new Set(visibleParagraphs.map(p => p.text));
      const unsupported = references.some(ref => ref.evidence.some(e => !textSet.has(e))) ? 'non_text_or_unmapped_evidence' : null;
      tasks.push({ id: qa.question_id, clusterId: paperId, split, unsupported,
        visible: { question: qa.question, title: paper.title, paragraphs: visibleParagraphs }, references });
    }
  }
  if (!tasks.length) throw new Error('qasper_empty_dataset');
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}
export function qasperInput(task) {
  const { question, title, paragraphs } = task.visible;
  return { kind: 'qasper', prompt: `Read /workspace/paper.json using the available file tools. Answer this question about the paper: ${question}\nReturn only JSON with keys "answer" (string) and "evidence" (array of paragraph IDs such as p0). Use "Unanswerable" with no evidence if the paper does not answer the question. Cite only paragraphs supporting your answer.`,
    files: { 'paper.json': JSON.stringify({ title, paragraphs }, null, 2) } };
}
export function gradeQasper(task, output) {
  let result;
  try { result = JSON.parse(output); } catch { return { status: 'failed', failureClass: 'agent', reason: 'output_not_json', metrics: { answerF1: 0, evidenceF1: 0, citationValidity: 0 } }; }
  if (!result || typeof result.answer !== 'string' || !Array.isArray(result.evidence) || result.evidence.some(id => typeof id !== 'string')
    || Object.keys(result).some(key => !['answer', 'evidence'].includes(key))) {
    return { status: 'failed', failureClass: 'agent', reason: 'output_schema_invalid', metrics: { answerF1: 0, evidenceF1: 0, citationValidity: 0 } };
  }
  const paragraphs = new Map(task.visible.paragraphs.map(p => [p.id, p.text]));
  const valid = result.evidence.every(id => paragraphs.has(id)) && new Set(result.evidence).size === result.evidence.length;
  const predicted = result.evidence.map(id => paragraphs.get(id) ?? `<invalid:${id}>`);
  const metrics = {
    answerF1: Math.max(...task.references.map(ref => answerF1(result.answer, ref.answer))),
    evidenceF1: Math.max(...task.references.map(ref => evidenceF1(predicted, ref.evidence))),
    citationValidity: valid ? 1 : 0
  };
  return { status: valid ? 'scored' : 'failed', failureClass: valid ? null : 'agent', reason: valid ? null : 'citation_invalid', metrics };
}
export const loadQasper = path => importQasper(JSON.parse(readFileSync(path, 'utf8')));
