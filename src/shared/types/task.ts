import type { z } from 'zod';

import {
  activeTaskItemSchema,
  backgroundTaskPreviewRequestSchema,
  backgroundTaskPreviewSchema,
  backgroundTaskRiskSchema,
  backgroundTaskSchema,
  backgroundTaskSummarySchema,
  backgroundTaskTriggerSchema,
  scheduledTaskRunSchema,
  schedulerStatusSchema,
  taskDeleteThreadRequestSchema,
  taskDeleteThreadResultSchema,
  taskDetailSchema,
  taskMessageHistoryPageSchema,
  taskMessageHistoryRequestSchema,
  taskRunSchema,
  taskSnapshotSchema,
  taskStatusSchema,
  taskThreadSchema,
  taskUpdateEventSchema,
  traySummarySchema,
  updateBackgroundTaskRequestSchema
} from '../schemas/ipc-core';
import {
  guardrailTaskEventPayloadSchema,
  persistedTaskEventSchema,
  taskEventSchema
} from '../schemas/task-event';

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskKind = z.infer<typeof taskThreadSchema>['kind'];
export type TaskThread = z.infer<typeof taskThreadSchema>;
export type TaskEvent = z.infer<typeof taskEventSchema>;
export type PersistedTaskEvent = z.infer<typeof persistedTaskEventSchema>;
export type GuardrailNudgePayload = z.infer<typeof guardrailTaskEventPayloadSchema>;
export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>;
export type TaskMessageHistoryRequest = z.infer<typeof taskMessageHistoryRequestSchema>;
export type TaskMessageHistoryPage = z.infer<typeof taskMessageHistoryPageSchema>;
export type TaskRun = z.infer<typeof taskRunSchema>;

export type AgentOutboxEvent =
  | {
      id: string;
      sequence: number;
      eventType: 'run_completed';
      runId: string;
      threadId: string;
      payload: {
        assistantMessage: string;
        durationMs: number;
        finishReason: 'stop';
        modelId: string;
        providerId: string;
        summary: string;
      };
      createdAt: string;
    }
  | {
      id: string;
      sequence: number;
      eventType: 'run_failed';
      runId: string;
      threadId: string;
      payload: {
        code: string;
        diagnostic?: {
          badKeys?: string[];
          schemaPath?: string;
          toolName?: string;
        };
        error: string;
        modelId: string;
        providerId: string;
        retryable: boolean;
        suggestion?: string;
      };
      createdAt: string;
    }
  | {
      id: string;
      sequence: number;
      eventType: 'run_cancelled';
      runId: string;
      threadId: string;
      payload: { reason: 'user_cancelled' };
      createdAt: string;
    }
  | {
      id: string;
      sequence: number;
      eventType: 'run_deleted';
      runId: string;
      threadId: string;
      payload: Record<string, never>;
      createdAt: string;
    };

export type TaskDeleteThreadRequest = z.infer<typeof taskDeleteThreadRequestSchema>;
export type TaskDeleteThreadResult = z.infer<typeof taskDeleteThreadResultSchema>;
export type BackgroundTaskTrigger = z.infer<typeof backgroundTaskTriggerSchema>;
export type BackgroundTaskRisk = z.infer<typeof backgroundTaskRiskSchema>;
export type BackgroundTaskPreviewRequest = z.infer<typeof backgroundTaskPreviewRequestSchema>;
export type BackgroundTaskPreview = z.infer<typeof backgroundTaskPreviewSchema>;
export type BackgroundTask = z.infer<typeof backgroundTaskSchema>;
export type ActiveTaskItem = z.infer<typeof activeTaskItemSchema>;
export type ScheduledTaskRun = z.infer<typeof scheduledTaskRunSchema>;
export type TaskDetail = z.infer<typeof taskDetailSchema>;
export type UpdateBackgroundTaskRequest = z.infer<typeof updateBackgroundTaskRequestSchema>;
export type TaskUpdateEvent = z.infer<typeof taskUpdateEventSchema>;
export type SchedulerStatus = z.infer<typeof schedulerStatusSchema>;
export type BackgroundTaskSummary = z.infer<typeof backgroundTaskSummarySchema>;
export type TraySummary = z.infer<typeof traySummarySchema>;
