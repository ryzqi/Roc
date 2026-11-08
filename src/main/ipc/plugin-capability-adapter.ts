import {wikiSaveSchema, wikiRollbackSchema} from '../../shared/schemas/research-wiki-pages';
import {researchTaskRequestSchema} from '../../shared/schemas/research-tasks';
import {taskFactsSaveSchema} from '../../shared/schemas/research-task-facts';
import {zenodoCredentialSchema, zenodoCredentialReadSchema, zenodoStartSchema, zenodoOperationActionSchema, zenodoPublicationApproveSchema, zenodoPublishSchema, zenodoOperationReadSchema} from '../../shared/schemas/research-zenodo-remote';
import {zenodoPrepareSchema} from '../../shared/schemas/research-zenodo';
import {monitorSaveSchema, monitorControlSchema, monitorCheckRequestSchema, monitorCancelSchema, monitorAcknowledgeSchema} from '../../shared/schemas/research-monitors';
import {researchIdeaPlanSaveSchema, researchIdeaPlanFreezeRequestSchema} from '../../shared/schemas/research-idea-plans';
import {researchIdeaOutcomeSaveSchema} from '../../shared/schemas/research-idea-outcomes';
import {researchCitationReviewSaveSchema} from '../../shared/schemas/research-citation-reviews';
import {researchConsistencySaveSchema} from '../../shared/schemas/research-consistency';
import {researchFigureConsistencySaveSchema} from '../../shared/schemas/research-figure-consistency';
import {researchJournalSaveSchema} from '../../shared/schemas/research-journal-compliance';
import {resourceAssociationSaveSchema} from '../../shared/schemas/research-resource-associations';
import {hfDownloadStartSchema} from '../../shared/schemas/research-huggingface-downloads';
import {researchResponseMatrixSaveSchema} from '../../shared/schemas/research-response-matrix';
import { withLiteratureContext } from '../services/literature-context';
import { researchPythonEnvironmentSelectSchema } from '../../shared/schemas/research-python-environments';
import { researchNotebookImportRequestSchema } from '../../shared/schemas/research-notebooks';
import { researchExperimentResultReviewSchema,researchExperimentResultEvidenceCaptureSchema } from '../../shared/schemas/research-experiment-results';
import {withResearchHumanContext} from '../services/research-human-context';
import {researchSourceMigrationCaptureSchema, researchSourceMigrationRejectSchema} from '../../shared/schemas/research-source-migrations';
import {researchSourceReplacementRequestSchema} from '../../shared/schemas/research-source-replacements';
import {researchDocumentAnnotationCreateRequestSchema, researchDocumentAnnotationCaptureRequestSchema} from '../../shared/schemas/research-document-annotations';
import {researchReviewProtocolSaveRequestSchema, researchReviewProtocolFreezeRequestSchema} from '../../shared/schemas/research-systematic-review';
import {researchReviewSearchStartSchema, researchReviewSearchCancelSchema} from '../../shared/schemas/research-review-search';
import {researchReviewCorpusCreateSchema} from '../../shared/schemas/research-review-corpus';
import {researchReviewFullTextBindingSaveSchema} from '../../shared/schemas/research-review-fulltext';
import {researchReviewFullTextDecisionSaveSchema,researchReviewFullTextArbitrationSaveSchema,researchReviewFullTextFreezeRequestSchema} from '../../shared/schemas/research-review-fulltext-screening';
import {researchReviewExtractionSaveSchema} from '../../shared/schemas/research-review-extraction';
import {researchReviewStudiesSaveSchema} from '../../shared/schemas/research-review-studies';
import {researchReviewQualityPlanCreateSchema,researchReviewQualityAssessmentSaveSchema} from '../../shared/schemas/research-review-quality';
import {researchReviewDuplicateSaveSchema, researchReviewDeduplicationFreezeSchema} from '../../shared/schemas/research-review-deduplication';
import {researchReviewScreeningPlanCreateSchema, researchReviewScreeningDecisionSaveSchema, researchReviewScreeningArbitrationSaveSchema,
  researchReviewScreeningFreezeRequestSchema} from '../../shared/schemas/research-review-screening';
import {
  researchEvidenceRelationProposalSchema, researchEvidenceRelationReviewSchema
} from '../../shared/schemas/research-evidence-relations';
import {
  pluginCapabilityMappings,
  type GeneratedPluginCapabilityMapping
} from '../../shared/ipc';
import type { IpcResult } from '../../shared/types';
import { wrapIpc } from '../services/errors';
import type { TimedHandle } from './ipc-common';

export type PluginCapabilityInvoker = {
  invokeCapability<TInput, TOutput>(name: string, input: TInput): Promise<TOutput>;
};

export type PluginCapabilityMapping = GeneratedPluginCapabilityMapping;
export type PluginCapabilityAdapter = {
  invoke(preloadMethod: string, args: readonly unknown[], windowId?: number): Promise<IpcResult<unknown>>;
};

export { pluginCapabilityMappings };

export function createPluginCapabilityAdapter(invoker: PluginCapabilityInvoker): PluginCapabilityAdapter {
  const mappingsByMethod = new Map<string, PluginCapabilityMapping>(
    pluginCapabilityMappings.map((item) => [item.preloadMethod, item])
  );
  return {
    async invoke(preloadMethod, args, windowId = 0) {
      const target = mappingsByMethod.get(preloadMethod);
      if (target === undefined) {
        return await wrapIpc(() => {
          throw new Error(`plugin_capability_mapping_missing:${preloadMethod}`);
        });
      }
      return await wrapIpc(async () => {
        const input = transformInput(target.inputTransform, args);
        if (target.capabilityName === 'research.wiki.save' || target.capabilityName === 'research.wiki.rollback') {
          const request = target.capabilityName === 'research.wiki.save' ? wikiSaveSchema.parse(input) : wikiRollbackSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.task.diagnostics.export') {
          const request = researchTaskRequestSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.task.facts.save') {
          const request = taskFactsSaveSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.zenodo.saveCredential') {
          const request = zenodoCredentialSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.zenodo.clearCredential') {
          const request = zenodoCredentialReadSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.zenodo.start') {
          const request = zenodoStartSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.zenodo.resume') {
          const request = zenodoOperationActionSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.zenodo.approvePublication') {
          const request = zenodoPublicationApproveSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.zenodo.publish') {
          const request = zenodoPublishSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.zenodo.cancel') {
          const request = zenodoOperationReadSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.zenodo.prepare') {
          const request = zenodoPrepareSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.monitors.save') {
          const request = monitorSaveSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.monitors.control') {
          const request = monitorControlSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.monitors.check') {
          const request = monitorCheckRequestSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.monitors.cancel') {
          const request = monitorCancelSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.monitors.acknowledge') {
          const request = monitorAcknowledgeSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.huggingfaceDownloads.start') {
          const request = hfDownloadStartSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.resourceAssociations.save') {
          const request = resourceAssociationSaveSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.journalCompliance.save') {
          const request = researchJournalSaveSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.responseMatrix.save') {
          const request = researchResponseMatrixSaveSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.figureConsistency.save') {
          const request = researchFigureConsistencySaveSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.consistency.save') {
          const request = researchConsistencySaveSchema.parse(input);
          return await withResearchHumanContext({capability: 'research.consistency.save', projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.citationReviews.save') {
          const request = researchCitationReviewSaveSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.ideaOutcomes.save') {
          const request = researchIdeaOutcomeSaveSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.ideaPlans.save' || target.capabilityName === 'research.ideaPlans.freeze') {
          const request = target.capabilityName === 'research.ideaPlans.save' ? researchIdeaPlanSaveSchema.parse(input) :
            researchIdeaPlanFreezeRequestSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if(target.capabilityName==='research.experimentResults.review') {
          const request=researchExperimentResultReviewSchema.parse(input);
          return withResearchHumanContext({capability:target.capabilityName,projectId:request.projectId,windowId},
            ()=>invoker.invokeCapability(target.capabilityName,request));
        }
        if(target.capabilityName==='research.experimentResults.captureEvidence') {
          const request=researchExperimentResultEvidenceCaptureSchema.parse(input);
          return withResearchHumanContext({capability:target.capabilityName,projectId:request.projectId,windowId},
            ()=>invoker.invokeCapability(target.capabilityName,request));
        }
        if (target.capabilityName === 'research.notebooks.import') {
          const request = researchNotebookImportRequestSchema.parse(input);
          return withResearchHumanContext({ capability: target.capabilityName, projectId: request.projectId, windowId },
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.pythonEnvironments.select') {
          const request = researchPythonEnvironmentSelectSchema.parse(input);
          return withResearchHumanContext({ capability: target.capabilityName, projectId: request.projectId, windowId },
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if(target.capabilityName==='research.reviewStudies.save') {
          const request=researchReviewStudiesSaveSchema.parse(input);
          return withResearchHumanContext({capability:target.capabilityName,projectId:request.projectId,windowId},
            ()=>invoker.invokeCapability(target.capabilityName,request));
        }
        if(target.capabilityName==='research.reviewQuality.saveAssessment') {
          const request=researchReviewQualityAssessmentSaveSchema.parse(input);
          return withResearchHumanContext({capability:target.capabilityName,projectId:request.projectId,windowId},
            ()=>invoker.invokeCapability(target.capabilityName,request));
        }
        if(target.capabilityName==='research.reviewQuality.createPlan') {
          const request=researchReviewQualityPlanCreateSchema.parse(input);
          return withResearchHumanContext({capability:target.capabilityName,projectId:request.projectId,windowId},
            ()=>invoker.invokeCapability(target.capabilityName,request));
        }
        if(target.capabilityName==='research.reviewExtraction.save') {
          const request=researchReviewExtractionSaveSchema.parse(input);
          return withResearchHumanContext({capability:target.capabilityName,projectId:request.projectId,windowId},
            ()=>invoker.invokeCapability(target.capabilityName,request));
        }
        if(target.capabilityName==='research.reviewFullTextScreening.freeze') {
          const request=researchReviewFullTextFreezeRequestSchema.parse(input);
          return withResearchHumanContext({capability:target.capabilityName,projectId:request.projectId,windowId},
            ()=>invoker.invokeCapability(target.capabilityName,request));
        }
        if(target.capabilityName==='research.reviewFullTextScreening.adjudicate') {
          const request=researchReviewFullTextArbitrationSaveSchema.parse(input);
          return withResearchHumanContext({capability:target.capabilityName,projectId:request.projectId,windowId},
            ()=>invoker.invokeCapability(target.capabilityName,request));
        }
        if(target.capabilityName==='research.reviewFullTextScreening.save') {
          const request=researchReviewFullTextDecisionSaveSchema.parse(input);
          return withResearchHumanContext({capability:target.capabilityName,projectId:request.projectId,windowId},
            ()=>invoker.invokeCapability(target.capabilityName,request));
        }
        if(target.capabilityName==='research.reviewFullText.save') {
          const request=researchReviewFullTextBindingSaveSchema.parse(input);
          return withResearchHumanContext({capability:target.capabilityName,projectId:request.projectId,windowId},
            ()=>invoker.invokeCapability(target.capabilityName,request));
        }
        if (target.capabilityName === 'research.reviewScreening.freeze') {
          const request = researchReviewScreeningFreezeRequestSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.reviewScreening.adjudicate') {
          const request = researchReviewScreeningArbitrationSaveSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.reviewScreening.save') {
          const request = researchReviewScreeningDecisionSaveSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.reviewScreening.createPlan') {
          const request = researchReviewScreeningPlanCreateSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.reviewDeduplication.save' || target.capabilityName === 'research.reviewDeduplication.freeze') {
          const request = target.capabilityName === 'research.reviewDeduplication.save' ?
            researchReviewDuplicateSaveSchema.parse(input) : researchReviewDeduplicationFreezeSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.reviewCorpus.create') {
          const request = researchReviewCorpusCreateSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.reviewSearch.start' || target.capabilityName === 'research.reviewSearch.cancel') {
          const request = target.capabilityName === 'research.reviewSearch.start' ?
            researchReviewSearchStartSchema.parse(input) : researchReviewSearchCancelSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.reviewProtocol.save' || target.capabilityName === 'research.reviewProtocol.freeze') {
          const request = target.capabilityName === 'research.reviewProtocol.save' ?
            researchReviewProtocolSaveRequestSchema.parse(input) : researchReviewProtocolFreezeRequestSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.annotations.create') {
          const request = researchDocumentAnnotationCreateRequestSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.target.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.annotations.capture') {
          const request = researchDocumentAnnotationCaptureRequestSchema.parse(input);
          return withResearchHumanContext({capability: target.capabilityName, projectId: request.projectId, windowId},
            () => invoker.invokeCapability(target.capabilityName, request));
        }
        if (target.capabilityName === 'research.relations.propose' || target.capabilityName === 'research.relations.review' ||
            target.capabilityName === 'research.sourceMigrations.capture' || target.capabilityName === 'research.sourceMigrations.reject' ||
            target.capabilityName === 'research.sourceReplacements.replace') {
          const request = target.capabilityName === 'research.relations.propose' ?
            researchEvidenceRelationProposalSchema.parse(input) : target.capabilityName === 'research.relations.review' ?
            researchEvidenceRelationReviewSchema.parse(input) : target.capabilityName === 'research.sourceMigrations.capture' ?
            researchSourceMigrationCaptureSchema.parse(input) : target.capabilityName === 'research.sourceMigrations.reject' ?
            researchSourceMigrationRejectSchema.parse(input) : researchSourceReplacementRequestSchema.parse(input);
          return withResearchHumanContext({
            capability: target.capabilityName, projectId: request.projectId, windowId
          }, () => invoker.invokeCapability(target.capabilityName, request));
        }
        const scoped = ['research.literature.search', 'research.literature.getSearch', 'research.library.addLiterature',
          'research.library.getImportOperation', 'research.library.cancelImportOperation', 'research.literature.getPool',
          'research.zotero.preview', 'research.zotero.getPreview', 'research.zotero.sources', 'research.zotero.review',
          'research.zotero.syncStart', 'research.zotero.syncRead', 'research.zotero.syncPage',
          'research.zotero.syncControl', 'research.zotero.syncAcknowledge', 'research.zotero.syncFind',
          'research.zotero.syncReadPage', 'research.zotero.sourceObserve', 'research.zotero.sourceState',
          'research.zotero.attachmentInspect', 'research.zotero.attachmentRead',
          'research.zotero.attachmentGrant', 'research.zotero.attachmentGrantRead', 'research.zotero.attachmentImport',
          'research.zotero.attachmentImportRead', 'research.zotero.attachmentImportCancel', 'research.zotero.children'].includes(target.capabilityName);
        if (!scoped) return invoker.invokeCapability(target.capabilityName, input);
        const projectId = typeof input === 'object' && input !== null && !Array.isArray(input) && 'projectId' in input && typeof input.projectId === 'string' ? input.projectId : null;
        return withLiteratureContext({ owner: `window:${windowId}`, projectId }, () => invoker.invokeCapability(target.capabilityName, input));
      });
    }
  };
}

export function registerPluginCapabilityIpc(timedHandle: TimedHandle, invoker: PluginCapabilityInvoker): void {
  const adapter = createPluginCapabilityAdapter(invoker);
  for (const target of pluginCapabilityMappings) {
    timedHandle(target.channel, (event: { sender: { id: number } }, ...args: unknown[]) => adapter.invoke(target.preloadMethod, args, event.sender.id));
  }
}

/**
 * A value that crossed the preload boundary. The capability's own zod input schema validates it, so
 * this type only has to be honest about the wire format: JSON values, never functions.
 */
type IpcArgumentValue =
  | string
  | number
  | boolean
  | null
  | readonly IpcArgumentValue[]
  | { readonly [key: string]: IpcArgumentValue };

function transformInput(
  transform: PluginCapabilityMapping['inputTransform'],
  args: readonly unknown[]
): IpcArgumentValue {
  if (transform.kind === 'none') {
    if (args.length !== 0) {
      throw new Error('ipc_capability_expected_no_args');
    }
    return {};
  }
  if (transform.kind === 'optional-first') {
    return args.length === 0 ? {} : firstArg(args);
  }
  if (transform.kind === 'first') {
    return firstArg(args);
  }
  if (transform.kind === 'id') {
    const value = firstArg(args);
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('ipc_capability_id_arg_invalid');
    }
    return { [transform.key]: value };
  }
  return assertNeverInputTransform(transform);
}

function assertNeverInputTransform(transform: never): never {
  throw new Error(`ipc_capability_input_transform_invalid:${String(transform)}`);
}

function firstArg(args: readonly unknown[]): IpcArgumentValue {
  const value = args[0];
  if (value === undefined) {
    throw new Error('ipc_capability_missing_arg');
  }
  // Decode at the boundary: everything below this point has been through the preload bridge, and
  // the capability's input schema is the real validator.
  return value as IpcArgumentValue;
}
