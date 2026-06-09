import type { BackgroundTask } from '../../../shared/types';
import { computeNextCronRunAt } from './cron-parser';

export function computeNextRunAt(task: BackgroundTask, now: Date = new Date()): string | null {
  if (!task.scheduled || task.triggerType === 'manual') {
    return null;
  }

  if (task.triggerType === 'once') {
    return task.nextRunAt;
  }

  if (task.cronExpression === null) {
    throw new Error(`Cron background task ${task.id} is missing cron_expression.`);
  }
  return computeNextCronRunAt(task.cronExpression, now);
}
