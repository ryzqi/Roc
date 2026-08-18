import type { z } from 'zod';

import {
  diagnosticCheckSchema,
  diagnosticPackageRequestSchema,
  diagnosticPackageSchema,
  healthCheckResultSchema
} from '../schemas/ipc-core';

export type DiagnosticPackageRequest = z.infer<typeof diagnosticPackageRequestSchema>;
export type DiagnosticPackage = z.infer<typeof diagnosticPackageSchema>;
export type DiagnosticCheck = z.infer<typeof diagnosticCheckSchema>;
export type DiagnosticCheckId = DiagnosticCheck['id'];
export type HealthCheckResult = z.infer<typeof healthCheckResultSchema>;
export type HealthCheck = HealthCheckResult['checks'][number];
export type HealthCheckName = HealthCheck['name'];
