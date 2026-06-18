import { describe, it, expect } from 'vitest';
import { SystemPromptBuilder, BlockStability } from '../../../../src/main/services/deep-agent/prompt-builder';
import type { FrozenSnapshot, FrozenSnapshotPart } from '../../../../src/main/services/memory/snapshot';

function createFrozenSnapshotPart(input: {
  kind: FrozenSnapshotPart['kind'];
  filename: FrozenSnapshotPart['filename'];
}): FrozenSnapshotPart {
  return {
    kind: input.kind,
    filename: input.filename,
    content: '',
    charCount: 0,
    charLimit: 100,
    source: 'global',
    enabled: true
  };
}

function createFrozenSnapshot(): FrozenSnapshot {
  return {
    user: createFrozenSnapshotPart({ kind: 'user', filename: 'USER.md' }),
    agents: createFrozenSnapshotPart({ kind: 'agents', filename: 'AGENTS.md' }),
    memory: createFrozenSnapshotPart({ kind: 'memory', filename: 'MEMORY.md' }),
    totalChars: 0,
    totalLimit: 300,
    globallyEnabled: true
  };
}

describe('SystemPromptBuilder', () => {
  it('应构建 5 层 Block 结构', () => {
    const blocks = SystemPromptBuilder.build({
      enabledCapabilities: { mcpServers: [], skills: [] },
      workspacePath: 'F:\\Code\\TestProject',
      frozenSnapshot: createFrozenSnapshot(),
      workflowHint: null,
      tools: []
    });

    expect(blocks).toHaveLength(5);
    expect(blocks[0].type).toBe('static');
    expect(blocks[1].type).toBe('workspace');
    expect(blocks[2].type).toBe('tools');
    expect(blocks[3].type).toBe('snapshot');
    expect(blocks[4].type).toBe('capability');
  });

  it('应为每个 Block 生成稳定的哈希', () => {
    const blocks1 = SystemPromptBuilder.build({
      enabledCapabilities: { mcpServers: ['exa'], skills: [] },
      workspacePath: 'F:\\Code\\TestProject',
      frozenSnapshot: createFrozenSnapshot(),
      workflowHint: null,
      tools: []
    });

    const blocks2 = SystemPromptBuilder.build({
      enabledCapabilities: { mcpServers: ['exa'], skills: [] },
      workspacePath: 'F:\\Code\\TestProject',
      frozenSnapshot: createFrozenSnapshot(),
      workflowHint: null,
      tools: []
    });

    expect(blocks1[0].hash).toBe(blocks2[0].hash);
    expect(blocks1[1].hash).toBe(blocks2[1].hash);
  });

  it('工作区路径变化应改变 WorkspaceBlock 哈希', () => {
    const blocks1 = SystemPromptBuilder.build({
      enabledCapabilities: { mcpServers: [], skills: [] },
      workspacePath: 'F:\\Code\\Project1',
      frozenSnapshot: createFrozenSnapshot(),
      workflowHint: null,
      tools: []
    });

    const blocks2 = SystemPromptBuilder.build({
      enabledCapabilities: { mcpServers: [], skills: [] },
      workspacePath: 'F:\\Code\\Project2',
      frozenSnapshot: createFrozenSnapshot(),
      workflowHint: null,
      tools: []
    });

    expect(blocks1[1].hash).not.toBe(blocks2[1].hash);
    expect(blocks1[0].hash).toBe(blocks2[0].hash);
  });

  it('应正确设置稳定性级别', () => {
    const blocks = SystemPromptBuilder.build({
      enabledCapabilities: { mcpServers: [], skills: [] },
      workspacePath: 'F:\\Code\\TestProject',
      frozenSnapshot: createFrozenSnapshot(),
      workflowHint: null,
      tools: []
    });

    expect(blocks[0].stability).toBe(BlockStability.STATIC);
    expect(blocks[1].stability).toBe(BlockStability.WORKSPACE);
    expect(blocks[2].stability).toBe(BlockStability.CAPABILITY);
    expect(blocks[3].stability).toBe(BlockStability.SESSION);
    expect(blocks[4].stability).toBe(BlockStability.CAPABILITY);
  });

  it('应写入新的 Windows 路径边界提示', () => {
    const blocks = SystemPromptBuilder.build({
      enabledCapabilities: { mcpServers: [], skills: [] },
      workspacePath: 'F:\\Code\\Roc',
      frozenSnapshot: createFrozenSnapshot(),
      workflowHint: null,
      tools: []
    });

    const content = blocks[1]?.content ?? '';
    expect(content).toContain('DeepAgents file tools accept only Roc virtual routes: /workspace/, /memory/, and /skills/.');
    expect(content).toContain('Agent memory files live under /memory/.../AGENTS.md, matching DeepAgents memory-source semantics.');
    expect(content).toContain('Use run_shell_command for local Windows commands; its default cwd is the selected Roc workspace root.');
    expect(content).toContain('Never pass /workspace/... to run_shell_command; use a relative path from the default cwd or a real Windows path.');
    expect(content).toContain('Do not pass Windows absolute paths or Linux paths to read_file, write_file, edit_file, ls, glob, or grep.');
    expect(content).toContain('After write_file or edit_file, verify the target via read_file or ls before saying the file was created or changed.');
  });

  it('应添加 DeepAgents 负责的后台任务创建指引', () => {
    const blocks = SystemPromptBuilder.build({
      enabledCapabilities: { mcpServers: [], skills: [] },
      workspacePath: 'F:\\Code\\Roc',
      frozenSnapshot: createFrozenSnapshot(),
      workflowHint: 'propose_background_task',
      tools: []
    });

    const content = blocks.map((block) => block.content).join('\n');

    expect(content).toContain('本轮工作流：创建后台任务。');
    expect(content).toContain(
      '你负责解析用户目标和触发时间；先调用 resolve_background_task_time，再用返回的 trigger 调用 propose_background_task 创建 preview，最后调用 schedule_background_task 落地。'
    );
    expect(content).toContain('创建后台任务不是立即执行任务目标；不要把用户要求定时执行的文件、shell 或业务动作在当前回合直接完成。');
    expect(content).toContain('中文时段解析约定：早上7点=07:00，晚上9点=21:00，中午1点=13:00，晚上12点=00:00。');
    expect(content).toContain('cron trigger 使用五段 cronExpression；nextRunAt 必须是 UTC ISO 字符串。');
    expect(content).toContain('不要自行猜测 nextRunAt；使用 resolve_background_task_time 返回的 trigger。');
    expect(content).toContain(
      'propose_background_task 只填写 goal 和 trigger；不要填写 workspacePath、allowedActions、forbiddenActions、notificationPolicy、enabledCapabilities 或 failurePolicy。'
    );
    expect(content).toContain('后台任务 workspacePath 由 runtime 注入当前 Windows 工作区路径。');
    expect(content).toContain('只有 propose_background_task 返回 previewId 后才能调用 schedule_background_task；缺少 previewId 时报告失败，不要编造。');
    expect(content).toContain('如果触发时间仍不确定，直接请求用户补充明确时间，不要调用 propose_background_task。');
    expect(content).not.toContain('harness 会解析时间');
    expect(content).toContain('resolve_background_task_time');
  });
});
