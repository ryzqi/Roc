import type {z} from 'zod';
import {researchManuscriptSyncInspectSchema, researchManuscriptSyncAttachSchema, researchManuscriptSyncApplySchema,
  researchManuscriptSyncInspectionSchema, type ResearchManuscriptSyncInspection} from '../../../shared/schemas/research-manuscript-sync';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import type {ResearchManuscriptSyncService} from './manuscript-sync-service';
import {RocDomainError} from '../../services/errors';

function descriptor<I>(name: string, inputSchema: z.ZodType<I>): CapabilityDescriptor<I, ResearchManuscriptSyncInspection> {
  return {name: `research.manuscriptSync.${name}`, version: '1.0.0', inputSchema, outputSchema: researchManuscriptSyncInspectionSchema};
}
const capabilities = {
  inspect: descriptor('inspect', researchManuscriptSyncInspectSchema),
  attach: descriptor('attach', researchManuscriptSyncAttachSchema),
  apply: descriptor('apply', researchManuscriptSyncApplySchema)
};
export const researchManuscriptSyncCapabilities = Object.values(capabilities);

export function registerResearchManuscriptSyncCapabilities(context: RocPluginContext, service: ResearchManuscriptSyncService,
  onCheckout: (projectId: string) => void): void {
  function register<I>(capability: CapabilityDescriptor<I, ResearchManuscriptSyncInspection>,
    action: (input: I) => Promise<ResearchManuscriptSyncInspection>): void {
    context.capabilities.register(context.pluginId, capability, async input => {
      try {return await action(input);}
      catch (error) {
        if (!(error instanceof Error) || error instanceof RocDomainError) throw error;
        const code = error.message.split(':')[0];
        if (!code.startsWith('research_')) throw error;
        throw new RocDomainError({code, message: `${messages[code] ?? '无法同步工作稿'}（${code}）`,
          category: 'conflict', retryable: false});
      }
    });
  }
  register(capabilities.inspect, input => service.inspect(input));
  register(capabilities.attach, async input => {
    const result = await service.attach(input);
    if (input.mode === 'checkout') onCheckout(input.projectId);
    return result;
  });
  register(capabilities.apply, input => service.apply(input));
}

const messages: Record<string, string> = {
  research_manuscript_sync_conflict: '工作稿或正文已变化，请刷新差异',
  research_manuscript_sync_artifact_changed: '正文版本已变化，请刷新',
  research_manuscript_sync_path_exists: '同名文件已存在，请选择其他位置或关联已有文件'
};
