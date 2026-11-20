export function ideaCanvasContentFixture() {
  const content = {
    problem: 'Synthetic latency reproducibility study',
    hypothesis: 'The declared intervention lowers the mean latency.',
    novelty: 'Pending comparison with the declared search scope',
    supportingEvidence: '', counterevidence: '',
    experiment: 'Compare the frozen input observations', risks: 'Synthetic fixture only',
    priority: 'medium', rationale: 'Test an explicitly falsifiable proposition'
  };
  return {...content, fields: ['problem', 'hypothesis', 'novelty', 'supportingEvidence', 'counterevidence', 'experiment', 'risks']
    .map(key => ({key, content: content[key], status: 'hypothesis', evidenceIds: []}))};
}

export function ideaPlanBodyFixture(hypothesis = ideaCanvasContentFixture().hypothesis) {
  return {
    hypothesis, falsifiableIf: 'The observed mean difference is zero or positive.',
    metrics: [{id: 'mean', label: 'Latency mean', definition: 'Arithmetic mean of every declared observation',
      unit: 'ms', direction: 'lower', expectedOutcome: 'A negative mean difference'}],
    dataPlan: 'Use all declared synthetic observations without outcome selection.',
    design: 'Fixed synthetic controlled comparison', analysisPlan: 'Arithmetic mean and sample standard deviation',
    observation: {kind: 'before_data'},
    novelty: {status: 'pending_verification', searchScope: 'Declared synthetic query and date range only', comparisons: []},
    sampleSize: {kind: 'not_calculated', reason: 'No scientific power claim for this engineering fixture'}
  };
}
