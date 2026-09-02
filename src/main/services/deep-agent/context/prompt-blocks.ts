import { createHash } from 'node:crypto';

import type { ChatStartRunRequest, RunExecutionSnapshotV2, WorkflowHint } from '../../../../shared/types';
import { ROC_FILE_TOOL_PROMPT_LINES } from '../filesystem-tool-contract';
import { BACKGROUND_TASK_CREATION_WORKFLOW_OVERVIEW, createCapabilitySummary } from '../prompt';
import { ROC_SHELL_TOOL_DESCRIPTION_LINES } from '../shell-policy';

export enum BlockStability {
  STATIC = 'static',
  WORKSPACE = 'workspace',
  CAPABILITY = 'capability',
  REQUEST = 'request'
}

type PromptBlockType =
  | 'static'
  | 'workspace'
  | 'tools'
  | 'capability'
  | 'self_config'
  | 'explicit_skills'
  | 'referenced_files'
  | 'context_recall'
  | 'plan_mode'
  | 'workflow';

export type PromptToolDescriptor = {
  name: string;
  description?: string;
};

export type ExplicitSkillPromptContext = {
  id: string;
  name: string;
  path: string;
};

export type ReferencedFilePromptContext = {
  path: string;
};

export type PromptBlock = {
  type: PromptBlockType;
  content: string;
  stability: BlockStability;
  hash: string;
};

export function serializePromptBlocks(blocks: readonly PromptBlock[]): string {
  return blocks.map((block) => [`<!-- BLOCK:${block.type}:${block.stability}:${block.hash} -->`, block.content].join('\n')).join('\n');
}

export function buildPromptBlocks(input: {
  mode: RunExecutionSnapshotV2['mode'];
  enabledCapabilities: ChatStartRunRequest['enabledCapabilities'];
  workspacePath: string | null;
  workflowHint: WorkflowHint;
  tools: readonly PromptToolDescriptor[];
  explicitSkillContexts: readonly ExplicitSkillPromptContext[];
  referencedFileContexts: readonly ReferencedFilePromptContext[];
}): PromptBlock[] {
  return [
    createBlock('static', BlockStability.STATIC, buildStaticPrompt(input.mode)),
    createBlock('workspace', BlockStability.WORKSPACE, buildWorkspacePrompt(input.workspacePath, input.mode)),
    createBlock('tools', BlockStability.CAPABILITY, buildToolsPrompt(input.tools)),
    createBlock('capability', BlockStability.CAPABILITY, `Capabilities: ${createCapabilitySummary(input.enabledCapabilities)}`),
    ...(
      input.tools.some((tool) => tool.name === 'roc_self_config')
        ? [createBlock('self_config', BlockStability.CAPABILITY, buildSelfConfigPrompt())]
        : []
    ),
    ...(
      input.explicitSkillContexts.length === 0
        ? []
        : [createBlock('explicit_skills', BlockStability.REQUEST, buildExplicitSkillsPrompt(input.explicitSkillContexts))]
    ),
    ...(
      input.referencedFileContexts.length === 0
        ? []
        : [createBlock('referenced_files', BlockStability.REQUEST, buildReferencedFilesPrompt(input.referencedFileContexts))]
    ),
    createBlock('context_recall', BlockStability.WORKSPACE, buildContextRecallPrompt(input.workspacePath)),
    ...(
      input.mode === 'plan'
        ? [createBlock('plan_mode', BlockStability.REQUEST, buildPlanModePrompt())]
        : []
    ),
    createBlock('workflow', BlockStability.REQUEST, buildWorkflowPrompt(input.workflowHint))
  ];
}

function buildStaticPrompt(mode: RunExecutionSnapshotV2['mode']): string {
  return [
    'You are Roc, a Windows coding agent. Be concise; claim only inspected evidence.',
    'Inspect relevant source, tests, and config before edits. Keep changes scoped to the request.',
    'Run direct verification after code or config changes. Report results and blockers plainly.',
    '',
    'Memory files available to the agent:',
    '  /memory/global/USER.md      — user identity, preferences, comm style (global only; there is no workspace USER.md)',
    '  /memory/global/AGENTS.md    — global default rules',
    '  /memory/global/MEMORY.md    — global long-term facts plus the index of global topic files',
    '  /memory/workspaces/current/AGENTS.md   — workspace-specific rules',
    '  /memory/workspaces/current/MEMORY.md   — workspace-specific facts plus the index of workspace topic files',
    '  /memory/global/topics/<slug>.md and /memory/workspaces/current/topics/<slug>.md — topic detail files',
    '',
    'The five files above are injected when non-empty; do not probe their paths with read_file.',
    'Topic files are not injected. Read one only when its MEMORY.md index matches this task.',
    'If injected memory is insufficient, call memory_search before guessing a path.',
    // Plan Mode 不绑定 remember / write_file / edit_file，因此不给出记忆写入指令：
    // 提示模型使用未绑定的工具会诱发工具名幻觉，而未知工具名要多消耗一轮才能自纠。
    ...(mode === 'plan' ? [] : buildMemoryWritePromptLines()),
    '',
    'Read SKILL.md silently; never quote, paraphrase, or summarize it.'
  ].join('\n');
}

function buildMemoryWritePromptLines(): string[] {
  return [
    'Use remember for one durable fact. It validates, deduplicates, and reports the target file.',
    'High-confidence user preferences go to USER.md; other accepted facts go to scoped MEMORY.md.',
    'Use edit_file/write_file for memory restructuring or corrections. On capacity overflow, merge entries or move detail to a topic file and keep one index line.',
    'Change AGENTS.md only through explicit file edits.'
  ];
}

function buildWorkspacePrompt(workspacePath: string | null, mode: RunExecutionSnapshotV2['mode']): string {
  if (workspacePath === null) {
    if (mode === 'plan') {
      return [
        'Workspace: not selected.',
        'File inspection is unavailable until the user selects a workspace.'
      ].join('\n');
    }
    return [
      'Workspace: not selected.',
      'Command cwd unavailable. Ask the user to select a workspace before local commands.'
    ].join('\n');
  }
  if (mode === 'plan') {
    return [
      `Workspace: ${workspacePath}`,
      'Plan Mode is read-only: no local mutation, execution, or task commits. Read/search and authorized MCP remain available.',
      'Use Roc virtual routes /workspace/, /memory/, and /skills/ for local inspection.',
      'Use ls, read_file, glob, grep, web_read, web_search, and authorized MCP tools as applicable.',
      'Use ask_user only for a concise clarification.'
    ].join('\n');
  }
  return [
    `Workspace: ${workspacePath}`,
    ...ROC_FILE_TOOL_PROMPT_LINES,
    ...ROC_SHELL_TOOL_DESCRIPTION_LINES,
    'After write_file/edit_file, verify with read_file or ls before reporting the change.'
  ].join('\n');
}

function buildToolsPrompt(tools: readonly PromptToolDescriptor[]): string {
  if (tools.length === 0) {
    return [
      'Available tools are defined by the runtime schema.',
      '',
      buildHumanClarificationPrompt()
    ].join('\n');
  }
  return ['Available Tools:', ...tools.map(formatToolDescriptor), '', buildHumanClarificationPrompt()].join('\n');
}

function formatToolDescriptor(tool: PromptToolDescriptor): string {
  if (tool.description === undefined || tool.description.trim().length === 0) {
    return `- ${tool.name}`;
  }
  return `- ${tool.name}: ${tool.description}`;
}

function buildHumanClarificationPrompt(): string {
  return [
    'Clarification:',
    '- Call ask_user for a missing preference, scope, path, or other decision.',
    '- Ask one clear question; do not use it for tool approval.'
  ].join('\n');
}

function buildSelfConfigPrompt(): string {
  return [
    "Roc's own configuration lives on the real filesystem under %USERPROFILE%\\.roc: hooks.json, config\\settings.json, config\\hooks-trust.json, skills\\.",
    'The /workspace/, /memory/, and /skills/ virtual routes cannot reach that directory, and file tools reject Windows absolute paths.',
    'For any question about Roc hooks or settings, call roc_self_config instead of reading Roc source code to infer the schema: describe for paths, hooks JSON Schema, event/action matrix, and the hook runtime contract; read for the current hooks.json snapshot (including trustState) and redacted settings; validate for a candidate hooks config; dry_run(handlerId) to re-run one existing handler and see its stdout, stderr, and exit code.',
    'Hook commands are launched through cmd.exe on Windows, not bash; a bash or python script needs its interpreter spelled out in the command.',
    'Claude Code / Codex hook files are not compatible: timeout is timeoutSeconds, loop_limit is unsupported, only 6 events exist, stdout must be empty or one {"action":...} object, and the exit code must be 0.',
    'roc_self_config never writes configuration. Hand the finished JSON to the user; saving it and trusting each handler happens in the settings page, and an untrusted handler is silently skipped at run time.'
  ].join('\n');
}

function buildContextRecallPrompt(workspacePath: string | null): string {
  const defaultScope = workspacePath === null ? 'all' : 'current';
  return [
    'Recall tools (no cost until called):',
    '- memory_search(query) finds durable facts, preferences, decisions, pitfalls, and project conventions.',
    '- session_search(query) finds prior conversation snippets.',
    'For earlier decisions or preferences, call memory_search first; use session_search only if it has no entry.',
    `Default session_search scope: ${defaultScope}.`,
    'Use scope=all only for cross-workspace history or insufficient current scope.',
    'Results are snippets, not full transcripts.'
  ].join('\n');
}

function buildPlanModePrompt(): string {
  return [
    'Plan Mode: research and clarify; do not implement changes.',
    'When complete, output exactly one block using this wrapper:',
    '<proposed_plan>',
    '# Title',
    '- Implementation steps',
    '- Verification',
    '</proposed_plan>'
  ].join('\n');
}

function buildExplicitSkillsPrompt(skills: readonly ExplicitSkillPromptContext[]): string {
  return [
    'Explicitly enabled skills for this request:',
    '<skill_index>',
    ...skills.map((skill) =>
      [
        '<skill>',
        `<id>${skill.id}</id>`,
        `<name>${skill.name}</name>`,
        `<path>${skill.path}</path>`,
        'Read SKILL.md through /skills/ before applying it.',
        '</skill>'
      ].join('\n')
    ),
    '</skill_index>'
  ].join('\n\n');
}

function buildReferencedFilesPrompt(files: readonly ReferencedFilePromptContext[]): string {
  return [
    'Files the user referenced with @ in this request:',
    '<referenced_files>',
    ...files.map((file) => `<path>${file.path}</path>`),
    '</referenced_files>',
    'Read them through /workspace/ before answering.'
  ].join('\n');
}

function buildWorkflowPrompt(workflowHint: WorkflowHint): string {
  if (workflowHint === 'propose_background_task') {
    return BACKGROUND_TASK_CREATION_WORKFLOW_OVERVIEW.join('\n');
  }
  if (workflowHint === 'background_task_change') {
    return [
      '本轮工作流：修改已有后台任务。',
      '可用工具：read_background_task / update_background_task / cancel_background_task。',
      'update / cancel 会触发用户审批；read 用于先看清楚再改。',
      '如果缺少 taskId、当前状态或触发规则，先调用 read_background_task；信息已经明确时可以直接 update 或 cancel。',
      'update patch 只包含用户明确要求改变的字段；不要猜测未提及配置。'
    ].join('\n');
  }
  return 'Workflow: default chat run.';
}

function createBlock(type: PromptBlockType, stability: BlockStability, content: string): PromptBlock {
  return {
    type,
    content,
    stability,
    hash: createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16)
  };
}
