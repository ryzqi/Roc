import { enabledCapabilitiesSchema } from '../../../shared/schemas/agent';
import type { TaskRun } from '../../../shared/types';
import { parseStoredJson } from '../../infrastructure/stored-json';

/**
 * Row shape and mapper for the `agent_runs` table.
 *
 * Both `AgentTaskHistoryContract` and `SessionRepository` read the same table, so the mapping from
 * `snake_case` columns to the `TaskRun` domain object lives here once instead of being copied into
 * each repository.
 */
export type TaskRunRow = {
  id: string;
  thread_id: string;
  run_number: number;
  user_input: string;
  status: TaskRun['status'];
  started_at: string;
  ended_at: string | null;
  model_id: string | null;
  enabled_capabilities_json: string;
};

export function mapTaskRun(row: TaskRunRow): TaskRun {
  return {
    id: row.id,
    threadId: row.thread_id,
    runNumber: row.run_number,
    userInput: row.user_input,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    modelId: row.model_id,
    enabledCapabilities: parseStoredJson(
      row.enabled_capabilities_json,
      enabledCapabilitiesSchema,
      'agent_run_capabilities_corrupt'
    )
  };
}
