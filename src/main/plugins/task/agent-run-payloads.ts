import type {
  AgentCapabilityPreview,
  ChatStartRunRequest,
  EnabledCapabilities,
  TaskEvent,
  TaskKind
} from '../../../shared/types';

export function readAgentRunCompletedPayload(payload: unknown): {
  runId: string;
  threadId: string;
  assistantMessage: string;
  providerId: string;
  modelId: string;
  durationMs: number;
  summary: string;
  finishReason: string;
} | null {
  if (payload === null || typeof payload !== 'object') {
    return null;
  }
  const runId = Reflect.get(payload, 'runId');
  const threadId = Reflect.get(payload, 'threadId');
  const assistantMessage = Reflect.get(payload, 'assistantMessage');
  const providerId = Reflect.get(payload, 'providerId');
  const modelId = Reflect.get(payload, 'modelId');
  const durationMs = Reflect.get(payload, 'durationMs');
  const summary = Reflect.get(payload, 'summary');
  const finishReason = Reflect.get(payload, 'finishReason');
  if (
    typeof runId !== 'string' ||
    typeof threadId !== 'string' ||
    typeof assistantMessage !== 'string' ||
    typeof providerId !== 'string' ||
    typeof modelId !== 'string' ||
    typeof durationMs !== 'number' ||
    typeof summary !== 'string' ||
    typeof finishReason !== 'string'
  ) {
    return null;
  }
  return {
    runId,
    threadId,
    assistantMessage,
    providerId,
    modelId,
    durationMs,
    summary,
    finishReason
  };
}

export function readAgentRunFailedPayload(payload: unknown): {
  runId: string;
  threadId: string;
  providerId: string;
  modelId: string;
  error: string;
  code: string;
  retryable: boolean;
} | null {
  if (payload === null || typeof payload !== 'object') {
    return null;
  }
  const runId = Reflect.get(payload, 'runId');
  const threadId = Reflect.get(payload, 'threadId');
  const providerId = Reflect.get(payload, 'providerId');
  const modelId = Reflect.get(payload, 'modelId');
  const error = Reflect.get(payload, 'error');
  const code = Reflect.get(payload, 'code');
  const retryable = Reflect.get(payload, 'retryable');
  if (
    typeof runId !== 'string' ||
    typeof threadId !== 'string' ||
    typeof providerId !== 'string' ||
    typeof modelId !== 'string' ||
    typeof error !== 'string' ||
    typeof code !== 'string' ||
    typeof retryable !== 'boolean'
  ) {
    return null;
  }
  return {
    runId,
    threadId,
    providerId,
    modelId,
    error,
    code,
    retryable
  };
}

export function readAgentTaskEventPayload(payload: unknown): {
  runId: string;
  threadId: string;
  type: TaskEvent['type'];
  payload: Record<string, unknown>;
} | null {
  if (payload === null || typeof payload !== 'object') {
    return null;
  }
  const runId = Reflect.get(payload, 'runId');
  const threadId = Reflect.get(payload, 'threadId');
  const type = Reflect.get(payload, 'type');
  const eventPayload = Reflect.get(payload, 'payload');
  if (
    typeof runId !== 'string' ||
    typeof threadId !== 'string' ||
    !isAgentTaskEventType(type) ||
    eventPayload === null ||
    typeof eventPayload !== 'object' ||
    Array.isArray(eventPayload)
  ) {
    return null;
  }
  return {
    runId,
    threadId,
    type,
    payload: eventPayload as Record<string, unknown>
  };
}

export function readAgentRunStartedPayload(payload: unknown): {
  runId: string;
  threadId: string;
  mode: ChatStartRunRequest['mode'];
  userInput: string;
  providerId: string;
  modelId: string;
  enabledCapabilities: EnabledCapabilities;
  workflowHint: ChatStartRunRequest['workflowHint'] | null;
  capabilityPreview?: AgentCapabilityPreview;
  createdAt: string;
} | null {
  if (payload === null || typeof payload !== 'object') {
    return null;
  }
  const runId = Reflect.get(payload, 'runId');
  const threadId = Reflect.get(payload, 'threadId');
  const mode = Reflect.get(payload, 'mode');
  const userInput = Reflect.get(payload, 'userInput');
  const providerId = Reflect.get(payload, 'providerId');
  const modelId = Reflect.get(payload, 'modelId');
  const enabledCapabilities = readEnabledCapabilities(Reflect.get(payload, 'enabledCapabilities'));
  const workflowHint = readWorkflowHint(Reflect.get(payload, 'workflowHint'));
  const capabilityPreview = readAgentCapabilityPreview(Reflect.get(payload, 'capabilityPreview'));
  const createdAt = Reflect.get(payload, 'createdAt');
  if (
    typeof runId !== 'string' ||
    typeof threadId !== 'string' ||
    !isChatRunMode(mode) ||
    typeof userInput !== 'string' ||
    typeof providerId !== 'string' ||
    typeof modelId !== 'string' ||
    enabledCapabilities === null ||
    workflowHint === undefined ||
    typeof createdAt !== 'string'
  ) {
    return null;
  }
  return {
    runId,
    threadId,
    mode,
    userInput,
    providerId,
    modelId,
    enabledCapabilities,
    workflowHint,
    ...(capabilityPreview === undefined ? {} : { capabilityPreview }),
    createdAt
  };
}

export function resolveAgentRunThreadKind(input: {
  mode: ChatStartRunRequest['mode'];
  workflowHint: ChatStartRunRequest['workflowHint'] | null;
}): TaskKind {
  if (input.mode === 'task' && input.workflowHint !== null) {
    return 'background';
  }
  return 'chat';
}

function isAgentTaskEventType(value: unknown): value is TaskEvent['type'] {
  return (
    value === 'tool_call' ||
    value === 'assistant_block' ||
    value === 'guardrail_nudge' ||
    value === 'subagent_started' ||
    value === 'subagent_completed' ||
    value === 'approval_requested' ||
    value === 'approval_decision'
  );
}

function isChatRunMode(value: unknown): value is ChatStartRunRequest['mode'] {
  return value === 'chat' || value === 'task';
}

function readWorkflowHint(value: unknown): ChatStartRunRequest['workflowHint'] | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  if (value === 'propose_background_task' || value === 'background_task_change') {
    return value;
  }
  return undefined;
}

function readAgentCapabilityPreview(value: unknown): AgentCapabilityPreview | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  const requestedCapabilities = readEnabledCapabilities(Reflect.get(value, 'requestedCapabilities'));
  const selectedCapabilities = readEnabledCapabilities(Reflect.get(value, 'selectedCapabilities'));
  const skippedCapabilities = Reflect.get(value, 'skippedCapabilities');
  const toolCards = Reflect.get(value, 'toolCards');
  const skillCards = Reflect.get(value, 'skillCards');
  const untrustedContextPolicy = Reflect.get(value, 'untrustedContextPolicy');
  if (
    requestedCapabilities === null ||
    selectedCapabilities === null ||
    !Array.isArray(skippedCapabilities) ||
    !Array.isArray(toolCards) ||
    !Array.isArray(skillCards) ||
    untrustedContextPolicy !== 'external_content_reference_only'
  ) {
    return undefined;
  }
  return value as AgentCapabilityPreview;
}

function readEnabledCapabilities(value: unknown): EnabledCapabilities | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const mcpServers = Reflect.get(value, 'mcpServers');
  const skills = Reflect.get(value, 'skills');
  if (!isStringArray(mcpServers) || !isStringArray(skills)) {
    return null;
  }
  return {
    mcpServers,
    skills
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
