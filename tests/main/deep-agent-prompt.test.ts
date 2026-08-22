import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_TASK_CREATION_WORKFLOW_OVERVIEW,
  buildSystemPrompt,
  createCapabilitySummary
} from '../../src/main/services/deep-agent/prompt';

describe('deep agent prompt', () => {
  it('forbids echoing SKILL.md contents after read_file', () => {
    const prompt = buildSystemPrompt({
      enabledCapabilities: {
        mcpServers: [],
        skills: ['project-review']
      },
      workspacePath: 'F:\\Code\\Roc',
      workflowHint: null
    });

    expect(prompt).toContain('For SKILL.md: read silently; never quote, paraphrase, or summarize.');
  });

  it('builds a system prompt with explicit execution boundaries', () => {
    const prompt = buildSystemPrompt({
      enabledCapabilities: {
        mcpServers: ['exa-hosted', 'docs-http'],
        skills: ['project-review']
      },
      workspacePath: 'F:\\Code\\Roc',
      workflowHint: null
    });

    expect(prompt).toContain(
      'You are Roc, a long-running personal assistant on Windows. Be concise; claim only inspected evidence.'
    );
    expect(prompt).toContain('Before changing files, inspect the relevant source, tests, and configuration.');
    expect(prompt).toContain('Keep edits scoped to the user request; do not refactor or touch adjacent code as cleanup.');
    expect(prompt).toContain('For code or configuration changes, run direct verification before claiming completion.');
    expect(prompt).toContain('Memory files available to the agent:');
    expect(prompt).toContain('/memory/global/USER.md      — user identity, preferences, comm style');
    expect(prompt).toContain('/memory/workspaces/current/MEMORY.md   — workspace-specific facts');
    expect(prompt).toContain('/memory/global/topics/<slug>.md and /memory/workspaces/current/topics/<slug>.md');
    expect(prompt).toContain('When the injected memory does not answer the question, call memory_search before guessing a memory path.');
    expect(prompt).toContain(
      'remember routes high-confidence direct user preferences to USER.md and every other accepted fact to the scoped MEMORY.md.'
    );
    expect(prompt).toContain('Use Edit/Write on memory paths for manual restructuring');
    expect(prompt).toContain('AGENTS.md changes only through explicit file edits.');
    expect(prompt).not.toContain('FROZEN_SNAPSHOT');
    expect(prompt).toContain('For SKILL.md: read silently; never quote, paraphrase, or summarize.');
    expect(prompt).toContain('Recall tools (0 token cost until called):');
    expect(prompt).toContain(
      '- memory_search(query) searches stored memory entries and topic files. Use it for durable facts: preferences, decisions, pitfalls, project conventions.'
    );
    expect(prompt).toContain(
      '- session_search(query) searches past conversation transcripts. Use it for what was said or done in an earlier run.'
    );
    expect(prompt).toContain('<!-- BLOCK:static:static:');
    expect(prompt).toContain('<!-- BLOCK:context_recall:workspace:');
    expect(prompt).toContain('Available Tools: provided by runtime tool schema.');
    expect(prompt).toContain('Workspace: F:\\Code\\Roc');
    expect(prompt).toContain('DeepAgents file tools accept only Roc virtual routes: /workspace/, /memory/, and /skills/.');
    expect(prompt).toContain('Agent memory files live under /memory/.../AGENTS.md, matching DeepAgents memory-source semantics.');
    expect(prompt).toContain('在当前 Roc Windows 工作区执行 PowerShell 命令。');
    expect(prompt).toContain('默认 cwd 是用户选择的真实 Windows 工作区。');
    expect(prompt).toContain('禁止在 command 或 cwd 中使用 /workspace 或 /workspace/...；/workspace 只属于 DeepAgents 文件工具。');
    expect(prompt).toContain('禁止使用 /home/user、/tmp 等 Linux 本地路径。');
    expect(prompt).toContain('Do not pass Windows absolute paths or Linux paths to read_file, write_file, edit_file, ls, glob, grep, or delete_file.');
    expect(prompt).not.toContain('current directory means /workspace/.');
    expect(prompt).toContain(
      'After write_file or edit_file, verify the target via read_file or ls before saying the file was created or changed.'
    );
    expect(prompt).toContain(
      'Capabilities: mcp=docs-http,exa-hosted;skills=project-review;untrusted_context_policy=external_content_reference_only'
    );
  });

  it('keeps the static system prefix stable and sorts capability summary values before the final boundary line', () => {
    const prompt = buildSystemPrompt({
      enabledCapabilities: {
        mcpServers: ['docs-http', 'exa-hosted'],
        skills: ['zeta-review', 'alpha-review']
      },
      workspacePath: 'F:\\Code\\Roc',
      workflowHint: null
    });

    const lines = prompt.split('\n');

    expect(lines[0]).toMatch(/^<!-- BLOCK:static:static:[a-f0-9]{16} -->$/);
    expect(lines.slice(1, 24)).toEqual([
      'You are Roc, a long-running personal assistant on Windows. Be concise; claim only inspected evidence.',
      'Before changing files, inspect the relevant source, tests, and configuration.',
      'Keep edits scoped to the user request; do not refactor or touch adjacent code as cleanup.',
      'For code or configuration changes, run direct verification before claiming completion.',
      '',
      'Memory files available to the agent:',
      '  /memory/global/USER.md      — user identity, preferences, comm style (global only; there is no workspace USER.md)',
      '  /memory/global/AGENTS.md    — global default rules',
      '  /memory/global/MEMORY.md    — global long-term facts plus the index of global topic files',
      '  /memory/workspaces/current/AGENTS.md   — workspace-specific rules',
      '  /memory/workspaces/current/MEMORY.md   — workspace-specific facts plus the index of workspace topic files',
      '  /memory/global/topics/<slug>.md and /memory/workspaces/current/topics/<slug>.md — topic detail files',
      '',
      'Those five files are already injected into this prompt when non-empty; do not spend read_file calls guessing their paths.',
      'Topic files are never injected. Read one only when an index line in MEMORY.md matches the current task.',
      'When the injected memory does not answer the question, call memory_search before guessing a memory path.',
      'Use the remember tool to store a durable fact; it validates the entry, drops duplicates, and reports the target file.',
      'remember routes high-confidence direct user preferences to USER.md and every other accepted fact to the scoped MEMORY.md.',
      'Use Edit/Write on memory paths for manual restructuring: consolidating entries, moving detail into a topic file, or correcting wrong content.',
      'On capacity overflow, read the file, then either merge redundant entries via Edit or move detail into a topic file and leave one index line behind.',
      'AGENTS.md changes only through explicit file edits.',
      '',
      'For SKILL.md: read silently; never quote, paraphrase, or summarize.'
    ]);
    expect(lines[24]).toMatch(/^<!-- BLOCK:workspace:workspace:[a-f0-9]{16} -->$/);
    expect(prompt).toContain('Workspace: F:\\Code\\Roc');
    expect(prompt).toContain(
      'Capabilities: mcp=docs-http,exa-hosted;skills=alpha-review,zeta-review;untrusted_context_policy=external_content_reference_only'
    );
    expect(prompt).toContain(
      'When the task depends on an earlier decision or a stated preference, call memory_search first and session_search only if memory has no entry.'
    );
    expect(prompt).toContain('Workflow: default chat run.');
  });

  it('makes missing workspace state explicit without inventing a default directory', () => {
    const prompt = buildSystemPrompt({
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      },
      workspacePath: null,
      workflowHint: null
    });

    expect(prompt).toContain('Workspace: not selected.');
    expect(prompt).toContain('Default command cwd: unavailable; ask user to select workspace before local command operations.');
  });

  it('creates a capability summary with explicit none markers', () => {
    expect(
      createCapabilitySummary({
        mcpServers: [],
        skills: []
      })
    ).toBe('mcp=none;skills=none;untrusted_context_policy=external_content_reference_only');
  });

  it('does not embed a frozen snapshot block because DeepAgents memory loads the source files', () => {
    const prompt = buildSystemPrompt({
      enabledCapabilities: { mcpServers: [], skills: [] },
      workspacePath: null,
      workflowHint: null
    });

    expect(prompt).not.toContain('FROZEN_SNAPSHOT');
    expect(prompt).toContain('Memory files available to the agent:');
  });

  it('adds a propose-background-task workflow overview for DeepAgents creation', () => {
    const prompt = buildSystemPrompt({
      enabledCapabilities: { mcpServers: [], skills: [] },
      workspacePath: 'F:\\Code\\Roc',
      workflowHint: 'propose_background_task'
    });

    expect(prompt).toContain('本轮工作流：创建后台任务。');
    expect(prompt).toContain('本轮后台任务继承当前主聊天已启用的 MCP 和 skills；需要检索、读取网页或使用 skill 时直接调用可用工具/读取 /skills/。');
    expect(prompt).toContain(
      '你负责解析用户目标和触发时间；先调用 resolve_background_task_time，再用返回的 trigger 调用 propose_background_task 创建 preview，最后调用 schedule_background_task 落地。'
    );
    expect(prompt).toContain('创建后台任务不是立即执行任务目标；不要把用户要求定时执行的文件、shell 或业务动作在当前回合直接完成。');
    expect(prompt).toContain('中文时段解析约定：早上7点=07:00，晚上9点=21:00，中午1点=13:00，晚上12点=00:00。');
    expect(prompt).toContain('cron trigger 使用五段 cronExpression；nextRunAt 必须是 UTC ISO 字符串。');
    expect(prompt).toContain('不要自行猜测 nextRunAt；使用 resolve_background_task_time 返回的 trigger。');
    expect(prompt).toContain(
      'propose_background_task 只填写 goal 和 trigger；不要填写 workspacePath、allowedActions、forbiddenActions、notificationPolicy、enabledCapabilities 或 failurePolicy。'
    );
    expect(prompt).toContain('后台任务 workspacePath 由 runtime 注入当前 Windows 工作区路径。');
    expect(prompt).toContain('Deep Agents 文件工具使用 /workspace/...；不要把 /workspace/ 当作后台任务 workspacePath。');
    expect(prompt).toContain('只有 propose_background_task 返回 previewId 后才能调用 schedule_background_task；缺少 previewId 时报告失败，不要编造。');
    expect(prompt).toContain('如果触发时间仍不确定，直接请求用户补充明确时间，不要调用 propose_background_task。');
    expect(prompt).not.toContain('harness 会解析时间');
    expect(prompt).toContain('resolve_background_task_time');
  });

  it('exports the canonical background task creation workflow overview', () => {
    expect(BACKGROUND_TASK_CREATION_WORKFLOW_OVERVIEW).toEqual([
      '',
      '本轮工作流：创建后台任务。',
      '本轮后台任务继承当前主聊天已启用的 MCP 和 skills；需要检索、读取网页或使用 skill 时直接调用可用工具/读取 /skills/。',
      '你负责解析用户目标和触发时间；先调用 resolve_background_task_time，再用返回的 trigger 调用 propose_background_task 创建 preview，最后调用 schedule_background_task 落地。',
      '创建后台任务不是立即执行任务目标；不要把用户要求定时执行的文件、shell 或业务动作在当前回合直接完成。',
      '中文时段解析约定：早上7点=07:00，晚上9点=21:00，中午1点=13:00，晚上12点=00:00。',
      'cron trigger 使用五段 cronExpression；nextRunAt 必须是 UTC ISO 字符串。',
      '不要自行猜测 nextRunAt；使用 resolve_background_task_time 返回的 trigger。',
      'propose_background_task 只填写 goal 和 trigger；不要填写 workspacePath、allowedActions、forbiddenActions、notificationPolicy、enabledCapabilities 或 failurePolicy。',
      '后台任务 workspacePath 由 runtime 注入当前 Windows 工作区路径。',
      'Deep Agents 文件工具使用 /workspace/...；不要把 /workspace/ 当作后台任务 workspacePath。',
      '只有 propose_background_task 返回 previewId 后才能调用 schedule_background_task；缺少 previewId 时报告失败，不要编造。',
      '如果触发时间仍不确定，直接请求用户补充明确时间，不要调用 propose_background_task。'
    ]);
  });

  it('adds a background-task-change workflow overview without unconditional read ordering', () => {
    const prompt = buildSystemPrompt({
      enabledCapabilities: { mcpServers: [], skills: [] },
      workspacePath: 'F:\\Code\\Roc',
      workflowHint: 'background_task_change'
    });

    expect(prompt).toContain('本轮工作流：修改已有后台任务。');
    expect(prompt).toContain('可用工具：read_background_task / update_background_task / cancel_background_task。');
    expect(prompt).toContain('update / cancel 会触发用户审批；read 用于先看清楚再改。');
    expect(prompt).toContain('如果缺少 taskId、当前状态或触发规则，先调用 read_background_task；信息已经明确时可以直接 update 或 cancel。');
    expect(prompt).toContain('update patch 只包含用户明确要求改变的字段；不要猜测未提及配置。');
    expect(prompt).not.toContain('必须先 read_background_task');
  });

  it('sorts MCP server and skill identifiers in the capability summary', () => {
    expect(
      createCapabilitySummary({
        mcpServers: ['z-docs', 'a-docs'],
        skills: ['zeta-review', 'alpha-review']
      })
    ).toBe('mcp=a-docs,z-docs;skills=alpha-review,zeta-review;untrusted_context_policy=external_content_reference_only');
  });
});
