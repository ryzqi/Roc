# DeepAgents Write File Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent recurrence of existing-file `write_file` conflicts by locking Roc path policy, adding create-only prompt guidance, and proving the DeepAgents conflict is treated as a hard file-tool error.

**Architecture:** Keep DeepAgents' upstream create-only `write_file` semantics. Roc stays responsible for virtual route validation, model-facing contract text, and hard tool error classification. The implementation is deliberately narrow: one contract string update plus focused regression tests and middleware-stack evidence.

**Tech Stack:** TypeScript 6.0, Vitest 4.1, Electron main process services, `deepagents@1.10.5`, LangChain middleware.

## Global Constraints

- Do not change DeepAgents source code or vendor a patched backend.
- Do not add overwrite/upsert behavior to `write_file`.
- Do not automatically rewrite `/frontend/index.html` to `/workspace/frontend/index.html`.
- Do not change shell cwd rules or allow `/workspace/...` in `run_shell_command`.
- Do not change UI layout or renderer behavior.
- Preserve Roc file-tool route prefixes: `/workspace`, `/memory`, and `/skills`.
- User-facing replies use Simplified Chinese; code identifiers, CLI commands, logs, errors, and protocol fields keep original language.
- PowerShell is the command shell for examples and verification.

---

## File Structure

- Modify `src/main/services/deep-agent/filesystem-tool-contract.ts`
  - Owns Roc file-tool route constants, path-field mapping, permissions, path normalization, and prompt guidance.
- Modify `tests/main/services/deep-agent/filesystem-tool-contract.test.ts`
  - Locks the route contract, invalid-path behavior, permissions, and prompt guidance array.
- Modify `tests/main/services/deep-agent/filesystem-path-policy.test.ts`
  - Locks runtime middleware behavior for invalid tool-call paths before handlers execute.
- Modify `tests/main/services/deep-agent/context/prompt-blocks.test.ts`
  - Locks normal chat prompt content and verifies plan mode stays mutation-free.
- Modify `tests/main/services/forge-guardrails/middleware/filesystem-tool-errors.test.ts`
  - Locks hard-error classification for DeepAgents file-tool failures.
- Modify `tests/main/deep-agent-build-wiring.test.ts`
  - Locks middleware stack evidence for Roc path policy and file-tool error middleware.

## Task 1: Lock `/frontend/index.html` Route Rejection

**Files:**
- Modify: `tests/main/services/deep-agent/filesystem-tool-contract.test.ts`
- Modify: `tests/main/services/deep-agent/filesystem-path-policy.test.ts`

**Interfaces:**
- Consumes: `validateRocFileToolPath(path: string)`, `normalizeRocFileToolPath(path: string)`, `createRocFilesystemPathPolicyMiddleware()`, `ROC_FILE_TOOL_ROUTE_ERROR`.
- Produces: Regression evidence that `/frontend/index.html` is rejected by Roc path validation and middleware.

- [ ] **Step 1: Add contract-level invalid path case**

In `tests/main/services/deep-agent/filesystem-tool-contract.test.ts`, add `/frontend/index.html` to the invalid path table:

```ts
  it.each([
    ['/home/user/workarea/create_docx.py', ROC_FILE_TOOL_ROUTE_ERROR],
    ['/tmp/create_docx.py', ROC_FILE_TOOL_ROUTE_ERROR],
    ['/frontend/index.html', ROC_FILE_TOOL_ROUTE_ERROR],
    ['F:\\Code\\Roc\\create_docx.py', ROC_FILE_TOOL_WINDOWS_PATH_ERROR],
    ['\\\\server\\share\\file.txt', ROC_FILE_TOOL_WINDOWS_PATH_ERROR],
    ['relative/file.txt', ROC_FILE_TOOL_ROUTE_ERROR],
    ['/agents/AGENTS.md', ROC_FILE_TOOL_ROUTE_ERROR],
    ['/workspace/../secret.txt', ROC_FILE_TOOL_TRAVERSAL_ERROR]
  ])('rejects invalid file-tool path %s', (path, error) => {
    expect(validateRocFileToolPath(path)).toEqual({ ok: false, error });
    expect(normalizeRocFileToolPath(path)).toEqual({ ok: false, error });
  });
```

- [ ] **Step 2: Add middleware-level regression**

In `tests/main/services/deep-agent/filesystem-path-policy.test.ts`, import `ROC_FILE_TOOL_ROUTE_ERROR` and add this test inside `describe('createRocFilesystemPathPolicyMiddleware', ...)`:

```ts
  it('rejects non-route absolute project paths before write_file reaches the handler', async () => {
    const middleware = createRocFilesystemPathPolicyMiddleware();
    const handler = vi.fn(async () => new ToolMessage({
      tool_call_id: 'call-front-end',
      name: 'write_file',
      content: 'handler reached'
    }));

    const result = await middleware.wrapToolCall!(
      {
        toolCall: {
          id: 'call-front-end',
          name: 'write_file',
          args: {
            file_path: '/frontend/index.html',
            content: '<!doctype html>'
          }
        },
        state: { messages: [] }
      } as never,
      handler
    );

    expect(handler).not.toHaveBeenCalled();
    expect(result).toBeInstanceOf(ToolMessage);
    expect(result).toMatchObject({
      tool_call_id: 'call-front-end',
      name: 'write_file',
      status: 'error',
      content: ROC_FILE_TOOL_ROUTE_ERROR
    });
  });
```

Update the import block to include `ROC_FILE_TOOL_ROUTE_ERROR`:

```ts
import {
  ROC_FILE_TOOL_MISSING_PATH_ERROR,
  ROC_FILE_TOOL_ROUTE_ERROR,
  ROC_FILE_TOOL_WINDOWS_PATH_ERROR
} from '../../../../src/main/services/deep-agent/filesystem-tool-contract';
```

- [ ] **Step 3: Run focused path tests**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/filesystem-tool-contract.test.ts tests/main/services/deep-agent/filesystem-path-policy.test.ts
```

Expected: both files pass. A failure here means current Roc path policy does not match the documented route contract.

- [ ] **Step 4: Commit Task 1**

Run:

```powershell
git add tests/main/services/deep-agent/filesystem-tool-contract.test.ts tests/main/services/deep-agent/filesystem-path-policy.test.ts
git commit -m "test: lock roc file route rejection"
```

## Task 2: Add Create-Only Prompt Contract

**Files:**
- Modify: `src/main/services/deep-agent/filesystem-tool-contract.ts`
- Modify: `tests/main/services/deep-agent/filesystem-tool-contract.test.ts`
- Modify: `tests/main/services/deep-agent/context/prompt-blocks.test.ts`
- Modify: `tests/main/plugins/agent/deep-agent-executor-tools.test.ts`

**Interfaces:**
- Consumes: `ROC_FILE_TOOL_PROMPT_LINES`, `buildPromptBlocks(...)`, `serializePromptBlocks(...)`, executor context assembly.
- Produces: Model-facing guidance that `write_file` creates new files only and existing files require `read_file -> edit_file`.

- [ ] **Step 1: Add failing prompt contract assertions**

In `tests/main/services/deep-agent/filesystem-tool-contract.test.ts`, update the expected `ROC_FILE_TOOL_PROMPT_LINES` array:

```ts
    expect(ROC_FILE_TOOL_PROMPT_LINES).toEqual([
      'DeepAgents file tools accept only Roc virtual routes: /workspace/, /memory/, and /skills/.',
      'Agent memory files live under /memory/.../AGENTS.md, matching DeepAgents memory-source semantics.',
      'write_file only creates new files. To change an existing file, read it first, then use edit_file with an exact replacement.',
      'Use run_shell_command for local Windows commands; its default cwd is the selected Roc workspace root.',
      'Never pass /workspace/... to run_shell_command; use a relative path from the default cwd or a real Windows path.',
      'Do not pass Windows absolute paths or Linux paths to read_file, write_file, edit_file, ls, glob, grep, or delete_file.'
    ]);
```

- [ ] **Step 2: Add normal chat prompt assertion**

In `tests/main/services/deep-agent/context/prompt-blocks.test.ts`, extend `it('serializes production prompt with block markers', ...)`:

```ts
    expect(prompt).toContain('write_file only creates new files. To change an existing file, read it first, then use edit_file with an exact replacement.');
```

Keep the existing plan-mode negative assertion unchanged:

```ts
    expect(prompt).not.toContain('After write_file or edit_file');
```

Also add this negative assertion in the same plan-mode test:

```ts
    expect(prompt).not.toContain('write_file only creates new files.');
```

- [ ] **Step 3: Add executor prompt assertion**

In `tests/main/plugins/agent/deep-agent-executor-tools.test.ts`, extend `it('uses the shared workflow system prompt in production executor runs', ...)`:

```ts
    expect(buildInput.systemPrompt).toContain('write_file only creates new files. To change an existing file, read it first, then use edit_file with an exact replacement.');
```

- [ ] **Step 4: Run prompt tests to confirm failure before production change**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/filesystem-tool-contract.test.ts tests/main/services/deep-agent/context/prompt-blocks.test.ts tests/main/plugins/agent/deep-agent-executor-tools.test.ts
```

Expected: failures mention the missing `write_file only creates new files...` prompt line.

- [ ] **Step 5: Implement prompt contract line**

In `src/main/services/deep-agent/filesystem-tool-contract.ts`, update `ROC_FILE_TOOL_PROMPT_LINES`:

```ts
export const ROC_FILE_TOOL_PROMPT_LINES = [
  'DeepAgents file tools accept only Roc virtual routes: /workspace/, /memory/, and /skills/.',
  'Agent memory files live under /memory/.../AGENTS.md, matching DeepAgents memory-source semantics.',
  'write_file only creates new files. To change an existing file, read it first, then use edit_file with an exact replacement.',
  'Use run_shell_command for local Windows commands; its default cwd is the selected Roc workspace root.',
  'Never pass /workspace/... to run_shell_command; use a relative path from the default cwd or a real Windows path.',
  'Do not pass Windows absolute paths or Linux paths to read_file, write_file, edit_file, ls, glob, grep, or delete_file.'
] as const;
```

- [ ] **Step 6: Run prompt tests to verify pass**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/filesystem-tool-contract.test.ts tests/main/services/deep-agent/context/prompt-blocks.test.ts tests/main/plugins/agent/deep-agent-executor-tools.test.ts
```

Expected: all listed tests pass.

- [ ] **Step 7: Commit Task 2**

Run:

```powershell
git add src/main/services/deep-agent/filesystem-tool-contract.ts tests/main/services/deep-agent/filesystem-tool-contract.test.ts tests/main/services/deep-agent/context/prompt-blocks.test.ts tests/main/plugins/agent/deep-agent-executor-tools.test.ts
git commit -m "fix: clarify deepagents write-file contract"
```

## Task 3: Lock Existing-File Conflict Classification

**Files:**
- Modify: `tests/main/services/forge-guardrails/middleware/filesystem-tool-errors.test.ts`

**Interfaces:**
- Consumes: `createFilesystemToolErrorMiddleware()` and `ToolMessage.status`.
- Produces: Regression evidence that DeepAgents existing-file `write_file` conflicts are hard file-tool errors.

- [ ] **Step 1: Add exact DeepAgents conflict test**

In `tests/main/services/forge-guardrails/middleware/filesystem-tool-errors.test.ts`, add this test inside `describe('ForgeFilesystemToolErrorMiddleware', ...)`:

```ts
  it('marks DeepAgents write_file existing-file conflicts as hard tool errors', async () => {
    const result = await runWrapToolCall({
      toolName: 'write_file',
      content: 'Cannot write to /frontend/index.html because it already exists. Read and then make an edit, or write to a new path.'
    });

    expect(result).toBeInstanceOf(ToolMessage);
    expect(result).toMatchObject({
      tool_call_id: 'call-write_file',
      name: 'write_file',
      status: 'error',
      content: 'Cannot write to /frontend/index.html because it already exists. Read and then make an edit, or write to a new path.'
    });
  });
```

- [ ] **Step 2: Run filesystem tool error tests**

Run:

```powershell
pnpm test -- tests/main/services/forge-guardrails/middleware/filesystem-tool-errors.test.ts
```

Expected: pass. Existing implementation already treats `Cannot write to ` as a hard `write_file` failure; this task locks the exact production symptom.

- [ ] **Step 3: Commit Task 3**

Run:

```powershell
git add tests/main/services/forge-guardrails/middleware/filesystem-tool-errors.test.ts
git commit -m "test: lock deepagents write conflict handling"
```

## Task 4: Prove Roc Middleware Stack Covers Runtime Paths

**Files:**
- Modify: `tests/main/deep-agent-build-wiring.test.ts`

**Interfaces:**
- Consumes: `buildDeepAgent(input: DeepAgentBuildInput)` and mocked `createDeepAgent` call input.
- Produces: Evidence that Roc path policy executes before filesystem tool error classification in the created DeepAgents middleware stack.

- [ ] **Step 1: Add middleware stack assertion**

In `tests/main/deep-agent-build-wiring.test.ts`, add this test near the existing middleware wiring tests:

```ts
  it('keeps Roc filesystem path policy before filesystem tool error classification', () => {
    const input = {
      mode: 'chat',
      model: {} as unknown,
      systemPrompt: 'system',
      backend: {} as unknown,
      store: {} as unknown,
      memorySources: ['/memory/global/AGENTS.md'],
      skillSources: [],
      subagents: [],
      tools: [],
      filesystemPermissions: [
        { operations: ['read'], paths: ['/workspace/**', '/memory/**', '/skills/**'], mode: 'allow' },
        { operations: ['write'], paths: ['/workspace/**', '/memory/**'], mode: 'allow' },
        { operations: ['write'], paths: ['/skills/**'], mode: 'deny' },
        { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' }
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
    if (createDeepAgentInput === undefined) {
      throw new Error('Expected DeepAgents input.');
    }
    const middlewareNames = createDeepAgentInput.middleware?.map((middleware) =>
      Reflect.get(middleware as object, 'name')
    ) ?? [];

    expect(middlewareNames).toContain('RocFilesystemPathPolicyMiddleware');
    expect(middlewareNames).toContain('ForgeFilesystemToolErrorMiddleware');
    expect(middlewareNames.indexOf('RocFilesystemPathPolicyMiddleware')).toBeLessThan(
      middlewareNames.indexOf('ForgeFilesystemToolErrorMiddleware')
    );
  });
```

- [ ] **Step 2: Extend plan-mode stack assertion**

In the existing `it('builds plan mode without file mutation tools while preserving non-file tools', ...)` test, extend the middleware assertions:

```ts
    expect(middlewareNames).toEqual(expect.arrayContaining([
      'RocPlanReadOnlyMemoryMiddleware',
      'RocPlanToolExposureMiddleware',
      'RocPlanRuntimeToolGuardMiddleware',
      'RocPlanFilesystemDefaultPathMiddleware',
      'RocFilesystemPathPolicyMiddleware',
      'ForgeFilesystemToolErrorMiddleware'
    ]));
```

Add ordering:

```ts
    expect(middlewareNames.indexOf('RocFilesystemPathPolicyMiddleware')).toBeLessThan(
      middlewareNames.indexOf('ForgeFilesystemToolErrorMiddleware')
    );
```

Extend the general-purpose and research subagent assertions:

```ts
    expect(generalPurposeMiddlewareNames).toEqual(expect.arrayContaining([
      'RocPlanReadOnlyMemoryMiddleware',
      'RocPlanToolExposureMiddleware',
      'RocPlanRuntimeToolGuardMiddleware',
      'RocPlanFilesystemDefaultPathMiddleware',
      'RocFilesystemPathPolicyMiddleware',
      'ForgeFilesystemToolErrorMiddleware'
    ]));
    expect(researchMiddlewareNames).toEqual(expect.arrayContaining([
      'RocPlanReadOnlyMemoryMiddleware',
      'RocPlanToolExposureMiddleware',
      'RocPlanRuntimeToolGuardMiddleware',
      'RocPlanFilesystemDefaultPathMiddleware',
      'RocFilesystemPathPolicyMiddleware',
      'ForgeFilesystemToolErrorMiddleware'
    ]));
```

- [ ] **Step 3: Run build wiring test**

Run:

```powershell
pnpm test -- tests/main/deep-agent-build-wiring.test.ts
```

Expected: pass. If this fails, inspect `src/main/services/deep-agent/agent-builder.ts` and keep the existing order where `createRocFilesystemPathPolicyMiddleware()` appears before `createFilesystemToolErrorMiddleware()`.

- [ ] **Step 4: Commit Task 4**

Run:

```powershell
git add tests/main/deep-agent-build-wiring.test.ts
git commit -m "test: lock roc filesystem middleware order"
```

## Task 5: Final Verification And Evidence

**Files:**
- No source edits.
- Use current diff and test output.

**Interfaces:**
- Consumes: all changes from Tasks 1-4.
- Produces: final evidence for the user: located path behavior, changed prompt contract, hard-error classification, and passing verification.

- [ ] **Step 1: Run targeted verification**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/filesystem-tool-contract.test.ts tests/main/services/deep-agent/filesystem-path-policy.test.ts tests/main/services/forge-guardrails/middleware/filesystem-tool-errors.test.ts tests/main/services/deep-agent/context/prompt-blocks.test.ts tests/main/plugins/agent/deep-agent-executor-tools.test.ts tests/main/deep-agent-build-wiring.test.ts
```

Expected: all listed test files pass.

- [ ] **Step 2: Run TypeScript verification**

Run:

```powershell
pnpm typecheck
```

Expected: pass.

- [ ] **Step 3: Run whitespace verification**

Run:

```powershell
git diff --check
```

Expected: no output and exit code `0`.

- [ ] **Step 4: Inspect final diff**

Run:

```powershell
git diff --stat
git diff -- src/main/services/deep-agent/filesystem-tool-contract.ts tests/main/services/deep-agent/filesystem-tool-contract.test.ts tests/main/services/deep-agent/filesystem-path-policy.test.ts tests/main/services/forge-guardrails/middleware/filesystem-tool-errors.test.ts tests/main/services/deep-agent/context/prompt-blocks.test.ts tests/main/plugins/agent/deep-agent-executor-tools.test.ts tests/main/deep-agent-build-wiring.test.ts
```

Expected: diff only contains the planned prompt line and regression tests.

- [ ] **Step 5: Commit final verification marker only if there are uncommitted verification edits**

Run:

```powershell
git status --short --branch
```

Expected after Tasks 1-4 commits: clean working tree on `main`. Do not create an empty commit.

## Self-Review

- Spec coverage: Task 1 covers `/frontend/index.html` route rejection; Task 2 covers create-only prompt contract; Task 3 covers DeepAgents existing-file conflict classification; Task 4 covers middleware stack evidence; Task 5 covers verification.
- Placeholder scan: no plan-writing placeholder wording is used.
- Type consistency: all referenced functions and constants already exist in `src/main/services/deep-agent/` or `src/main/services/forge-guardrails/`; no new exported API is introduced.
