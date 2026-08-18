import type { z } from 'zod';

import {
  appStatusSchema,
  performanceSampleRequestSchema,
  performanceSampleSchema,
  systemAppearanceSnapshotSchema,
  windowBoundsSnapshotSchema,
  windowStateSnapshotSchema
} from '../schemas/ipc-core';

export type AppStatus = z.infer<typeof appStatusSchema>;
export type WindowStateSnapshot = z.infer<typeof windowStateSnapshotSchema>;
export type WindowBoundsSnapshot = z.infer<typeof windowBoundsSnapshotSchema>;
export type PerformanceSample = z.infer<typeof performanceSampleSchema>;
export type PerformanceElectronMetrics = PerformanceSample['electron'];
export type PerformanceProcessMetric = PerformanceElectronMetrics['processMetrics'][number];
export type SystemAppearanceSnapshot = z.infer<typeof systemAppearanceSnapshotSchema>;
export type PerformanceSampleRequest = z.infer<typeof performanceSampleRequestSchema>;
