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
  let pendingMutation: Promise<TraySummary> | null = null;

  function getTraySummary(): TraySummary | Promise<TraySummary> {
    const backgroundTasks = options.getBackgroundTaskSummary();
    if (backgroundTasks instanceof Promise) {
      return backgroundTasks.then((summary) => createTraySummary(summary, backgroundPaused));
    }
    return createTraySummary(backgroundTasks, backgroundPaused);
  }

  function mutate(paused: boolean): TraySummary | Promise<TraySummary> {
    const run = (): TraySummary | Promise<TraySummary> => {
      const settled = (): TraySummary | Promise<TraySummary> => {
        backgroundPaused = paused;
        return getTraySummary();
      };
      const result = paused ? options.scheduler.suspendAll() : options.scheduler.resumeAll();
      return result instanceof Promise ? result.then(settled) : settled();
    };
    // Tray and settings share this scheduler. Opposing requests must settle in order.
    const result = pendingMutation === null ? run() : pendingMutation.catch(() => undefined).then(run);
    if (!(result instanceof Promise)) return result;
    const tracked = result.then(
      summary => {if (pendingMutation === tracked) pendingMutation = null; return summary;},
      (error: unknown) => {if (pendingMutation === tracked) pendingMutation = null; throw error;}
    );
    pendingMutation = tracked;
    return tracked;
  }

  return {
    getTraySummary,
    pauseBackgroundExecution() {
      return mutate(true);
    },
    resumeBackgroundExecution() {
      return mutate(false);
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
