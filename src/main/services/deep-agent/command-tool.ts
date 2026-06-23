import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { validateRocWindowsShellPath } from './shell-path-guard';
import type { AgentExecuteAdapter } from './types';

const schema = z.object({
  command: z.string().trim().min(1).describe('PowerShell command. Must not contain /workspace, /workspace/... or Linux local paths.'),
  cwd: z.string().trim().min(1).optional().describe('Optional real Windows cwd. Omit to use the selected Roc workspace root.')
});

export function createRocWindowsCommandTool(
  adapter: AgentExecuteAdapter
): DynamicStructuredTool<typeof schema, z.infer<typeof schema>, z.infer<typeof schema>, string> {
  return new DynamicStructuredTool<typeof schema, z.infer<typeof schema>, z.infer<typeof schema>, string>({
    name: 'run_shell_command',
    description: [
      '在当前 Roc Windows 工作区执行 PowerShell 命令。',
      '默认 cwd 是用户选择的真实 Windows 工作区。',
      '禁止在 command 或 cwd 中使用 /workspace 或 /workspace/...；/workspace 只属于 DeepAgents 文件工具。',
      '引用工作区文件时用相对路径，或用真实 Windows 路径，例如 F:\\Code\\Roc\\script.ps1。',
      '适合运行测试、构建、脚本和本地命令。'
    ].join('\n'),
    schema,
    func: async (request) => {
      validateRocWindowsCommand(request.command);
      if (request.cwd !== undefined) {
        validateRocWindowsCommand(request.cwd);
      }
      const result = await adapter.executeAgentCommand({ command: request.command, cwd: request.cwd });
      return JSON.stringify(result, null, 2);
    }
  });
}

function validateRocWindowsCommand(command: string): void {
  validateRocWindowsShellPath(command);
}
