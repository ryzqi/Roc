import type { ResearchStageRoleProfile } from '../../../shared/types';

export const researchCapabilityToolNames: Readonly<Record<string, string>> = {
  'research.knowledge.search': 'search_knowledge',
  'research.literature.search': 'search_literature',
  'research.evidence.capture': 'capture_evidence',
  'research.evidence.list': 'list_evidence',
  'research.artifacts.get': 'read_artifact',
  'research.artifacts.inspectProduction': 'inspect_production_input',
  'research.artifacts.readProductionFile': 'read_production_input_file',
  'research.review.readReport': 'read_review_report',
  'research.workspace.readFile': 'read_workspace_file',
  'research.workspace.saveFile': 'save_workspace_file',
  'research.experiment.startOwned': 'start_experiment',
  'research.experiment.getOwned': 'get_experiment',
  'research.experiment.publishOwned': 'publish_experiment',
  'research.figure.startOwned': 'start_figure',
  'research.figure.publishOwned': 'publish_figure',
  'research.template.readOwned': 'read_template_file',
  'research.template.saveOwned': 'save_template_file',
  'research.template.compileOwned': 'compile_template',
  'research.export.prepareOwned': 'prepare_export',
  'research.export.getOwned': 'get_export',
  'research.export.publishOwned': 'publish_export'
};

const readCapabilities = ['research.knowledge.search', 'research.evidence.list', 'research.artifacts.get'];
const evidenceCapabilities = [...readCapabilities, 'research.evidence.capture'];
const productionInputs = ['research.artifacts.inspectProduction', 'research.artifacts.readProductionFile'];
const workspaceFiles = ['research.workspace.readFile', 'research.workspace.saveFile'];
const experimentEffects = [...workspaceFiles, 'research.experiment.startOwned', 'research.experiment.getOwned', 'research.experiment.publishOwned'];
const figureEffects = [...workspaceFiles, 'research.figure.startOwned', 'research.experiment.getOwned', 'research.figure.publishOwned'];
const exportEffects = ['research.template.readOwned', 'research.template.saveOwned', 'research.template.compileOwned',
  'research.export.prepareOwned', 'research.export.getOwned', 'research.export.publishOwned'];

const profiles: Record<ResearchStageRoleProfile['stage'], ResearchStageRoleProfile> = {
  discovery: { stage: 'discovery', role: 'research-discovery-agent', skillIds: ['roc-research-discovery'], allowedCapabilities: readCapabilities, outputKind: 'search_strategy' },
  retrieval: { stage: 'retrieval', role: 'literature-retrieval-agent', skillIds: ['roc-literature-retrieval'], allowedCapabilities: [...evidenceCapabilities, 'research.literature.search'], outputKind: 'source_corpus' },
  reading: { stage: 'reading', role: 'paper-reading-agent', skillIds: ['roc-paper-reading'], allowedCapabilities: evidenceCapabilities, outputKind: 'reading_notes' },
  ideation: { stage: 'ideation', role: 'research-ideation-agent', skillIds: ['roc-research-ideation'], allowedCapabilities: evidenceCapabilities, outputKind: 'idea_canvas' },
  planning: { stage: 'planning', role: 'research-planning-agent', skillIds: ['roc-research-planning'], allowedCapabilities: evidenceCapabilities, outputKind: 'research_plan' },
  experiment: { stage: 'experiment', role: 'experiment-agent', skillIds: ['roc-experiment-provenance'], allowedCapabilities: [...evidenceCapabilities, ...productionInputs, ...experimentEffects], outputKind: 'experiment_run' },
  figure: { stage: 'figure', role: 'scientific-figure-agent', skillIds: ['roc-scientific-figure'], allowedCapabilities: [...evidenceCapabilities, ...productionInputs, ...figureEffects], outputKind: 'figure' },
  writing: { stage: 'writing', role: 'academic-writing-agent', skillIds: ['roc-academic-writing'], allowedCapabilities: [...evidenceCapabilities, ...productionInputs], outputKind: 'manuscript' },
  review: { stage: 'review', role: 'peer-review-panel', skillIds: ['roc-peer-review'], allowedCapabilities: [...readCapabilities, ...productionInputs, 'research.review.readReport'], outputKind: 'review_report' },
  revision: { stage: 'revision', role: 'revision-agent', skillIds: ['roc-revision-coach'], allowedCapabilities: [...evidenceCapabilities, ...productionInputs], outputKind: 'manuscript' },
  export: { stage: 'export', role: 'manuscript-export-agent', skillIds: ['roc-manuscript-export'], allowedCapabilities: [...readCapabilities, ...productionInputs, ...exportEffects], outputKind: 'export_package' }
};

export function getResearchStageRoleProfile(stage: ResearchStageRoleProfile['stage']): ResearchStageRoleProfile {
  return profiles[stage];
}
