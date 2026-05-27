import type { TaskEvent, TaskDetail } from '../../../shared/types';
import type { ChatRunState } from '../../chat-run-state';

export type TaskRunOutputStatus = 'idle' | 'running' | 'waiting_user' | 'completed' | 'failed';

export type TaskRunOutput = {
  runId: string | null;
  status: TaskRunOutputStatus;
  userInput: string | null;
  assistantMessage: string;
  reasoning: string;
  tools: Array<{ name: string; status: string; data: unknown }>;
  subagents: Array<{ name: string; status: string; summary: string | null }>;
  error: string | null;
};

export function buildTaskRunOutput(input: {
  detail: TaskDetail | null;
  liveRun: ChatRunState | null;
}): TaskRunOutput | null {
  const detail = input.detail;
  if (detail === null) {
    return null;
  }

  const runId = detail.lastRunId ?? detail.runHistory[0]?.id ?? null;
  const run = runId === null ? null : detail.runHistory.find((entry) => entry.id === runId) ?? null;
  const persistedEvents = runId === null
    ? []
    : detail.recentEvents
        .filter((event) => event.runId === runId)
        .slice()
        .sort(compareTaskEventsAscending);

  const persisted = buildPersistedOutput(runId, run, persistedEvents);
  const liveRun = input.liveRun;
  if (
    liveRun !== null &&
    liveRun.mode === 'task' &&
    liveRun.runId !== null &&
    liveRun.runId === runId &&
    (liveRun.status === 'running' || liveRun.status === 'waiting_user')
  ) {
    return {
      ...persisted,
      runId: liveRun.runId,
      status: liveRun.status,
      assistantMessage: liveRun.assistantMessage.length === 0 ? persisted.assistantMessage : liveRun.assistantMessage,
      reasoning: liveRun.reasoning.length === 0 ? persisted.reasoning : liveRun.reasoning,
      tools: liveRun.toolEvents.map((event) => ({
        name: event.name,
        status: event.event,
        data: event.data
      })),
      subagents: liveRun.subagents.map((subagent) => ({
        name: subagent.subagent,
        status: subagent.status,
        summary: subagent.summary
      })),
      error: liveRun.errorMessage ?? persisted.error
    };
  }

  return persisted;
}

function buildPersistedOutput(
  runId: string | null,
  run: TaskDetail['runHistory'][number] | null,
  events: TaskEvent[]
): TaskRunOutput {
  let assistantMessage = '';
  let assistantDelta = '';
  let reasoning = '';
  let error: string | null = null;
  const tools: TaskRunOutput['tools'] = [];
  const subagents: TaskRunOutput['subagents'] = [];

  for (const event of events) {
    if (event.type === 'message_delta') {
      const delta = readAssistantDelta(event.payload);
      if (delta !== null) {
        assistantDelta += delta;
      }
      continue;
    }
    if (event.type === 'reasoning_delta') {
      const delta = readReasoningDelta(event.payload);
      if (delta !== null) {
        reasoning += delta;
      }
      continue;
    }
    if (event.type === 'message') {
      const content = readAssistantMessage(event.payload);
      if (content !== null) {
        assistantMessage = content;
      }
      continue;
    }
    if (event.type === 'tool_call') {
      const tool = readToolCall(event.payload);
      if (tool !== null) {
        tools.push(tool);
      }
      continue;
    }
    if (event.type === 'agent_execute') {
      const command = readAgentExecute(event.payload);
      if (command !== null) {
        tools.push(command);
      }
      continue;
    }
    if (event.type === 'subagent_started' || event.type === 'subagent_completed') {
      const subagent = readSubagent(event.type, event.payload);
      if (subagent !== null) {
        subagents.push(subagent);
      }
      continue;
    }
    if (event.type === 'error') {
      const message = readErrorMessage(event.payload);
      if (message !== null) {
        error = message;
      }
    }
  }

  return {
    runId,
    status: normalizeTaskRunStatus(run?.status ?? null),
    userInput: run?.userInput ?? null,
    assistantMessage: assistantMessage.length > 0 ? assistantMessage : assistantDelta,
    reasoning,
    tools,
    subagents,
    error
  };
}

function normalizeTaskRunStatus(status: string | null): TaskRunOutputStatus {
  if (status === 'running' || status === 'waiting_user' || status === 'completed' || status === 'failed') {
    return status;
  }
  return 'idle';
}

function readAssistantDelta(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (payload.role !== 'assistant') {
    return null;
  }
  return typeof payload.delta === 'string' ? payload.delta : null;
}

function readReasoningDelta(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  return typeof payload.delta === 'string' ? payload.delta : null;
}

function readAssistantMessage(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (payload.role !== 'assistant') {
    return null;
  }
  return typeof payload.content === 'string' ? payload.content : null;
}

function readToolCall(payload: unknown): { name: string; status: string; data: unknown } | null {
  if (!isRecord(payload) || typeof payload.name !== 'string' || typeof payload.status !== 'string') {
    return null;
  }
  if ('output' in payload) {
    return {
      name: payload.name,
      status: payload.status,
      data: payload.output
    };
  }
  if ('input' in payload) {
    return {
      name: payload.name,
      status: payload.status,
      data: payload.input
    };
  }
  if ('error' in payload) {
    return {
      name: payload.name,
      status: payload.status,
      data: payload.error
    };
  }
  return {
    name: payload.name,
    status: payload.status,
    data: null
  };
}

function readAgentExecute(payload: unknown): { name: string; status: string; data: unknown } | null {
  if (!isRecord(payload) || typeof payload.command !== 'string') {
    return null;
  }
  const status = typeof payload.exitCode === 'number' ? `exit ${payload.exitCode}` : 'executed';
  const output = typeof payload.output === 'string' ? payload.output : null;
  return {
    name: payload.command,
    status,
    data: output === null ? payload : output
  };
}

function compareTaskEventsAscending(left: TaskEvent, right: TaskEvent): number {
  const createdAtOrder = left.createdAt.localeCompare(right.createdAt);
  if (createdAtOrder !== 0) {
    return createdAtOrder;
  }
  return (left.sequence ?? 0) - (right.sequence ?? 0);
}

function readSubagent(
  type: Extract<TaskEvent['type'], 'subagent_started' | 'subagent_completed'>,
  payload: unknown
): { name: string; status: string; summary: string | null } | null {
  if (!isRecord(payload) || typeof payload.name !== 'string') {
    return null;
  }
  return {
    name: payload.name,
    status: type === 'subagent_started' ? 'started' : 'completed',
    summary: typeof payload.summary === 'string' ? payload.summary : null
  };
}

function readErrorMessage(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  return typeof payload.message === 'string' ? payload.message : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
