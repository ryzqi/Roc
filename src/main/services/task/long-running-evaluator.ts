import type { TaskRun, TaskStatus } from '../../../shared/types';

export type LongRunningThresholds = {
  runningSeconds: number;
  toolCallCount: number;
  subagentCount: number;
};

export type LongRunningPromotionReason =
  | 'running_over_90s'
  | 'tool_calls_exceeded'
  | 'subagent_spawned'
  | 'approval_waiting'
  | 'manual';

export type LongRunningPromotionPayload = {
  reason: LongRunningPromotionReason;
  threshold: number | null;
  observedValue: number | null;
};

const terminalStatuses: ReadonlySet<TaskStatus> = new Set(['completed', 'failed', 'cancelled', 'archived']);

export function evaluateLongRunningCandidate(input: {
  run: TaskRun;
  thresholds: LongRunningThresholds;
  toolCallCount: number;
  subagentCount: number;
  nowMs?: number;
}): LongRunningPromotionPayload | null {
  if (terminalStatuses.has(input.run.status)) {
    return null;
  }

  if (input.run.status === 'waiting_user') {
    return {
      reason: 'approval_waiting',
      threshold: null,
      observedValue: null
    };
  }

  if (input.subagentCount >= input.thresholds.subagentCount) {
    return {
      reason: 'subagent_spawned',
      threshold: input.thresholds.subagentCount,
      observedValue: input.subagentCount
    };
  }

  if (input.toolCallCount > input.thresholds.toolCallCount) {
    return {
      reason: 'tool_calls_exceeded',
      threshold: input.thresholds.toolCallCount,
      observedValue: input.toolCallCount
    };
  }

  if (input.run.status === 'running') {
    const runningSeconds = Math.floor(((input.nowMs ?? Date.now()) - new Date(input.run.startedAt).getTime()) / 1000);
    if (runningSeconds > input.thresholds.runningSeconds) {
      return {
        reason: 'running_over_90s',
        threshold: input.thresholds.runningSeconds,
        observedValue: runningSeconds
      };
    }
  }

  return null;
}
