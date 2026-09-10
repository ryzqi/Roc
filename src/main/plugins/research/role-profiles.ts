import type { ResearchStageRoleProfile } from '../../../shared/types';

const profiles: Record<ResearchStageRoleProfile['stage'], ResearchStageRoleProfile> = {
  discovery: { stage: 'discovery', role: 'research-discovery-agent', skillIds: ['roc-research-discovery'], allowedCapabilities: ['research.projects', 'research.knowledge.search'], outputKind: 'search_strategy' },
  retrieval: { stage: 'retrieval', role: 'literature-retrieval-agent', skillIds: ['roc-literature-retrieval'], allowedCapabilities: ['research.literature.search', 'research.knowledge.upsert'], outputKind: 'source_corpus' },
  reading: { stage: 'reading', role: 'paper-reading-agent', skillIds: ['nature-reader'], allowedCapabilities: ['research.knowledge.search', 'research.provenance'], outputKind: 'reading_notes' },
  ideation: { stage: 'ideation', role: 'research-ideation-agent', skillIds: ['roc-research-ideation'], allowedCapabilities: ['research.knowledge.search', 'research.provenance'], outputKind: 'idea_canvas' },
  planning: { stage: 'planning', role: 'research-planning-agent', skillIds: ['roc-research-planning'], allowedCapabilities: ['research.knowledge.search', 'research.provenance'], outputKind: 'research_plan' },
  experiment: { stage: 'experiment', role: 'experiment-agent', skillIds: ['roc-experiment-provenance'], allowedCapabilities: ['workspace.files', 'research.experiment.record', 'research.provenance'], outputKind: 'experiment_run' },
  figure: { stage: 'figure', role: 'scientific-figure-agent', skillIds: ['scipilot-figure-skill'], allowedCapabilities: ['workspace.files', 'research.figure.record', 'research.provenance'], outputKind: 'figure' },
  writing: { stage: 'writing', role: 'academic-writing-agent', skillIds: ['roc-academic-writing'], allowedCapabilities: ['research.knowledge.search', 'research.provenance', 'workspace.files'], outputKind: 'manuscript' },
  review: { stage: 'review', role: 'peer-review-panel', skillIds: ['roc-peer-review'], allowedCapabilities: ['research.knowledge.search', 'research.provenance'], outputKind: 'review_report' },
  revision: { stage: 'revision', role: 'revision-agent', skillIds: ['roc-revision-coach'], allowedCapabilities: ['research.knowledge.search', 'research.provenance', 'workspace.files'], outputKind: 'revision_plan' },
  export: { stage: 'export', role: 'manuscript-export-agent', skillIds: ['roc-manuscript-export'], allowedCapabilities: ['research.template.compile', 'research.provenance'], outputKind: 'export_package' }
};

export function getResearchStageRoleProfile(stage: ResearchStageRoleProfile['stage']): ResearchStageRoleProfile {
  return profiles[stage];
}

