import { createDeepAgent } from 'deepagents';

import type {
  AgentRuntimeStatus,
  ChatAssistantBlock,
  ChatStartRunRequest,
  TaskEvent,
  TaskKind
} from '../../../shared/types';

const backgroundTaskToolNames = new Set([
  'resolve_background_task_time',
  'propose_background_task',
  'schedule_background_task',
  'read_background_task',
  'update_background_task',
  'cancel_background_task'
]);

export function createTaskEventFromAssistantBlock(block: ChatAssistantBlock): Pick<TaskEvent, 'type' | 'payload'> {
  if (block.kind !== 'tool_call' || !backgroundTaskToolNames.has(block.name)) {
    return {
      type: 'assistant_block',
      payload: block
    };
  }
  const payload: Record<string, unknown> = {
    name: block.name,
    status: block.phase
  };
  if ('input' in block) {
    payload.input = block.input;
  }
  if ('output' in block) {
    payload.output = block.output;
  }
  if ('error' in block) {
    payload.error = block.error;
  }
  return {
    type: 'tool_call',
    payload
  };
}

export function resolveNewRunThreadKind(request: ChatStartRunRequest): TaskKind {
  if (request.mode === 'task' && request.taskSource === 'workbench') {
    return 'background';
  }
  return 'chat';
}

export function updateSuccessfulToolBlocks(successfulToolBlockIds: Set<string>, block: ChatAssistantBlock): void {
  if (block.kind !== 'tool_call') {
    return;
  }
  if (block.phase === 'end') {
    successfulToolBlockIds.add(block.blockId);
    return;
  }
  if (block.phase === 'error') {
    successfulToolBlockIds.delete(block.blockId);
  }
}

export function createBlockedAgentRuntimeStatus(): AgentRuntimeStatus {
  return {
    deepAgentsPackage: 'available',
    deepAgentsApi: {
      createDeepAgent: typeof createDeepAgent === 'function'
    },
    defaultModelConfigured: false,
    defaultModelState: {
      status: 'missing',
      modelId: null,
      providerId: null,
      reason: 'No default model configured for the agent plugin runtime.'
    },
    memoryAccess: 'store_backend',
    execution: 'blocked_until_provider_configured'
  };
}
