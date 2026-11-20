import {changePaperAcquisitionSchema, listPaperAcquisitionResultSchema, listPaperAcquisitionSchema,
  paperAcquisitionJobSchema, literatureAcquisitionSettingsSchema, type LiteratureAcquisitionSettings,
  type ChangePaperAcquisition, type ListPaperAcquisition} from '../../../shared/schemas/literature-acquisition';
import {z} from 'zod';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {RocDomainError} from '../../services/errors';
import type {LiteratureAcquisitionService} from './literature-acquisition-service';

const capabilities = {
  settings: {name: 'research.library.acquisitionSettings', version: '1.0.0', inputSchema: z.object({}).strict(), outputSchema: literatureAcquisitionSettingsSchema},
  saveSettings: {name: 'research.library.saveAcquisitionSettings', version: '1.0.0', inputSchema: literatureAcquisitionSettingsSchema, outputSchema: literatureAcquisitionSettingsSchema},
  list: {name: 'research.library.listAcquisition', version: '1.0.0', inputSchema: listPaperAcquisitionSchema, outputSchema: listPaperAcquisitionResultSchema},
  retry: {name: 'research.library.retryAcquisition', version: '1.0.0', inputSchema: changePaperAcquisitionSchema, outputSchema: paperAcquisitionJobSchema},
  cancel: {name: 'research.library.cancelAcquisition', version: '1.0.0', inputSchema: changePaperAcquisitionSchema, outputSchema: paperAcquisitionJobSchema}
} as const satisfies Record<string, CapabilityDescriptor>;
export const literatureAcquisitionCapabilities = Object.values(capabilities);
const settingsKey = 'literature.acquisition';
export function readAcquisitionSettings(context: RocPluginContext): LiteratureAcquisitionSettings {
  return literatureAcquisitionSettingsSchema.parse(context.config.get(settingsKey) ?? {});
}

export function registerLiteratureAcquisitionCapabilities(context: RocPluginContext, service: LiteratureAcquisitionService): void {
  context.capabilities.register(context.pluginId, capabilities.settings, async () => readAcquisitionSettings(context));
  context.capabilities.register(context.pluginId, capabilities.saveSettings, async (input: LiteratureAcquisitionSettings) => {
    const settings = literatureAcquisitionSettingsSchema.parse(input);
    context.config.set(settingsKey, settings);
    return settings;
  });
  async function change(request: ChangePaperAcquisition, action: 'retry' | 'cancel') {
    try {return service.change(request, action);}
    catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'literature_acquisition_changed') throw new RocDomainError({code, category: 'conflict', retryable: false,
        message: '文献处理任务已更新，请刷新进度后重试。'});
      if (code === 'literature_acquisition_not_found') throw new RocDomainError({code, category: 'not_found', retryable: false,
        message: '文献处理任务不存在，或不属于当前项目。'});
      if (code === 'literature_acquisition_replacement_invalid') throw new RocDomainError({code, category: 'validation', retryable: false,
        message: '补充的 PDF 不属于当前文献或项目，请重新选择。'});
      throw error;
    }
  }
  context.capabilities.register(context.pluginId, capabilities.list, async (request: ListPaperAcquisition) => service.list(request));
  context.capabilities.register(context.pluginId, capabilities.retry, (request: ChangePaperAcquisition) => change(request, 'retry'));
  context.capabilities.register(context.pluginId, capabilities.cancel, (request: ChangePaperAcquisition) => change(request, 'cancel'));
}
