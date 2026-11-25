import { researchEnvironmentProbeResourceSchema, type ResearchEnvironmentProbeResource } from '../../../shared/schemas/research-process-resources';
import { ResearchProcessError, type ResearchProcessRequest, type ResearchProcessResult } from './process-runner';
import { researchContentHash } from './research-files';

/** Record the dispatched probe policy and its actual resource receipt. */
export async function runEnvironmentProbe(kind: ResearchEnvironmentProbeResource['kind'], request: ResearchProcessRequest,
  run: (request: ResearchProcessRequest) => Promise<ResearchProcessResult>,
  observe: (receipt: ResearchEnvironmentProbeResource) => void): Promise<ResearchProcessResult> {
  const { signal: _signal, ...dispatch } = request;
  const basis = {
    kind, command: request.command, requestHash: researchContentHash(JSON.stringify(dispatch)),
    policy: { timeoutMs: request.timeoutMs, maxOutputBytes: request.maxOutputBytes, resourceLimits: request.resourceLimits,
      writeLimits: request.writeLimits, allowGpuAcceleration: request.allowGpuAcceleration, networkAccess: request.networkAccess }
  };
  let result: ResearchProcessResult;
  try { result = await run(request); }
  catch (error) {
    observe(researchEnvironmentProbeResourceSchema.parse({
      ...basis, outcome: 'rejected', exitCode: null, error: error instanceof Error ? error.message : 'research_environment_probe_rejected',
      usage: error instanceof ResearchProcessError ? error.resourceUsage : null,
      admission: error instanceof ResearchProcessError ? error.admission : null, recordedAt: new Date().toISOString()
    }));
    throw error;
  }
  observe(researchEnvironmentProbeResourceSchema.parse({
    ...basis, outcome: 'returned', exitCode: result.exitCode, error: null, usage: result.resourceUsage,
    admission: result.admission, recordedAt: new Date().toISOString()
  }));
  return result;
}
