import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Diagnostics supplement the official token/evidence F1; they do not replace it.
export function qasperDiagnostics(task, result, metrics, reason = null, directory = null) {
  const answerability = new Set(task.references.map(ref => ref.type === 'none' ? 'unanswerable' : 'answerable'));
  const predictedAbstention = result?.answer?.trim().toLowerCase() === 'unanswerable';
  const labels = reason ? [reason] : [
    ...(metrics.answerF1 < 1 ? ['answer_mismatch'] : []),
    ...(metrics.evidenceF1 < 1 ? ['evidence_mismatch'] : [])
  ];
  let evidenceReadCoverage = null;
  if (directory && Array.isArray(result?.evidence)) {
    const requests = readFileSync(join(directory, 'transcript.jsonl'), 'utf8').trimEnd().split('\n').map(JSON.parse)
      .filter(event => event.type === 'request');
    const delivered = requests.flatMap(event => event.body.messages.filter(message => message.role === 'tool'))
      .map(message => typeof message.content === 'string' ? message.content.replace(/^\s*\d+\t/gmu, '') : '');
    const read = task.visible.paragraphs.filter(paragraph => delivered.some(content =>
      content.includes(JSON.stringify(paragraph.text)) && content.includes(JSON.stringify(paragraph.id))));
    evidenceReadCoverage = result.evidence.length
      ? result.evidence.filter(id => read.some(paragraph => paragraph.id === id)).length / result.evidence.length
      : predictedAbstention ? 1 : 0;
    if (evidenceReadCoverage < 1) labels.push('evidence_not_fully_read');
  }
  return { firstStage: reason ? 'generation' : metrics.evidenceF1 < 1 ? 'evidence_selection' : metrics.answerF1 < 1 ? 'generation' : null,
    labels, formatValid: !['output_not_json', 'output_schema_invalid'].includes(reason),
    citationValid: metrics.citationValidity === 1, answerTokenF1: metrics.answerF1,
    answerability: answerability.size === 1 ? [...answerability][0] : 'mixed',
    abstentionAccuracy: answerability.size === 1 ? Number(predictedAbstention === answerability.has('unanswerable')) : null,
    evidenceReadCoverage, answerCorrectness: 'needs_review', claimSupport: 'needs_review',
    successRubric: 'one-official-reference-exact-answer-and-evidence-v1' };
}
