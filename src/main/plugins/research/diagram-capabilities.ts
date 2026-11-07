import {researchDiagramRequestSchema, researchDiagramResultSchema} from '../../../shared/schemas/research-diagrams';
import type {RocPluginContext} from '../../kernel/types';
import type {ResearchDiagramService} from './diagram-service';
export const researchDiagramCapability = {name: 'research.diagrams.render', version: '1.0.0',
  inputSchema: researchDiagramRequestSchema, outputSchema: researchDiagramResultSchema};
export function registerResearchDiagramCapability(context: RocPluginContext, service: ResearchDiagramService): void {
  context.capabilities.register(context.pluginId, researchDiagramCapability, async input => service.render(researchDiagramRequestSchema.parse(input)));
}
