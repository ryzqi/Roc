import type { DynamicStructuredTool, ToolSchemaBase } from '@langchain/core/tools';
import type { AnySubAgent, ExecuteResponse } from 'deepagents';
import type { ShellExecutionResult } from '../../../shared/types';
import type { ExecutionGrantProfile } from './execution-grant-broker';

export type RunFailure = {
  code: string;
  diagnostic?: {
    badKeys?: string[];
    schemaPath?: string;
    toolName?: string;
  };
  message: string;
  retryable: boolean;
  suggestion?: string;
};

export type RuntimeSubagent = AnySubAgent;

// Erase concrete tool schema output at collection boundaries without widening to any.
export type StringDynamicStructuredTool = DynamicStructuredTool<ToolSchemaBase, never, unknown, string>;

export type AgentExecuteAdapter = {
  executeAgentCommand(input: {
    command: string;
    cwd?: string;
    toolCallId: string;
    profile: ExecutionGrantProfile;
  }): Promise<
    ExecuteResponse & {
      command: string;
      cwd: string;
      usedRtk: boolean;
      truncated?: boolean;
      bypassReason?: ShellExecutionResult['bypassReason'];
    }
  >;
};

/**
 * Roc-visible built-in DeepAgents tool allowlist.
 *
 * Deep Agents can also expose a native `execute` filesystem tool, but Roc must not expose it:
 * filesystem permissions do not constrain shell commands. Roc shell access is provided through
 * the three brokered command tools: `run_shell_command`, `run_isolated_read_command`, and
 * `run_trusted_host_command`.
 */
export const DEEP_AGENT_BUILT_IN_TOOLS = [
  'write_todos',
  'task',
  'ls',
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'grep'
] as const;
