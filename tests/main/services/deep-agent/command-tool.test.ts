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
      '/workspace/ 是 DeepAgents 文件工具路由，不是 Windows shell 路径。'
    );
    expect(executeAgentCommand).not.toHaveBeenCalled();
  });

  it('rejects DeepAgents virtual workspace paths in option values before shell execution', async () => {
    const executeAgentCommand = vi.fn();
    const tool = createRocWindowsCommandTool({ executeAgentCommand });

    await expect(tool.invoke({ command: 'python .\\main.py --input=/workspace/gold_price_scheduler/main.py' })).rejects.toThrow(
      '/workspace/ 是 DeepAgents 文件工具路由，不是 Windows shell 路径。'
    );
    expect(executeAgentCommand).not.toHaveBeenCalled();
  });

  it('rejects DeepAgents virtual workspace cwd before shell execution', async () => {
    const executeAgentCommand = vi.fn();
    const tool = createRocWindowsCommandTool({ executeAgentCommand });

    await expect(tool.invoke({ command: 'python .\\main.py', cwd: '/workspace/gold_price_scheduler' })).rejects.toThrow(
      '/workspace/ 是 DeepAgents 文件工具路由，不是 Windows shell 路径。'
    );
    expect(executeAgentCommand).not.toHaveBeenCalled();
  });

  it('rejects Linux local paths before shell execution', async () => {
    const executeAgentCommand = vi.fn();
    const tool = createRocWindowsCommandTool({ executeAgentCommand });

    await expect(tool.invoke({ command: 'python /home/user/workarea/create_docx.py' })).rejects.toThrow(
      'Roc 在 Windows 本地执行命令；请使用当前工作区 cwd 下的相对路径或 Windows 路径。'
    );
    expect(executeAgentCommand).not.toHaveBeenCalled();
  });
});
