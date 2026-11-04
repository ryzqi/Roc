import { withLiteratureContext } from '../services/literature-context';
import {withResearchHumanContext} from '../services/research-human-context';
import {researchSourceMigrationCaptureSchema, researchSourceMigrationRejectSchema} from '../../shared/schemas/research-source-migrations';
import {researchSourceReplacementRequestSchema} from '../../shared/schemas/research-source-replacements';
import {researchDocumentAnnotationCreateRequestSchema, researchDocumentAnnotationCaptureRequestSchema} from '../../shared/schemas/research-document-annotations';
import {researchReviewProtocolSaveRequestSchema, researchReviewProtocolFreezeRequestSchema} from '../../shared/schemas/research-systematic-review';
import {researchReviewSearchStartSchema, researchReviewSearchCancelSchema} from '../../shared/schemas/research-review-search';
import {researchReviewCorpusCreateSchema} from '../../shared/schemas/research-review-corpus';
import {researchReviewFullTextBindingSaveSchema} from '../../shared/schemas/research-review-fulltext';
import {researchReviewFullTextDecisionSaveSchema,researchReviewFullTextArbitrationSaveSchema} from '../../shared/schemas/research-review-fulltext-screening';
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

export type PluginCapabilityDomain = GeneratedPluginCapabilityMapping['domain'];

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
