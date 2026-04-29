import type { TraySummary } from '../../shared/types';
import type { TaskService } from './task-service';

export class LifecycleService {
  private backgroundPaused = false;

  constructor(private readonly taskService: TaskService) {}

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
    return this.getTraySummary();
  }

  resumeBackgroundExecution(): TraySummary {
    this.backgroundPaused = false;
    return this.getTraySummary();
  }
}
