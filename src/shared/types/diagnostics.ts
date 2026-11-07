import type { z } from 'zod';

import type {
  diagnosticCheckSchema,
  diagnosticPackageRequestSchema,
  diagnosticPackageSchema,
  healthCheckResultSchema
} from '../schemas/ipc-core';

export type DiagnosticPackageRequest = z.infer<typeof diagnosticPackageRequestSchema>;
export type DiagnosticPackage = z.infer<typeof diagnosticPackageSchema>;
export type DiagnosticCheck = z.infer<typeof diagnosticCheckSchema>;
export type HealthCheckResult = z.infer<typeof healthCheckResultSchema>;
