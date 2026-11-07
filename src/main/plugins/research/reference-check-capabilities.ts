import {referenceCheckRequestSchema, referenceCheckReportSchema} from '../../../shared/schemas/research-reference-check';
import type {RocPluginContext} from '../../kernel/types';
import {literatureContext, assertLiteratureActive} from '../../services/literature-context';
import type {ReferenceCheckService} from './reference-check-service';

export const referenceCheckCapability = {name: 'research.library.checkReferences', version: '1.0.0',
  inputSchema: referenceCheckRequestSchema, outputSchema: referenceCheckReportSchema};
export function registerReferenceCheckCapability(context: RocPluginContext, service: ReferenceCheckService): void {
  context.capabilities.register(context.pluginId, referenceCheckCapability, async input => {
    const scope = literatureContext();
    assertLiteratureActive(scope);
    const request = referenceCheckRequestSchema.parse(input);
    if (request.projectId !== scope.projectId) throw new Error('research_library_project_mismatch');
    const result = await service.check(request, scope.signal);
    assertLiteratureActive(scope);
    return result;
  });
}
