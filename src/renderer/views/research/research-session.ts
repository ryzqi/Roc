import type { ResearchArtifact } from '../../../shared/types';
import type { RocClient } from '../../shared/roc-client';
import { createResearchExperimentAdapter, createResearchExperimentProjection, type ResearchExperimentProjection } from './research-experiments';
import { createResearchFigureAdapter, createResearchFigureProjection, type ResearchFigureProjection } from './research-figures';
import { createResearchIdeaAdapter, createResearchIdeaProjection, type ResearchIdeaHost, type ResearchIdeaProjection } from './research-ideas';
import { createResearchKnowledgeAdapter, createResearchKnowledgeProjection, type ResearchKnowledgeProjection } from './research-knowledge';
import { createResearchLibraryAdapter, createResearchLibraryProjection, type ResearchLibraryProjection } from './research-library';
import { createResearchManuscriptAdapter, createResearchManuscriptProjection, type ResearchManuscriptHost, type ResearchManuscriptProjection } from './research-manuscript';
import { createResearchPolicyAdapter, createResearchPolicyProjection, type ResearchPolicyProjection } from './research-policies';
import { createResearchProductionAdapter, createResearchProductionProjection, type ResearchProductionHost, type ResearchProductionProjection } from './research-production';
import { createResearchTemplateAdapter, createResearchTemplateProjection, type ResearchTemplateProjection } from './research-templates';
import { createResearchWorkbench, createResearchWorkbenchAdapter, type ResearchWorkbench } from './research-workbench';

export type ResearchSession = {
  workbench: ResearchWorkbench;
  library: ResearchLibraryProjection;
  knowledge: ResearchKnowledgeProjection;
  experiments: ResearchExperimentProjection;
  figures: ResearchFigureProjection;
  policies: ResearchPolicyProjection;
  templates: ResearchTemplateProjection;
  manuscript: ResearchManuscriptProjection;
  ideas: ResearchIdeaProjection;
  production: ResearchProductionProjection;
  bindProject(projectId: string | null): void;
  chooseWorkspace(): Promise<string | null>;
};

function createStageHost(workbench: ResearchWorkbench) {
  function snapshot() {
    return workbench.getSnapshot();
  }
  function stageStatus(stage: 'writing' | 'ideation') {
    return snapshot().workflow?.stages.find((entry) => entry.stage === stage)?.status;
  }
  const manuscriptHost: ResearchManuscriptHost = {
    projectId() { return snapshot().project?.id ?? null; },
    currentStage() { return snapshot().workflow?.currentStage ?? null; },
    stageStatus,
    moveToWriting() { return workbench.transition('move', { targetStage: 'writing' }); },
    startWriting() { return workbench.transition('start'); },
    refresh() { return workbench.refresh(); }
  };
  const ideaHost: ResearchIdeaHost = {
    projectId() { return snapshot().project?.id ?? null; },
    currentStage() { return snapshot().workflow?.currentStage ?? null; },
    stageStatus,
    moveToIdeation() { return workbench.transition('move', { targetStage: 'ideation' }); },
    startIdeation() { return workbench.transition('start'); },
    refresh() { return workbench.refresh(); },
    async selectProject(projectId) {
      await workbench.load();
      await workbench.selectProject(projectId);
    }
  };
  const productionHost: ResearchProductionHost = {
    projectId() { return snapshot().project?.id ?? null; },
    language() { return snapshot().project?.language ?? 'zh'; },
    approvedManuscript() {
      return snapshot().artifacts.find((item: ResearchArtifact) => item.kind === 'manuscript' && item.status === 'approved');
    }
  };
  return { manuscriptHost, ideaHost, productionHost };
}

export function createResearchSession(client: RocClient): ResearchSession {
  const workbench = createResearchWorkbench(createResearchWorkbenchAdapter(client));
  const library = createResearchLibraryProjection(createResearchLibraryAdapter(client));
  const knowledge = createResearchKnowledgeProjection(createResearchKnowledgeAdapter(client));
  const experiments = createResearchExperimentProjection(createResearchExperimentAdapter(client));
  const figures = createResearchFigureProjection(createResearchFigureAdapter(client));
  const policies = createResearchPolicyProjection(createResearchPolicyAdapter(client));
  const templates = createResearchTemplateProjection(createResearchTemplateAdapter(client));
  const hosts = createStageHost(workbench);
  const manuscript = createResearchManuscriptProjection(createResearchManuscriptAdapter(client), hosts.manuscriptHost);
  const ideas = createResearchIdeaProjection(createResearchIdeaAdapter(client), hosts.ideaHost);
  const production = createResearchProductionProjection(createResearchProductionAdapter(client), hosts.productionHost);
  return {
    workbench, library, knowledge, experiments, figures, policies, templates, manuscript, ideas, production,
    bindProject(projectId) {
      library.setProject(projectId);
      knowledge.setProject(projectId);
      experiments.setProject(projectId);
      figures.setProject(projectId);
      policies.setProject(projectId);
      templates.setProject(projectId);
      production.setProject(projectId);
    },
    async chooseWorkspace() {
      const selected = await client.api.workspace.selectFromDialog();
      if (!selected.ok) {
        workbench.fail(selected.error.message);
        return null;
      }
      if (selected.data === null) {
        return null;
      }
      return selected.data.path;
    }
  };
}

