# Slash Skill Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/skill <skill-id> <prompt>` in the chat input so the named skill's `SKILL.md` is explicitly loaded into the current run context without changing `enabledCapabilities.skills`.

**Architecture:** Renderer parses only the slash command prefix and sends `explicitSkillIds` beside the cleaned user prompt. Main process validates and reads the explicit skills, then appends a request-scoped prompt block before building the DeepAgent. Existing selected skills still flow through `enabledCapabilities.skills` and the DeepAgents skills catalog.

**Tech Stack:** TypeScript ESM, React 19 renderer, Electron IPC capability schemas, DeepAgents, Vitest.

## Global Constraints

- `/skill` must not select, overwrite, append, or persist `enabledCapabilities.skills`.
- `SKILL.md` content must be read in the main process, not in renderer.
- User message history must store the cleaned prompt, not the `/skill ...` control prefix.
- Other skills remain discoverable only through existing name/description catalog behavior.
- No new dependencies.
- Preserve existing TypeScript style: 2 spaces, semicolons, single quotes.
- Verification commands use PowerShell.

---

## File Structure

- Create `src/renderer/chat/slash-skill-command.ts`: pure parser for `/skill <id> <prompt>`.
- Modify `src/renderer/chat/task-run-payload.ts`: add `explicitSkillIds?: string[]`.
- Modify `src/renderer/chat/chat-view.tsx`: apply parser before submit; pass `explicitSkillIds`.
- Modify `src/renderer/app/use-app-task-runs.ts`: pass `explicitSkillIds` into `ChatStartRunRequest`.
- Modify `src/shared/types/chat.ts`: add `explicitSkillIds?: string[]` to `ChatStartRunRequest`.
- Modify `src/main/plugins/agent/index.ts`: validate `explicitSkillIds`.
- Modify `src/main/plugins/agent/runtime-types.ts`: retain `explicitSkillIds` through HITL interrupt/resume.
- Modify `src/main/plugins/agent/runtime.ts`: copy `explicitSkillIds` into resumed requests.
- Create `src/main/services/deep-agent/context/explicit-skills.ts`: main-side validation and `SKILL.md` loading via skills capabilities.
- Modify `src/main/services/deep-agent/context/prompt-blocks.ts`: add `explicit_skills` request block.
- Modify `src/main/services/deep-agent/context/context-assembler.ts`: accept explicit skill contexts.
- Modify `src/main/plugins/agent/deep-agent-executor.ts`: load explicit skills before assembling context.
- Modify tests under `tests/renderer` and `tests/main/plugins/agent`.

---

### Task 1: Shared Request Contract And Parser

**Files:**
- Create: `src/renderer/chat/slash-skill-command.ts`
- Modify: `src/renderer/chat/task-run-payload.ts`
- Modify: `src/shared/types/chat.ts`
- Test: `tests/renderer/chat-composer.test.ts`

**Interfaces:**
- Produces: `parseSlashSkillCommand(value: string): SlashSkillCommandParseResult`
- Produces: `ChatTaskSubmitPayload.explicitSkillIds?: string[]`
- Produces: `ChatStartRunRequest.explicitSkillIds?: string[]`
- Consumes: existing renderer submit code in later tasks.

- [ ] **Step 1: Write parser tests**

Append this block to `tests/renderer/chat-composer.test.ts`:

```typescript
import { parseSlashSkillCommand } from '../../src/renderer/chat/slash-skill-command';

describe('slash skill command parser', () => {
  it('parses slash skill command into explicit skill id and cleaned input', () => {
    expect(parseSlashSkillCommand('/skill python-expert 优化这段代码')).toEqual({
      kind: 'ok',
      input: '优化这段代码',
      explicitSkillIds: ['python-expert']
    });
  });

  it('keeps multiline prompt after the skill id', () => {
    expect(parseSlashSkillCommand('/skill python-expert\n优化这段代码')).toEqual({
      kind: 'ok',
      input: '优化这段代码',
      explicitSkillIds: ['python-expert']
    });
  });

  it('does not treat other slash text or inline slash skill text as a command', () => {
    expect(parseSlashSkillCommand('/skills python-expert')).toEqual({
      kind: 'none',
      input: '/skills python-expert'
    });
    expect(parseSlashSkillCommand('请使用 /skill python-expert')).toEqual({
      kind: 'none',
      input: '请使用 /skill python-expert'
    });
  });

  it('returns concrete errors for missing id and missing prompt', () => {
    expect(parseSlashSkillCommand('/skill')).toEqual({
      kind: 'error',
      message: '请输入 Skill ID。'
    });
    expect(parseSlashSkillCommand('/skill python-expert')).toEqual({
      kind: 'error',
      message: '请输入要发送的内容。'
    });
  });
});
```

- [ ] **Step 2: Run parser tests and verify failure**

Run:

```powershell
pnpm test -- tests/renderer/chat-composer.test.ts
```

Expected: FAIL with an import error for `slash-skill-command`.

- [ ] **Step 3: Add parser implementation**

Create `src/renderer/chat/slash-skill-command.ts`:

```typescript
export type SlashSkillCommandParseResult =
  | {
      kind: 'none';
      input: string;
    }
  | {
      kind: 'ok';
      input: string;
      explicitSkillIds: string[];
    }
  | {
      kind: 'error';
      message: string;
    };

export function parseSlashSkillCommand(value: string): SlashSkillCommandParseResult {
  if (!startsWithSkillCommand(value)) {
    return {
      kind: 'none',
      input: value
    };
  }

  const commandBody = value.slice('/skill'.length).trimStart();
  if (commandBody.length === 0) {
    return {
      kind: 'error',
      message: '请输入 Skill ID。'
    };
  }

  const skillIdEnd = findFirstWhitespaceIndex(commandBody);
  const skillId = skillIdEnd === -1 ? commandBody : commandBody.slice(0, skillIdEnd);
  const prompt = skillIdEnd === -1 ? '' : commandBody.slice(skillIdEnd).trimStart();

  if (prompt.trim().length === 0) {
    return {
      kind: 'error',
      message: '请输入要发送的内容。'
    };
  }

  return {
    kind: 'ok',
    input: prompt.trim(),
    explicitSkillIds: [skillId]
  };
}

function startsWithSkillCommand(value: string): boolean {
  if (value === '/skill') {
    return true;
  }
  const next = value.at('/skill'.length);
  return value.startsWith('/skill') && next !== undefined && /\s/.test(next);
}

function findFirstWhitespaceIndex(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== undefined && /\s/.test(char)) {
      return index;
    }
  }
  return -1;
}
```

- [ ] **Step 4: Add shared request fields**

Modify `src/renderer/chat/task-run-payload.ts`:

```typescript
export type ChatTaskSubmitPayload = {
  input: string;
  attachments?: ChatImageAttachment[];
  explicitSkillIds?: string[];
  workflowHint?: WorkflowHint;
  taskSource?: 'workbench' | null;
  workspacePath?: string | null;
};
```

Modify `src/shared/types/chat.ts`:

```typescript
export type ChatStartRunRequest = {
  input: string;
  mode: ChatRunMode;
  enabledCapabilities: EnabledCapabilities;
  threadId?: string | null;
  workflowHint?: WorkflowHint;
  taskSource?: 'workbench' | null;
  workspacePath?: string | null;
  attachments?: ChatImageAttachment[];
  explicitSkillIds?: string[];
};
```

- [ ] **Step 5: Run parser tests and commit**

Run:

```powershell
pnpm test -- tests/renderer/chat-composer.test.ts
```

Expected: PASS.

Commit:

```powershell
git add src/renderer/chat/slash-skill-command.ts src/renderer/chat/task-run-payload.ts src/shared/types/chat.ts tests/renderer/chat-composer.test.ts
git commit -m "feat: parse slash skill command"
```

---

### Task 2: Renderer Submit Plumbing

**Files:**
- Modify: `src/renderer/chat/chat-view.tsx`
- Modify: `src/renderer/app/use-app-task-runs.ts`
- Test: `tests/renderer/chat-view.slash-skill.test.tsx`

**Interfaces:**
- Consumes: `parseSlashSkillCommand()` from Task 1.
- Produces: `ChatTaskSubmitPayload.explicitSkillIds` passed into chat run requests.

- [ ] **Step 1: Write renderer submit test**

Create `tests/renderer/chat-view.slash-skill.test.tsx` with this content:

```typescript
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatView } from '../../src/renderer/chat/chat-view';
import type { RocClient } from '../../src/renderer/shared/roc-client';
import type { RocPreloadApi } from '../../src/shared/ipc';
import { createLoadedState } from './view-test-helpers';

describe('chat view slash skill command', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    window.roc = {
      chat: {
        onRunEvent: () => () => {},
        resumeRun: async () => ({ ok: true })
      },
      tasks: {
        getThreadMessages: async () => ({ ok: true, data: [] })
      },
      files: {
        selectFromDialog: async () => ({ ok: true, data: null })
      }
    } as RocPreloadApi;
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    vi.unstubAllGlobals();
  });

  it('submits slash skill command as cleaned input plus explicit skill ids', async () => {
    const submissions: unknown[] = [];
    await act(async () => {
      root.render(
        React.createElement(ChatView, {
          chatSelectionVersion: 1,
          client: createChatClient(),
          selectedThreadId: null,
          state: createLoadedState({
            selectedSkills: ['existing-skill']
          }),
          updateLoadedState: () => {},
          onSubmitChatTask: async (payload) => {
            submissions.push(payload);
            return { ok: true as const };
          }
        })
      );
    });

    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]');
    if (input === null) {
      throw new Error('chat_input_missing');
    }
    await act(async () => {
      input.value = '/skill python-expert 优化这段代码';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const submit = container.querySelector<HTMLButtonElement>('[data-testid="chat-task-submit"]');
    if (submit === null) {
      throw new Error('chat_submit_missing');
    }
    await act(async () => {
      submit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(submissions).toEqual([
      {
        input: '优化这段代码',
        explicitSkillIds: ['python-expert']
      }
    ]);
  });

  function createChatClient(): RocClient {
    return { api: window.roc };
  }
});
```

- [ ] **Step 2: Run renderer test and verify failure**

Run:

```powershell
pnpm test -- tests/renderer/chat-view.slash-skill.test.tsx
```

Expected: FAIL because submitted payload still contains `/skill python-expert ...` and no `explicitSkillIds`.

- [ ] **Step 3: Parse command in `ChatView`**

Modify `src/renderer/chat/chat-view.tsx` imports:

```typescript
import { parseSlashSkillCommand } from './slash-skill-command';
```

In `submitCurrentInput()`, replace the first `trimmedInput` and payload construction with this structure:

```typescript
  async function submitCurrentInput(): Promise<void> {
    const parsedSkillCommand = parseSlashSkillCommand(chatInput);
    if (parsedSkillCommand.kind === 'error') {
      chatRun.setError(parsedSkillCommand.message);
      return;
    }
    const submissionInput = parsedSkillCommand.kind === 'ok' ? parsedSkillCommand.input : chatInput;
    const trimmedInput = submissionInput.trim();
    const imageInputSupported = isImageInputSupported(state);
    const sendDisabled =
      submitting ||
      trimmedInput.length === 0 ||
      state.agent.execution !== 'ready' ||
      (selectedAttachments.length > 0 && !imageInputSupported);
    if (sendDisabled) {
      return;
    }
    setSubmitting(true);
    try {
      const attachments = toChatImageAttachments(selectedAttachments);
      const payload: ChatTaskSubmitPayload = {
        input: trimmedInput
      };
      if (attachments.length > 0) {
        payload.attachments = attachments;
      }
      if (parsedSkillCommand.kind === 'ok') {
        payload.explicitSkillIds = parsedSkillCommand.explicitSkillIds;
      }
      const result = await onSubmitChatTask(payload);
      if (result.ok) {
        setPendingUserInput(trimmedInput);
        setChatInput('');
        revokeAttachmentPreviewUrls(selectedAttachments);
        setSelectedAttachments([]);
      } else {
        chatRun.setError(result.error);
      }
    } finally {
      setSubmitting(false);
    }
  }
```

- [ ] **Step 4: Pass `explicitSkillIds` into agent start requests**

Modify both `chatFeature.startRun({ ... })` calls in `src/renderer/app/use-app-task-runs.ts`:

```typescript
      const request: ChatStartRunRequest = {
        input: payload.input,
        mode: 'chat',
        threadId: selectedThreadId,
        enabledCapabilities: {
          mcpServers: currentSelectedMcpServers,
          skills: currentSelectedSkills
        },
        workflowHint: null,
        taskSource: null,
        workspacePath: null
      };
      if (payload.explicitSkillIds !== undefined) {
        request.explicitSkillIds = payload.explicitSkillIds;
      }
      const result = await chatFeature.startRun(request);
```

For task mode, use the same pattern with `mode: 'task'`, `workflowHint`, `taskSource`, and `workspacePath` already computed in the function.

- [ ] **Step 5: Run renderer tests and commit**

Run:

```powershell
pnpm test -- tests/renderer/chat-composer.test.ts tests/renderer/chat-view.slash-skill.test.tsx
```

Expected: PASS.

Commit:

```powershell
git add src/renderer/chat/chat-view.tsx src/renderer/app/use-app-task-runs.ts tests/renderer/chat-view.slash-skill.test.tsx
git commit -m "feat: send explicit slash skill ids"
```

---

### Task 3: Main Request Schema And Resume Retention

**Files:**
- Modify: `src/main/plugins/agent/index.ts`
- Modify: `src/main/plugins/agent/runtime-types.ts`
- Modify: `src/main/plugins/agent/runtime.ts`
- Test: `tests/main/plugins/agent/plugin.test.ts`

**Interfaces:**
- Consumes: `ChatStartRunRequest.explicitSkillIds`.
- Produces: schema validation for `explicitSkillIds`.
- Produces: `PendingInterrupt.explicitSkillIds`.

- [ ] **Step 1: Write schema and resume metadata tests**

Append to `tests/main/plugins/agent/plugin.test.ts`:

```typescript
describe('agent run schema explicit skills', () => {
  it('accepts explicit skill ids on chat start requests', () => {
    const plugin = createAgentPlugin();
    const startDescriptor = plugin.manifest.capabilities.find((capability) => capability.name === 'agent.run.start');
    const parsed = startDescriptor?.inputSchema.safeParse({
      input: '优化这段代码',
      mode: 'chat',
      enabledCapabilities: {
        mcpServers: [],
        skills: ['existing-skill']
      },
      explicitSkillIds: ['python-expert']
    });

    expect(parsed?.success).toBe(true);
  });

  it('rejects empty explicit skill ids', () => {
    const plugin = createAgentPlugin();
    const startDescriptor = plugin.manifest.capabilities.find((capability) => capability.name === 'agent.run.start');
    const parsed = startDescriptor?.inputSchema.safeParse({
      input: '优化这段代码',
      mode: 'chat',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      },
      explicitSkillIds: ['']
    });

    expect(parsed?.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run plugin test and verify failure**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/plugin.test.ts
```

Expected: FAIL because `explicitSkillIds` is not in `chatStartRunRequestSchema`.

- [ ] **Step 3: Add schema validation**

Modify `src/main/plugins/agent/index.ts` schema:

```typescript
const chatStartRunRequestSchema = z.object({
  input: z.string(),
  mode: z.enum(['chat', 'task']),
  enabledCapabilities: enabledCapabilitiesSchema,
  threadId: z.string().nullable().optional(),
  workflowHint: z.enum(['propose_background_task', 'background_task_change']).nullable().optional(),
  taskSource: z.enum(['workbench']).nullable().optional(),
  workspacePath: z.string().nullable().optional(),
  attachments: z.array(chatImageAttachmentSchema).max(4).optional(),
  explicitSkillIds: z.array(z.string().trim().min(1)).optional()
}) satisfies z.ZodType<ChatStartRunRequest>;
```

- [ ] **Step 4: Retain explicit skill ids through HITL resume**

Modify `src/main/plugins/agent/runtime-types.ts`:

```typescript
export type PendingInterrupt = {
  interruptId: string;
  payload: ChatApprovalRequest;
  taskSource: ChatStartRunRequest['taskSource'] | null;
  workflowHint: ChatStartRunRequest['workflowHint'] | null;
  workspacePath: ChatStartRunRequest['workspacePath'];
  explicitSkillIds: ChatStartRunRequest['explicitSkillIds'];
};
```

Modify `src/main/plugins/agent/runtime.ts`:

In `resumeRun()`, after `resumedRequest` is created:

```typescript
    if (pendingInterrupt.explicitSkillIds !== undefined) {
      resumedRequest.explicitSkillIds = pendingInterrupt.explicitSkillIds;
    }
```

In `handleRunInterrupted()` input type:

```typescript
    explicitSkillIds: ChatStartRunRequest['explicitSkillIds'];
```

In the call to `handleRunInterrupted()` inside `executeDeepAgentRun()`:

```typescript
          explicitSkillIds: input.request.explicitSkillIds,
```

In `this.pendingInterrupts.set(...)`:

```typescript
      explicitSkillIds: input.explicitSkillIds
```

- [ ] **Step 5: Run plugin test and commit**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/plugin.test.ts
```

Expected: PASS.

Commit:

```powershell
git add src/main/plugins/agent/index.ts src/main/plugins/agent/runtime-types.ts src/main/plugins/agent/runtime.ts tests/main/plugins/agent/plugin.test.ts
git commit -m "feat: accept explicit skill ids"
```

---

### Task 4: Explicit Skill Loading And Prompt Injection

**Files:**
- Create: `src/main/services/deep-agent/context/explicit-skills.ts`
- Modify: `src/main/services/deep-agent/context/prompt-blocks.ts`
- Modify: `src/main/services/deep-agent/context/context-assembler.ts`
- Modify: `src/main/plugins/agent/deep-agent-executor.ts`
- Modify: `tests/main/plugins/agent/deep-agent-executor-test-helpers.ts`
- Test: `tests/main/plugins/agent/deep-agent-executor.test.ts`

**Interfaces:**
- Produces: `ExplicitSkillContext = { id: string; name: string; path: string; content: string }`
- Produces: `loadExplicitSkillContexts(input): Promise<ExplicitSkillContext[]>`
- Consumes: `ChatStartRunRequest.explicitSkillIds`.
- Produces: `explicit_skills` request prompt block.

- [ ] **Step 1: Extend executor test helper capabilities**

Modify imports in `tests/main/plugins/agent/deep-agent-executor-test-helpers.ts`:

```typescript
  SkillFilePreviewResult,
  SkillSnapshot,
```

Extend `createCapabilities()` options type:

```typescript
  options: {
    capabilityPreview?: boolean;
    mcpTools?: ClientTool[];
    workspace?: Workspace | null;
    skills?: SkillSnapshot[];
    skillFiles?: Record<string, string>;
  } = {}
```

Add handlers before the final unexpected capability throw:

```typescript
      if (name === 'skills.list') {
        const skills = options.skills === undefined ? [] : options.skills;
        return skills as TOutput;
      }
      if (name === 'skills.file.read') {
        const request = input as { id: string; relativePath: string };
        const files = options.skillFiles === undefined ? {} : options.skillFiles;
        const content = files[request.id];
        if (content === undefined) {
          throw new Error(`skill_file_missing:${request.id}`);
        }
        return {
          id: request.id,
          relativePath: request.relativePath,
          kind: 'text',
          content,
          truncated: false,
          sizeBytes: Buffer.byteLength(content, 'utf8')
        } satisfies SkillFilePreviewResult as TOutput;
      }
```

- [ ] **Step 2: Write explicit skill prompt test**

Append to `tests/main/plugins/agent/deep-agent-executor.test.ts`:

```typescript
  it('loads explicit slash skill SKILL.md into request context without changing selected skills', async () => {
    const capabilityCalls: Array<{ name: string; input: unknown }> = [];
    await buildExecutorOnce(
      createCapabilities(capabilityCalls, {
        skills: [
          {
            id: 'python-expert',
            name: 'python-expert',
            enabled: true,
            path: 'F:\\Code\\Roc\\.roc\\skills\\python-expert',
            description: 'Python expertise',
            status: 'ready',
            lastError: null
          },
          {
            id: 'typescript',
            name: 'typescript',
            enabled: true,
            path: 'F:\\Code\\Roc\\.roc\\skills\\typescript',
            description: 'TypeScript expertise',
            status: 'ready',
            lastError: null
          }
        ],
        skillFiles: {
          'python-expert': '---\nname: python-expert\ndescription: Python expertise\n---\n# Python Expert\nUse pytest.'
        }
      }),
      {
        explicitSkillIds: ['python-expert'],
        enabledCapabilities: {
          mcpServers: [],
          skills: ['typescript']
        }
      }
    );

    const buildInput = readBuildInput();

    expect(buildInput.skillSources).toEqual(['/skills/']);
    expect(buildInput.systemPrompt).toContain('<skill>');
    expect(buildInput.systemPrompt).toContain('<name>python-expert</name>');
    expect(buildInput.systemPrompt).toContain('/skills/python-expert/SKILL.md');
    expect(buildInput.systemPrompt).toContain('# Python Expert');
    expect(buildInput.systemPrompt).toContain('Capabilities: mcp=none;skills=typescript;');
    expect(buildInput.systemPrompt).not.toContain('<name>typescript</name>');
    expect(capabilityCalls.map((call) => call.name)).toEqual([
      'workspace.getCurrent',
      'skills.list',
      'skills.file.read'
    ]);
  });

  it('rejects disabled explicit slash skill before building the agent', async () => {
    await expect(
      buildExecutorOnce(
        createCapabilities([], {
          skills: [
            {
              id: 'python-expert',
              name: 'python-expert',
              enabled: false,
              path: 'F:\\Code\\Roc\\.roc\\skills\\python-expert',
              description: 'Python expertise',
              status: 'ready',
              lastError: null
            }
          ]
        }),
        {
          explicitSkillIds: ['python-expert']
        }
      )
    ).rejects.toThrow('skill_disabled:python-expert');
  });
```

- [ ] **Step 3: Run executor test and verify failure**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/deep-agent-executor.test.ts
```

Expected: FAIL because `explicitSkillIds` is not loaded into the prompt.

- [ ] **Step 4: Create explicit skill loader**

Create `src/main/services/deep-agent/context/explicit-skills.ts`:

```typescript
import type { SkillFilePreviewResult, SkillSnapshot } from '../../../../shared/types';
import type { RocCapabilityRegistry } from '../../../kernel/types';

export type ExplicitSkillContext = {
  id: string;
  name: string;
  path: string;
  content: string;
};

export async function loadExplicitSkillContexts(input: {
  capabilities: RocCapabilityRegistry;
  explicitSkillIds: readonly string[] | undefined;
}): Promise<ExplicitSkillContext[]> {
  if (input.explicitSkillIds === undefined || input.explicitSkillIds.length === 0) {
    return [];
  }

  const skills = await input.capabilities.invoke<{}, SkillSnapshot[]>('skills.list', {});
  const contexts: ExplicitSkillContext[] = [];
  for (const skillId of input.explicitSkillIds) {
    const skill = skills.find((item) => item.id === skillId);
    if (skill === undefined) {
      throw new Error(`skill_not_found:${skillId}`);
    }
    if (!skill.enabled) {
      throw new Error(`skill_disabled:${skillId}`);
    }
    if (skill.status !== 'ready') {
      throw new Error(`skill_invalid:${skillId}`);
    }
    const file = await input.capabilities.invoke<{ id: string; relativePath: string }, SkillFilePreviewResult>(
      'skills.file.read',
      {
        id: skillId,
        relativePath: 'SKILL.md'
      }
    );
    if (file.kind !== 'text' || file.truncated) {
      throw new Error(`explicit_skill_read_failed:${skillId}`);
    }
    contexts.push({
      id: skill.id,
      name: skill.name,
      path: `/skills/${skill.id}/SKILL.md`,
      content: file.content
    });
  }
  return contexts;
}
```

- [ ] **Step 5: Add prompt block support**

Modify `src/main/services/deep-agent/context/prompt-blocks.ts`:

```typescript
export type PromptBlockType =
  | 'static'
  | 'workspace'
  | 'tools'
  | 'capability'
  | 'explicit_skills'
  | 'context_recall'
  | 'workflow';

export type ExplicitSkillPromptContext = {
  name: string;
  path: string;
  content: string;
};
```

Extend `buildPromptBlocks()` input:

```typescript
  explicitSkillContexts: readonly ExplicitSkillPromptContext[];
```

Insert the explicit block after the capability block:

```typescript
    createBlock('capability', BlockStability.CAPABILITY, `Capabilities: ${createCapabilitySummary(input.enabledCapabilities)}`),
    ...(
      input.explicitSkillContexts.length === 0
        ? []
        : [createBlock('explicit_skills', BlockStability.REQUEST, buildExplicitSkillsPrompt(input.explicitSkillContexts))]
    ),
```

Add helper:

```typescript
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
```

- [ ] **Step 6: Pass contexts through assembler and executor**

Modify `src/main/services/deep-agent/context/context-assembler.ts` input:

```typescript
  explicitSkillContexts: readonly ExplicitSkillContext[];
```

Import type:

```typescript
import type { ExplicitSkillContext } from './explicit-skills';
```

Pass to `buildPromptBlocks()`:

```typescript
    explicitSkillContexts: input.explicitSkillContexts,
```

Modify `src/main/plugins/agent/deep-agent-executor.ts` imports:

```typescript
import { loadExplicitSkillContexts } from '../../services/deep-agent/context/explicit-skills';
```

Before `assembleContextHarness()`:

```typescript
      const explicitSkillContexts = await loadExplicitSkillContexts({
        capabilities: options.capabilities,
        explicitSkillIds: input.request.explicitSkillIds
      });
```

Pass to assembler:

```typescript
        explicitSkillContexts,
```

- [ ] **Step 7: Run executor tests and commit**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/deep-agent-executor.test.ts
```

Expected: PASS.

Commit:

```powershell
git add src/main/services/deep-agent/context/explicit-skills.ts src/main/services/deep-agent/context/prompt-blocks.ts src/main/services/deep-agent/context/context-assembler.ts src/main/plugins/agent/deep-agent-executor.ts tests/main/plugins/agent/deep-agent-executor-test-helpers.ts tests/main/plugins/agent/deep-agent-executor.test.ts
git commit -m "feat: load explicit slash skills"
```

---

### Task 5: Cross-Layer Verification

**Files:**
- Modify only if preceding verification exposes a direct issue.

**Interfaces:**
- Consumes all previous tasks.
- Produces final evidence that parser, renderer, schema, executor, and type contracts agree.

- [ ] **Step 1: Run focused test set**

Run:

```powershell
pnpm test -- tests/renderer/chat-composer.test.ts tests/renderer/chat-view.slash-skill.test.tsx tests/main/plugins/agent/deep-agent-executor.test.ts tests/main/plugins/agent/plugin.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```powershell
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Run whitespace check**

Run:

```powershell
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 4: Commit verification-only fixes if needed**

If Step 1, 2, or 3 required code changes, commit only those direct fixes:

```powershell
git add <changed-files>
git commit -m "fix: align slash skill command verification"
```

If no files changed, do not create a commit.
