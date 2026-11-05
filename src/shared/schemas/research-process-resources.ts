import { z } from 'zod';

const nonnegativeInteger = z.number().int().nonnegative();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);

export const researchProcessResourceUsageSchema = z.object({
  mode: z.literal('monitored'), sampleIntervalMs: z.literal(100), samples: nonnegativeInteger,
  observedCpuTimeMs: nonnegativeInteger.nullable(), peakResidentBytes: nonnegativeInteger.nullable()
}).strict().superRefine((value, context) => {
  const unknown = value.observedCpuTimeMs === null && value.peakResidentBytes === null;
  const observed = value.observedCpuTimeMs !== null && value.peakResidentBytes !== null;
  if (value.samples === 0 ? !unknown : !observed) context.addIssue({ code: 'custom', message: 'research_process_resource_observation_invalid' });
});

export const researchExperimentResourceReportSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1), projectId: z.string().min(1), engine: z.enum(['typescript', 'r', 'julia']),
  inputHash: digest.nullable(), environmentHash: digest.nullable(),
  backend: z.object({
    id: z.literal('macos-seatbelt'), contractVersion: z.literal(1), kernelRelease: z.string().min(1),
    architecture: z.string().min(1), cpuHardLimit: z.literal(false), memoryHardLimit: z.literal(false)
  }).strict(),
  policy: z.object({
    timeoutMs: z.number().int().positive(), maxOutputBytes: z.number().int().positive(),
    fileLimits: z.object({
      maxFileBytes: z.number().int().positive(), maxTotalBytes: z.number().int().positive(),
      maxFiles: z.number().int().positive(), maxEntries: z.number().int().positive()
    }).strict(),
    resourceLimits: z.object({
      mode: z.literal('monitored'), cpuTimeMs: z.number().int().positive(), maxResidentBytes: z.number().int().positive()
    }).strict(),
    allowGpuAcceleration: z.literal(false), networkAccess: z.literal('none')
  }).strict(),
  outcome: z.enum(['not_dispatched', 'returned', 'rejected']),
  exitCode: z.number().int().nullable(), error: z.string().min(1).nullable(),
  usage: researchProcessResourceUsageSchema.nullable(),
  admission: z.object({ waitMs: nonnegativeInteger, holdMs: nonnegativeInteger }).strict().nullable(),
  recordedAt: z.iso.datetime()
}).strict().superRefine((value, context) => {
  if (value.outcome === 'returned') {
    if (value.inputHash === null || value.environmentHash === null || value.exitCode === null
      || value.error !== null || value.usage === null || value.admission === null) {
      context.addIssue({ code: 'custom', message: 'research_experiment_resource_result_invalid' });
    }
  } else if (value.exitCode !== null || value.error === null) {
    context.addIssue({ code: 'custom', message: 'research_experiment_resource_failure_invalid' });
  }
  if (value.outcome === 'not_dispatched' && (value.usage !== null || value.admission !== null)) {
    context.addIssue({ code: 'custom', message: 'research_experiment_resource_dispatch_invalid' });
  }
  if (value.outcome === 'rejected' && (value.inputHash === null || value.environmentHash === null)) {
    context.addIssue({ code: 'custom', message: 'research_experiment_resource_basis_required' });
  }
});

export type ResearchProcessResourceUsage = z.infer<typeof researchProcessResourceUsageSchema>;
export type ResearchExperimentResourceReport = z.infer<typeof researchExperimentResourceReportSchema>;
