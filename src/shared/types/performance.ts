import type { z } from 'zod';

import type { performanceSampleSchema } from '../schemas/ipc-core';

type PerformanceSample = z.infer<typeof performanceSampleSchema>;

export type PerformanceSnapshot = PerformanceSample['timing'];
export type PerformanceTimingSample = PerformanceSnapshot['samples'][number];
export type PerformanceIpcSummary = PerformanceSample['ipc'];
export type PerformanceIpcChannelSummary = PerformanceIpcSummary['topSlowCalls'][number];
