export function ragDiagnostics({ expected, ingestion, retrieval, context, grade }) {
  const labels = [];
  if (ingestion !== null && ingestion < 1) labels.push('ingestion_gap');
  if (retrieval !== null && retrieval < 1) labels.push('retrieval_miss');
  if (context !== null && context < 1 && retrieval > 0) labels.push('context_loss');
  if (['output_not_json', 'output_schema_invalid'].includes(grade.reason)) labels.push('format_error');
  if (['citation_invalid', 'unsupported_citation', 'citation_not_read'].includes(grade.reason)) labels.push(grade.reason);
  if (grade.metrics?.abstentionAccuracy === 0) labels.push('abstention_error');
  if ((grade.metrics?.answerF1 ?? 0) < 1 && !labels.length) labels.push('needs_review');
  const stage = labels.includes('ingestion_gap') ? 'ingestion' : labels.includes('retrieval_miss') ? 'retrieval'
    : labels.includes('context_loss') ? 'context' : labels.includes('format_error') ? 'format'
    : labels.length ? 'generation' : null;
  return { schemaVersion: 1, firstStage: stage, firstAbnormalStage: stage, labels,
    indexContainsGold: ingestion === null ? null : ingestion === 1,
    goldInCandidates: retrieval === null ? null : retrieval === 1,
    goldInContext: context === null ? null : context === 1,
    formatValid: !['output_not_json', 'output_schema_invalid'].includes(grade.reason),
    needsReview: labels.includes('needs_review'), ingestionCoverage: ingestion,
    retrievalCoverage: retrieval, contextCoverage: context, answerability: expected.answerability,
    semanticAnswerCorrectness: { status: 'needs_review', reason: 'no_calibrated_independent_semantic_review' },
    claimSupport: { status: grade.reason === 'unsupported_citation' ? 'failed' : 'needs_review',
      reason: grade.reason === 'unsupported_citation' ? 'cited_source_does_not_cover_gold_evidence' : 'no_calibrated_claim_judge' },
    attribution: 'observed failure stage; not proof of a unique causal root cause' };
}
