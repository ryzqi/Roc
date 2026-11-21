import {researchImpactInspectSchema, researchImpactReportSchema} from '../../../shared/schemas/research-impact';
import {researchRepairStartSchema, researchRepairReceiptSchema} from '../../../shared/schemas/research-repair';
import type {RocPluginContext} from '../../kernel/types';
import type {ResearchImpactService} from './impact-service';
import type {ResearchRepairService} from './repair-service';

const inspect = {name: 'research.impact.inspect', version: '1.0.0', inputSchema: researchImpactInspectSchema, outputSchema: researchImpactReportSchema};
const repair = {name: 'research.impact.repair', version: '1.0.0', inputSchema: researchRepairStartSchema, outputSchema: researchRepairReceiptSchema};
export const researchImpactCapabilities = [inspect, repair];
export function registerResearchImpactCapabilities(context: RocPluginContext, impact: ResearchImpactService, repairs: ResearchRepairService): void {
  context.capabilities.register(context.pluginId, inspect, async input => impact.inspect(input));
  context.capabilities.register(context.pluginId, repair, async input => repairs.start(input));
}
