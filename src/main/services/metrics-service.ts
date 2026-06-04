import type { HistogramStats, Metric, MetricFilter, MetricsSnapshot } from '../../shared/types';

type StoredMetric = Metric & {
  sequence: number;
};

export class MetricsService {
  private readonly metrics = new Map<string, StoredMetric[]>();
  private readonly maxSamplesPerMetric = 1000;
  private sequence = 0;

  incrementCounter(name: string, labels: Record<string, string> = {}): void {
    const key = this.buildKey(name, labels);
    const latest = this.getLatest(key);
    this.record({
      name,
      type: 'counter',
      value: (latest?.value ?? 0) + 1,
      timestamp: new Date().toISOString(),
      labels
    });
  }

  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    this.record({
      name,
      type: 'gauge',
      value,
      timestamp: new Date().toISOString(),
      labels
    });
  }

  recordHistogram(name: string, value: number, labels: Record<string, string> = {}): void {
    this.record({
      name,
      type: 'histogram',
      value,
      timestamp: new Date().toISOString(),
      labels
    });
  }

  query(filter: MetricFilter = {}): Metric[] {
    const results: StoredMetric[] = [];
    for (const samples of this.metrics.values()) {
      for (const metric of samples) {
        if (this.matchesFilter(metric, filter)) {
          results.push(metric);
        }
      }
    }
    return results
      .sort((left, right) => right.sequence - left.sequence)
      .map(({ sequence: _sequence, ...metric }) => metric);
  }

  getSnapshot(filter: MetricFilter = {}): MetricsSnapshot {
    const metrics = this.query(filter);
    return {
      generatedAt: new Date().toISOString(),
      metrics,
      summary: {
        totalMetrics: metrics.length,
        counterCount: metrics.filter((metric) => metric.type === 'counter').length,
        gaugeCount: metrics.filter((metric) => metric.type === 'gauge').length,
        histogramCount: metrics.filter((metric) => metric.type === 'histogram').length
      }
    };
  }

  getHistogramStats(name: string, labels: Record<string, string> = {}): HistogramStats | null {
    const samples = this.metrics.get(this.buildKey(name, labels));
    if (samples === undefined || samples.length === 0) {
      return null;
    }

    const values = samples.map((sample) => sample.value).sort((left, right) => left - right);
    const sum = values.reduce((total, value) => total + value, 0);
    return {
      count: values.length,
      sum,
      avg: sum / values.length,
      min: values[0]!,
      max: values[values.length - 1]!,
      p50: this.percentile(values, 50),
      p95: this.percentile(values, 95),
      p99: this.percentile(values, 99)
    };
  }

  private record(metric: Metric): void {
    const key = this.buildKey(metric.name, metric.labels);
    const samples = this.metrics.get(key) ?? [];
    samples.push({
      ...metric,
      sequence: this.sequence
    });
    this.sequence += 1;
    if (samples.length > this.maxSamplesPerMetric) {
      samples.shift();
    }
    this.metrics.set(key, samples);
  }

  private buildKey(name: string, labels: Record<string, string>): string {
    const labelText = Object.entries(labels)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join(',');
    return `${name}{${labelText}}`;
  }

  private getLatest(key: string): StoredMetric | null {
    const samples = this.metrics.get(key);
    return samples?.at(-1) ?? null;
  }

  private matchesFilter(metric: Metric, filter: MetricFilter): boolean {
    if (filter.name !== undefined && metric.name !== filter.name) {
      return false;
    }
    if (filter.type !== undefined && metric.type !== filter.type) {
      return false;
    }
    if (filter.since !== undefined && metric.timestamp < filter.since) {
      return false;
    }
    if (filter.labels !== undefined) {
      for (const [key, value] of Object.entries(filter.labels)) {
        if (metric.labels[key] !== value) {
          return false;
        }
      }
    }
    return true;
  }

  private percentile(sortedValues: readonly number[], percentile: number): number {
    const index = Math.ceil((sortedValues.length * percentile) / 100) - 1;
    return sortedValues[Math.max(0, index)]!;
  }
}
