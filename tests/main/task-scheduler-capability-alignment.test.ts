import { describe, expect, it, vi } from 'vitest';
import type { BackgroundTask, EnabledCapabilities } from '../../src/shared/types';
import { TaskSchedulerService } from '../../src/main/services/task-scheduler-service';

function makeBackgroundTask(): BackgroundTask {
  return {
    id: 'background_1',
    threadId: 'thread_1',
    runId: 'run_seed',
    goal: '',
    status: 'running',
    scheduled: true,
    triggerType: 'once',
    triggerDescription: '一次性',
    nextRunAt: new Date(Date.now() - 1000).toISOString(),
    cronExpression: null,
    workspacePath: process.cwd(),
    allowedActions: [],
    forbiddenActions: [],
    failurePolicy: 'pause_and_report',
    notificationPolicy: 'failures_and_confirmations',
    riskLevel: 'low',
    requiresConfirmation: false,
    lastRunAt: null,
    lastRunStatus: null,
    runCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    enabledCapabilities: null
  };
}

function makeFakeTaskService(task: BackgroundTask) {
  return {
    listSchedulableBackgroundTasks: () => [task],
    countRecentSkippedScheduledRuns: () => 0,
    recordScheduledTaskRun: vi.fn().mockReturnValue({ id: 'sched_1' }),
    pauseBackgroundTaskForScheduler: vi.fn(),
    markBackgroundTaskFired: vi.fn().mockReturnValue({ ...task, status: 'paused' as const }),
    updateBackgroundTaskNextRunAt: vi.fn()
  } as unknown as ConstructorParameters<typeof TaskSchedulerService>[0];
}

describe('task-scheduler-service 能力对齐', () => {
  it('fire 时调用 resolver 取得全局当前启用集合并传给 runtime', async () => {
    const task = makeBackgroundTask();
    const runtime = { startRun: vi.fn().mockResolvedValue({ runId: 'run_1' }) };
    const snapshot: EnabledCapabilities = { mcpServers: ['github', 'exa-hosted'], skills: ['design'] };
    const resolver = { resolveCurrentEnabledCapabilities: vi.fn().mockReturnValue(snapshot) };
    const scheduler = new TaskSchedulerService(
      makeFakeTaskService(task),
      runtime,
      { capabilityResolver: resolver }
    );
    scheduler.start();

    await scheduler.fire(task.id);

    expect(resolver.resolveCurrentEnabledCapabilities).toHaveBeenCalledTimes(1);
    expect(runtime.startRun).toHaveBeenCalledWith(
      expect.objectContaining({ enabledCapabilities: snapshot })
    );
  });

  it('任务自带 enabledCapabilities 时优先使用任务字段，不调用 resolver', async () => {
    const task: BackgroundTask = {
      ...makeBackgroundTask(),
      enabledCapabilities: { mcpServers: ['github'], skills: [] }
    };
    const runtime = { startRun: vi.fn().mockResolvedValue({ runId: 'run_1' }) };
    const resolver = { resolveCurrentEnabledCapabilities: vi.fn() };
    const scheduler = new TaskSchedulerService(
      makeFakeTaskService(task),
      runtime,
      { capabilityResolver: resolver }
    );
    scheduler.start();

    await scheduler.fire(task.id);

    expect(resolver.resolveCurrentEnabledCapabilities).not.toHaveBeenCalled();
    expect(runtime.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        enabledCapabilities: { mcpServers: ['github'], skills: [] }
      })
    );
  });
});
