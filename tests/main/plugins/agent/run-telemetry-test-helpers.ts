import type { TaskRun } from '../../../../src/shared/types';
import {
  AgentRunTelemetryAccumulator,
  type AgentRunTelemetryV1
} from '../../../../src/main/plugins/agent/run-telemetry';
import type { AgentSessionRepository } from '../../../../src/main/plugins/agent/session-repository';

export function createTerminalRunTelemetry(input: {
  repository: AgentSessionRepository;
  run: TaskRun;
  terminal: Parameters<AgentRunTelemetryAccumulator['markTerminal']>[0];
}): AgentRunTelemetryV1 {
  const existing = requireRunTelemetry(input.repository, input.run);
  const accumulator = new AgentRunTelemetryAccumulator({
    existing,
    run: input.run,
    snapshot: input.repository.getRunExecutionSnapshot(input.run.id)
  });
  accumulator.markTerminal(input.terminal);
  return accumulator.snapshot();
}

export function requireRunTelemetry(
  repository: AgentSessionRepository,
  run: TaskRun
): AgentRunTelemetryV1 {
  const telemetry = repository.getRunTelemetry(run.id);
  if (telemetry === null) {
    throw new Error('test_agent_run_telemetry_missing');
  }
  return telemetry;
}
