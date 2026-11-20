import type {
  AgentCapabilityPreview,
  ChatStartRunRequest,
  EnabledCapabilities,
  TaskKind
} from '../../../shared/types';
import { agentTaskEventPayloadSchema } from '../../../shared/schemas/task-event';
import { readRecordValue } from '../../services/deep-agent/record-utils';

export function readAgentTaskEventPayload(payload: unknown): {
  runId: string;
  threadId: string;
  type: 'approval_decision' | 'approval_requested' | 'assistant_block' | 'guardrail_nudge' | 'hook_completed' | 'hook_started' | 'subagent_event' | 'task_acceptance' | 'tool_call';
  payload: Record<string, unknown>;
} | null {
  const parsed = agentTaskEventPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
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
  const runId = readRecordValue(payload, 'runId');
  const threadId = readRecordValue(payload, 'threadId');
  const mode = readRecordValue(payload, 'mode');
  const userInput = readRecordValue(payload, 'userInput');
  const providerId = readRecordValue(payload, 'providerId');
  const modelId = readRecordValue(payload, 'modelId');
  const enabledCapabilities = readEnabledCapabilities(readRecordValue(payload, 'enabledCapabilities'));
  const workflowHint = readWorkflowHint(readRecordValue(payload, 'workflowHint'));
  const capabilityPreview = readAgentCapabilityPreview(readRecordValue(payload, 'capabilityPreview'));
  const createdAt = readRecordValue(payload, 'createdAt');
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

function isChatRunMode(value: unknown): value is ChatStartRunRequest['mode'] {
  return value === 'chat' || value === 'task' || value === 'plan';
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
  const manifest = readRecordValue(value, 'manifest');
  if (manifest === null || typeof manifest !== 'object') {
    return undefined;
  }
  const requestedCapabilities = readEnabledCapabilities(readRecordValue(manifest, 'requestedCapabilities'));
  const selectedCapabilities = readEnabledCapabilities(readRecordValue(manifest, 'resolvedCapabilities'));
  const skippedCapabilities = readRecordValue(manifest, 'skippedCapabilities');
  const toolCards = readRecordValue(value, 'toolCards');
  const skillCards = readRecordValue(value, 'skillCards');
  const untrustedContextPolicy = readRecordValue(manifest, 'untrustedContextPolicy');
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
  const mcpServers = readRecordValue(value, 'mcpServers');
  const skills = readRecordValue(value, 'skills');
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
