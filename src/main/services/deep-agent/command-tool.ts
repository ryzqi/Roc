import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import {
  evaluateShellPolicy,
  ROC_SHELL_COMMAND_SCHEMA_DESCRIPTION,
  ROC_SHELL_CWD_SCHEMA_DESCRIPTION
} from './shell-policy';
import type { ExecutionGrantProfile } from './execution-grant-broker';
import type { AgentExecuteAdapter, StringDynamicStructuredTool } from './types';

const schema = z.object({
  command: z.string().trim().min(1).describe(ROC_SHELL_COMMAND_SCHEMA_DESCRIPTION),
  cwd: z.string().trim().min(1).optional().describe(ROC_SHELL_CWD_SCHEMA_DESCRIPTION)
}).strict();

export type RocCommandToolOptions = {
  name: 'run_shell_command' | 'run_isolated_read_command' | 'run_trusted_host_command';
  profile: ExecutionGrantProfile;
  description: string;
};

export function createRocCommandTool(
  adapter: AgentExecuteAdapter,
  options: RocCommandToolOptions
): StringDynamicStructuredTool {
  return tool(async (request: z.output<typeof schema>, runtime: ToolRuntime) => {
    const verdict = evaluateShellPolicy({ command: request.command, cwd: request.cwd });
    if (verdict.verdict === 'deny') {
      throw new Error(verdict.message);
    }
    const result = await adapter.executeAgentCommand({
      command: request.command,
      cwd: request.cwd,
      toolCallId: runtime.toolCallId,
      profile: options.profile
    });
    return JSON.stringify(result, null, 2);
  }, {
    name: options.name,
    description: options.description,
    schema
  });
}
