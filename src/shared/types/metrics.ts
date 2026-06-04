export type MetricType = 'counter' | 'gauge' | 'histogram';

export type Metric = {
  name: string;
  type: MetricType;
  value: number;
  timestamp: string;
  labels: Record<string, string>;
};

export type MetricFilter = {
  name?: string;
  type?: MetricType;
  labels?: Record<string, string>;
  since?: string;
};

export type MetricsSnapshot = {
  generatedAt: string;
  metrics: Metric[];
  summary: {
    totalMetrics: number;
    counterCount: number;
    gaugeCount: number;
    histogramCount: number;
  };
};

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
