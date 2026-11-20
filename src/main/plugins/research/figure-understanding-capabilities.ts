import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {getCapabilityAbortSignal} from '../../kernel/capability-cancellation';
import {figureUnderstandingRequestSchema, figureUnderstandingResultSchema,
  type FigureUnderstandingRequest, type FigureUnderstandingResult} from '../../../shared/schemas/research-figure-understanding';
import type {FigureUnderstandingService} from './figure-understanding-service';

export const figureUnderstandingCapability: CapabilityDescriptor<FigureUnderstandingRequest, FigureUnderstandingResult> = {
  name: 'research.visual.understandFigure', version: '1.0.0',
  inputSchema: figureUnderstandingRequestSchema, outputSchema: figureUnderstandingResultSchema
};
export function registerFigureUnderstandingCapability(context: RocPluginContext, service: FigureUnderstandingService): void {
  context.capabilities.register(context.pluginId, figureUnderstandingCapability,
    input => service.analyze(input, getCapabilityAbortSignal() ?? new AbortController().signal));
}
