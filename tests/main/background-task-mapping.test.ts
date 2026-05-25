import { describe, expect, it } from 'vitest';
import { backgroundTaskFromRow } from '../../src/main/services/task/background-task-mapping';
import type { BackgroundTaskRow } from '../../src/main/services/task/types';

const baseRow: BackgroundTaskRow = {
  id: 'background_1',
  thread_id: 'thread_1',
  run_id: 'run_1',
  goal: '',
  status: 'running',
  scheduled: 1,
  trigger_type: 'manual',
  trigger_description: '',
  next_run_at: null,
  cron_expression: null,
  workspace_path: '',
  allowed_actions_json: '[]',
  forbidden_actions_json: '[]',
  failure_policy: 'pause_and_report',
  notification_policy: 'failures_and_confirmations',
  risk_level: 'low',
  requires_confirmation: 0,
  last_run_at: null,
  last_run_status: null,
  run_count: 0,
  created_at: '',
  updated_at: '',
  enabled_capabilities_json: null
};

describe('background-task-mapping.enabledCapabilities', () => {
  it('NULL -> null', () => {
    expect(backgroundTaskFromRow({ ...baseRow, enabled_capabilities_json: null }).enabledCapabilities).toBeNull();
  });

  it('合法 JSON -> 对象', () => {
    const row = { ...baseRow, enabled_capabilities_json: '{"mcpServers":["github"],"skills":[]}' };
    expect(backgroundTaskFromRow(row).enabledCapabilities).toEqual({ mcpServers: ['github'], skills: [] });
  });

  it('非法 JSON -> null（不抛）', () => {
    const row = { ...baseRow, enabled_capabilities_json: '{not json}' };
    expect(backgroundTaskFromRow(row).enabledCapabilities).toBeNull();
  });
});
