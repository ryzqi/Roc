import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { InMemoryStore } from '@langchain/langgraph';
import { StateBackend } from 'deepagents';
import { z } from 'zod';

import { compileRunCapabilityManifest } from '../../../src/main/plugins/agent/run-capability-manifest';
import { toRunExecutionMode } from '../../../src/main/plugins/agent/run-execution-snapshot';
import { buildDeepAgent } from '../../../src/main/services/deep-agent/agent-builder';
import type { RocCompositeBackend } from '../../../src/main/services/deep-agent/backend';
import type { RocSqliteCheckpointer } from '../../../src/main/services/deep-agent/sqlite-checkpointer';
import { createDeepAgentTestSnapshot } from '../../main/deep-agent-test-helpers';

export const todoItemSchema = z
  .object({
    content: z.string().min(1),
    status: z.enum(['pending', 'in_progress', 'completed'])
  })
  .strict();

export const trajectoryEventSchema = z.discriminatedUnion('kind', [
  z
    .object({
      args: z.record(z.string(), z.unknown()),
      id: z.string().min(1),
      kind: z.literal('assistant_tool_call'),
      name: z.string().min(1)
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      kind: z.literal('tool_result'),
      name: z.string().min(1),
      status: z.enum(['success', 'error'])
    })
    .strict()
]);

export type EvalAgentMode = 'chat' | 'plan';
export type TrajectoryEvent = z.infer<typeof trajectoryEventSchema>;

export function createEvalAgent(input: {
  mode: EvalAgentMode;
  model: BaseChatModel;
  checkpointer: RocSqliteCheckpointer;
  systemPrompt: string;
}) {
  const backend = Object.assign(new StateBackend(), { routePrefixes: [] }) as RocCompositeBackend;
  const capabilityManifest = compileRunCapabilityManifest({
    deleteFileApprovalMode: 'fully_automatic',
    mcpApprovalMode: 'fully_automatic',
    mcpServers: [],
    requestedCapabilities: { mcpServers: [], skills: [] },
    skills: [],
    mode: input.mode,
    workflowHint: null
  }).manifest;

  return buildDeepAgent({
    snapshot: createDeepAgentTestSnapshot({
      capabilityManifest,
      mode: toRunExecutionMode(input.mode),
      budget: {
        contextBudgetTokens: null
      }
    }),
    model: input.model,
    systemPrompt: input.systemPrompt,
    backend,
    store: new InMemoryStore(),
    memorySources: [],
    skillSources: [],
    subagents: [],
    tools: [],
    checkpointer: input.checkpointer
  });
}

export function assertTerminalOutcome(messages: readonly BaseMessage[]): string {
  const terminalMessage = messages.at(-1);
  if (!AIMessage.isInstance(terminalMessage)) {
    throw new Error('agent_eval_terminal_ai_message_missing');
  }
  if (readAiToolCalls(terminalMessage).length !== 0) {
    throw new Error('agent_eval_terminal_tool_calls_present');
  }
  if (typeof terminalMessage.content !== 'string' || terminalMessage.content.length === 0) {
    throw new Error('agent_eval_terminal_content_not_text');
  }
  return terminalMessage.content;
}

export function readTrajectory(messages: readonly BaseMessage[]): TrajectoryEvent[] {
  const trajectory: TrajectoryEvent[] = [];
  for (const message of messages) {
    if (AIMessage.isInstance(message)) {
      for (const toolCall of readAiToolCalls(message)) {
        trajectory.push({
          args: toolCall.args,
          id: requireToolCallId(toolCall.id),
          kind: 'assistant_tool_call',
          name: toolCall.name
        });
      }
    }
    if (ToolMessage.isInstance(message)) {
      if (message.name === undefined || message.name.length === 0) {
        throw new Error('agent_eval_tool_result_name_missing');
      }
      trajectory.push({
        id: message.tool_call_id,
        kind: 'tool_result',
        name: message.name,
        status: readToolResultStatus(message.status)
      });
    }
  }
  return trajectory;
}

export function readTodos(value: unknown) {
  if (value === undefined) {
    return [];
  }
  const parsed = z.array(todoItemSchema).safeParse(value);
  if (!parsed.success) {
    throw new Error('agent_eval_todos_invalid', { cause: parsed.error });
  }
  return parsed.data;
}

export function readFilePaths(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('agent_eval_files_invalid');
  }
  return Object.keys(value).sort();
}

function readAiToolCalls(message: AIMessage) {
  if (message.tool_calls === undefined) {
    return [];
  }
  return message.tool_calls;
}

function requireToolCallId(id: string | undefined): string {
  if (id === undefined || id.length === 0) {
    throw new Error('agent_eval_tool_call_id_missing');
  }
  return id;
}

function readToolResultStatus(status: ToolMessage['status']): 'success' | 'error' {
  // LangChain 1.2.x omits status for successful tool results; errors are explicit.
  if (status === undefined || status === 'success') {
    return 'success';
  }
  if (status === 'error') {
    return 'error';
  }
  throw new Error('agent_eval_tool_result_status_invalid');
}
