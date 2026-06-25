# Chat Plan Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add normal-chat Plan mode with `Shift+Tab` mode switching, read-only planning tools, and clean-context execution from the final proposed plan.

**Architecture:** Treat Plan as a run-level chat mode, not a UI-only flag. The renderer owns composer mode and plan execution UX; shared types carry `mode: 'plan'`; main runtime builds a reduced Plan tool surface with read file tools but no mutation tools or shell tool. Executing a plan always starts a new `chat` run with `threadId: null` and input equal to the extracted final plan text.

**Tech Stack:** TypeScript ESM, React 19, Electron IPC, DeepAgents, Vitest.

## Global Constraints

- Scope is normal chat only; task workbench, task detail, scheduled/background task creation, and task approval flows stay unchanged.
- `Shift+Tab` toggles only `Chat` and `Plan`.
- Plan mode exposes read file tools: `ls`, `read_file`, `grep`, `glob`.
- Plan mode does not expose `write_file`, `edit_file`, `delete_file`, background-task mutation tools, or `run_shell_command`.
- Executing a plan starts a new `chat` run with `threadId: null`.
- Execution input is exactly the final extracted `<proposed_plan>` inner text, trimmed.
- Do not rely on prompt text for safety; enforce Plan restrictions in runtime tool construction.
- Use existing style: 2 spaces, semicolons, single quotes.

---

## File Structure

- Modify `src/shared/types/chat.ts`: add `plan` to `ChatRunMode`.
- Modify `src/renderer/chat/task-run-payload.ts`: allow `mode?: 'chat' | 'plan'`.
- Create `src/renderer/chat/proposed-plan.ts`: pure extraction helper for the last complete `<proposed_plan>` block.
- Modify `src/renderer/chat/chat-view.tsx`: own composer mode, pass mode into submissions, render execute action for completed Plan output.
- Modify `src/renderer/chat/chat-composer.tsx`: expose mode selector UI and `Shift+Tab` toggle.
- Modify `src/renderer/app/use-app-task-runs.ts`: route plan submissions to `mode: 'plan'`; execute-plan submissions to new `chat` thread by accepting `threadIdOverride: null`.
- Modify `src/main/plugins/agent/index.ts`: schema accepts `mode: 'plan'`.
- Modify `src/main/plugins/task/agent-run-payloads.ts`: persisted run event parser accepts `plan` where needed.
- Modify `src/main/plugins/agent/deep-agent-executor.ts`: build Plan tool surface and read-only file permissions.
- Modify `src/main/services/deep-agent/filesystem-tool-contract.ts`: add `createRocReadOnlyFilesystemPermissions()`.
- Modify `src/main/services/deep-agent/context/prompt-blocks.ts` or adjacent prompt builder: add Plan workflow prompt when `mode === 'plan'`.
- Test files:
  - `tests/renderer/proposed-plan.test.ts`
  - `tests/renderer/chat-composer.test.ts`
  - `tests/renderer/chat-view.test.ts`
  - `tests/renderer/app-shell.test.tsx`
  - `tests/main/plugins/agent/deep-agent-executor-tools.test.ts`
  - `tests/main/deep-agent-build-wiring.test.ts`
  - `tests/main/plugins/agent/plugin.test.ts`

---

### Task 1: Shared Plan Mode Contract

**Files:**
- Modify: `src/shared/types/chat.ts`
- Modify: `src/renderer/chat/task-run-payload.ts`
- Modify: `src/main/plugins/agent/index.ts`
- Modify: `src/main/plugins/task/agent-run-payloads.ts`
- Test: `tests/main/plugins/agent/plugin.test.ts`
- Test: `tests/main/plugins/task/plugin-agent-events.test.ts`

**Interfaces:**
- Produces: `ChatRunMode = 'chat' | 'task' | 'plan'`
- Produces: `ChatTaskSubmitPayload.mode?: 'chat' | 'plan'`

- [ ] **Step 1: Write failing schema/type tests**

Add a test in `tests/main/plugins/agent/plugin.test.ts` that starts an agent run with `mode: 'plan'` and expects the plugin schema to accept it:

```typescript
it('accepts plan mode chat runs', async () => {
  const plugin = createAgentPlugin({
    repository,
    eventBus,
    modelFactory,
    deepAgentExecutor
  });
  const result = await plugin.capabilities['agent.run.start']({
    input: 'Plan this change',
    mode: 'plan',
    enabledCapabilities: { mcpServers: [], skills: [] },
    workflowHint: null,
    taskSource: null,
    workspacePath: null
  });
  expect(result.mode).toBe('plan');
});
```

- [ ] **Step 2: Run focused failing test**

Run: `pnpm test -- tests/main/plugins/agent/plugin.test.ts`

Expected: FAIL because `plan` is not accepted by current mode schema or type.

- [ ] **Step 3: Extend shared types**

In `src/shared/types/chat.ts`, change:

```typescript
export type ChatRunMode = 'chat' | 'task';
```

to:

```typescript
export type ChatRunMode = 'chat' | 'task' | 'plan';
```

In `src/renderer/chat/task-run-payload.ts`, change:

```typescript
import type { ChatImageAttachment, WorkflowHint } from '../../shared/types';
```

to:

```typescript
import type { ChatImageAttachment, ChatRunMode, WorkflowHint } from '../../shared/types';
```

and add:

```typescript
  mode?: Extract<ChatRunMode, 'chat' | 'plan'>;
```

to `ChatTaskSubmitPayload`.

- [ ] **Step 4: Extend validation schemas**

In `src/main/plugins/agent/index.ts`, update the mode schema from `['chat', 'task']` to `['chat', 'task', 'plan']`.

In `src/main/plugins/task/agent-run-payloads.ts`, update `isChatRunMode()` so it returns true for:

```typescript
value === 'chat' || value === 'task' || value === 'plan'
```

- [ ] **Step 5: Run focused tests**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/plugin.test.ts tests/main/plugins/task/plugin-agent-events.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/shared/types/chat.ts src/renderer/chat/task-run-payload.ts src/main/plugins/agent/index.ts src/main/plugins/task/agent-run-payloads.ts tests/main/plugins/agent/plugin.test.ts tests/main/plugins/task/plugin-agent-events.test.ts
git commit -m "feat: add chat plan run mode contract"
```

---

### Task 2: Plan Extraction Helper

**Files:**
- Create: `src/renderer/chat/proposed-plan.ts`
- Test: `tests/renderer/proposed-plan.test.ts`

**Interfaces:**
- Produces: `extractLastProposedPlan(text: string): string | null`

- [ ] **Step 1: Write failing tests**

Create `tests/renderer/proposed-plan.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { extractLastProposedPlan } from '../../src/renderer/chat/proposed-plan';

describe('extractLastProposedPlan', () => {
  it('returns trimmed inner text from a proposed plan block', () => {
    expect(extractLastProposedPlan('before\n<proposed_plan>\n# Plan\n- do it\n</proposed_plan>\nafter')).toBe('# Plan\n- do it');
  });

  it('uses the last complete proposed plan block', () => {
    expect(extractLastProposedPlan('<proposed_plan>old</proposed_plan>\ntext\n<proposed_plan>\nnew\n</proposed_plan>')).toBe('new');
  });

  it('returns null when no complete block exists', () => {
    expect(extractLastProposedPlan('<proposed_plan>\nmissing close')).toBeNull();
    expect(extractLastProposedPlan('plain text')).toBeNull();
  });

  it('returns null for an empty proposed plan', () => {
    expect(extractLastProposedPlan('<proposed_plan>   \n </proposed_plan>')).toBeNull();
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `pnpm test -- tests/renderer/proposed-plan.test.ts`

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement helper**

Create `src/renderer/chat/proposed-plan.ts`:

```typescript
const PROPOSED_PLAN_OPEN = '<proposed_plan>';
const PROPOSED_PLAN_CLOSE = '</proposed_plan>';

export function extractLastProposedPlan(text: string): string | null {
  let searchEnd = text.length;
  while (searchEnd > 0) {
    const closeIndex = text.lastIndexOf(PROPOSED_PLAN_CLOSE, searchEnd);
    if (closeIndex === -1) {
      return null;
    }
    const openIndex = text.lastIndexOf(PROPOSED_PLAN_OPEN, closeIndex);
    if (openIndex === -1) {
      return null;
    }
    const plan = text.slice(openIndex + PROPOSED_PLAN_OPEN.length, closeIndex).trim();
    if (plan.length > 0) {
      return plan;
    }
    searchEnd = openIndex;
  }
  return null;
}
```

- [ ] **Step 4: Run helper tests**

Run: `pnpm test -- tests/renderer/proposed-plan.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/renderer/chat/proposed-plan.ts tests/renderer/proposed-plan.test.ts
git commit -m "feat: extract proposed plan text"
```

---

### Task 3: Composer Mode UI And Shift+Tab

**Files:**
- Modify: `src/renderer/chat/chat-composer.tsx`
- Modify: `src/renderer/chat/chat-view.tsx`
- Modify: `src/renderer/styles/composer.css`
- Test: `tests/renderer/chat-composer.test.ts`

**Interfaces:**
- Consumes: `ChatTaskSubmitPayload.mode?: 'chat' | 'plan'`
- Produces: `ChatComposerProps.composerMode: 'chat' | 'plan'`
- Produces: `ChatComposerProps.onComposerModeChange(next: 'chat' | 'plan'): void`

- [ ] **Step 1: Write failing static-render test**

Add to `tests/renderer/chat-composer.test.ts`:

```typescript
it('renders chat and plan composer modes', () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatComposer, {
      client: testClient,
      chatInput: '规划',
      onChatInputChange: () => {},
      selectedAttachments: [],
      onSelectedAttachmentsChange: () => {},
      imageInputSupported: true,
      activeComposerPopover: null,
      onActiveComposerPopoverChange: () => {},
      composerMode: 'plan',
      onComposerModeChange: () => {},
      submitting: false,
      state: createLoadedState({}),
      updateLoadedState: () => {},
      onSubmit: async () => {}
    })
  );

  expect(html).toContain('data-testid="chat-composer-mode"');
  expect(html).toContain('Plan');
  expect(html).toContain('composer-mode-option is-selected');
});
```

- [ ] **Step 2: Run failing test**

Run: `pnpm test -- tests/renderer/chat-composer.test.ts`

Expected: FAIL because new props and UI do not exist.

- [ ] **Step 3: Add composer props and UI**

In `src/renderer/chat/chat-composer.tsx`, define:

```typescript
type ComposerMode = 'chat' | 'plan';
```

Extend `ChatComposerProps`:

```typescript
  composerMode: ComposerMode;
  onComposerModeChange: (next: ComposerMode) => void;
```

Add mode buttons in `.composer-bottom` left side before tool buttons:

```tsx
<div className="composer-mode-toggle" data-testid="chat-composer-mode" aria-label="发送模式">
  {(['chat', 'plan'] as const).map((mode) => (
    <button
      className={composerMode === mode ? 'composer-mode-option is-selected' : 'composer-mode-option'}
      key={mode}
      type="button"
      onClick={() => onComposerModeChange(mode)}
    >
      {mode === 'chat' ? 'Chat' : 'Plan'}
    </button>
  ))}
</div>
```

In the textarea `onKeyDown`, handle `Shift+Tab` before Enter handling:

```typescript
if (event.key === 'Tab' && event.shiftKey && !event.nativeEvent.isComposing) {
  event.preventDefault();
  onComposerModeChange(composerMode === 'chat' ? 'plan' : 'chat');
  return;
}
```

- [ ] **Step 4: Own composer mode in ChatView**

In `src/renderer/chat/chat-view.tsx`, add:

```typescript
type ComposerMode = 'chat' | 'plan';
const [composerMode, setComposerMode] = useState<ComposerMode>('chat');
```

When building payload in `submitCurrentInput()`:

```typescript
if (composerMode === 'plan') {
  payload.mode = 'plan';
}
```

Pass props to `ChatComposer`:

```tsx
composerMode={composerMode}
onComposerModeChange={setComposerMode}
```

- [ ] **Step 5: Add minimal CSS**

In `src/renderer/styles/composer.css`, add focused compact styles:

```css
.composer-mode-toggle {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg-soft);
}

.composer-mode-option {
  min-width: 44px;
  height: 26px;
  border: 0;
  border-radius: 4px;
  color: var(--muted);
  background: transparent;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.composer-mode-option.is-selected {
  color: var(--ink);
  background: var(--surface);
}
```

- [ ] **Step 6: Run composer tests**

Run: `pnpm test -- tests/renderer/chat-composer.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/renderer/chat/chat-composer.tsx src/renderer/chat/chat-view.tsx src/renderer/styles/composer.css tests/renderer/chat-composer.test.ts
git commit -m "feat: add chat composer plan mode toggle"
```

---

### Task 4: Plan Execution UX With Clean Context

**Files:**
- Modify: `src/renderer/chat/chat-view.tsx`
- Modify: `src/renderer/app/use-app-task-runs.ts`
- Test: `tests/renderer/chat-view.test.ts`
- Test: `tests/renderer/app-shell.test.tsx`

**Interfaces:**
- Consumes: `extractLastProposedPlan(text: string): string | null`
- Produces: execute-plan action starts `ChatTaskSubmitPayload` with `mode: 'chat'`, `input: planText`, and clean thread behavior.

- [ ] **Step 1: Write failing clean-context test**

In `tests/renderer/app-shell.test.tsx`, add a test that calls the chat submit path with `payload.mode = 'plan'`, simulates a completed plan, then invokes execute action. Assert the second `chat.startRun` request has:

```typescript
expect(secondRequest).toMatchObject({
  input: '# Plan\n- implement',
  mode: 'chat',
  threadId: null,
  workflowHint: null,
  taskSource: null,
  workspacePath: null
});
expect(secondRequest.input).not.toContain('Plan this');
```

- [ ] **Step 2: Run failing renderer tests**

Run:

```powershell
pnpm test -- tests/renderer/app-shell.test.tsx tests/renderer/chat-view.test.ts
```

Expected: FAIL because execute-plan action and clean thread override do not exist.

- [ ] **Step 3: Add thread override to startChatRun**

In `src/renderer/chat/task-run-payload.ts`, add:

```typescript
  cleanThread?: boolean;
```

In `src/renderer/app/use-app-task-runs.ts`, change `startChatRun` to compute mode and thread id explicitly:

```typescript
const requestMode = payload.mode === 'plan' ? 'plan' : 'chat';
const requestThreadId = payload.cleanThread === true || payload.mode === 'plan' ? null : selectedThreadId;
```

Use those values in the request:

```typescript
const request: ChatStartRunRequest = {
  input: payload.input,
  mode: requestMode,
  threadId: requestThreadId,
  enabledCapabilities: {
    mcpServers: currentSelectedMcpServers,
    skills: currentSelectedSkills
  },
  workflowHint: null,
  taskSource: null,
  workspacePath: null
};
```

This makes Plan submissions and execute-plan submissions independent from the selected history thread.

- [ ] **Step 4: Render execute action after completed Plan**

In `src/renderer/chat/chat-view.tsx`, track latest completed Plan output from transcript or live run state. Use `extractLastProposedPlan()` only after `chatRun.state.status === 'completed'` and `chatRun.state.mode === 'plan'`.

Add handler:

```typescript
async function executePlan(planText: string): Promise<void> {
  setComposerMode('chat');
  const result = await onSubmitChatTask({
    input: planText,
    mode: 'chat',
    cleanThread: true
  });
  if (!result.ok) {
    chatRun.setError(result.error);
  }
}
```

Render:

```tsx
{executablePlanText === null ? null : (
  <div className="chat-plan-actions" data-testid="chat-plan-actions">
    <button type="button" data-testid="chat-plan-execute" onClick={() => void executePlan(executablePlanText)}>
      执行计划
    </button>
    <button type="button" data-testid="chat-plan-continue" onClick={() => setComposerMode('plan')}>
      继续规划
    </button>
  </div>
)}
```

- [ ] **Step 5: Run renderer tests**

Run:

```powershell
pnpm test -- tests/renderer/app-shell.test.tsx tests/renderer/chat-view.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/renderer/chat/chat-view.tsx src/renderer/app/use-app-task-runs.ts src/renderer/chat/task-run-payload.ts tests/renderer/app-shell.test.tsx tests/renderer/chat-view.test.ts
git commit -m "feat: execute proposed plan with clean chat context"
```

---

### Task 5: Plan Runtime Tool Surface

**Files:**
- Modify: `src/main/services/deep-agent/filesystem-tool-contract.ts`
- Modify: `src/main/plugins/agent/deep-agent-executor.ts`
- Test: `tests/main/plugins/agent/deep-agent-executor-tools.test.ts`
- Test: `tests/main/deep-agent-build-wiring.test.ts`

**Interfaces:**
- Produces: `createRocReadOnlyFilesystemPermissions(): FilesystemPermission[]`
- Produces: Plan executor tools exclude `run_shell_command`, `delete_file`, and background-task tools.

- [ ] **Step 1: Write failing tool-surface tests**

In `tests/main/plugins/agent/deep-agent-executor-tools.test.ts`, add assertions for a plan request:

```typescript
it('does not expose mutation tools in plan mode', async () => {
  const tools = await collectExecutorToolNames({
    mode: 'plan',
    workflowHint: null,
    enabledCapabilities: { mcpServers: [], skills: [] }
  });

  expect(tools).toContain('web_read');
  expect(tools).not.toContain('run_shell_command');
  expect(tools).not.toContain('delete_file');
  expect(tools).not.toContain('create_background_task');
  expect(tools).not.toContain('update_background_task');
  expect(tools).not.toContain('cancel_background_task');
});
```

In `tests/main/deep-agent-build-wiring.test.ts`, add:

```typescript
it('uses read-only filesystem permissions for plan mode', async () => {
  const build = await buildExecutorInput({ mode: 'plan' });
  expect(build.filesystemPermissions).toEqual([
    { operations: ['read'], paths: ['/workspace/**', '/memory/**', '/skills/**'], mode: 'allow' },
    { operations: ['write'], paths: ['/**'], mode: 'deny' }
  ]);
});
```

- [ ] **Step 2: Run failing main tests**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/deep-agent-executor-tools.test.ts tests/main/deep-agent-build-wiring.test.ts
```

Expected: FAIL because plan tool filtering and read-only permission helper do not exist.

- [ ] **Step 3: Add read-only filesystem permissions**

In `src/main/services/deep-agent/filesystem-tool-contract.ts`, add:

```typescript
export function createRocReadOnlyFilesystemPermissions(): FilesystemPermission[] {
  return [
    { operations: ['read'], paths: ['/workspace/**', '/memory/**', '/skills/**'], mode: 'allow' },
    { operations: ['write'], paths: ['/**'], mode: 'deny' }
  ];
}
```

- [ ] **Step 4: Filter executor tools by mode**

In `src/main/plugins/agent/deep-agent-executor.ts`, import `createRocReadOnlyFilesystemPermissions`.

Change tool creation call:

```typescript
const tools = await createExecutorTools({
  capabilities: options.capabilities,
  enabledCapabilities: input.request.enabledCapabilities,
  backgroundTaskToolMode: input.request.mode === 'plan' ? null : readBackgroundTaskToolMode(input.request),
  runtimeWorkspacePath: runtimeWorkspace === null ? null : runtimeWorkspace.path,
  shellExecutionService,
  mode: input.request.mode
});
```

Extend `createExecutorTools` input:

```typescript
  mode: ChatStartRunRequest['mode'];
```

Build plan tools:

```typescript
if (input.mode === 'plan') {
  return {
    runTools: [webReadTool],
    webReadTool
  };
}
```

Keep existing normal tools for `chat` and `task`.

Change filesystem permission argument:

```typescript
filesystemPermissions:
  input.request.mode === 'plan'
    ? createRocReadOnlyFilesystemPermissions()
    : createRocFilesystemPermissions(),
```

- [ ] **Step 5: Run focused main tests**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/deep-agent-executor-tools.test.ts tests/main/deep-agent-build-wiring.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/main/services/deep-agent/filesystem-tool-contract.ts src/main/plugins/agent/deep-agent-executor.ts tests/main/plugins/agent/deep-agent-executor-tools.test.ts tests/main/deep-agent-build-wiring.test.ts
git commit -m "feat: restrict plan mode runtime tools"
```

---

### Task 6: Plan Prompt Contract

**Files:**
- Modify: `src/main/services/deep-agent/context/prompt-blocks.ts`
- Modify: `src/main/services/deep-agent/context/context-assembler.ts`
- Modify: `src/main/plugins/agent/deep-agent-executor.ts`
- Test: `tests/main/services/deep-agent/context/prompt-blocks.test.ts`

**Interfaces:**
- Consumes: `ChatStartRunRequest['mode']`
- Produces: `buildPromptBlocks(input: { mode: ChatStartRunRequest['mode']; ... }): PromptBlock[]`
- Produces: `assembleContextHarness(input: { mode: ChatStartRunRequest['mode']; ... }): ContextHarness`

- [ ] **Step 1: Write failing prompt test**

In `tests/main/services/deep-agent/context/prompt-blocks.test.ts`, add:

```typescript
it('adds plan mode instructions when request mode is plan', () => {
  const blocks = buildPromptBlocks({
    mode: 'plan',
    enabledCapabilities: {
      mcpServers: [],
      skills: []
    },
    workflowHint: null,
    workspacePath: 'F:\\Code\\Roc',
    tools: [],
    explicitSkillContexts: []
  });

  const prompt = blocks.map((block) => block.content).join('\n');
  expect(prompt).toContain('Plan Mode');
  expect(prompt).toContain('<proposed_plan>');
  expect(prompt).toContain('</proposed_plan>');
});

it('does not add plan mode instructions for normal chat', () => {
  const blocks = buildPromptBlocks({
    mode: 'chat',
    enabledCapabilities: {
      mcpServers: [],
      skills: []
    },
    workflowHint: null,
    workspacePath: 'F:\\Code\\Roc',
    tools: [],
    explicitSkillContexts: []
  });

  const prompt = blocks.map((block) => block.content).join('\n');
  expect(prompt).not.toContain('<proposed_plan>');
});
```

- [ ] **Step 2: Run failing prompt test**

Run: `pnpm test -- tests/main/services/deep-agent/context/prompt-blocks.test.ts`

Expected: FAIL because prompt builder does not consume mode.

- [ ] **Step 3: Thread mode into context assembly**

Update context assembly input types from:

```typescript
workflowHint: WorkflowHint;
```

to include:

```typescript
mode: ChatStartRunRequest['mode'];
workflowHint: WorkflowHint;
```

Pass `mode: input.request.mode` from `src/main/plugins/agent/deep-agent-executor.ts` into `assembleContextHarness()`.

- [ ] **Step 4: Add Plan prompt block**

In `src/main/services/deep-agent/context/prompt-blocks.ts`, extend `PromptBlockType`:

```typescript
  | 'plan_mode'
```

Add `mode` to `buildPromptBlocks()` input:

```typescript
  mode: ChatStartRunRequest['mode'];
```

Add this block before `workflow`:

```typescript
    ...(
      input.mode === 'plan'
        ? [createBlock('plan_mode', BlockStability.REQUEST, buildPlanModePrompt())]
        : []
    ),
```

Add helper:

```typescript
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
```

In `src/main/services/deep-agent/context/context-assembler.ts`, add `mode` to `assembleContextHarness()` input and pass it through to `buildPromptBlocks()`.

- [ ] **Step 5: Run prompt tests**

Run: `pnpm test -- tests/main/services/deep-agent/context/prompt-blocks.test.ts tests/main/deep-agent-prompt.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/main/services/deep-agent/context src/main/plugins/agent/deep-agent-executor.ts tests/main/services/deep-agent/context/prompt-blocks.test.ts tests/main/deep-agent-prompt.test.ts
git commit -m "feat: add plan mode prompt contract"
```

---

### Task 7: End-To-End Verification

**Files:**
- Modify only files already changed by earlier tasks if failures expose small integration gaps.

**Interfaces:**
- Consumes all previous tasks.
- Produces verified Plan mode implementation.

- [ ] **Step 1: Run targeted test set**

Run:

```powershell
pnpm test -- tests/renderer/proposed-plan.test.ts tests/renderer/chat-composer.test.ts tests/renderer/chat-view.test.ts tests/renderer/app-shell.test.tsx tests/main/plugins/agent/plugin.test.ts tests/main/plugins/agent/deep-agent-executor-tools.test.ts tests/main/deep-agent-build-wiring.test.ts tests/main/services/deep-agent/context/prompt-blocks.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```powershell
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Run IPC check if shared IPC generated files changed**

Run:

```powershell
pnpm check:ipc
```

Expected: PASS or no generated IPC changes required.

- [ ] **Step 4: Run full test suite if targeted tests changed shared runtime behavior**

Run:

```powershell
pnpm test
```

Expected: PASS.

- [ ] **Step 5: Check whitespace**

Run:

```powershell
git diff --check
```

Expected: no output.

- [ ] **Step 6: Final commit**

```powershell
git status --short
git add src tests
git commit -m "feat: add chat plan mode"
```

Expected: working tree clean after commit.

---

## Self-Review Notes

- Spec coverage: mode contract, UI toggle, clean execution context, Plan extraction, tool restrictions, prompt contract, and tests are covered.
- Placeholder scan: no unresolved placeholder markers are present.
- Type consistency: `mode?: 'chat' | 'plan'`, `ChatRunMode`, `cleanThread?: boolean`, and `extractLastProposedPlan()` are named consistently across tasks.
