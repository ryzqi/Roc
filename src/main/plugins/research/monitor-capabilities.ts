import {z} from 'zod';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {
  monitorSaveSchema, monitorSchema, monitorReadSchema, monitorControlSchema, monitorCheckRequestSchema,
  monitorCheckSchema, monitorCancelSchema, monitorCancelResultSchema, monitorListSchema, monitorListResultSchema,
  monitorHistorySchema, monitorChecksResultSchema, monitorVersionsResultSchema, monitorAlertsResultSchema,
  monitorCheckReadSchema, monitorAcknowledgeSchema, monitorAlertSchema
} from '../../../shared/schemas/research-monitors';
import type {ResearchMonitorService} from './monitor-service';
import type {ResearchMonitorRepository} from './monitor-repository';
import {RocDomainError} from '../../services/errors';

function descriptor<I, O>(name: string, inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>): CapabilityDescriptor<I, O> {
  return {name, version: '1.0.0', inputSchema, outputSchema};
}
const capabilities = {
  save: descriptor('research.monitors.save', monitorSaveSchema, monitorSchema),
  control: descriptor('research.monitors.control', monitorControlSchema, monitorSchema),
  check: descriptor('research.monitors.check', monitorCheckRequestSchema, monitorCheckSchema),
  cancel: descriptor('research.monitors.cancel', monitorCancelSchema, monitorCancelResultSchema),
  acknowledge: descriptor('research.monitors.acknowledge', monitorAcknowledgeSchema, monitorAlertSchema),
  read: descriptor('research.monitors.read', monitorReadSchema, monitorSchema),
  list: descriptor('research.monitors.list', monitorListSchema, monitorListResultSchema),
  versions: descriptor('research.monitors.versions', monitorHistorySchema, monitorVersionsResultSchema),
  checks: descriptor('research.monitors.checks', monitorHistorySchema, monitorChecksResultSchema),
  alerts: descriptor('research.monitors.alerts', monitorHistorySchema, monitorAlertsResultSchema),
  readCheck: descriptor('research.monitors.readCheck', monitorCheckReadSchema, monitorCheckSchema),
  resume: descriptor('research.monitors.handlePowerResume', z.strictObject({}), z.strictObject({handled: z.literal(true)}))
};
export const researchMonitorCapabilities = Object.values(capabilities);
export function registerResearchMonitorCapabilities(context: RocPluginContext, service: ResearchMonitorService,
  repository: ResearchMonitorRepository): void {
  function register<I, O>(capability: CapabilityDescriptor<I, O>, run: (input: I) => O | Promise<O>): void {
    context.capabilities.register(context.pluginId, capability, async input => {
      try {return await run(capability.inputSchema.parse(input));}
      catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (!code.startsWith('research_monitor_')) throw error;
        throw new RocDomainError({code, message: `文献监控操作未完成：${code}`, category: code.includes('not_found') ?
          'not_found' : code.includes('storage') ? 'degraded' : 'conflict', retryable: false});
      }
    });
  }
  register(capabilities.save, input => service.save(input));
  register(capabilities.control, input => service.control(input));
  register(capabilities.check, input => service.check(input));
  register(capabilities.cancel, input => service.cancel(input));
  register(capabilities.acknowledge, input => repository.acknowledge(input));
  register(capabilities.read, input => repository.get(input.projectId, input.monitorId));
  register(capabilities.list, input => repository.list(input));
  register(capabilities.versions, input => repository.history(input, 'versions'));
  register(capabilities.checks, input => repository.history(input, 'checks'));
  register(capabilities.alerts, input => repository.history(input, 'alerts'));
  register(capabilities.readCheck, input => repository.check(input.projectId, input.monitorId, input.checkId));
  register(capabilities.resume, () => {service.reconcile(); return {handled: true};});
}
