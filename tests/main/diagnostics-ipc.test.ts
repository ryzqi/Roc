import { describe, expect, it, vi } from 'vitest';
import { registerDiagnosticsIpc } from '../../src/main/ipc/diagnostics-ipc';
import type { IpcMainHandler } from '../../src/main/ipc/ipc-common';
import { MetricsService } from '../../src/main/services/metrics-service';
import { ipcChannels } from '../../src/shared/ipc';

describe('diagnostics IPC', () => {
  it('returns metrics snapshots through diagnostics IPC', async () => {
    const handlers = new Map<string, IpcMainHandler>();
    const metricsService = new MetricsService();
    metricsService.incrementCounter('agent.run.started', { mode: 'task' });

    registerDiagnosticsIpc(
      (channel, handler) => handlers.set(channel, handler),
      {
        samplePerformance: vi.fn(),
        createDiagnosticPackage: vi.fn(),
        runChecks: vi.fn()
      } as never,
      {
        getStatus: vi.fn()
      } as never,
      {
        check: vi.fn()
      } as never,
      metricsService
    );

    const result = await handlers.get(ipcChannels.diagnosticsGetMetricsSnapshot)?.(null, {
      name: 'agent.run.started'
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        summary: {
          totalMetrics: 1,
          counterCount: 1,
          gaugeCount: 0,
          histogramCount: 0
        },
        metrics: [
          expect.objectContaining({
            name: 'agent.run.started',
            labels: { mode: 'task' }
          })
        ]
      }
    });
  });

  it('returns health checks through diagnostics IPC', async () => {
    const handlers = new Map<string, IpcMainHandler>();
    const healthCheck = {
      status: 'healthy',
      checks: [
        {
          name: 'database',
          status: 'pass',
          lastChecked: '2026-06-04T00:00:00.000Z'
        }
      ]
    };

    registerDiagnosticsIpc(
      (channel, handler) => handlers.set(channel, handler),
      {
        samplePerformance: vi.fn(),
        createDiagnosticPackage: vi.fn(),
        runChecks: vi.fn()
      } as never,
      {
        getStatus: vi.fn()
      } as never,
      {
        check: vi.fn().mockResolvedValue(healthCheck)
      } as never,
      new MetricsService()
    );

    const result = await handlers.get(ipcChannels.diagnosticsRunHealthCheck)?.(null);

    expect(result).toEqual({
      ok: true,
      data: healthCheck
    });
  });
});
