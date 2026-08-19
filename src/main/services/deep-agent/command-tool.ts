import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  evaluateShellPolicy,
  ROC_SHELL_COMMAND_SCHEMA_DESCRIPTION,
  ROC_SHELL_CWD_SCHEMA_DESCRIPTION,
  ROC_SHELL_TOOL_DESCRIPTION
} from './shell-policy';
import type { AgentExecuteAdapter } from './types';

const schema = z.object({
  command: z.string().trim().min(1).describe(ROC_SHELL_COMMAND_SCHEMA_DESCRIPTION),
  cwd: z.string().trim().min(1).optional().describe(ROC_SHELL_CWD_SCHEMA_DESCRIPTION)
});

export function createRocWindowsCommandTool(
  adapter: AgentExecuteAdapter
): DynamicStructuredTool<typeof schema, z.infer<typeof schema>, z.infer<typeof schema>, string> {
  return new DynamicStructuredTool<typeof schema, z.infer<typeof schema>, z.infer<typeof schema>, string>({
    name: 'run_shell_command',
    description: ROC_SHELL_TOOL_DESCRIPTION,
    schema,
    func: async (request) => {
      const verdict = evaluateShellPolicy({ command: request.command, cwd: request.cwd });
      if (verdict.verdict === 'deny') {
        throw new Error(verdict.message);
      }
      const result = await adapter.executeAgentCommand({ command: request.command, cwd: request.cwd });
      return JSON.stringify(result, null, 2);
    }
  });
}
