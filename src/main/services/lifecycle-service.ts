import type { TraySummary } from '../../shared/types';
import type { TaskService } from './task-service';
import type { TaskSchedulerService } from './task-scheduler-service';

export class LifecycleService {
  private backgroundPaused = false;
  private schedulerService: TaskSchedulerService | null = null;

  constructor(private readonly taskService: TaskService) {}

  attachScheduler(schedulerService: TaskSchedulerService): void {
    this.schedulerService = schedulerService;
  }

  getTraySummary(): TraySummary {
    const backgroundTasks = this.taskService.getBackgroundTaskSummary();
    return {
      residentEnabled: true,
      backgroundPaused: this.backgroundPaused,
      backgroundTasks,
      nextRunAt: backgroundTasks.nextRunAt,
      updatedAt: new Date().toISOString()
    };
  }

  pauseBackgroundExecution(): TraySummary {
    this.backgroundPaused = true;
    this.schedulerService?.suspendAll();
    return this.getTraySummary();
  }

  resumeBackgroundExecution(): TraySummary {
    this.backgroundPaused = false;
    this.schedulerService?.resumeAll();
    return this.getTraySummary();
  }
}
