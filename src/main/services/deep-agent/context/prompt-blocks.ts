import { createHash } from 'node:crypto';

import type { ChatStartRunRequest, WorkflowHint } from '../../../../shared/types';
import { ROC_FILE_TOOL_PROMPT_LINES } from '../filesystem-tool-contract';
import { BACKGROUND_TASK_CREATION_WORKFLOW_OVERVIEW, createCapabilitySummary } from '../prompt';

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
  | 'context_recall'
  | 'plan_mode'
  | 'workflow';

export type PromptToolDescriptor = {
  name: string;
  description?: string;
};

export type ExplicitSkillPromptContext = {
  name: string;
  path: string;
  content: string;
};

export type PromptBlock = {
  type: PromptBlockType;
  content: string;
  stability: BlockStability;
  hash: string;
};

export function buildPromptBlocks(input: {
  mode: ChatStartRunRequest['mode'];
  enabledCapabilities: ChatStartRunRequest['enabledCapabilities'];
  workspacePath: string | null;
  workflowHint: WorkflowHint;
  tools: readonly PromptToolDescriptor[];
  explicitSkillContexts: readonly ExplicitSkillPromptContext[];
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
    'Persistent memory is stored in Roc SQLite through DeepAgents memory and is visible in later sessions:',
    '  /memory/global/USER.md      — user identity, preferences, comm style (~500 tok cap)',
    '  /memory/global/AGENTS.md    — global default rules (~300 tok cap)',
    '  /memory/global/MEMORY.md    — global long-term facts (~800 tok cap)',
    '  /memory/workspaces/current/AGENTS.md   — workspace-specific rules (overrides global if exists)',
    '  /memory/workspaces/current/MEMORY.md   — workspace-specific facts (overrides global if exists)',
    '',
    'Use Edit/Write on those paths. On capacity overflow you receive "X/Y, please consolidate" — read the file, merge/drop redundant entries via Edit, then retry.',
    'Automatic writes only append to MEMORY.md; USER.md and AGENTS.md change only through explicit file edits.',
    '',
    'For SKILL.md: read silently; never quote, paraphrase, or summarize.'
  ].join('\n');
}

function buildWorkspacePrompt(workspacePath: string | null, mode: ChatStartRunRequest['mode']): string {
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
      'Plan Mode blocks local file mutation tools but keeps read, search, and selected MCP tools available.',
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
    'Use session_search(query) to recall what was discussed in past conversations (0 token cost until called).',
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
    'Explicitly loaded skills for this request:',
    ...skills.map((skill) =>
      [
        '<skill>',
        `<name>${skill.name}</name>`,
        `<path>${skill.path}</path>`,
        skill.content,
        '</skill>'
      ].join('\n')
    )
  ].join('\n\n');
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
