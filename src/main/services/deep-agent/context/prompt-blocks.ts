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
    createBlock('static', BlockStability.STATIC, buildStaticPrompt()),
    createBlock('workspace', BlockStability.WORKSPACE, buildWorkspacePrompt(input.workspacePath, input.mode)),
    createBlock('tools', BlockStability.CAPABILITY, buildToolsPrompt(input.tools)),
    createBlock('capability', BlockStability.CAPABILITY, `Capabilities: ${createCapabilitySummary(input.enabledCapabilities)}`),
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

function buildStaticPrompt(): string {
  return [
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
  ].join('\n');
}

function buildWorkspacePrompt(workspacePath: string | null, mode: RunExecutionSnapshotV2['mode']): string {
  if (workspacePath === null) {
    if (mode === 'plan') {
      return [
        'Workspace: not selected.',
        'Plan Mode file inspection is unavailable until the user selects a workspace.'
      ].join('\n');
    }
    return [
      'Workspace: not selected.',
      'Default command cwd: unavailable; ask user to select workspace before local command operations.'
    ].join('\n');
  }
  if (mode === 'plan') {
    return [
      `Workspace: ${workspacePath}`,
      'Plan Mode blocks local mutation, execution, and task-commit tools while keeping read, search, and selected MCP tools available under MCP authorization policy.',
      'Local file inspection uses Roc virtual routes: /workspace/, /memory/, and /skills/.',
      'Use ls, read_file, glob, and grep for local inspection in Plan Mode.',
      'Use web_read for public web pages and web_search for current public search.',
      'Use selected MCP tools when the enabled MCP configuration provides relevant context or search capabilities.',
      'Use ask_user only for concise clarifying questions when needed.'
    ].join('\n');
  }
  return [
    `Workspace: ${workspacePath}`,
    ...ROC_FILE_TOOL_PROMPT_LINES,
    ...ROC_SHELL_TOOL_DESCRIPTION_LINES,
    'After write_file or edit_file, verify the target via read_file or ls before saying the file was created or changed.'
  ].join('\n');
}

function buildToolsPrompt(tools: readonly PromptToolDescriptor[]): string {
  if (tools.length === 0) {
    return [
      'Available Tools: provided by runtime tool schema.',
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
    'Human clarification:',
    '- You may call ask_user when a user preference, scope decision, path choice, or clarification would improve the result.',
    '- Ask one clear question at a time.',
    '- Avoid fragmented repeated questions; gather enough context first when possible.',
    '- Do not use ask_user for approval of tool calls.'
  ].join('\n');
}

function buildContextRecallPrompt(workspacePath: string | null): string {
  const defaultScope = workspacePath === null ? 'all' : 'current';
  return [
    'Recall tools (0 token cost until called):',
    '- memory_search(query) searches stored memory entries and topic files. Use it for durable facts: preferences, decisions, pitfalls, project conventions.',
    '- session_search(query) searches past conversation transcripts. Use it for what was said or done in an earlier run.',
    'When the task depends on an earlier decision or a stated preference, call memory_search first and session_search only if memory has no entry.',
    `Default session_search scope: ${defaultScope}.`,
    'Use scope=all only when the user asks for cross-workspace history or current scoped recall is insufficient.',
    'Session search returns snippets, not full transcript content.'
  ].join('\n');
}

function buildPlanModePrompt(): string {
  return [
    'Plan Mode: research, ask concise clarifying questions when needed, and do not implement changes.',
    'When the plan is complete, output exactly one final proposed plan block.',
    'Use this exact wrapper:',
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
        'Read the SKILL.md file through the /skills/ route before applying it.',
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
    'Read them through the /workspace/ route before answering; the user pointed at them deliberately.'
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
