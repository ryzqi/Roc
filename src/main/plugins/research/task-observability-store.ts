import type {Database} from 'better-sqlite3';
import {AgentRunTelemetryRepository} from '../agent/run-telemetry';
import {AgentRunEventLog} from '../agent/run-event-log';
import {taskCallDiagnosticsSchema, taskCallsPageSchema, taskReplayDiagnosticsSchema, taskTelemetrySchema,
  type TaskExecutionDiagnosticsRequest} from '../../../shared/schemas/research-task-observability';
import type {ChatRunEvent} from '../../../shared/types';

/** Only measured fields leave this boundary; envelopes and replay snapshot state stay private. */
export class ResearchTaskObservabilityStore {
  readonly telemetry: AgentRunTelemetryRepository;
  readonly events: AgentRunEventLog;
  constructor(private readonly db: Database) {
    this.telemetry = new AgentRunTelemetryRepository(db);
    this.events = new AgentRunEventLog(db);
  }
  calls(request: TaskExecutionDiagnosticsRequest) {
    const rows = this.db.prepare(`SELECT c.task_id taskId,c.rowid sequence,c.run_id runId,c.call_id callId,c.kind,c.state,
      c.reserved_tokens reservedTokens,c.actual_tokens actualTokens,c.reserved_cost_microusd reservedCostMicrousd,
      c.actual_cost_microusd actualCostMicrousd,c.pricing_version pricingVersion,c.created_at createdAt,
      (SELECT MAX(e.created_at) FROM research_task_events e WHERE e.task_id=c.task_id AND e.execution_kind=c.execution_kind
        AND e.execution_id=c.run_id AND e.call_id=c.call_id AND e.event_type IN ('call_settled','call_unknown')) settledAt,
      o.started_at,o.duration_ms,o.status invocation_status
      FROM agent_budget_calls c LEFT JOIN agent_budget_call_observations o ON o.run_id=c.run_id AND o.call_id=c.call_id
      WHERE c.execution_kind=? AND c.run_id=? AND c.rowid>? ORDER BY c.rowid LIMIT ?`)
      .all(request.executionKind, request.executionId, request.afterCallSequence, request.limit + 1) as Array<{
        started_at: string|null; duration_ms: number|null; invocation_status: string|null; [key: string]: unknown;
      }>;
    if (rows.some(row => row.taskId !== request.taskId)) throw new Error('research_task_call_scope_corrupt');
    const calls = rows.slice(0, request.limit).map(({taskId: _taskId, started_at, duration_ms, invocation_status, ...row}) => {
      return taskCallDiagnosticsSchema.parse({...row, invocation: started_at === null ? null : {
        startedAt: started_at, durationMs: duration_ms, status: invocation_status}});
    });
    return taskCallsPageSchema.parse({calls, nextSequence: calls.at(-1)?.sequence ?? request.afterCallSequence, hasMore: rows.length > request.limit});
  }
  summary(runId: string) {
    const telemetry = this.telemetry.get(runId);
    return telemetry === null ? null : taskTelemetrySchema.parse({
      firstOutputMs: telemetry.runtime.firstOutputMs, toolCalls: telemetry.tool.callCount, toolErrors: telemetry.tool.errorCount,
      admission: {acquisitions: telemetry.toolAdmission.acquisitionCount, cancellations: telemetry.toolAdmission.cancellationCount,
        waitMs: telemetry.toolAdmission.wait.totalMs, holdMs: telemetry.toolAdmission.hold.totalMs}, trace: telemetry.trace
    });
  }
  replay(request: TaskExecutionDiagnosticsRequest) {
    const page = this.events.replayRunEvents({runId: request.executionId, afterSequence: request.afterEventSequence, limit: request.limit + 1});
    const events = page.events.slice(0, request.limit).map(row => {
      const value = eventStatus(row.event);
      return {sequence: row.sequence, type: row.event.type, createdAt: row.createdAt, ...value};
    });
    return taskReplayDiagnosticsSchema.parse({events,
      nextSequence: events.at(-1)?.sequence ?? (page.kind === 'replay_gap' ? page.snapshot.throughSequence : request.afterEventSequence),
      hasMore: page.events.length > request.limit,
      gap: page.kind === 'replay_gap' ? {throughSequence: page.snapshot.throughSequence, historyComplete: page.snapshot.historyComplete} : null});
  }
}
function eventStatus(event: ChatRunEvent): {toolCallId: string|null; status: string|null; failed: boolean} {
  if (event.type === 'assistant_block' && event.block.kind === 'tool_call') {
    return {toolCallId: event.block.callId, status: event.block.phase, failed: event.block.phase === 'error'};
  }
  return {toolCallId: null, status: null, failed: event.type === 'run_failed' || event.type === 'context_maintenance' && event.event === 'context_compaction_failed'};
}
