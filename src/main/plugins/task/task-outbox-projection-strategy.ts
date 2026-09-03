import type { AgentOutboxEvent, BackgroundTask } from '../../../shared/types';

/**
 * 任务状态转换动作
 */
export type TaskStateTransition =
  | { type: 'update_status'; taskId: string; status: 'success' | 'cancelled'; timestamp: string }
  | { type: 'pause_after_failure'; taskId: string; timestamp: string }
  | { type: 'no_op' };

/**
 * 任务 Outbox 投影策略
 *
 * 封装 "事件 → 状态转换" 规则,隔离投影逻辑与持久化逻辑
 */
export interface TaskOutboxProjectionStrategy {
  /**
   * 根据事件计算状态转换动作
   *
   * @param task - 当前任务状态
   * @param event - 收到的 outbox 事件
   * @returns 状态转换动作 (可能是 no_op)
   */
  applyEvent(task: BackgroundTask | null, event: AgentOutboxEvent): TaskStateTransition;
}

/**
 * 默认投影策略
 *
 * 规则:
 * - run_completed + isLatestRun → 更新状态为 success
 * - run_failed + isLatestRun → 暂停任务
 * - run_cancelled + isLatestRun → 更新状态为 cancelled
 * - 其他情况 → no_op
 */
export class DefaultTaskOutboxProjectionStrategy implements TaskOutboxProjectionStrategy {
  applyEvent(task: BackgroundTask | null, event: AgentOutboxEvent): TaskStateTransition {
    if (task === null) {
      return { type: 'no_op' };
    }

    const isLatestRun = task.runId === event.runId;
    if (!isLatestRun) {
      return { type: 'no_op' };
    }

    switch (event.eventType) {
      case 'run_completed':
        return {
          type: 'update_status',
          taskId: task.id,
          status: 'success',
          timestamp: event.createdAt
        };

      case 'run_failed':
        return {
          type: 'pause_after_failure',
          taskId: task.id,
          timestamp: event.createdAt
        };

      case 'run_cancelled':
        return {
          type: 'update_status',
          taskId: task.id,
          status: 'cancelled',
          timestamp: event.createdAt
        };

      case 'run_deleted':
        return { type: 'no_op' };

      default: {
        const exhaustive: never = event;
        throw new Error(`未处理的事件类型: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
}
