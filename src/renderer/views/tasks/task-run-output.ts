import type { ChatAssistantBlock, TaskEvent, TaskDetail } from '../../../shared/types';
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
  guardrails: Array<{
    nudgeKind: string;
    tier: number | null;
    content: string;
    toolName: string | null;
    toolCallId: string | null;
  }>;
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
    const liveReasoning = readLiveReasoning(liveRun);
    const liveTools = readLiveTools(liveRun);
    return {
      ...persisted,
      runId: liveRun.runId,
      status: liveRun.status,
      assistantMessage: liveRun.assistantMessage.length === 0 ? persisted.assistantMessage : liveRun.assistantMessage,
      reasoning: liveReasoning.length === 0 ? persisted.reasoning : liveReasoning,
      tools: liveTools.length === 0 ? persisted.tools : liveTools,
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
  const assistantToolBlockIndexes = new Map<string, number>();
  const subagents: TaskRunOutput['subagents'] = [];
  const guardrails: TaskRunOutput['guardrails'] = [];

  for (const event of events) {
    if (event.type === 'message') {
      const content = readAssistantMessage(event.payload);
      if (content !== null) {
        assistantMessage = content;
      }
      continue;
    }
    if (event.type === 'assistant_block') {
      const block = readAssistantBlock(event.payload);
      if (block !== null) {
        if (block.kind === 'text' && typeof block.text === 'string') {
          assistantDelta += block.text;
        }
        if (block.kind === 'reasoning' && typeof block.text === 'string') {
          reasoning += block.text;
        }
        if (block.kind === 'tool_call') {
          applyToolBlock(tools, assistantToolBlockIndexes, block);
        }
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
    if (event.type === 'guardrail_nudge') {
      const guardrail = readGuardrailNudge(event.payload);
      if (guardrail !== null) {
        guardrails.push(guardrail);
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
    guardrails,
    error
  };
}

function normalizeTaskRunStatus(status: string | null): TaskRunOutputStatus {
  if (status === 'running' || status === 'waiting_user' || status === 'completed' || status === 'failed') {
    return status;
  }
  return 'idle';
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

function readAssistantBlock(payload: unknown): ChatAssistantBlock | null {
  if (!isRecord(payload) || typeof payload.blockId !== 'string') {
    return null;
  }
  if (payload.kind === 'text' || payload.kind === 'reasoning') {
    if ((payload.phase !== 'delta' && payload.phase !== 'end') || ('text' in payload && typeof payload.text !== 'string')) {
      return null;
    }
    return payload as ChatAssistantBlock;
  }
  if (
    payload.kind !== 'tool_call' ||
    typeof payload.callId !== 'string' ||
    typeof payload.name !== 'string' ||
    !isToolPhase(payload.phase)
  ) {
    return null;
  }
  return payload as ChatAssistantBlock;
}

function isToolPhase(value: unknown): value is Extract<ChatAssistantBlock, { kind: 'tool_call' }>['phase'] {
  return value === 'start' || value === 'progress' || value === 'end' || value === 'error';
}

function readToolBlock(block: Extract<ChatAssistantBlock, { kind: 'tool_call' }>): { name: string; status: string; data: unknown } {
  if (block.phase === 'error' && 'error' in block) {
    return {
      name: block.name,
      status: block.phase,
      data: block.error
    };
  }
  if (block.phase === 'end' && 'output' in block) {
    return {
      name: block.name,
      status: block.phase,
      data: block.output
    };
  }
  if ('input' in block) {
    return {
      name: block.name,
      status: block.phase,
      data: block.input
    };
  }
  return {
    name: block.name,
    status: block.phase,
    data: null
  };
}

function applyToolBlock(
  tools: TaskRunOutput['tools'],
  indexes: Map<string, number>,
  block: Extract<ChatAssistantBlock, { kind: 'tool_call' }>
): void {
  const tool = readToolBlock(block);
  const existingIndex = indexes.get(block.blockId);
  if (existingIndex === undefined) {
    indexes.set(block.blockId, tools.length);
    tools.push(tool);
    return;
  }
  tools[existingIndex] = tool;
}

function readLiveReasoning(liveRun: ChatRunState): string {
  return liveRun.activityBlocks.flatMap((block) => (block.kind === 'reasoning' ? [block.content] : [])).join('');
}

function readLiveTools(liveRun: ChatRunState): TaskRunOutput['tools'] {
  return liveRun.activityBlocks.flatMap((block) => {
    if (block.kind !== 'tool_call') {
      return [];
    }
    if (block.output !== null && block.output !== undefined) {
      return [{ name: block.name, status: block.status, data: block.output }];
    }
    if (block.error !== null && block.error !== undefined) {
      return [{ name: block.name, status: block.status, data: block.error }];
    }
    return [{ name: block.name, status: block.status, data: block.input }];
  });
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

function readGuardrailNudge(payload: unknown): TaskRunOutput['guardrails'][number] | null {
  if (!isRecord(payload) || typeof payload.nudgeKind !== 'string' || typeof payload.content !== 'string') {
    return null;
  }
  return {
    nudgeKind: payload.nudgeKind,
    tier: typeof payload.tier === 'number' ? payload.tier : null,
    content: payload.content,
    toolName: typeof payload.toolName === 'string' ? payload.toolName : null,
    toolCallId: typeof payload.toolCallId === 'string' ? payload.toolCallId : null
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
