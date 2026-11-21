import {researchResultDerivationRequestSchema, researchResultDerivationSchema} from '../../../shared/schemas/research-result-derivation';
import {researchResultFigureSourceRequestSchema, researchResultFigureSourceSchema} from '../../../shared/schemas/research-result-figure-source';
import type {RocPluginContext} from '../../kernel/types';
import type {ResearchResultDerivationService} from './result-derivation-service';
import type {ResearchResultFigureSourceService} from './result-figure-source';

const preview = {name: 'research.resultDerivation.preview', version: '1.0.0',
  inputSchema: researchResultDerivationRequestSchema, outputSchema: researchResultDerivationSchema};
const prepareFigure = {name: 'research.resultDerivation.prepareFigure', version: '1.0.0',
  inputSchema: researchResultFigureSourceRequestSchema, outputSchema: researchResultFigureSourceSchema};
export const researchResultDerivationCapabilities = [preview, prepareFigure];

export function registerResearchResultDerivationCapabilities(context: RocPluginContext,
  derivation: ResearchResultDerivationService, sources: ResearchResultFigureSourceService): void {
  context.capabilities.register(context.pluginId, preview, input => derivation.preview(input));
  context.capabilities.register(context.pluginId, prepareFigure, input => sources.prepare(input));
}
