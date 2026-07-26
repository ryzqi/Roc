import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetricsService } from '../../src/main/services/metrics-service';

describe('MetricsService', () => {
  let metricsService: MetricsService;

  beforeEach(() => {
    metricsService = new MetricsService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('increments counters by metric name and labels', () => {
    metricsService.incrementCounter('agent.run.started', { mode: 'task', providerId: 'nvidia' });
    metricsService.incrementCounter('agent.run.started', { providerId: 'nvidia', mode: 'task' });
    metricsService.incrementCounter('agent.run.started', { mode: 'chat', providerId: 'nvidia' });

    const taskMetrics = metricsService.query({
      name: 'agent.run.started',
      labels: { mode: 'task', providerId: 'nvidia' }
    });

    expect(taskMetrics).toHaveLength(2);
    expect(taskMetrics[0]).toMatchObject({
      name: 'agent.run.started',
      type: 'counter',
      value: 2,
      labels: expect.objectContaining({ mode: 'task', providerId: 'nvidia' })
    });
  });

  it('records gauges and returns latest samples first', () => {
    metricsService.setGauge('scheduler.registered_tasks', 3);
    metricsService.setGauge('scheduler.registered_tasks', 7);

    const metrics = metricsService.query({ name: 'scheduler.registered_tasks', type: 'gauge' });

    expect(metrics).toHaveLength(2);
    expect(metrics[0]).toMatchObject({
      type: 'gauge',
      value: 7
    });
    expect(metrics[1]).toMatchObject({
      type: 'gauge',
      value: 3
    });
  });

  it('records histograms and calculates percentile stats', () => {
    for (let value = 1; value <= 100; value += 1) {
      metricsService.recordHistogram('provider.request.duration_ms', value, { providerId: 'nvidia' });
    }

    const stats = metricsService.getHistogramStats('provider.request.duration_ms', { providerId: 'nvidia' });

    expect(stats).toEqual({
      count: 100,
      sum: 5050,
      avg: 50.5,
      min: 1,
      max: 100,
      p50: 50,
      p95: 95,
      p99: 99
    });
  });

  it('filters by type, labels, and timestamp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    metricsService.incrementCounter('agent.run.started', { mode: 'task' });
    const since = '2026-01-01T00:00:01.000Z';
    vi.setSystemTime(new Date(since));
    metricsService.setGauge('scheduler.registered_tasks', 4, { state: 'active' });
    metricsService.recordHistogram('agent.run.duration_ms', 42, { mode: 'task' });

    expect(metricsService.query({ type: 'counter' })).toHaveLength(1);
    expect(metricsService.query({ labels: { mode: 'task' } })).toHaveLength(2);
    expect(metricsService.query({ since }).map((metric) => metric.name)).toEqual([
      'agent.run.duration_ms',
      'scheduler.registered_tasks'
    ]);
    expect(metricsService.query({ since: '2026-01-01T00:00:02.000Z' })).toHaveLength(0);
  });

  it('caps samples per metric to bound memory use', () => {
    for (let value = 1; value <= 1005; value += 1) {
      metricsService.recordHistogram('agent.run.duration_ms', value);
    }

    const stats = metricsService.getHistogramStats('agent.run.duration_ms');

    expect(stats).toMatchObject({
      count: 1000,
      min: 6,
      max: 1005
    });
  });

  it.each(['runId', 'threadId', 'occurrenceId', 'dispatchKey']) (
    'rejects high-cardinality %s labels',
    (label) => {
      expect(() => metricsService.incrementCounter('agent.run.started', { [label]: 'unique-value' })).toThrow(
        `metrics_high_cardinality_label_forbidden:${label}`
      );
    }
  );

  it('builds snapshots with summary counts', () => {
    metricsService.incrementCounter('agent.run.started');
    metricsService.setGauge('scheduler.registered_tasks', 4);
    metricsService.recordHistogram('agent.run.duration_ms', 42);

    const snapshot = metricsService.getSnapshot();

    expect(snapshot.generatedAt).toEqual(expect.any(String));
    expect(snapshot.summary).toEqual({
      totalMetrics: 3,
      counterCount: 1,
      gaugeCount: 1,
      histogramCount: 1
    });
  });

  it('records prompt cache hit ratio from provider usage without estimated savings', () => {
    metricsService.recordPromptCacheMetrics({
      input_tokens: 600,
      cache_creation_tokens: 300,
      cache_read_tokens: 900
    });

    expect(metricsService.query({ name: 'prompt_cache_read_tokens' })[0]?.value).toBe(900);
    expect(metricsService.query({ name: 'prompt_cache_creation_tokens' })[0]?.value).toBe(300);
    expect(metricsService.query({ name: 'prompt_cache_hit_ratio' })[0]?.value).toBe(0.5);
    expect(metricsService.query({ name: 'prompt_cache_tokens_saved' })).toHaveLength(0);
  });

  it('queries one thousand samples within five milliseconds', () => {
    for (let value = 1; value <= 1000; value += 1) {
      metricsService.recordHistogram('provider.request.duration_ms', value, { providerId: 'nvidia' });
    }

    const startedAt = performance.now();
    const metrics = metricsService.query({ name: 'provider.request.duration_ms', labels: { providerId: 'nvidia' } });
    const durationMs = performance.now() - startedAt;

    expect(metrics).toHaveLength(1000);
    expect(durationMs).toBeLessThan(5);
  });
});
