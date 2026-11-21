import { registerResearchWikiCapabilities } from './wiki-capabilities';
import { createPaperCardGenerator, paperCardDerivation } from './paper-card-service';
import { createWikiSynthesizer } from './wiki-synthesis';
import { recordCapabilityOperationReceipt } from '../../kernel/capability-operation-context';
import { ResearchTaskFactsService } from './task-facts';
import { registerTaskFactCapabilities } from './task-fact-capabilities';
import { ResearchTaskController } from './task-controller';
import { registerResearchTaskCapabilities } from './task-capabilities';
import { ResearchTaskDiagnosticsExporter } from './task-diagnostics-export';
import { ResearchTaskDiagnosticsService } from './task-diagnostics';
import { notifyResearchTaskChanged } from './task-notifications';
import { z } from 'zod';
import { researchArtifactCreateRequestSchema, researchArtifactIdRequestSchema, researchArtifactListRequestSchema, researchArtifactUpdateRequestSchema, researchProjectCreateRequestSchema, researchProjectIdRequestSchema, researchProjectUpdateRequestSchema, researchStageSchema, researchWorkflowEventsRequestSchema, researchWorkflowTransitionRequestSchema } from '../../../shared/schemas/research';
import type { ResearchStageRoleRequest } from '../../../shared/types';
import type { RocPluginContext } from '../../kernel/types';
import { getResearchStageRoleProfile } from './role-profiles';
import type { ResearchReviewSearchService } from './review-search-service';
import { ResearchProductionEffectService } from './production-effects';
import { ResearchWorkspaceFileService } from './workspace-files';
import { registerResearchEvidenceCapabilities } from './evidence-capabilities';
import { registerResearchManuscriptCapabilities } from './manuscript-capabilities';
import {registerResearchManuscriptSyncCapabilities} from './manuscript-sync-capabilities';
import { registerResearchIdeaCapabilities } from './idea-capabilities';
import { registerResearchIdeaPlanCapabilities } from './idea-plan-capabilities';
import { registerResearchRunCapabilities } from './run-capabilities';
import { registerResearchArtifactInspectorCapability } from './artifact-inspector-capability';
import { ResearchStageRuntime } from './stage-runtime';
import { createResearchHumanGate } from './human-gate';
import { ResearchArtifactScientificReviewService } from './artifact-scientific-reviews';
import { applyResearchWorkflowTransition } from './research-plugin-lifecycle';
import { researchContentHash } from './research-files';
import { pluginId, workbenchCapabilities, lifecycleCapabilities } from './research-plugin-contract';
import type { ResearchPluginOptions } from './research-plugin-options';
import type { ResearchPluginLifecycle } from './research-plugin-lifecycle';
import type { ResearchProductionServices } from './research-plugin-production';
import type { ResearchLiteratureServices } from './research-plugin-literature';
import {registerResearchProposalCapabilities} from './proposal-capabilities';
import {ResearchProposalService} from './proposal-service';
import {ResearchJournalComplianceService} from './journal-compliance-service';
import {ResearchStageReadinessService} from './stage-readiness';
import {ResearchResultDerivationService} from './result-derivation-service';
import {ResearchResultFigureSourceService} from './result-figure-source';
import {registerResearchResultDerivationCapabilities} from './result-derivation-capabilities';
import {registerResearchImpactCapabilities} from './impact-capabilities';
import {registerResearchArgumentOutlineCapabilities} from './argument-outline-capabilities';
import {registerResearchSubmissionProfileCapabilities} from './submission-profile-capabilities';
import {ResearchSubmissionService} from './submission-service';
import {registerResearchSubmissionCapabilities} from './submission-capabilities';
import {registerResearchFeedbackCapabilities} from './feedback-capabilities';
import {registerResearchExternalExperimentCapabilities} from './external-experiment-capabilities';
import {join} from 'node:path';

export async function registerResearchWorkflow(
  context: RocPluginContext, options: ResearchPluginOptions,
  lifecycle: ResearchPluginLifecycle, production: ResearchProductionServices,
  literature: ResearchLiteratureServices, reviewSearches: ResearchReviewSearchService
): Promise<void> {
  const { db, visual, figureUnderstanding, researchRepository, researchIndexer, researchPythonEnvironments, researchExperiments,
    researchResults, researchFigures, researchTemplates, researchExports, zenodoPublication,
    productionJob, notifyWorkspacePathStructureChanged } = production;
  const workspaceFiles = new ResearchWorkspaceFileService(db, researchRepository, () => new Date().toISOString(), notifyWorkspacePathStructureChanged);
  const effects = new ResearchProductionEffectService(researchRepository, workspaceFiles,
    researchExperiments, researchFigures, researchTemplates, researchExports);
  const resultDerivation = new ResearchResultDerivationService(researchRepository, researchResults);
  registerResearchResultDerivationCapabilities(context, resultDerivation, new ResearchResultFigureSourceService(resultDerivation, workspaceFiles));
  registerResearchImpactCapabilities(context, researchRepository.impact, researchRepository.repairs);
  registerResearchArgumentOutlineCapabilities(context, researchRepository.argumentOutlines);
  registerResearchSubmissionProfileCapabilities(context, researchRepository.submissionProfiles);
  const submissions=new ResearchSubmissionService(db,researchRepository,researchExports,production.toolchain,
    options.exportRoot===undefined?null:join(options.exportRoot,'submissions'));
  submissions.recover();
  lifecycle.ownBackgroundServices([submissions]);
  registerResearchSubmissionCapabilities(context,submissions);
  registerResearchFeedbackCapabilities(context,researchRepository.feedback);
  registerResearchExternalExperimentCapabilities(context,researchRepository.externalExperiments,workspaceFiles);
  const scientificReviews = new ResearchArtifactScientificReviewService(researchRepository, researchResults, researchFigures);
  const humanGate = createResearchHumanGate({ repository: researchRepository, production: productionJob, scientificReviews });
  const readiness = new ResearchStageReadinessService(researchRepository, context.capabilities);
  const runtime = new ResearchStageRuntime(researchRepository, context.capabilities, options.roleExecutor, humanGate, effects,
    (taskId, projectId) => notifyResearchTaskChanged(context, taskId, projectId), 1, (run, signal) => readiness.check(run, signal));
  lifecycle.own('stageRuntime', runtime);
  const taskController = new ResearchTaskController(options.tasks, {
    stages: runtime,
    cancelChat: async runId => await context.capabilities.invoke('agent.run.cancel', { runId }),
    cancelJob: async (kind, projectId, executionId) => {
      switch (kind) {
        case 'experiment': return await researchExperiments.cancel(projectId, executionId);
        case 'figure': return await researchFigures.cancel(projectId, executionId);
        case 'export': return await researchExports.cancel(projectId, executionId);
        case 'review_search': return await reviewSearches.cancelTaskQuery(projectId, executionId);
      }
    }
  }, () => runtime.resumeScheduler());
  runtime.attachTaskController(taskController);
  await runtime.recoverPendingOutputs();
  registerTaskFactCapabilities(context, new ResearchTaskFactsService(researchRepository));
  const taskDiagnostics = new ResearchTaskDiagnosticsService(researchRepository, options.usageLedger, reviewSearches, researchExperiments);
  registerResearchTaskCapabilities(context, options.tasks, taskController, taskDiagnostics,
    new ResearchTaskDiagnosticsExporter(taskDiagnostics, options.tasks, options.diagnosticsRoot));
  registerResearchRunCapabilities(context, researchRepository.runs, runtime, researchRepository.reviews, options.executionGrantBroker);
  registerResearchArtifactInspectorCapability(context, researchRepository);
  registerResearchEvidenceCapabilities(context, researchRepository.evidence);
  registerResearchWikiCapabilities(context, researchRepository.wiki, researchRepository.paperCards, production.scientificExtraction);
  researchRepository.wiki.configureSynthesis(createWikiSynthesizer(options.modelFactory));
  researchRepository.paperCards.start(createPaperCardGenerator(options.modelFactory), {
    versions: () => ({...paperCardDerivation, modelRevision: options.modelFactory.defaultChatModelStamp()})
  });
  researchRepository.wiki.start();
  registerResearchManuscriptCapabilities(context, researchRepository.manuscripts);
  registerResearchManuscriptSyncCapabilities(context, researchRepository.manuscriptSync, projectId => {
    const {workspacePath} = researchRepository.getProject(projectId);
    if (workspacePath !== null) notifyWorkspacePathStructureChanged(workspacePath, 'research_file_saved');
  });
  registerResearchIdeaCapabilities(context, researchRepository.ideas);
  registerResearchIdeaPlanCapabilities(context, researchRepository.ideaPlans);
  registerResearchProposalCapabilities(context, new ResearchProposalService(researchRepository, researchExperiments,
    researchResults, researchFigures, new ResearchJournalComplianceService(researchRepository, researchFigures)));
  context.capabilities.register(pluginId, lifecycleCapabilities.createArtifact, async (input) =>
    researchRepository.createArtifact(researchArtifactCreateRequestSchema.parse(input)));
  context.capabilities.register(pluginId, lifecycleCapabilities.getArtifact, async (input) =>
    researchRepository.getArtifact(researchArtifactIdRequestSchema.parse(input).id));
  context.capabilities.register(pluginId, lifecycleCapabilities.listArtifacts, async (input) => {
    const request = researchArtifactListRequestSchema.parse(input);
    return researchRepository.listArtifacts(request.projectId, request.stage);
  });
  context.capabilities.register(pluginId, lifecycleCapabilities.updateArtifact, async (input) =>
    researchRepository.updateArtifact(researchArtifactUpdateRequestSchema.parse(input)));
  context.capabilities.register(pluginId, lifecycleCapabilities.events, async (input) =>
    researchRepository.listWorkflowEvents(researchWorkflowEventsRequestSchema.parse(input)));
  context.capabilities.register(pluginId, workbenchCapabilities.listProjects, async () => researchRepository.listProjects());
  context.capabilities.register(pluginId, workbenchCapabilities.getProject, async (input) => researchRepository.getProject((input as { id: string }).id));
  context.capabilities.register(pluginId, workbenchCapabilities.createProject, async (input) => {
    const project = researchRepository.createProject(researchProjectCreateRequestSchema.parse(input));
    researchIndexer.projectChanged(project.id);
    return project;
  });
  context.capabilities.register(pluginId, workbenchCapabilities.updateProject, async (input) => {
    const project = researchRepository.updateProject(researchProjectUpdateRequestSchema.parse(input));
    researchIndexer.projectChanged(project.id);
    researchExperiments.projectChanged(project.id);
    researchFigures.projectChanged(project.id);
    researchExports.projectChanged(project.id);
    zenodoPublication.projectChanged(project.id);
    if (project.status === 'archived') {
      await researchIndexer.releaseProject(project.id);
      await reviewSearches.releaseProject(project.id);
      await visual.releaseProject(project.id);
      await figureUnderstanding.releaseProject(project.id);
      await researchPythonEnvironments.releaseProject(project.id);
    }
    return project;
  });
  context.capabilities.register(pluginId, workbenchCapabilities.deleteProject, async (input) => {
    const request = researchProjectIdRequestSchema.parse(input);
    return researchIndexer.withProjectReleased(request.id, () => visual.withProjectReleased(request.id, () => figureUnderstanding.withProjectReleased(request.id, async () => {
      await reviewSearches.releaseProject(request.id);
      await researchPythonEnvironments.releaseProject(request.id);
      await literature.releaseDownloads(request.id);
      const result = researchRepository.deleteProject(request.id);
      researchExperiments.releaseProject(request.id);
      researchFigures.releaseProject(request.id);
      researchExports.releaseProject(request.id);
      zenodoPublication.releaseProject(request.id);
      runtime.releaseProject(request.id);
      return result;
    })));
  });
  context.capabilities.register(pluginId, workbenchCapabilities.getWorkflow, async (input) => researchRepository.getWorkflow((input as { id: string }).id));
  context.capabilities.register(pluginId, workbenchCapabilities.verifyStageArtifacts, async (input) => {
    const request = z.object({ projectId: z.string().min(1), stage: researchStageSchema }).strict().parse(input);
    const proof = researchRepository.verifyStageForTaskAcceptance(request.projectId, request.stage);
    const refs = [...proof.refs];
    const stage = researchRepository.getWorkflow(request.projectId).stages.find((item) => item.stage === request.stage);
    if (stage === undefined) throw new Error('research_stage_not_found');
    await scientificReviews.verifyArtifacts(request.projectId, stage.artifactIds);
    if (request.stage === 'experiment') {
      for (const id of stage.artifactIds) {
        const artifact = researchRepository.getArtifact(id);
        const run = researchRepository.experiments.forArtifact(artifact);
        const verified = await researchExperiments.snapshot(request.projectId, run.id);
        const { artifactId: _artifactId, ...manifest } = verified;
        refs.push({ path: `research-experiment:${run.id}/manifest.json`, sha256: researchContentHash(JSON.stringify(manifest, null, 2)) });
        refs.push(...verified.files.map((file) => ({ path: `research-experiment:${run.id}/${file.area}/${file.path}`, sha256: file.sha256 })));
        refs.push({ path: `research-experiment:${run.id}/environment`, sha256: researchContentHash(JSON.stringify(run.environment)) });
      }
    } else if (request.stage === 'figure') {
      await researchFigures.verifyStage(request.projectId);
      for (const id of stage.artifactIds) {
        const artifact = researchRepository.getArtifact(id);
        const publication = researchRepository.figures.forArtifact(artifact);
        const run = researchRepository.figureRuns.get(request.projectId, publication.runId);
        refs.push({ path: `research-figure:${run.id}/figure-manifest.json`, sha256: publication.manifestHash });
        refs.push(...run.files.map((file) => ({ path: `research-figure:${run.id}/${file.area}/${file.path}`, sha256: file.sha256 })));
        refs.push({ path: `research-figure:${run.id}/environment`, sha256: researchContentHash(JSON.stringify(run.environment)) });
      }
    } else if (request.stage === 'export') {
      await researchExports.verifyStage(request.projectId);
      for (const id of stage.artifactIds) {
        const artifact = researchRepository.getArtifact(id);
        const record = researchRepository.exports.forArtifact(artifact);
        refs.push({ path: `research-export:${record.id}/sources`, sha256: record.sourceHash! });
        refs.push(...record.files.map((file) => ({ path: `research-export:${record.id}/bundle/${file.path}`, sha256: file.sha256 })));
        if (record.archive !== null) refs.push({ path: `research-export:${record.id}/${record.archive.path}`, sha256: record.archive.sha256 });
      }
    }
    const currentProof = researchRepository.verifyStageForTaskAcceptance(request.projectId, request.stage);
    if (JSON.stringify(currentProof) !== JSON.stringify(proof)) throw new Error('research_artifact_review_changed');
    const uniqueRefs = [...new Map(refs.map((ref) => [ref.path, ref])).values()];
    return { ...proof, detail: `${proof.detail} Full ${request.stage} verifier passed.`, refs: uniqueRefs };
  });
  context.capabilities.register(pluginId, workbenchCapabilities.transitionWorkflow, async input => {
    const request = researchWorkflowTransitionRequestSchema.parse(input);
    // Approve/reject publish inside the synchronous repository transaction after validation.
    if (request.action !== 'approve' && request.action !== 'reject') recordCapabilityOperationReceipt();
    const snapshot = await applyResearchWorkflowTransition({ request, gate: humanGate, runtime, exports: researchExports });
    if (['complete', 'approve', 'reject'].includes(request.action)) {
      for (const taskId of researchRepository.runs.taskIdsForStage(request.projectId, request.expectedStage)) {
        runtime.synchronizeTaskState(taskId, request.projectId);
        notifyResearchTaskChanged(context, taskId, request.projectId);
      }
    }
    return snapshot;
  });
  context.capabilities.register(pluginId, workbenchCapabilities.stageRole, async (input) =>
    getResearchStageRoleProfile((input as ResearchStageRoleRequest).stage)
  );
}
