import { describe, expect, it, vi } from 'vitest';
import { createRocWindowsCommandTool } from '../../../../src/main/services/deep-agent/command-tool';

describe('createRocWindowsCommandTool', () => {
  it('runs valid commands through the Roc shell adapter', async () => {
    const executeAgentCommand = vi.fn(async () => ({
      command: 'python .\\create_docx.py',
      cwd: 'F:\\Code\\Roc',
      exitCode: 0,
      output: 'ok',
      truncated: false,
      usedRtk: false
    }));
    const tool = createRocWindowsCommandTool({ executeAgentCommand });

    await expect(tool.invoke({ command: 'python .\\create_docx.py' })).resolves.toContain('"exitCode": 0');
    expect(executeAgentCommand).toHaveBeenCalledWith({ command: 'python .\\create_docx.py', cwd: undefined });
  });

  it('rejects DeepAgents virtual workspace paths before shell execution', async () => {
    const executeAgentCommand = vi.fn();
    const tool = createRocWindowsCommandTool({ executeAgentCommand });

    await expect(tool.invoke({ command: 'copy /workspace/gold_price_scheduler/main.py G:\\杂\\test\\gold_price.py' })).rejects.toThrow(
      'run_shell_command 使用真实 Windows cwd，不接受 DeepAgents 文件工具路由 /workspace/...。'
    );
    expect(executeAgentCommand).not.toHaveBeenCalled();
  });
});
