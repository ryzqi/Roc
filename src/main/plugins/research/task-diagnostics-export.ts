import {createHash, randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {researchTaskRequestSchema} from '../../../shared/schemas/research-tasks';
import {taskDiagnosticsExportSchema, type TaskDiagnosticsExport} from '../../../shared/schemas/research-task-observability';
import {requireResearchHuman} from '../../services/research-human-context';
import type {ResearchTaskDiagnosticsService} from './task-diagnostics';
import type {ResearchTaskRepository} from './research-task-repository';
const privateId = (value: string|null): string|null => value === null ? null : createHash('sha256').update(value).digest('hex');

export class ResearchTaskDiagnosticsExporter {
  constructor(private readonly diagnostics: ResearchTaskDiagnosticsService, private readonly tasks: ResearchTaskRepository,
    private readonly root: string) {}
  async export(input: {projectId: string; taskId: string}): Promise<TaskDiagnosticsExport> {
    const request = researchTaskRequestSchema.parse(input);
    requireResearchHuman('research.task.diagnostics.export', request.projectId);
    const summary = this.diagnostics.get(request);
    if (summary.executions.length > 500) throw new Error('research_task_diagnostics_execution_limit');
    const createdAt = new Date().toISOString();
    const executions = [];
    for (const execution of summary.executions) {
      const association = execution.association;
      const observation = await this.diagnostics.inspectExecution({...request, executionKind: association.kind,
        executionId: association.executionId, afterCallSequence: 0, afterEventSequence: 0, limit: 100});
      executions.push({
        kind: association.kind, executionId: privateId(association.executionId), parentKind: association.parentKind,
        parentExecutionId: privateId(association.parentExecutionId), manifestHash: association.manifestHash,
        status: execution.status, stage: execution.stage, errorPresent: execution.error !== null,
        startedAt: execution.startedAt, endedAt: execution.endedAt, artifacts: execution.artifacts.map(artifact => ({
          ...artifact, id: privateId(artifact.id)
        })), telemetry: observation.telemetry, resources: observation.resources,
        calls: {...observation.calls, calls: observation.calls.calls.map(call => ({
          ...call, runId: privateId(call.runId), callId: privateId(call.callId)
        }))},
        replay: observation.replay === null ? null : {...observation.replay, events: observation.replay.events.map(event => ({
          ...event, toolCallId: privateId(event.toolCallId)
        }))}
      });
    }
    const events = this.tasks.events({...request, afterSequence: 0, limit: 100});
    const payload = {schemaVersion: 1, createdAt, projectId: privateId(request.projectId), taskId: privateId(request.taskId),
      status: summary.task.status, usage: summary.usage,
      recoveryIssues: summary.recoveryIssues, eventDelivery: summary.eventDelivery, executions,
      taskEvents: {...events, events: events.events.map(event => ({sequence: event.sequence, eventType: event.eventType,
        executionKind: event.payload.executionKind, executionId: privateId(event.payload.executionId), callId: privateId(event.payload.callId),
        createdAt: event.createdAt, reasonPresent: event.payload.reason !== null}))},
      omissions: ['goals', 'facts', 'actors', 'provider_names', 'model_names', 'prompts', 'tool_arguments', 'tool_results',
        'error_text', 'paths', 'replay_snapshot_state'],
      coverage: 'first_100_calls_and_events_per_execution;first_100_task_events;hasMore_and_gap_are_explicit', externalTrace: 'not_exported'};
    if (JSON.stringify(this.diagnostics.get(request)) !== JSON.stringify(summary)) throw new Error('research_task_diagnostics_source_changed');
    const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    if (bytes.length > 2 * 1024 * 1024) throw new Error('research_task_diagnostics_export_size_limit');
    // User-triggered local package; no caller-controlled destination or network transport.
    this.tasks.get(request.taskId, request.projectId);
    await mkdir(this.root, {recursive: true, mode: 0o700});
    const path = join(this.root, `research-task-${randomUUID()}.json`);
    await writeFile(path, bytes, {flag: 'wx', mode: 0o600});
    return taskDiagnosticsExportSchema.parse({path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      createdAt, redacted: true, externalTrace: 'not_exported'});
  }
}
