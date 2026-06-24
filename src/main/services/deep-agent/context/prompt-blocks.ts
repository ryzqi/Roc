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

export type PromptBlockType = 'static' | 'workspace' | 'tools' | 'capability' | 'context_recall' | 'workflow';

export type PromptToolDescriptor = {
  name: string;
  description?: string;
};

export type PromptBlock = {
  type: PromptBlockType;
  content: string;
  stability: BlockStability;
  hash: string;
};

export function buildPromptBlocks(input: {
  enabledCapabilities: ChatStartRunRequest['enabledCapabilities'];
  workspacePath: string | null;
  workflowHint: WorkflowHint;
  tools: readonly PromptToolDescriptor[];
}): PromptBlock[] {
  return [
    createBlock('static', BlockStability.STATIC, buildStaticPrompt()),
    createBlock('workspace', BlockStability.WORKSPACE, buildWorkspacePrompt(input.workspacePath)),
    createBlock('tools', BlockStability.CAPABILITY, buildToolsPrompt(input.tools)),
    createBlock('capability', BlockStability.CAPABILITY, `Capabilities: ${createCapabilitySummary(input.enabledCapabilities)}`),
    createBlock('context_recall', BlockStability.WORKSPACE, buildContextRecallPrompt(input.workspacePath)),
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

function buildWorkspacePrompt(workspacePath: string | null): string {
  if (workspacePath === null) {
    return [
      'Workspace: not selected.',
      'Default command cwd: unavailable; ask user to select workspace before local command operations.'
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
    return 'Available Tools: provided by runtime tool schema.';
  }
  return ['Available Tools:', ...tools.map(formatToolDescriptor)].join('\n');
}

function formatToolDescriptor(tool: PromptToolDescriptor): string {
  if (tool.description === undefined || tool.description.trim().length === 0) {
    return `- ${tool.name}`;
  }
  return `- ${tool.name}: ${tool.description}`;
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
