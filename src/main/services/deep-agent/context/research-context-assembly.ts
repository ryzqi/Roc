import {researchTaskContextSchema, type ResearchTaskContext} from '../../../../shared/schemas/research-task-facts';

/** Rebuilt from the scoped ledger before every model request; never persisted as a new fact. */
export function assembleResearchTaskContext(value: ResearchTaskContext) {
  const {task, facts} = researchTaskContextSchema.parse(value);
  const snapshot = facts.snapshot;
  if (snapshot !== null && (snapshot.taskId !== task.id || snapshot.projectId !== task.projectId)) {
    throw new Error('research_task_context_scope_mismatch');
  }
  const expected = new Set(snapshot?.entries.flatMap(entry => entry.sources.map((_, index) => `${entry.id}:${index}`)) ?? []);
  const freshness = new Map(facts.freshness.map(source => [`${source.entryId}:${source.sourceIndex}`, source]));
  if (facts.freshness.length !== freshness.size || freshness.size !== expected.size ||
      [...freshness.keys()].some(key => !expected.has(key))) throw new Error('research_task_context_freshness_incomplete');
  const entries = snapshot?.entries ?? [];
  const unavailable = entries.flatMap(entry => {
    const reasons = entry.sources.flatMap((_, index) => {
      const source = freshness.get(`${entry.id}:${index}`)!;
      return source.state === 'expired' ? [source.reason ?? 'source_unverifiable'] : [];
    });
    if (entry.state !== 'active') reasons.push(entry.state);
    return reasons.length === 0 ? [] : [{id: entry.id, reasons: [...new Set(reasons)], evidenceStatus: 'not_verified' as const}];
  });
  const excludedIds = new Set(unavailable.map(entry => entry.id));
  const current = entries.filter(entry => !excludedIds.has(entry.id));
  const hardKinds = new Set(['constraint', 'human_decision', 'evaluation_condition', 'correction']);
  return {
    authority: 'research_data_only' as const,
    task: {id: task.id, projectId: task.projectId, goal: task.goal},
    ledger: snapshot === null ? null : {revision: snapshot.revision, snapshotHash: snapshot.snapshotHash},
    constraintsAndDecisions: current.filter(entry => hardKinds.has(entry.kind)),
    taskFacts: current.filter(entry => !hardKinds.has(entry.kind)),
    references: entries.flatMap(entry => entry.sources.map((source, sourceIndex) => ({
      source, ...freshness.get(`${entry.id}:${sourceIndex}`)!
    }))),
    conflicts: current.flatMap(entry => (entry.contradicts ?? []).filter(id => !excludedIds.has(id))
      .map(id => ({entryId: entry.id, contradicts: id, resolution: 'unresolved' as const}))),
    unavailableFacts: unavailable
  };
}
