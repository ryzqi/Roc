import type { BackgroundTaskSummary, TraySummary } from '../../../shared/types';

export type DiagnosticsLifecycleScheduler = {
  suspendAll(): void | Promise<void>;
  resumeAll(): void | Promise<void>;
};

export type DiagnosticsLifecycleAdapterOptions = {
  getBackgroundTaskSummary: () => BackgroundTaskSummary | Promise<BackgroundTaskSummary>;
  scheduler: DiagnosticsLifecycleScheduler;
};

export type DiagnosticsLifecycleAdapter = {
  getTraySummary(): TraySummary | Promise<TraySummary>;
  pauseBackgroundExecution(): TraySummary | Promise<TraySummary>;
  resumeBackgroundExecution(): TraySummary | Promise<TraySummary>;
};

export function createDiagnosticsLifecycleAdapter(
  options: DiagnosticsLifecycleAdapterOptions
): DiagnosticsLifecycleAdapter {
  let backgroundPaused = false;

  function getTraySummary(): TraySummary | Promise<TraySummary> {
    const backgroundTasks = options.getBackgroundTaskSummary();
    if (backgroundTasks instanceof Promise) {
      return backgroundTasks.then((summary) => createTraySummary(summary, backgroundPaused));
    }
    return createTraySummary(backgroundTasks, backgroundPaused);
  }

  return {
    getTraySummary,
    pauseBackgroundExecution() {
      backgroundPaused = true;
      const result = options.scheduler.suspendAll();
      if (result instanceof Promise) {
        return result.then(() => getTraySummary());
      }
      return getTraySummary();
    },
    resumeBackgroundExecution() {
      backgroundPaused = false;
      const result = options.scheduler.resumeAll();
      if (result instanceof Promise) {
        return result.then(() => getTraySummary());
      }
      return getTraySummary();
    }
  };
}

function createTraySummary(backgroundTasks: BackgroundTaskSummary, backgroundPaused: boolean): TraySummary {
  return {
    residentEnabled: true,
    backgroundPaused,
    backgroundTasks,
    nextRunAt: backgroundTasks.nextRunAt,
    updatedAt: new Date().toISOString()
  };
}
