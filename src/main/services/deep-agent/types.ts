import type { DynamicStructuredTool, ToolSchemaBase } from '@langchain/core/tools';
import type { AnySubAgent, ExecuteResponse } from 'deepagents';
import type {
  ShellExecutionResult,
} from '../../../shared/types';

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
  executeAgentCommand(input: { command: string; cwd?: string }): Promise<
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
 * Deep Agents 1.10.8 also has a native `execute` filesystem tool, but Roc must not expose it:
 * filesystem permissions do not constrain shell commands. Roc shell access is only
 * `run_shell_command`, guarded by createRocShellPathPolicyMiddleware and ShellExecutionService.
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
