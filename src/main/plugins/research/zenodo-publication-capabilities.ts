import {z} from 'zod';
import {zenodoCredentialSchema, zenodoCredentialStatusSchema, zenodoCredentialReadSchema, zenodoStartSchema, zenodoOperationSchema, zenodoOperationReadSchema, zenodoOperationForPreparationSchema, zenodoOperationListSchema, zenodoOperationListResultSchema, zenodoOperationActionSchema, zenodoPublicationApproveSchema, zenodoPublicationApprovalSchema, zenodoPublishSchema} from '../../../shared/schemas/research-zenodo-remote';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import type {ZenodoPublicationService} from './zenodo-publication';
import type {ZenodoOperationRepository} from './zenodo-operation-repository';

function descriptor<I, O>(name: string, inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>): CapabilityDescriptor<I, O> {
  return {name, version: '1.0.0', inputSchema, outputSchema};
}
const capabilities = {
  saveCredential: descriptor('research.zenodo.saveCredential', zenodoCredentialSchema, zenodoCredentialStatusSchema),
  clearCredential: descriptor('research.zenodo.clearCredential', zenodoCredentialReadSchema, zenodoCredentialStatusSchema),
  credentialStatus: descriptor('research.zenodo.credentialStatus', zenodoCredentialReadSchema, zenodoCredentialStatusSchema),
  start: descriptor('research.zenodo.start', zenodoStartSchema, zenodoOperationSchema),
  getOperation: descriptor('research.zenodo.getOperation', zenodoOperationReadSchema, zenodoOperationSchema),
  operationForPreparation: descriptor('research.zenodo.operationForPreparation', zenodoOperationForPreparationSchema, zenodoOperationSchema.nullable()),
  listOperations: descriptor('research.zenodo.listOperations', zenodoOperationListSchema, zenodoOperationListResultSchema),
  refresh: descriptor('research.zenodo.refresh', zenodoOperationReadSchema, zenodoOperationSchema),
  resume: descriptor('research.zenodo.resume', zenodoOperationActionSchema, zenodoOperationSchema),
  approvePublication: descriptor('research.zenodo.approvePublication', zenodoPublicationApproveSchema, zenodoPublicationApprovalSchema),
  publish: descriptor('research.zenodo.publish', zenodoPublishSchema, zenodoOperationSchema),
  cancel: descriptor('research.zenodo.cancel', zenodoOperationReadSchema, zenodoOperationSchema)
};
export const researchZenodoPublicationCapabilities = Object.values(capabilities);
export function registerResearchZenodoPublicationCapabilities(context: RocPluginContext, service: ZenodoPublicationService,
  repository: ZenodoOperationRepository): void {
  function register<I, O>(capability: CapabilityDescriptor<I, O>, run: (input: I) => O | Promise<O>): void {
    context.capabilities.register(context.pluginId, capability, async input => run(capability.inputSchema.parse(input)));
  }
  register(capabilities.saveCredential, input => service.saveCredential(input));
  register(capabilities.clearCredential, input => service.clearCredential(input));
  register(capabilities.credentialStatus, input => service.credentialStatus(input));
  register(capabilities.start, input => service.start(input));
  register(capabilities.getOperation, input => service.get(input));
  register(capabilities.operationForPreparation, input => repository.forPreparation(input.projectId, input.preparationId));
  register(capabilities.listOperations, input => repository.list(input));
  register(capabilities.refresh, input => service.refresh(input));
  register(capabilities.resume, input => service.resume(input));
  register(capabilities.approvePublication, input => service.approve(input));
  register(capabilities.publish, input => service.publish(input));
  register(capabilities.cancel, input => service.cancel(input));
}
