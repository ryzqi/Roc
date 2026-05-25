import type { BackgroundTask, EnabledCapabilities } from '../../../shared/types';
import type { DatabaseService } from '../database-service';
import { RocDomainError } from '../errors';
import { requireText } from './validation';
import type { BackgroundTaskRow } from './types';

export function backgroundTaskFromRow(row: BackgroundTaskRow): BackgroundTask {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    goal: row.goal,
    status: row.status,
    scheduled: row.scheduled === 1,
    triggerType: row.trigger_type,
    triggerDescription: row.trigger_description,
    nextRunAt: row.next_run_at,
    cronExpression: row.cron_expression,
    workspacePath: row.workspace_path,
    allowedActions: JSON.parse(row.allowed_actions_json) as string[],
    forbiddenActions: JSON.parse(row.forbidden_actions_json) as string[],
    failurePolicy: row.failure_policy,
    notificationPolicy: row.notification_policy,
    riskLevel: row.risk_level,
    requiresConfirmation: row.requires_confirmation === 1,
    lastRunAt: row.last_run_at,
    lastRunStatus: row.last_run_status,
    runCount: row.run_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    enabledCapabilities: parseEnabledCapabilities(row.enabled_capabilities_json)
  };
}

export function requireBackgroundTask(database: DatabaseService, id: string): BackgroundTask {
  const taskId = requireText(id, 'background_task_id_empty', '后台任务 ID 不能为空。', '请选择一个后台任务。');
  const row = database.db
    .prepare(
      `SELECT id, thread_id, run_id, goal, status, scheduled, trigger_type, trigger_description, next_run_at,
              cron_expression, workspace_path,
              allowed_actions_json, forbidden_actions_json, failure_policy, notification_policy, risk_level,
              requires_confirmation, last_run_at, last_run_status, run_count, created_at, updated_at,
              enabled_capabilities_json
       FROM background_tasks
       WHERE id = ?`
    )
    .get(taskId) as BackgroundTaskRow | undefined;

  if (row === undefined) {
    throw new RocDomainError({
      code: 'background_task_not_found',
      message: '后台任务不存在。',
      category: 'not_found',
      retryable: false,
      userAction: '请刷新任务工作台后重试。'
    });
  }

  return backgroundTaskFromRow(row);
}

function parseEnabledCapabilities(raw: string | null): EnabledCapabilities | null {
  if (raw === null || raw.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const value = parsed as { mcpServers?: unknown; skills?: unknown };
    if (!Array.isArray(value.mcpServers) || !Array.isArray(value.skills)) {
      return null;
    }
    return {
      mcpServers: value.mcpServers.filter((item): item is string => typeof item === 'string'),
      skills: value.skills.filter((item): item is string => typeof item === 'string')
    };
  } catch {
    return null;
  }
}
