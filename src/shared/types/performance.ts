import type { z } from 'zod';

import { performanceSampleSchema } from '../schemas/ipc-core';

type PerformanceSample = z.infer<typeof performanceSampleSchema>;

export type PerformanceSnapshot = PerformanceSample['timing'];
export type PerformanceTimingSample = PerformanceSnapshot['samples'][number];
export type PerformancePhase = PerformanceTimingSample['phase'];
export type PerformanceIpcSummary = PerformanceSample['ipc'];
export type PerformanceIpcChannelSummary = PerformanceIpcSummary['topSlowCalls'][number];
