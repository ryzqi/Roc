import type { StructuredFailure } from './structured-failure';

export type RetryEvent = {
  attempt: number;
  delayMs: number;
  layer: 'provider' | 'checkpoint' | 'tool' | 'network';
  operation: string;
  errorCode: string;
  category: string;
  useCheckpointResume: boolean;
  timestamp: number;
};

export class RetryTelemetry {
  private events: RetryEvent[] = [];
  private readonly runId: string;

  constructor(runId: string) {
    this.runId = runId;
  }

  record(event: {
    attempt: number;
    delayMs: number;
    failure: StructuredFailure;
    operation: string;
    useCheckpointResume: boolean;
  }): void {
    const retryEvent: RetryEvent = {
      attempt: event.attempt,
      delayMs: event.delayMs,
      layer: this.inferLayer(event.failure),
      operation: event.operation,
      errorCode: event.failure.code,
      category: event.failure.category,
      useCheckpointResume: event.useCheckpointResume,
      timestamp: Date.now()
    };

    this.events.push(retryEvent);

    // 发送到 diagnostics 插件
    if (typeof globalThis !== 'undefined' && (globalThis as any).electron?.ipc) {
      void (globalThis as any).electron.ipc
        .invoke('diagnostics:recordMetric', {
          name: 'agent.retry',
          value: 1,
          tags: {
            run_id: this.runId,
            attempt: event.attempt.toString(),
            layer: retryEvent.layer,
            operation: event.operation,
            error_code: retryEvent.errorCode,
            category: retryEvent.category,
            checkpoint_resume: event.useCheckpointResume.toString()
          }
        })
        .catch(() => {
          // 遥测失败不影响主流程
        });
    }
  }

  private inferLayer(failure: StructuredFailure): RetryEvent['layer'] {
    if (failure.telemetryTags.subsystem === 'checkpoint') return 'checkpoint';
    if (failure.telemetryTags.subsystem === 'network') return 'network';
    if (failure.telemetryTags.layer === 'tool') return 'tool';
    return 'provider';
  }

  summarize(): {
    totalRetries: number;
    byLayer: Record<string, number>;
    byErrorCode: Record<string, number>;
    avgDelayMs: number;
    checkpointResumes: number;
  } {
    if (this.events.length === 0) {
      return {
        totalRetries: 0,
        byLayer: {},
        byErrorCode: {},
        avgDelayMs: 0,
        checkpointResumes: 0
      };
    }

    const byLayer: Record<string, number> = {};
    const byErrorCode: Record<string, number> = {};
    let totalDelay = 0;
    let checkpointResumes = 0;

    for (const event of this.events) {
      byLayer[event.layer] = (byLayer[event.layer] ?? 0) + 1;
      byErrorCode[event.errorCode] = (byErrorCode[event.errorCode] ?? 0) + 1;
      totalDelay += event.delayMs;
      if (event.useCheckpointResume) checkpointResumes++;
    }

    return {
      totalRetries: this.events.length,
      byLayer,
      byErrorCode,
      avgDelayMs: totalDelay / this.events.length,
      checkpointResumes
    };
  }

  getEvents(): ReadonlyArray<Readonly<RetryEvent>> {
    return this.events;
  }
}
