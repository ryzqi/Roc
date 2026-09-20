import { describe, expect, it, vi } from 'vitest';

import { createResearchSession } from '../../src/renderer/views/research/research-session';

describe('research session', () => {
  it('binds the selected project across projections in one place', () => {
    const research = {
      listProjects: vi.fn(),
      createProject: vi.fn(),
      getWorkflow: vi.fn(),
      listWorkflowEvents: vi.fn(),
      listStageRuns: vi.fn(),
      listArtifacts: vi.fn(),
      getIndexStatus: vi.fn(),
      transitionWorkflow: vi.fn(),
      startStageRun: vi.fn(),
      cancelStageRun: vi.fn(),
      retryStageRun: vi.fn(),
      controlIndex: vi.fn(),
      listLibrary: vi.fn(),
      searchLiterature: vi.fn(),
      importLibraryDoi: vi.fn(),
      importBibliography: vi.fn(),
      exportBibliography: vi.fn(),
      importLibraryRecord: vi.fn(),
      linkLibraryItem: vi.fn(),
      listDocuments: vi.fn(),
      getDocumentContent: vi.fn(),
      importDocument: vi.fn(),
      parseDocument: vi.fn(),
      listEvidence: vi.fn(),
      searchKnowledge: vi.fn(),
      captureEvidence: vi.fn(),
      listEmbeddingConfigs: vi.fn(),
      saveEmbeddingConfig: vi.fn(),
      listExperiments: vi.fn(),
      inspectExperimentEnvironment: vi.fn(),
      startExperiment: vi.fn(),
      cancelExperiment: vi.fn(),
      publishExperiment: vi.fn(),
      getExperiment: vi.fn(),
      readExperimentFile: vi.fn(),
      listStagePolicies: vi.fn(),
      saveStagePolicy: vi.fn(),
      listTemplates: vi.fn(),
      getTemplateFiles: vi.fn(),
      importTemplate: vi.fn(),
      readTemplateFile: vi.fn(),
      saveTemplateFile: vi.fn(),
      compileTemplate: vi.fn(),
      createArtifact: vi.fn(),
      getManuscript: vi.fn(),
      listClaims: vi.fn(),
      createClaim: vi.fn(),
      saveManuscript: vi.fn(),
      getIdeaCanvas: vi.fn(),
      saveIdeaCanvas: vi.fn(),
      promoteIdeaCanvas: vi.fn(),
      listFigures: vi.fn(),
      listExports: vi.fn(),
      prepareExport: vi.fn(),
      publishExport: vi.fn(),
      writeExport: vi.fn()
    };
    const session = createResearchSession({ api: { research, files: { selectFromDialog: vi.fn() } } as never });
    const library = vi.spyOn(session.library, 'setProject');
    const knowledge = vi.spyOn(session.knowledge, 'setProject');
    const experiments = vi.spyOn(session.experiments, 'setProject');
    const policies = vi.spyOn(session.policies, 'setProject');
    const templates = vi.spyOn(session.templates, 'setProject');
    const production = vi.spyOn(session.production, 'setProject');
    session.bindProject('research_1');
    expect(library).toHaveBeenCalledWith('research_1');
    expect(knowledge).toHaveBeenCalledWith('research_1');
    expect(experiments).toHaveBeenCalledWith('research_1');
    expect(policies).toHaveBeenCalledWith('research_1');
    expect(templates).toHaveBeenCalledWith('research_1');
    expect(production).toHaveBeenCalledWith('research_1');
  });
});
