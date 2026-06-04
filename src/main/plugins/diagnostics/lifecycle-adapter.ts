import type { BackgroundTaskSummary, TraySummary } from '../../../shared/types';

export type DiagnosticsLifecycleScheduler = {
  suspendAll(): void;
  resumeAll(): void;
};

export type DiagnosticsLifecycleAdapterOptions = {
  getBackgroundTaskSummary: () => BackgroundTaskSummary;
  scheduler: DiagnosticsLifecycleScheduler;
};

export type DiagnosticsLifecycleAdapter = {
  getTraySummary(): TraySummary;
  pauseBackgroundExecution(): TraySummary;
  resumeBackgroundExecution(): TraySummary;
};

export function createDiagnosticsLifecycleAdapter(
  options: DiagnosticsLifecycleAdapterOptions
): DiagnosticsLifecycleAdapter {
  let backgroundPaused = false;

  function getTraySummary(): TraySummary {
    const backgroundTasks = options.getBackgroundTaskSummary();
    return {
      residentEnabled: true,
      backgroundPaused,
      backgroundTasks,
      nextRunAt: backgroundTasks.nextRunAt,
      updatedAt: new Date().toISOString()
    };
  }

  return {
    getTraySummary,
    pauseBackgroundExecution() {
      backgroundPaused = true;
      options.scheduler.suspendAll();
      return getTraySummary();
    },
    resumeBackgroundExecution() {
      backgroundPaused = false;
      options.scheduler.resumeAll();
      return getTraySummary();
    }
  };
}
