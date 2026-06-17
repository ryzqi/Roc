import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { AgentExecuteAdapter } from './types';

const schema = z.object({
  command: z.string().trim().min(1),
  cwd: z.string().trim().min(1).optional()
});

const VIRTUAL_WORKSPACE_ERROR = '/workspace/ 是 DeepAgents 文件工具路由，不是 Windows shell 路径。';
const LINUX_PATH_ERROR = 'Roc 在 Windows 本地执行命令；请使用当前工作区 cwd 下的相对路径或 Windows 路径。';

export function createRocWindowsCommandTool(
  adapter: AgentExecuteAdapter
): DynamicStructuredTool<typeof schema, z.infer<typeof schema>, z.infer<typeof schema>, string> {
  return new DynamicStructuredTool<typeof schema, z.infer<typeof schema>, z.infer<typeof schema>, string>({
    name: 'run_shell_command',
    description: [
      '在当前 Roc Windows 工作区执行 PowerShell 命令。',
      '默认 cwd 是用户选择的真实 Windows 工作区。',
      '不要把 /workspace/... 传给此工具；/workspace/... 只属于 DeepAgents 文件工具。',
      '适合运行测试、构建、脚本和本地命令。'
    ].join('\n'),
    schema,
    func: async (request) => {
      validateRocWindowsCommand(request.command);
      const result = await adapter.executeAgentCommand({ command: request.command, cwd: request.cwd });
      return JSON.stringify(result, null, 2);
    }
  });
}

export function validateRocWindowsCommand(command: string): void {
  if (containsVirtualWorkspacePath(command)) {
    throw new Error(VIRTUAL_WORKSPACE_ERROR);
  }
  if (containsLinuxLocalPath(command)) {
    throw new Error(LINUX_PATH_ERROR);
  }
}

function containsVirtualWorkspacePath(command: string): boolean {
  return /(?:"\/workspace(?:\/|$)[^"]*"|'\/workspace(?:\/|$)[^']*'|(?:^|[\s;&|])\/workspace(?:\/|$)\S*)/i.test(command);
}

function containsLinuxLocalPath(command: string): boolean {
  return /(?:"\/(?:home\/user|tmp)(?:\/|$)[^"]*"|'\/(?:home\/user|tmp)(?:\/|$)[^']*'|(?:^|[\s;&|])\/(?:home\/user|tmp)(?:\/|$)\S*)/i.test(command);
}
