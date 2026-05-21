import type { BackgroundTask } from '../../../shared/types';

export type BackgroundTaskRow = {
  id: string;
  thread_id: string;
  run_id: string;
  goal: string;
  status: BackgroundTask['status'];
  scheduled: number;
  trigger_type: BackgroundTask['triggerType'];
  trigger_description: string;
  next_run_at: string | null;
  cron_expression: string | null;
  workspace_path: string;
  allowed_actions_json: string;
  forbidden_actions_json: string;
  failure_policy: BackgroundTask['failurePolicy'];
  notification_policy: BackgroundTask['notificationPolicy'];
  risk_level: BackgroundTask['riskLevel'];
  requires_confirmation: number;
  last_run_at: string | null;
  last_run_status: BackgroundTask['lastRunStatus'];
  run_count: number;
  created_at: string;
  updated_at: string;
};
