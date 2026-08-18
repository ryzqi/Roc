import type { z } from 'zod';

import { metricFilterSchema, metricsSnapshotSchema } from '../schemas/ipc-core';

export type MetricsSnapshot = z.infer<typeof metricsSnapshotSchema>;
export type Metric = MetricsSnapshot['metrics'][number];
export type MetricType = Metric['type'];
export type MetricFilter = z.infer<typeof metricFilterSchema>;

export type HistogramStats = {
  count: number;
  sum: number;
  avg: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
};
