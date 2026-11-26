import type { ResearchStageRoleProfile } from '../../../shared/types';

export const researchCapabilityToolNames: Readonly<Record<string, string>> = {
  'research.knowledge.search': 'search_knowledge',
  'research.knowledge.scientificQuery': 'search_scientific_knowledge',
  'research.knowledge.scientificContext': 'read_scientific_context',
  'research.knowledge.scientificEvidence': 'validate_scientific_evidence',
  'research.knowledge.deepRequest': 'request_paper_deep_knowledge',
  'research.knowledge.deepRead': 'read_paper_deep_knowledge',
  'research.literature.search': 'search_literature',
  'research.literature.getSearch': 'read_literature_search',
  'research.library.addLiterature': 'add_literature',
  'research.library.getImportOperation': 'get_literature_import',
  'research.library.cancelImportOperation': 'cancel_literature_import',
  'research.evidence.capture': 'capture_evidence',
  'research.evidence.list': 'list_evidence',
  'research.evidence.inspect': 'inspect_evidence_source',
  'research.relations.list': 'list_evidence_relations',
  'research.claims.compare': 'compare_claims',
  'research.sourceMigrations.list': 'read_source_migrations',
  'research.sourceReplacements.list': 'read_source_replacements',
  'research.artifacts.get': 'read_artifact',
  'research.artifacts.inspectProduction': 'inspect_production_input',
  'research.artifacts.readProductionFile': 'read_production_input_file',
  'research.review.readReport': 'read_review_report',
  'research.writing.prepareContext': 'prepare_writing_context',
  'research.writing.checkGrounding': 'check_draft_grounding',
  'research.writing.reviewImpact': 'review_writing_impact',
  'research.workspace.readFile': 'read_workspace_file',
  'research.workspace.saveFile': 'save_workspace_file',
  'research.pythonEnvironments.prepareOwned': 'prepare_python_environment',
  'research.pythonEnvironments.status': 'get_python_environment_status',
  'research.pythonEnvironments.cancelOwned': 'cancel_python_environment',
  'research.pythonEnvironments.list': 'list_python_environments',
  'research.experiment.environment': 'inspect_experiment_environment',
  'research.experiment.startOwned': 'start_experiment',
  'research.experiment.getOwned': 'get_experiment',
  'research.experiment.publishOwned': 'publish_experiment',
  'research.figure.startOwned': 'start_figure',
  'research.figure.environment': 'inspect_figure_environment',
  'research.figure.getOwned': 'get_figure',
  'research.figure.publishOwned': 'publish_figure',
  'research.template.readOwned': 'read_template_file',
  'research.template.saveOwned': 'save_template_file',
  'research.template.compileOwned': 'compile_template',
  'research.export.prepareOwned': 'prepare_export',
  'research.export.getOwned': 'get_export',
  'research.export.publishOwned': 'publish_export'
};

const readCapabilities = ['research.knowledge.search', 'research.knowledge.scientificQuery',
  'research.knowledge.scientificContext', 'research.knowledge.scientificEvidence', 'research.evidence.list', 'research.evidence.inspect',
  'research.relations.list', 'research.claims.compare', 'research.sourceMigrations.list', 'research.sourceReplacements.list', 'research.artifacts.get'];
const evidenceCapabilities = [...readCapabilities, 'research.evidence.capture'];
const deepKnowledgeCapabilities = ['research.knowledge.deepRequest', 'research.knowledge.deepRead'];
const productionInputs = ['research.artifacts.inspectProduction', 'research.artifacts.readProductionFile'];
const writingChecks = ['research.writing.checkGrounding', 'research.writing.reviewImpact'];
const writingCapabilities = ['research.writing.prepareContext', ...writingChecks];
const workspaceFiles = ['research.workspace.readFile', 'research.workspace.saveFile'];
const experimentEffects = [...workspaceFiles, 'research.pythonEnvironments.prepareOwned', 'research.pythonEnvironments.status',
  'research.pythonEnvironments.cancelOwned', 'research.pythonEnvironments.list', 'research.experiment.environment',
  'research.experiment.startOwned', 'research.experiment.getOwned', 'research.experiment.publishOwned'];
const figureEffects = [...workspaceFiles, 'research.figure.environment', 'research.figure.startOwned', 'research.figure.getOwned', 'research.figure.publishOwned'];
const exportEffects = ['research.template.readOwned', 'research.template.saveOwned', 'research.template.compileOwned',
  'research.export.prepareOwned', 'research.export.getOwned', 'research.export.publishOwned'];

const profiles: Record<ResearchStageRoleProfile['stage'], ResearchStageRoleProfile> = {
  discovery: { stage: 'discovery', role: 'research-discovery-agent', skillIds: ['roc-research-discovery'], allowedCapabilities: readCapabilities, outputKind: 'search_strategy' },
  retrieval: { stage: 'retrieval', role: 'literature-retrieval-agent', skillIds: ['roc-literature-retrieval'], allowedCapabilities: [...evidenceCapabilities, 'research.literature.search', 'research.literature.getSearch', 'research.library.addLiterature', 'research.library.getImportOperation', 'research.library.cancelImportOperation'], outputKind: 'source_corpus' },
  reading: { stage: 'reading', role: 'paper-reading-agent', skillIds: ['roc-paper-reading'], allowedCapabilities: [...evidenceCapabilities, ...deepKnowledgeCapabilities], outputKind: 'reading_notes' },
  ideation: { stage: 'ideation', role: 'research-ideation-agent', skillIds: ['roc-research-ideation'], allowedCapabilities: evidenceCapabilities, outputKind: 'idea_canvas' },
  planning: { stage: 'planning', role: 'research-planning-agent', skillIds: ['roc-research-planning'], allowedCapabilities: [...evidenceCapabilities, ...deepKnowledgeCapabilities], outputKind: 'research_plan' },
  experiment: { stage: 'experiment', role: 'experiment-agent', skillIds: ['roc-experiment-provenance'], allowedCapabilities: [...evidenceCapabilities, ...productionInputs, ...experimentEffects], outputKind: 'experiment_run' },
  figure: { stage: 'figure', role: 'scientific-figure-agent', skillIds: ['roc-scientific-figure'], allowedCapabilities: [...evidenceCapabilities, ...productionInputs, ...figureEffects], outputKind: 'figure' },
  writing: { stage: 'writing', role: 'academic-writing-agent', skillIds: ['roc-academic-writing'], allowedCapabilities: [...evidenceCapabilities, ...productionInputs, ...writingCapabilities, ...deepKnowledgeCapabilities], outputKind: 'manuscript' },
  review: { stage: 'review', role: 'peer-review-panel', skillIds: ['roc-peer-review'], allowedCapabilities: [...readCapabilities, ...productionInputs, 'research.review.readReport', ...writingChecks], outputKind: 'review_report' },
  revision: { stage: 'revision', role: 'revision-agent', skillIds: ['roc-revision-coach'], allowedCapabilities: [...evidenceCapabilities, ...productionInputs, ...writingCapabilities, ...deepKnowledgeCapabilities], outputKind: 'manuscript' },
  export: { stage: 'export', role: 'manuscript-export-agent', skillIds: ['roc-manuscript-export'], allowedCapabilities: [...readCapabilities, ...productionInputs, ...exportEffects], outputKind: 'export_package' }
};

export function getResearchStageRoleProfile(stage: ResearchStageRoleProfile['stage']): ResearchStageRoleProfile {
  return profiles[stage];
}
