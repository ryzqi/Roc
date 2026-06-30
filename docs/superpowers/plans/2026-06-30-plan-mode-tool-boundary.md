# Plan Mode Tool Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Roc plan mode expose only read-only research and inspection tools to the model while preserving chat mode's current tool surface.

**Architecture:** Add a Roc-owned request-level model tool exposure middleware for plan mode. Wire `ChatStartRunRequest.mode` into `buildDeepAgent()`, use the middleware only for plan mode, keep read-only filesystem permissions as a runtime backstop, and update prompt text to describe the actual plan tool surface.

**Tech Stack:** TypeScript 6, Electron main process, DeepAgents 1.10.5, LangChain middleware, Vitest.

## Global Constraints

- Windows 11 and PowerShell are the execution environment.
- Do not fork DeepAgents or modify `node_modules/`.
- Do not use prompt-only enforcement for tool boundaries.
- Do not change renderer UI, IPC schema, background task persistence, scheduling, or history isolation.
- Do not change chat mode's current write-file, command, MCP, background-task, or subagent capabilities.
- plan mode model-visible allowlist is exactly `ls`, `read_file`, `glob`, `grep`, `web_read`, `ask_user`, `session_search`.
- plan mode model-visible deny surface includes `write_file`, `edit_file`, `delete_file`, `run_shell_command`, `execute`, `task`, `write_todos`, selected MCP tools, and background task tools.
- Keep `createRocReadOnlyFilesystemPermissions()` in plan mode as a runtime backstop.
- Keep TypeScript ESM style, 2-space indentation, semicolons, and single quotes.
- Do not update `AGENTS.md`; the current project rules already cover this boundary.

---

## File Structure

- Create `src/main/services/deep-agent/model-tool-exposure.ts`
  - Owns the plan-mode model-visible tool allowlist.
  - Exports `PLAN_MODE_MODEL_VISIBLE_TOOL_NAMES`, `filterPlanModeModelTools()`, and `createRocPlanToolExposureMiddleware()`.
- Create `tests/main/services/deep-agent/model-tool-exposure.test.ts`
  - Unit tests the allowlist and middleware behavior without building a full DeepAgents agent.
- Modify `src/main/services/deep-agent/agent-builder.ts`
  - Adds `mode` to `DeepAgentBuildInput`.
  - Adds `RocPlanToolExposureMiddleware` only when `mode === 'plan'`.
- Modify `src/main/plugins/agent/deep-agent-executor.ts`
  - Passes `input.request.mode` into `buildDeepAgent()`.
- Modify `src/main/services/deep-agent/context/prompt-blocks.ts`
  - Makes plan prompt describe only real read-only plan tools.
- Modify `tests/main/deep-agent-build-wiring.test.ts`
  - Verifies plan middleware wiring and chat non-wiring.
  - Updates existing build inputs to include `mode`.
- Modify `tests/main/plugins/agent/deep-agent-executor-tools.test.ts`
  - Verifies executor passes `mode: 'plan'`.
  - Verifies plan mode does not pass selected MCP or mutation custom tools.
- Modify `tests/main/services/deep-agent/deep-agent-official-contracts.test.ts`
  - Documents that read-only permissions do not remove DeepAgents write tools from the model tool list.
- Modify `tests/main/services/deep-agent/context/prompt-blocks.test.ts`
  - Verifies new plan prompt wording and removal of blocked-tool instruction wording.

---

### Task 1: Add Plan Tool Exposure Filter

**Files:**
- Create: `src/main/services/deep-agent/model-tool-exposure.ts`
- Create: `tests/main/services/deep-agent/model-tool-exposure.test.ts`

**Interfaces:**
- Produces:
  - `PLAN_MODE_MODEL_VISIBLE_TOOL_NAMES: readonly ['ls', 'read_file', 'glob', 'grep', 'web_read', 'ask_user', 'session_search']`
  - `filterPlanModeModelTools<TTool extends { name: string }>(tools: readonly TTool[]): TTool[]`
  - `createRocPlanToolExposureMiddleware(): ReturnType<typeof createMiddleware>`
- Consumes:
  - `createMiddleware` from `langchain`

- [ ] **Step 1: Write the failing unit test**

Create `tests/main/services/deep-agent/model-tool-exposure.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';

import {
  PLAN_MODE_MODEL_VISIBLE_TOOL_NAMES,
  createRocPlanToolExposureMiddleware,
  filterPlanModeModelTools
} from '../../../../src/main/services/deep-agent/model-tool-exposure';

type NamedTool = {
  name: string;
};

function tool(name: string): NamedTool {
  return { name };
}

describe('plan mode model tool exposure', () => {
  it('keeps only the plan mode model-visible allowlist', () => {
    const tools = [
      tool('ls'),
      tool('read_file'),
      tool('glob'),
      tool('grep'),
      tool('web_read'),
      tool('ask_user'),
      tool('session_search'),
      tool('write_file'),
      tool('edit_file'),
      tool('delete_file'),
      tool('run_shell_command'),
      tool('execute'),
      tool('task'),
      tool('write_todos'),
      tool('filesystem__search'),
      tool('resolve_background_task_time'),
      tool('propose_background_task'),
      tool('schedule_background_task'),
      tool('read_background_task'),
      tool('update_background_task'),
      tool('cancel_background_task')
    ];

    expect(filterPlanModeModelTools(tools).map((candidate) => candidate.name)).toEqual(
      PLAN_MODE_MODEL_VISIBLE_TOOL_NAMES
    );
  });

  it('filters request tools before the model call', async () => {
    const middleware = createRocPlanToolExposureMiddleware();
    const wrapModelCall = Reflect.get(middleware as object, 'wrapModelCall');
    if (typeof wrapModelCall !== 'function') {
      throw new Error('expected_wrap_model_call');
    }

    const handler = vi.fn(async (request: { tools?: NamedTool[] }) =>
      request.tools?.map((candidate) => candidate.name)
    );

    const output = await wrapModelCall(
      {
        tools: [
          tool('ls'),
          tool('write_file'),
          tool('web_read'),
          tool('task'),
          tool('session_search')
        ]
      },
      handler
    );

    expect(output).toEqual(['ls', 'web_read', 'session_search']);
    expect(handler).toHaveBeenCalledWith({
      tools: [tool('ls'), tool('web_read'), tool('session_search')]
    });
  });
});
```

- [ ] **Step 2: Run the unit test to verify it fails**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/model-tool-exposure.test.ts
```

Expected: FAIL because `src/main/services/deep-agent/model-tool-exposure.ts` does not exist.

- [ ] **Step 3: Add the minimal implementation**

Create `src/main/services/deep-agent/model-tool-exposure.ts`:

```typescript
import { createMiddleware } from 'langchain';

export const PLAN_MODE_MODEL_VISIBLE_TOOL_NAMES = [
  'ls',
  'read_file',
  'glob',
  'grep',
  'web_read',
  'ask_user',
  'session_search'
] as const;

const PLAN_MODE_MODEL_VISIBLE_TOOL_SET = new Set<string>(PLAN_MODE_MODEL_VISIBLE_TOOL_NAMES);

type NamedTool = {
  name: string;
};

export function filterPlanModeModelTools<TTool extends NamedTool>(tools: readonly TTool[]): TTool[] {
  return tools.filter((tool) => PLAN_MODE_MODEL_VISIBLE_TOOL_SET.has(tool.name));
}

export function createRocPlanToolExposureMiddleware() {
  return createMiddleware({
    name: 'RocPlanToolExposureMiddleware',
    wrapModelCall: async (request, handler) => {
      if (request.tools === undefined) {
        return await handler(request);
      }
      return await handler({
        ...request,
        tools: filterPlanModeModelTools(request.tools)
      });
    }
  });
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/model-tool-exposure.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- src/main/services/deep-agent/model-tool-exposure.ts tests/main/services/deep-agent/model-tool-exposure.test.ts
git commit -m "feat: add plan mode tool exposure filter"
```

---

### Task 2: Wire Plan Middleware Into Deep Agent Builder

**Files:**
- Modify: `src/main/services/deep-agent/agent-builder.ts`
- Modify: `tests/main/deep-agent-build-wiring.test.ts`

**Interfaces:**
- Consumes:
  - `createRocPlanToolExposureMiddleware()` from Task 1.
  - `ChatStartRunRequest['mode']` from `src/shared/types`.
- Produces:
  - `DeepAgentBuildInput.mode: ChatStartRunRequest['mode']`
  - `RocPlanToolExposureMiddleware` in `createDeepAgent({ middleware })` only when `mode === 'plan'`.

- [ ] **Step 1: Write failing builder wiring tests**

Modify `tests/main/deep-agent-build-wiring.test.ts`:

1. Add `mode: 'chat',` immediately after `const input = {` in every existing `input = { ... } as unknown as DeepAgentBuildInput` object in this file.

2. Add these tests before `it('runs Roc shell path policy before RTK can rewrite or deny shell commands', ...)`:

```typescript
  it('adds plan model tool exposure middleware only for plan mode', () => {
    const input = {
      mode: 'plan',
      model: {} as unknown,
      systemPrompt: 'system',
      backend: {} as unknown,
      store: {} as unknown,
      memorySources: [],
      skillSources: [],
      subagents: [],
      tools: [],
      filesystemPermissions: [
        { operations: ['read'], paths: ['/workspace/**'], mode: 'allow' },
        { operations: ['write'], paths: ['/**'], mode: 'deny' }
      ],
      workspacePath: 'F:\\Code\\Roc',
      interruptOn: undefined,
      checkpointer: undefined,
      providerType: 'openai_compatible',
      workflowHint: null,
      contextBudgetTokens: undefined
    } as unknown as DeepAgentBuildInput;

    buildDeepAgent(input);

    const createDeepAgentInput = vi.mocked(createDeepAgent).mock.calls[0]?.[0];
    const middlewareNames = createDeepAgentInput?.middleware?.map((middleware) =>
      Reflect.get(middleware as object, 'name')
    ) ?? [];

    expect(middlewareNames).toContain('RocPlanToolExposureMiddleware');
  });

  it('does not add plan model tool exposure middleware for chat mode', () => {
    const input = {
      mode: 'chat',
      model: {} as unknown,
      systemPrompt: 'system',
      backend: {} as unknown,
      store: {} as unknown,
      memorySources: [],
      skillSources: [],
      subagents: [],
      tools: [],
      filesystemPermissions: undefined,
      workspacePath: 'F:\\Code\\Roc',
      interruptOn: undefined,
      checkpointer: undefined,
      providerType: 'openai_compatible',
      workflowHint: null,
      contextBudgetTokens: undefined
    } as unknown as DeepAgentBuildInput;

    buildDeepAgent(input);

    const createDeepAgentInput = vi.mocked(createDeepAgent).mock.calls[0]?.[0];
    const middlewareNames = createDeepAgentInput?.middleware?.map((middleware) =>
      Reflect.get(middleware as object, 'name')
    ) ?? [];

    expect(middlewareNames).not.toContain('RocPlanToolExposureMiddleware');
  });
```

- [ ] **Step 2: Run builder test to verify it fails**

Run:

```powershell
pnpm test -- tests/main/deep-agent-build-wiring.test.ts
```

Expected: FAIL because `RocPlanToolExposureMiddleware` is not wired into `buildDeepAgent()`.

- [ ] **Step 3: Implement builder wiring**

Modify the imports at the top of `src/main/services/deep-agent/agent-builder.ts`:

```typescript
import type { ChatStartRunRequest, ProviderType, WorkflowHint } from '../../../shared/types';
import { createRocPlanToolExposureMiddleware } from './model-tool-exposure';
```

Modify `DeepAgentBuildInput`:

```typescript
export type DeepAgentBuildInput = {
  mode: ChatStartRunRequest['mode'];
  model: BaseChatModel;
  systemPrompt: string;
  backend: RocCompositeBackend;
  store: BaseStore;
  memorySources: string[];
  skillSources: string[];
  subagents: RuntimeSubagent[];
  tools: ClientTool[];
  filesystemPermissions: FilesystemPermission[] | undefined;
  workspacePath: string | null;
  interruptOn: NonNullable<Parameters<typeof createDeepAgent>[0]>['interruptOn'];
  checkpointer: BaseCheckpointSaver | undefined;
  providerType: ProviderType;
  workflowHint: WorkflowHint;
  contextBudgetTokens: number | undefined;
  hookMiddleware?: RocHookMiddlewareOptions;
};
```

Modify `buildDeepAgent()` immediately after `hookMiddleware`:

```typescript
  const hookMiddleware = input.hookMiddleware === undefined ? [] : [createRocHookMiddleware(input.hookMiddleware)];
  const planModeToolExposureMiddleware =
    input.mode === 'plan' ? [createRocPlanToolExposureMiddleware()] : [];
  const guardrails = [
    ...hookMiddleware,
    ...planModeToolExposureMiddleware,
    createRocShellPathPolicyMiddleware({ workspacePath: input.workspacePath }),
```

- [ ] **Step 4: Run builder test to verify it passes**

Run:

```powershell
pnpm test -- tests/main/deep-agent-build-wiring.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run Task 1 test again**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/model-tool-exposure.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add -- src/main/services/deep-agent/agent-builder.ts tests/main/deep-agent-build-wiring.test.ts
git commit -m "feat: wire plan mode tool exposure"
```

---

### Task 3: Pass Request Mode From Executor And Lock Custom Tool Surface

**Files:**
- Modify: `src/main/plugins/agent/deep-agent-executor.ts`
- Modify: `tests/main/plugins/agent/deep-agent-executor-tools.test.ts`

**Interfaces:**
- Consumes:
  - `DeepAgentBuildInput.mode` from Task 2.
- Produces:
  - `buildDeepAgent({ mode: input.request.mode, ... })`.

- [ ] **Step 1: Write failing executor tests**

Modify `tests/main/plugins/agent/deep-agent-executor-tools.test.ts`:

1. Add `createMcpTool` to the helper import list:

```typescript
  createMcpTool,
```

2. In `it('does not expose mutation tools in plan mode', ...)`, add this assertion after reading `toolNames`:

```typescript
    expect(readBuildInput().mode).toBe('plan');
```

3. Add this test after `it('does not expose mutation tools in plan mode', ...)`:

```typescript
  it('does not load selected MCP tools into plan mode custom tools', async () => {
    await buildExecutorOnce(
      createCapabilities([], {
        mcpTools: [createMcpTool('filesystem__search')]
      }),
      {
        mode: 'plan',
        workflowHint: null,
        taskSource: null,
        enabledCapabilities: {
          mcpServers: ['filesystem'],
          skills: []
        }
      }
    );

    const toolNames = readBuiltTools().map((tool) => tool.name);

    expect(readBuildInput().mode).toBe('plan');
    expect(toolNames).toContain('web_read');
    expect(toolNames).toContain('ask_user');
    expect(toolNames).toContain('session_search');
    expect(toolNames).not.toContain('filesystem__search');
  });
```

- [ ] **Step 2: Run executor tools test to verify it fails**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/deep-agent-executor-tools.test.ts
```

Expected: FAIL because `readBuildInput().mode` is currently undefined.

- [ ] **Step 3: Pass mode into `buildDeepAgent()`**

Modify the `buildDeepAgent({ ... })` object in `src/main/plugins/agent/deep-agent-executor.ts`:

```typescript
      const agent = buildDeepAgent({
        mode: input.request.mode,
        model: handle.model,
        systemPrompt: contextHarness.systemPrompt,
        backend: runtimeBackend.backend,
        store: options.store,
        memorySources: contextHarness.memorySources,
        skillSources: contextHarness.skillSources,
        subagents: createRunSubagents({
          webReadTool: tools.webReadTool
        }),
        tools: contextHarness.tools,
```

- [ ] **Step 4: Run executor tools test to verify it passes**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/deep-agent-executor-tools.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run builder test again**

Run:

```powershell
pnpm test -- tests/main/deep-agent-build-wiring.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add -- src/main/plugins/agent/deep-agent-executor.ts tests/main/plugins/agent/deep-agent-executor-tools.test.ts
git commit -m "feat: pass agent request mode to builder"
```

---

### Task 4: Document DeepAgents Read-Only Permission Limitation

**Files:**
- Modify: `tests/main/services/deep-agent/deep-agent-official-contracts.test.ts`

**Interfaces:**
- Consumes:
  - `createFilesystemMiddleware` from `deepagents`.
  - `createRocReadOnlyFilesystemPermissions()` from `src/main/services/deep-agent/filesystem-tool-contract.ts`.
- Produces:
  - A contract test proving read-only permissions do not hide write tools from model tool registration.

- [ ] **Step 1: Write the contract test**

Modify imports in `tests/main/services/deep-agent/deep-agent-official-contracts.test.ts`:

```typescript
import { DEEP_AGENT_BUILT_IN_TOOLS } from '../../../../src/main/services/deep-agent/types';
import { createRocReadOnlyFilesystemPermissions } from '../../../../src/main/services/deep-agent/filesystem-tool-contract';
```

Add this test after `it('documents that DeepAgents filesystem middleware registers execute with file tools', ...)`:

```typescript
  it('documents that read-only permissions do not hide write tools from DeepAgents filesystem middleware', () => {
    const middleware = createFilesystemMiddleware({
      permissions: createRocReadOnlyFilesystemPermissions()
    });
    const tools = middleware.tools;
    if (tools === undefined) {
      throw new Error('expected_filesystem_tools');
    }
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual(expect.arrayContaining([
      'ls',
      'read_file',
      'write_file',
      'edit_file',
      'glob',
      'grep'
    ]));
  });
```

- [ ] **Step 2: Run the contract test**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/deep-agent-official-contracts.test.ts
```

Expected: PASS. This test is expected to pass before implementation because it documents the upstream behavior that motivated the fix.

- [ ] **Step 3: Commit**

```powershell
git add -- tests/main/services/deep-agent/deep-agent-official-contracts.test.ts
git commit -m "test: document read only filesystem tool exposure"
```

---

### Task 5: Update Plan Mode Prompt To Match Tool Surface

**Files:**
- Modify: `src/main/services/deep-agent/context/prompt-blocks.ts`
- Modify: `tests/main/services/deep-agent/context/prompt-blocks.test.ts`

**Interfaces:**
- Consumes:
  - Existing `buildPromptBlocks()` behavior.
- Produces:
  - plan prompt that describes read-only inspection tools and no longer mentions blocked mutation tool calls.

- [ ] **Step 1: Write failing prompt assertions**

Modify `it('adds plan mode instructions when request mode is plan', ...)` in `tests/main/services/deep-agent/context/prompt-blocks.test.ts`:

```typescript
    expect(prompt).toContain('Plan Mode');
    expect(prompt).toContain('Plan Mode exposes read-only inspection tools only.');
    expect(prompt).toContain('Use ls, read_file, glob, and grep for local inspection in Plan Mode.');
    expect(prompt).toContain('Use web_read for public web pages.');
    expect(prompt).toContain('Use ask_user only for concise clarifying questions when needed.');
    expect(prompt).toContain('<proposed_plan>');
    expect(prompt).toContain('</proposed_plan>');
    expect(prompt).not.toContain('Use run_shell_command');
    expect(prompt).not.toContain('Do not call write_file');
    expect(prompt).not.toContain('Do not call edit_file');
    expect(prompt).not.toContain('Do not call delete_file');
    expect(prompt).not.toContain('Do not call run_shell_command');
    expect(prompt).not.toContain('After write_file or edit_file');
```

- [ ] **Step 2: Run prompt test to verify it fails**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/context/prompt-blocks.test.ts
```

Expected: FAIL because the prompt still contains `Do not call write_file, edit_file, delete_file, or run_shell_command in Plan Mode.` and does not contain the new read-only wording.

- [ ] **Step 3: Update plan prompt wording**

Modify the `if (mode === 'plan')` branch in `buildWorkspacePrompt()` in `src/main/services/deep-agent/context/prompt-blocks.ts`:

```typescript
  if (mode === 'plan') {
    return [
      `Workspace: ${workspacePath}`,
      'Plan Mode exposes read-only inspection tools only.',
      'Local file inspection uses Roc virtual routes: /workspace/, /memory/, and /skills/.',
      'Use ls, read_file, glob, and grep for local inspection in Plan Mode.',
      'Use web_read for public web pages.',
      'Use ask_user only for concise clarifying questions when needed.'
    ].join('\n');
  }
```

- [ ] **Step 4: Run prompt test to verify it passes**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/context/prompt-blocks.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- src/main/services/deep-agent/context/prompt-blocks.ts tests/main/services/deep-agent/context/prompt-blocks.test.ts
git commit -m "fix: align plan prompt with read only tools"
```

---

### Task 6: Verify End-To-End Tool Boundary

**Files:**
- Test-only task; no planned source modifications.

**Interfaces:**
- Consumes all previous tasks.
- Produces a verified status for the plan-mode tool boundary.

- [ ] **Step 1: Run focused model exposure test**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/model-tool-exposure.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run executor tool surface test**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/deep-agent-executor-tools.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run DeepAgents contract test**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/deep-agent-official-contracts.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run prompt test**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/context/prompt-blocks.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run builder wiring test**

Run:

```powershell
pnpm test -- tests/main/deep-agent-build-wiring.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run TypeScript verification**

Run:

```powershell
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Run whitespace and patch check**

Run:

```powershell
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 8: Inspect final diff**

Run:

```powershell
git status --short --branch
git diff --stat
```

Expected: working branch is `main`; diff contains only plan-mode tool boundary source and test changes.

- [ ] **Step 9: Commit verification-ready result if prior tasks were squashed by the executor**

Run this only if earlier tasks were not already committed:

```powershell
git add -- src/main/services/deep-agent/model-tool-exposure.ts src/main/services/deep-agent/agent-builder.ts src/main/plugins/agent/deep-agent-executor.ts src/main/services/deep-agent/context/prompt-blocks.ts tests/main/services/deep-agent/model-tool-exposure.test.ts tests/main/deep-agent-build-wiring.test.ts tests/main/plugins/agent/deep-agent-executor-tools.test.ts tests/main/services/deep-agent/deep-agent-official-contracts.test.ts tests/main/services/deep-agent/context/prompt-blocks.test.ts
git commit -m "fix: hide mutation tools in plan mode"
```

Expected: commit succeeds, or no commit is needed because each task already committed its changes.
