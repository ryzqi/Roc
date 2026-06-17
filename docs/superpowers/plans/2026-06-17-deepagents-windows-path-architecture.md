# DeepAgents Windows Path Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split DeepAgents file-tool paths from Roc Windows shell execution so invalid Linux/Windows file paths fail before backend writes, and commands run only through a Roc-owned Windows command tool.

**Architecture:** Keep DeepAgents built-in file tools and routed virtual filesystem paths. Remove command execution from the backend passed to DeepAgents filesystem middleware by wrapping `CompositeBackend` in a non-execution file backend, then expose shell execution as a Roc custom tool. Add explicit filesystem permissions, hard file-tool path policy, and cleanup prompts/docs/tests that still describe DeepAgents built-in `execute`.

**Tech Stack:** TypeScript, Electron main process, DeepAgents JS, LangChain middleware, Vitest, PowerShell.

---

## Source Spec

- `docs/superpowers/specs/2026-06-17-deepagents-windows-path-architecture-design.md`

## File Structure

- `src/main/services/deep-agent/backend.ts`
  - Split the current `RocHostShellBackend` responsibility.
  - Add a route-rejecting filesystem backend that does not implement `execute`.
  - Wrap DeepAgents `CompositeBackend` so the object passed to `createDeepAgent` exposes file methods and `routePrefixes`, but no `execute`.
  - Export filesystem permission rules.

- `src/main/services/deep-agent/filesystem-path-policy.ts`
  - New focused middleware and validators for file-tool path arguments.
  - Reject invalid paths before backend dispatch and return `ToolMessage` with `status: 'error'`.

- `src/main/services/deep-agent/command-tool.ts`
  - New focused Roc command tool.
  - Uses Windows command semantics and calls `AgentExecuteAdapter`.
  - Rejects DeepAgents virtual paths and Linux-style local paths before invoking `shell.execute`.

- `src/main/services/deep-agent/agent-builder.ts`
  - Use the new path policy middleware before filesystem error normalization.
  - Pass explicit permissions into `createDeepAgent`.

- `src/main/services/deep-agent/harness-profiles.ts`
  - Add `excludedTools: ['execute']` to the existing Roc harness profile.

- `src/main/services/deep-agent/types.ts`
  - Remove `execute` from `DEEP_AGENT_BUILT_IN_TOOLS`.
  - Keep `AgentExecuteAdapter` for the Roc command tool path.

- `src/main/plugins/agent/deep-agent-executor.ts`
  - Stop passing shell execution into `createBackend`.
  - Add the Roc command tool to `runTools`.
  - Pass explicit filesystem permissions.

- `src/main/services/deep-agent/prompt.ts`
  - Remove old prompt compensation that teaches the model to reconcile `/workspace/` with Windows shell paths.
  - Mention `run_shell_command` as the Windows command tool only if command guidance is still needed.

- `src/main/services/deep-agent/prompt-builder.ts`
  - Mirror the prompt cleanup for the alternate prompt builder path.

- `src/main/plugins/agent/capability-preview.ts`
  - Replace the built-in `execute` capability card with the Roc command tool capability card.

- `docs/rtk-integration.md`
  - Move RTK wording from DeepAgents built-in `execute` to the Roc command tool path.

- Tests:
  - `tests/main/services/deep-agent/backend.test.ts`
  - `tests/main/services/deep-agent/filesystem-path-policy.test.ts`
  - `tests/main/services/deep-agent/command-tool.test.ts`
  - `tests/main/deep-agent-build-wiring.test.ts`
  - `tests/main/plugins/agent/deep-agent-executor.test.ts`
  - `tests/main/deep-agent-prompt.test.ts`
  - `tests/main/services/deep-agent/prompt-builder.test.ts`
  - `tests/main/plugins/agent/capability-preview.test.ts`
  - `tests/main/deep-agent-tool-retry.test.ts`
  - `tests/main/services/forge-guardrails/integration/full-stack.test.ts`

---

### Task 1: Add Red Tests For Non-Execution Backend And Permissions

**Files:**
- Create: `tests/main/services/deep-agent/backend.test.ts`
- Modify: `tests/main/plugins/agent/deep-agent-executor.test.ts`

- [ ] **Step 1: Create backend tests that prove the current backend is wrong**

Create `tests/main/services/deep-agent/backend.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createBackend, createRocFilesystemPermissions } from '../../../../src/main/services/deep-agent/backend';
import { CapacityService } from '../../../../src/main/services/memory/capacity';
import { defaultSettings } from '../../../../src/main/services/config/defaults';
import { SecurityScanService } from '../../../../src/main/services/memory/security-scan';
import { RocPaths } from '../../../../src/main/services/paths';

const workspacePath = 'F:\\Code\\Roc';

function createTestBackend() {
  return createBackend({
    workspaceService: {
      getCurrentWorkspace: () => ({ path: workspacePath, label: 'Roc' })
    } as Parameters<typeof createBackend>[0]['workspaceService'],
    paths: new RocPaths('F:\\Code\\Roc\\.test-data'),
    securityScan: new SecurityScanService(defaultSettings.memory.securityScan),
    capacity: new CapacityService(defaultSettings.memory.charLimits),
    consolidatorService: {
      scheduleForFile: vi.fn()
    } as unknown as Parameters<typeof createBackend>[0]['consolidatorService'],
    activeModelHandle: {} as Parameters<typeof createBackend>[0]['activeModelHandle'],
    selectedSkillIds: []
  });
}

describe('DeepAgents Roc backend', () => {
  it('does not expose execute on the filesystem backend passed to DeepAgents', () => {
    const { backend } = createTestBackend();

    expect('execute' in backend).toBe(false);
    expect(Reflect.get(backend, 'execute')).toBeUndefined();
  });

  it('keeps Roc virtual route prefixes for file tools', () => {
    const { backend } = createTestBackend();

    expect(backend.routePrefixes).toEqual(expect.arrayContaining(['/workspace/', '/skills/', '/agents/', '/memory/']));
  });

  it('keeps unknown file routes as hard errors', async () => {
    const { backend } = createTestBackend();

    await expect(backend.write('/home/user/workarea/create_docx.py', 'print(1)')).resolves.toEqual({
      error: 'Roc 当前只允许访问 /workspace/、/skills/、/agents/、/memory/ 路径。'
    });
  });

  it('uses an explicit final deny rule because DeepAgents permissions default to allow', () => {
    expect(createRocFilesystemPermissions()).toEqual([
      { operations: ['read'], paths: ['/workspace/**', '/memory/**', '/skills/**', '/agents/**'], mode: 'allow' },
      { operations: ['write'], paths: ['/workspace/**', '/memory/**'], mode: 'allow' },
      { operations: ['write'], paths: ['/skills/**', '/agents/**'], mode: 'deny' },
      { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' }
    ]);
  });
});
```

- [ ] **Step 2: Update executor wiring test to expect permissions**

In `tests/main/plugins/agent/deep-agent-executor.test.ts`, change the backend test around the existing `keeps the DeepAgents backend available during workbench proposal runs` case:

```ts
expect(buildInput.backend.routePrefixes).toEqual(expect.arrayContaining(['/workspace/', '/skills/', '/agents/', '/memory/']));
expect('execute' in buildInput.backend).toBe(false);
expect(buildInput.filesystemPermissions).toEqual([
  { operations: ['read'], paths: ['/workspace/**', '/memory/**', '/skills/**', '/agents/**'], mode: 'allow' },
  { operations: ['write'], paths: ['/workspace/**', '/memory/**'], mode: 'allow' },
  { operations: ['write'], paths: ['/skills/**', '/agents/**'], mode: 'deny' },
  { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' }
]);
```

- [ ] **Step 3: Run tests to verify they fail for the current implementation**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/backend.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts
```

Expected:

- `does not expose execute on the filesystem backend passed to DeepAgents` fails because the current backend exposes `execute`.
- `keeps the DeepAgents backend available during workbench proposal runs` fails because `filesystemPermissions` is still `undefined`.

- [ ] **Step 4: Commit red tests**

Run:

```powershell
git add tests/main/services/deep-agent/backend.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts
git commit -m "test: cover deepagents file backend boundaries"
```

---

### Task 2: Split DeepAgents File Backend From Shell Execution

**Files:**
- Modify: `src/main/services/deep-agent/backend.ts`
- Modify: `src/main/plugins/agent/deep-agent-executor.ts`
- Modify: `src/main/services/deep-agent/agent-builder.ts`

- [ ] **Step 1: Replace sandbox backend typing in backend.ts**

In `src/main/services/deep-agent/backend.ts`, remove `ExecuteResponse` and `SandboxBackendProtocolV2` from the `deepagents` import and remove `AgentExecuteAdapter`.

Replace the current `RocCompositeBackend` type with:

```ts
export type RocCompositeBackend = AnyBackendProtocol & {
  readonly routePrefixes: string[];
};
```

- [ ] **Step 2: Replace `RocHostShellBackend` with a non-execution file fallback**

Delete the `RocHostShellBackend` class and add this class in its place:

```ts
class RocRouteRejectingFilesystemBackend {
  readonly id = 'roc-route-rejecting-filesystem';

  ls(_path: string): Promise<LsResult> {
    return Promise.resolve({ files: [] });
  }

  read(_filePath: string, _offset?: number, _limit?: number): Promise<ReadResult> {
    return Promise.resolve({ error: UNKNOWN_ROUTE_ERROR });
  }

  readRaw(_filePath: string): Promise<ReadRawResult> {
    return Promise.resolve({ error: UNKNOWN_ROUTE_ERROR });
  }

  grep(_pattern: string, _path?: string | null, _glob?: string | null): Promise<GrepResult> {
    return Promise.resolve({ matches: [] });
  }

  glob(_pattern: string, _path?: string): Promise<GlobResult> {
    return Promise.resolve({ files: [] });
  }

  write(_filePath: string, _content: string): Promise<import('deepagents').WriteResult> {
    return Promise.resolve({ error: UNKNOWN_ROUTE_ERROR });
  }

  edit(_filePath: string, _oldString: string, _newString: string, _replaceAll?: boolean): Promise<EditResult> {
    return Promise.resolve({ error: UNKNOWN_ROUTE_ERROR });
  }

  uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    return Promise.resolve(files.map(([path]) => ({ path, error: 'permission_denied' })));
  }

  downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    return Promise.resolve(paths.map((path) => ({ path, content: null, error: 'permission_denied' })));
  }
}
```

- [ ] **Step 3: Add a wrapper that hides `CompositeBackend.execute`**

Add this class below the read-only backend classes:

```ts
class RocNonExecutingCompositeBackend implements RocCompositeBackend {
  constructor(private readonly delegate: CompositeBackend) {}

  get routePrefixes(): string[] {
    return this.delegate.routePrefixes;
  }

  ls(path: string): Promise<LsResult> {
    return this.delegate.ls(path);
  }

  read(filePath: string, offset?: number, limit?: number): Promise<ReadResult> {
    return this.delegate.read(filePath, offset, limit);
  }

  readRaw(filePath: string): Promise<ReadRawResult> {
    return this.delegate.readRaw(filePath);
  }

  grep(pattern: string, path?: string, glob?: string | null): Promise<GrepResult> {
    return this.delegate.grep(pattern, path, glob);
  }

  glob(pattern: string, path?: string): Promise<GlobResult> {
    return this.delegate.glob(pattern, path);
  }

  write(filePath: string, content: string): Promise<import('deepagents').WriteResult> {
    return this.delegate.write(filePath, content);
  }

  edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean): Promise<EditResult> {
    return this.delegate.edit(filePath, oldString, newString, replaceAll);
  }

  uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    return this.delegate.uploadFiles(files);
  }

  downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    return this.delegate.downloadFiles(paths);
  }
}
```

- [ ] **Step 4: Export explicit permission rules**

Add this function near the route constants:

```ts
export function createRocFilesystemPermissions(): import('deepagents').FilesystemPermission[] {
  return [
    { operations: ['read'], paths: ['/workspace/**', '/memory/**', '/skills/**', '/agents/**'], mode: 'allow' },
    { operations: ['write'], paths: ['/workspace/**', '/memory/**'], mode: 'allow' },
    { operations: ['write'], paths: ['/skills/**', '/agents/**'], mode: 'deny' },
    { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' }
  ];
}
```

- [ ] **Step 5: Stop accepting shell execution in createBackend**

In `createRouteBackends`, remove `shellExecutionService` from the input type and replace:

```ts
const hostShellBackend = new RocHostShellBackend(input.shellExecutionService);
```

with:

```ts
const routeRejectingBackend = new RocRouteRejectingFilesystemBackend();
```

Replace:

```ts
const backend = new CompositeBackend(hostShellBackend, routes) as RocCompositeBackend;
```

with:

```ts
const routedBackend = new CompositeBackend(routeRejectingBackend, routes);
const backend = new RocNonExecutingCompositeBackend(routedBackend);
```

Remove `shellExecutionService` from the exported `createBackend` input type and call to `createRouteBackends`.

- [ ] **Step 6: Update runtime backend creation**

In `src/main/plugins/agent/deep-agent-executor.ts`, remove the `AgentExecuteAdapter` import and delete the `shellExecutionService` object inside `createRuntimeBackend`.

Replace the `createBackend` call argument:

```ts
shellExecutionService,
```

with nothing. The `createBackend` call should still pass workspace service, paths, security scan, capacity, consolidator service, active model handle, and selected skill IDs.

- [ ] **Step 7: Run backend tests**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/backend.test.ts
```

Expected: `PASS`.

- [ ] **Step 8: Commit backend split**

Run:

```powershell
git add src/main/services/deep-agent/backend.ts src/main/plugins/agent/deep-agent-executor.ts tests/main/services/deep-agent/backend.test.ts
git commit -m "fix: split deepagents file backend from shell execution"
```

---

### Task 3: Wire Permissions, Hide Built-In Execute, And Update Built-In Tool Registry

**Files:**
- Modify: `src/main/plugins/agent/deep-agent-executor.ts`
- Modify: `src/main/services/deep-agent/harness-profiles.ts`
- Modify: `src/main/services/deep-agent/types.ts`
- Modify: `tests/main/deep-agent-build-wiring.test.ts`
- Modify: `tests/main/deep-agent-tool-retry.test.ts`
- Modify: `tests/main/services/forge-guardrails/integration/full-stack.test.ts`

- [ ] **Step 1: Wire filesystem permissions in executor**

In `src/main/plugins/agent/deep-agent-executor.ts`, change the backend import:

```ts
import { createBackend, createRocFilesystemPermissions } from '../../services/deep-agent/backend';
```

Replace the `buildDeepAgent` input:

```ts
filesystemPermissions: undefined,
```

with:

```ts
filesystemPermissions: createRocFilesystemPermissions(),
```

- [ ] **Step 2: Hide built-in execute in Roc harness profile**

In `src/main/services/deep-agent/harness-profiles.ts`, replace:

```ts
const profile = createHarnessProfile({ excludedMiddleware: ['SummarizationMiddleware'] });
```

with:

```ts
const profile = createHarnessProfile({
  excludedMiddleware: ['SummarizationMiddleware'],
  excludedTools: ['execute']
});
```

- [ ] **Step 3: Remove execute from DeepAgents built-in rescue candidates**

In `src/main/services/deep-agent/types.ts`, remove the final `'execute'` entry from `DEEP_AGENT_BUILT_IN_TOOLS`.

The array should end with:

```ts
  'edit_file',
  'glob',
  'grep'
] as const;
```

- [ ] **Step 4: Update build wiring tests to pass permissions explicitly**

In `tests/main/deep-agent-build-wiring.test.ts`, replace `filesystemPermissions: undefined` in each test input with:

```ts
filesystemPermissions: [
  { operations: ['read'], paths: ['/workspace/**'], mode: 'allow' },
  { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' }
],
```

After `buildDeepAgent(input);`, add this assertion to the first test:

```ts
expect(vi.mocked(createDeepAgent).mock.calls[0]?.[0]).toMatchObject({
  permissions: [
    { operations: ['read'], paths: ['/workspace/**'], mode: 'allow' },
    { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' }
  ]
});
```

- [ ] **Step 5: Update existing tests that build DeepAgent with undefined permissions**

In these files, replace `filesystemPermissions: undefined` test fixtures with `filesystemPermissions: []` unless the test is specifically checking Roc production wiring:

- `tests/main/deep-agent-tool-retry.test.ts`
- `tests/main/services/forge-guardrails/integration/full-stack.test.ts`

Use this exact fixture value:

```ts
filesystemPermissions: [],
```

- [ ] **Step 6: Run wiring tests**

Run:

```powershell
pnpm test -- tests/main/deep-agent-build-wiring.test.ts tests/main/deep-agent-tool-retry.test.ts tests/main/services/forge-guardrails/integration/full-stack.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts
```

Expected: `PASS`.

- [ ] **Step 7: Commit permission and harness changes**

Run:

```powershell
git add src/main/plugins/agent/deep-agent-executor.ts src/main/services/deep-agent/harness-profiles.ts src/main/services/deep-agent/types.ts tests/main/deep-agent-build-wiring.test.ts tests/main/deep-agent-tool-retry.test.ts tests/main/services/forge-guardrails/integration/full-stack.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts
git commit -m "fix: constrain deepagents filesystem permissions"
```

---

### Task 4: Add Hard File-Tool Path Policy Middleware

**Files:**
- Create: `src/main/services/deep-agent/filesystem-path-policy.ts`
- Create: `tests/main/services/deep-agent/filesystem-path-policy.test.ts`
- Modify: `src/main/services/deep-agent/agent-builder.ts`

- [ ] **Step 1: Write file path policy tests**

Create `tests/main/services/deep-agent/filesystem-path-policy.test.ts`:

```ts
import { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import { createRocFilesystemPathPolicyMiddleware, validateRocFileToolPath } from '../../../../src/main/services/deep-agent/filesystem-path-policy';

describe('validateRocFileToolPath', () => {
  it.each([
    '/workspace/create_docx.py',
    '/memory/global/MEMORY.md',
    '/skills/python/SKILL.md',
    '/agents/AGENTS.md'
  ])('accepts Roc route path %s', (path) => {
    expect(validateRocFileToolPath(path)).toEqual({ ok: true });
  });

  it.each([
    ['/home/user/workarea/create_docx.py', 'Roc 文件工具只允许访问 /workspace/、/skills/、/agents/、/memory/ 路径。'],
    ['/tmp/create_docx.py', 'Roc 文件工具只允许访问 /workspace/、/skills/、/agents/、/memory/ 路径。'],
    ['F:\\Code\\Roc\\create_docx.py', 'Roc 文件工具使用虚拟路径；请改用 /workspace/...。'],
    ['\\\\server\\share\\file.txt', 'Roc 文件工具使用虚拟路径；请改用 /workspace/...。'],
    ['relative/file.txt', 'Roc 文件工具只允许访问 /workspace/、/skills/、/agents/、/memory/ 路径。'],
    ['/workspace/../secret.txt', 'Roc 文件工具路径不能包含 .. 路径段。']
  ])('rejects invalid path %s', (path, error) => {
    expect(validateRocFileToolPath(path)).toEqual({ ok: false, error });
  });
});

describe('createRocFilesystemPathPolicyMiddleware', () => {
  it('returns an error ToolMessage before invalid write_file reaches the handler', async () => {
    const middleware = createRocFilesystemPathPolicyMiddleware();
    const handler = vi.fn(async () => new ToolMessage({
      tool_call_id: 'call-1',
      name: 'write_file',
      content: 'handler reached'
    }));

    const result = await middleware.wrapToolCall!(
      {
        toolCall: {
          id: 'call-1',
          name: 'write_file',
          args: { file_path: '/home/user/workarea/create_docx.py', content: 'print(1)' }
        }
      } as never,
      handler
    );

    expect(handler).not.toHaveBeenCalled();
    expect(ToolMessage.isInstance(result)).toBe(true);
    expect((result as ToolMessage).status).toBe('error');
    expect((result as ToolMessage).content).toContain('/workspace/');
  });

  it('allows valid file-tool paths to reach the handler', async () => {
    const middleware = createRocFilesystemPathPolicyMiddleware();
    const handler = vi.fn(async () => new ToolMessage({
      tool_call_id: 'call-2',
      name: 'write_file',
      content: 'ok'
    }));

    const result = await middleware.wrapToolCall!(
      {
        toolCall: {
          id: 'call-2',
          name: 'write_file',
          args: { file_path: '/workspace/create_docx.py', content: 'print(1)' }
        }
      } as never,
      handler
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect((result as ToolMessage).content).toBe('ok');
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/filesystem-path-policy.test.ts
```

Expected: fail because `filesystem-path-policy.ts` does not exist.

- [ ] **Step 3: Implement path policy middleware**

Create `src/main/services/deep-agent/filesystem-path-policy.ts`:

```ts
import { ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';

const FILE_PATH_TOOL_ARGS: Record<string, readonly string[]> = {
  ls: ['path'],
  read_file: ['file_path'],
  write_file: ['file_path'],
  edit_file: ['file_path'],
  glob: ['path'],
  grep: ['path']
};

const ALLOWED_ROUTES = ['/workspace/', '/memory/', '/skills/', '/agents/'] as const;
const ROUTE_ERROR = 'Roc 文件工具只允许访问 /workspace/、/skills/、/agents/、/memory/ 路径。';
const WINDOWS_PATH_ERROR = 'Roc 文件工具使用虚拟路径；请改用 /workspace/...。';
const TRAVERSAL_ERROR = 'Roc 文件工具路径不能包含 .. 路径段。';

export type RocFileToolPathValidation = { ok: true } | { ok: false; error: string };

export function validateRocFileToolPath(path: string): RocFileToolPathValidation {
  if (isWindowsAbsolutePath(path)) {
    return { ok: false, error: WINDOWS_PATH_ERROR };
  }
  if (!path.startsWith('/')) {
    return { ok: false, error: ROUTE_ERROR };
  }
  if (path.split('/').includes('..')) {
    return { ok: false, error: TRAVERSAL_ERROR };
  }
  if (!ALLOWED_ROUTES.some((route) => path.startsWith(route))) {
    return { ok: false, error: ROUTE_ERROR };
  }
  return { ok: true };
}

export function createRocFilesystemPathPolicyMiddleware() {
  return createMiddleware({
    name: 'RocFilesystemPathPolicyMiddleware',
    wrapToolCall: async (request, handler) => {
      const argNames = FILE_PATH_TOOL_ARGS[request.toolCall.name];
      if (argNames === undefined) {
        return handler(request);
      }

      const args = request.toolCall.args;
      if (!isRecord(args)) {
        return handler(request);
      }

      for (const argName of argNames) {
        const value = args[argName];
        if (value === undefined || value === null) {
          continue;
        }
        if (typeof value !== 'string') {
          return createErrorMessage(request.toolCall.id, request.toolCall.name, ROUTE_ERROR);
        }
        const validation = validateRocFileToolPath(value);
        if (!validation.ok) {
          return createErrorMessage(request.toolCall.id, request.toolCall.name, validation.error);
        }
      }

      return handler(request);
    }
  });
}

function createErrorMessage(toolCallId: string | undefined, toolName: string, content: string): ToolMessage {
  return new ToolMessage({
    tool_call_id: toolCallId ?? `roc_path_policy_${toolName}`,
    name: toolName,
    content,
    status: 'error'
  });
}

function isWindowsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
```

- [ ] **Step 4: Add middleware to agent-builder before filesystem error normalization**

In `src/main/services/deep-agent/agent-builder.ts`, add:

```ts
import { createRocFilesystemPathPolicyMiddleware } from './filesystem-path-policy';
```

In the `guardrails` array, insert the path policy before `createFilesystemToolErrorMiddleware()`:

```ts
    createToolProtocolMiddleware(),
    createErrorBudgetMiddleware(),
    createForgeIterationTrackingMiddleware(),
    createRocFilesystemPathPolicyMiddleware(),
    createFilesystemToolErrorMiddleware(),
```

- [ ] **Step 5: Run path policy and build wiring tests**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/filesystem-path-policy.test.ts tests/main/deep-agent-build-wiring.test.ts
```

Expected: `PASS`.

- [ ] **Step 6: Commit path policy**

Run:

```powershell
git add src/main/services/deep-agent/filesystem-path-policy.ts src/main/services/deep-agent/agent-builder.ts tests/main/services/deep-agent/filesystem-path-policy.test.ts
git commit -m "fix: reject invalid deepagents file paths before backend dispatch"
```

---

### Task 5: Add Roc-Owned Windows Command Tool

**Files:**
- Create: `src/main/services/deep-agent/command-tool.ts`
- Create: `tests/main/services/deep-agent/command-tool.test.ts`
- Modify: `src/main/plugins/agent/deep-agent-executor.ts`
- Modify: `tests/main/plugins/agent/deep-agent-executor.test.ts`

- [ ] **Step 1: Write command tool tests**

Create `tests/main/services/deep-agent/command-tool.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createRocWindowsCommandTool } from '../../../../src/main/services/deep-agent/command-tool';

describe('createRocWindowsCommandTool', () => {
  it('runs valid commands through the Roc shell adapter', async () => {
    const executeAgentCommand = vi.fn(async () => ({
      command: 'python .\\create_docx.py',
      cwd: 'F:\\Code\\Roc',
      exitCode: 0,
      output: 'ok',
      truncated: false,
      usedRtk: false
    }));
    const tool = createRocWindowsCommandTool({ executeAgentCommand });

    await expect(tool.invoke({ command: 'python .\\create_docx.py' })).resolves.toContain('"exitCode": 0');
    expect(executeAgentCommand).toHaveBeenCalledWith({ command: 'python .\\create_docx.py', cwd: undefined });
  });

  it('rejects DeepAgents virtual workspace paths before shell execution', async () => {
    const executeAgentCommand = vi.fn();
    const tool = createRocWindowsCommandTool({ executeAgentCommand });

    await expect(tool.invoke({ command: 'python /workspace/create_docx.py' })).rejects.toThrow(
      '/workspace/ 是 DeepAgents 文件工具路由，不是 Windows shell 路径。'
    );
    expect(executeAgentCommand).not.toHaveBeenCalled();
  });

  it('rejects Linux local paths before shell execution', async () => {
    const executeAgentCommand = vi.fn();
    const tool = createRocWindowsCommandTool({ executeAgentCommand });

    await expect(tool.invoke({ command: 'python /home/user/workarea/create_docx.py' })).rejects.toThrow(
      'Roc 在 Windows 本地执行命令；请使用当前工作区 cwd 下的相对路径或 Windows 路径。'
    );
    expect(executeAgentCommand).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run command tool test to verify it fails**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/command-tool.test.ts
```

Expected: fail because `command-tool.ts` does not exist.

- [ ] **Step 3: Implement the command tool**

Create `src/main/services/deep-agent/command-tool.ts`:

```ts
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { AgentExecuteAdapter } from './types';

const schema = z.object({
  command: z.string().trim().min(1),
  cwd: z.string().trim().min(1).optional()
});

const VIRTUAL_WORKSPACE_ERROR = '/workspace/ 是 DeepAgents 文件工具路由，不是 Windows shell 路径。';
const LINUX_PATH_ERROR = 'Roc 在 Windows 本地执行命令；请使用当前工作区 cwd 下的相对路径或 Windows 路径。';

export function createRocWindowsCommandTool(
  adapter: AgentExecuteAdapter
): DynamicStructuredTool<typeof schema, z.infer<typeof schema>, z.infer<typeof schema>, string> {
  return new DynamicStructuredTool<typeof schema, z.infer<typeof schema>, z.infer<typeof schema>, string>({
    name: 'run_shell_command',
    description: [
      '在当前 Roc Windows 工作区执行 PowerShell 命令。',
      '默认 cwd 是用户选择的真实 Windows 工作区。',
      '不要把 /workspace/... 传给此工具；/workspace/... 只属于 DeepAgents 文件工具。',
      '适合运行测试、构建、脚本和本地命令。'
    ].join('\n'),
    schema,
    func: async (request) => {
      validateRocWindowsCommand(request.command);
      const result = await adapter.executeAgentCommand({ command: request.command, cwd: request.cwd });
      return JSON.stringify(result, null, 2);
    }
  });
}

export function validateRocWindowsCommand(command: string): void {
  if (containsVirtualWorkspacePath(command)) {
    throw new Error(VIRTUAL_WORKSPACE_ERROR);
  }
  if (containsLinuxLocalPath(command)) {
    throw new Error(LINUX_PATH_ERROR);
  }
}

function containsVirtualWorkspacePath(command: string): boolean {
  return /(?:"\/workspace(?:\/|$)[^"]*"|'\/workspace(?:\/|$)[^']*'|(?:^|[\s;&|])\/workspace(?:\/|$)\S*)/i.test(command);
}

function containsLinuxLocalPath(command: string): boolean {
  return /(?:"\/(?:home\/user|tmp)(?:\/|$)[^"]*"|'\/(?:home\/user|tmp)(?:\/|$)[^']*'|(?:^|[\s;&|])\/(?:home\/user|tmp)(?:\/|$)\S*)/i.test(command);
}
```

- [ ] **Step 4: Wire the command tool into executor run tools**

In `src/main/plugins/agent/deep-agent-executor.ts`, add:

```ts
import { createRocWindowsCommandTool } from '../../services/deep-agent/command-tool';
```

Change `createExecutorTools` input type to include:

```ts
  shellExecutionService: AgentExecuteAdapter;
```

Add the command tool to `runTools` after `delete_file`:

```ts
  const runTools: ClientTool[] = [
    webReadTool,
    createDeleteFileTool(input.capabilities),
    createRocWindowsCommandTool(input.shellExecutionService),
    ...mcpTools
  ];
```

Move the existing shell adapter creation out of `createRuntimeBackend` into the main `execute` flow before `createExecutorTools`, using the same implementation currently used inside `createRuntimeBackend`:

```ts
      const shellExecutionService = createShellExecutionAdapter(options.capabilities);
      const tools = await createExecutorTools({
        capabilities: options.capabilities,
        enabledCapabilities: input.request.enabledCapabilities,
        backgroundTaskToolMode: readBackgroundTaskToolMode(input.request),
        runtimeWorkspacePath: workspace === null ? null : workspace.path,
        shellExecutionService
      });
```

Add this helper near `createRuntimeBackend`:

```ts
function createShellExecutionAdapter(capabilities: RocCapabilityRegistry): AgentExecuteAdapter {
  return {
    executeAgentCommand: async ({ command, cwd }) => {
      const result = await capabilities.invoke<
        { command: string; cwd?: string; source: 'agent' },
        ShellExecutionResult
      >('shell.execute', {
        command,
        cwd,
        source: 'agent'
      });
      return {
        command: result.command,
        cwd: result.cwd,
        exitCode: result.exitCode,
        output: formatShellOutput(result),
        truncated: false,
        usedRtk: result.usedRtk,
        bypassReason: result.bypassReason
      };
    }
  };
}
```

- [ ] **Step 5: Add executor wiring tests for the new tool**

In `tests/main/plugins/agent/deep-agent-executor.test.ts`, add:

```ts
  it('exposes Roc Windows command tool instead of DeepAgents built-in execute', async () => {
    await buildExecutorOnce(createCapabilities([]), {
      mode: 'chat',
      workflowHint: null,
      taskSource: null
    });

    const toolNames = readBuiltTools().map((tool) => tool.name);

    expect(toolNames).toContain('run_shell_command');
    expect(toolNames).not.toContain('execute');
  });

  it('runs Roc Windows command tool through shell.execute capability', async () => {
    const capabilityCalls: Array<{ name: string; input: unknown }> = [];
    await buildExecutorOnce(createCapabilities(capabilityCalls), {
      mode: 'chat',
      workflowHint: null,
      taskSource: null
    });

    const output = await invokeTool(findTool(readBuiltTools(), 'run_shell_command'), {
      command: 'python .\\create_docx.py'
    });

    expect(output).toContain('"exitCode": 0');
    expect(capabilityCalls).toContainEqual({
      name: 'shell.execute',
      input: {
        command: 'python .\\create_docx.py',
        cwd: undefined,
        source: 'agent'
      }
    });
  });
```

If the local `createCapabilities` helper currently returns a shell result only through backend calls, update it to return this result for `shell.execute`:

```ts
if (name === 'shell.execute') {
  return {
    command: (input as { command: string }).command,
    cwd: 'F:\\Code\\Roc',
    exitCode: 0,
    stdout: 'ok',
    stderr: '',
    usedRtk: false
  } satisfies ShellExecutionResult;
}
```

- [ ] **Step 6: Run command tool and executor tests**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/command-tool.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts
```

Expected: `PASS`.

- [ ] **Step 7: Commit command tool**

Run:

```powershell
git add src/main/services/deep-agent/command-tool.ts src/main/plugins/agent/deep-agent-executor.ts tests/main/services/deep-agent/command-tool.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts
git commit -m "feat: add roc windows command tool for deep agent runs"
```

---

### Task 6: Clean Prompt And Capability Preview Legacy Execute References

**Files:**
- Modify: `src/main/services/deep-agent/prompt.ts`
- Modify: `src/main/services/deep-agent/prompt-builder.ts`
- Modify: `src/main/plugins/agent/capability-preview.ts`
- Modify: `tests/main/deep-agent-prompt.test.ts`
- Modify: `tests/main/services/deep-agent/prompt-builder.test.ts`
- Modify: `tests/main/plugins/agent/capability-preview.test.ts`

- [ ] **Step 1: Update workspace boundary prompt text**

In both `src/main/services/deep-agent/prompt.ts` and `src/main/services/deep-agent/prompt-builder.ts`, replace the workspace block lines:

```ts
    'Default cwd for shell commands: selected Roc workspace root.',
    'Use /workspace/ only for Deep Agents file tools.',
    'Use the Windows workspace root for shell paths; never run rtk ls /workspace.',
    'For directory listings on native Windows, prefer the file ls tool or PowerShell Get-ChildItem.',
    'Do not pass Windows absolute paths like C:\\\\path\\\\file.txt or G:\\\\path\\\\file.txt to read_file, write_file, or edit_file.',
    'After write_file or edit_file, verify the target via read_file or ls before saying the file was created or changed.',
    'Run file and shell ops inside workspace unless user explicitly names another allowed path.'
```

with:

```ts
    'DeepAgents file tools accept only Roc virtual routes: /workspace/, /memory/, /skills/, and /agents/.',
    'Use run_shell_command for local Windows commands; its default cwd is the selected Roc workspace root.',
    'Do not pass Windows absolute paths or Linux paths to read_file, write_file, edit_file, ls, glob, or grep.',
    'After write_file or edit_file, verify the target via read_file or ls before saying the file was created or changed.'
```

For the no-workspace branch, replace:

```ts
'Default cwd: unavailable; ask user to select workspace before file or shell ops.'
```

with:

```ts
'Default command cwd: unavailable; ask user to select workspace before local command operations.'
```

- [ ] **Step 2: Replace capability preview card**

In `src/main/plugins/agent/capability-preview.ts`, rename `createExecuteCard` to `createRunShellCommandCard` and change the returned card to:

```ts
function createRunShellCommandCard(): AgentCapabilityCard {
  return {
    id: 'builtin:run_shell_command',
    name: 'run_shell_command',
    capabilityType: 'terminal_tool',
    description: '通过 Roc Windows 命令工具在当前工作区执行 PowerShell 命令，由 Roc 的 RTK 与审计层统一包裹。',
    requiredInput: 'PowerShell command',
    scope: 'workspace',
    dependencies: ['ShellExecutionService', 'RtkService'],
    sideEffects: ['workspace_command_execution', 'task_trace_audit'],
    requiresApproval: false,
    supportsLongTermGrant: false,
    revokeGrantHint: 'run_shell_command 由 Roc 内置工具提供，不创建长期授权。',
    riskLevel: 'medium',
    auditCategory: 'agent_execute',
    untrustedContext: false
  };
}
```

Update the caller that previously used `createExecuteCard()` to use `createRunShellCommandCard()`.

- [ ] **Step 3: Update prompt tests**

In `tests/main/deep-agent-prompt.test.ts` and `tests/main/services/deep-agent/prompt-builder.test.ts`, replace assertions for:

- `Default cwd for shell commands: selected Roc workspace root.`
- `Use /workspace/ only for Deep Agents file tools.`
- `Use the Windows workspace root for shell paths; never run rtk ls /workspace.`
- `For directory listings on native Windows, prefer the file ls tool or PowerShell Get-ChildItem.`
- `Run file and shell ops inside workspace unless user explicitly names another allowed path.`

with assertions for:

```ts
expect(prompt).toContain('DeepAgents file tools accept only Roc virtual routes: /workspace/, /memory/, /skills/, and /agents/.');
expect(prompt).toContain('Use run_shell_command for local Windows commands; its default cwd is the selected Roc workspace root.');
expect(prompt).toContain('Do not pass Windows absolute paths or Linux paths to read_file, write_file, edit_file, ls, glob, or grep.');
```

Keep the existing verification assertion:

```ts
expect(prompt).toContain('After write_file or edit_file, verify the target via read_file or ls before saying the file was created or changed.');
```

- [ ] **Step 4: Update capability preview tests**

In `tests/main/plugins/agent/capability-preview.test.ts`, replace expectations for `execute` with `run_shell_command`.

Use:

```ts
expect(card).toMatchObject({
  id: 'builtin:run_shell_command',
  name: 'run_shell_command',
  capabilityType: 'terminal_tool',
  requiredInput: 'PowerShell command',
  dependencies: ['ShellExecutionService', 'RtkService'],
  auditCategory: 'agent_execute'
});
```

- [ ] **Step 5: Run prompt and capability tests**

Run:

```powershell
pnpm test -- tests/main/deep-agent-prompt.test.ts tests/main/services/deep-agent/prompt-builder.test.ts tests/main/plugins/agent/capability-preview.test.ts
```

Expected: `PASS`.

- [ ] **Step 6: Commit prompt and preview cleanup**

Run:

```powershell
git add src/main/services/deep-agent/prompt.ts src/main/services/deep-agent/prompt-builder.ts src/main/plugins/agent/capability-preview.ts tests/main/deep-agent-prompt.test.ts tests/main/services/deep-agent/prompt-builder.test.ts tests/main/plugins/agent/capability-preview.test.ts
git commit -m "fix: remove legacy deepagents execute guidance"
```

---

### Task 7: Clean RTK Documentation And Regression References

**Files:**
- Modify: `docs/rtk-integration.md`
- Modify: `tests/main/plugins/agent/runtime.test.ts`
- Modify: `tests/main/plugins/task/plugin.test.ts`

- [ ] **Step 1: Update RTK documentation wording**

In `docs/rtk-integration.md`, replace references to:

```md
Deep Agents `execute`
agent `execute`
```

with:

```md
Roc `run_shell_command`
Roc command tool
```

The first paragraph should read:

```md
Roc 集成 RTK v0.42.0，用于压缩 Roc `run_shell_command` 工具的 shell 输出。集成路径是：
```

- [ ] **Step 2: Update UI/runtime tests that model old execute tool events**

Search:

```powershell
rg -n "name: 'execute'|actionName: 'execute'|builtin:execute|Deep Agents 内建 execute|agent `execute`" tests/main/plugins src/main docs
```

For tests that simulate arbitrary tool streaming and do not specifically require the old tool name, replace:

```ts
name: 'execute'
actionName: 'execute'
```

with:

```ts
name: 'run_shell_command'
actionName: 'run_shell_command'
```

Apply this in:

- `tests/main/plugins/agent/runtime.test.ts`
- `tests/main/plugins/task/plugin.test.ts`

Do not rename the plugin runtime capability `shell.execute`; that is Roc's internal capability and remains in scope.

- [ ] **Step 3: Run affected runtime tests**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/runtime.test.ts tests/main/plugins/task/plugin.test.ts
```

Expected: `PASS`.

- [ ] **Step 4: Run regression search**

Run:

```powershell
rg -n "Deep Agents `execute`|agent `execute`|builtin:execute|Deep Agents 内建 execute|filesystemPermissions\\)\\.toBeUndefined|/home/user/workarea" src tests docs
```

Expected:

- No matches outside the design spec and plan docs.
- If matches remain in source or tests, update them in this task before committing.

- [ ] **Step 5: Commit docs and regression cleanup**

Run:

```powershell
git add docs/rtk-integration.md tests/main/plugins/agent/runtime.test.ts tests/main/plugins/task/plugin.test.ts
git commit -m "docs: update command execution references"
```

---

### Task 8: Full Verification And Review Pass

**Files:**
- Verify only unless a previous task left a failing assertion.

- [ ] **Step 1: Run targeted Deep Agent and shell suites**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/backend.test.ts tests/main/services/deep-agent/filesystem-path-policy.test.ts tests/main/services/deep-agent/command-tool.test.ts tests/main/deep-agent-build-wiring.test.ts tests/main/deep-agent-tool-retry.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts tests/main/deep-agent-prompt.test.ts tests/main/services/deep-agent/prompt-builder.test.ts tests/main/plugins/agent/capability-preview.test.ts tests/main/plugins/runtime-tools/shell-adapter.test.ts tests/main/services/forge-guardrails/integration/full-stack.test.ts
```

Expected: `PASS`.

- [ ] **Step 2: Run typecheck**

Run:

```powershell
pnpm typecheck
```

Expected: exits with code `0`.

- [ ] **Step 3: Run full test suite if targeted tests and typecheck pass**

Run:

```powershell
pnpm test
```

Expected: exits with code `0`.

Note: If `node-pty` reports `Error: AttachConsole failed` during teardown but Vitest exits `0`, treat that as known Roc teardown noise and record it in the final evidence.

- [ ] **Step 4: Run final regression searches**

Run:

```powershell
rg -n "Deep Agents `execute`|agent `execute`|builtin:execute|Deep Agents 内建 execute|filesystemPermissions\\)\\.toBeUndefined|/home/user/workarea" src tests docs
rg -n "name: 'execute'|actionName: 'execute'" src tests docs
```

Expected:

- First command has no matches outside `docs/superpowers/specs/` and `docs/superpowers/plans/`.
- Second command has no matches for agent-visible tool usage. Internal `shell.execute` capability references are allowed and must remain.

- [ ] **Step 5: Commit verification-only fixes if any were required**

If Step 1, 2, 3, or 4 required code/test/doc fixes, list the changed files first:

```powershell
git status --short
```

Then stage only those verification-fix files. For example, if the output shows `M  tests/main/plugins/agent/runtime.test.ts`, run:

```powershell
git add -- tests/main/plugins/agent/runtime.test.ts
git commit -m "test: verify deepagents windows path architecture"
```

If no files changed, do not create an empty commit.

- [ ] **Step 6: Prepare completion summary**

Final implementation summary must include:

- Commit list from this plan.
- Exact verification commands and outcomes.
- Whether `pnpm test` had known `AttachConsole failed` teardown noise.
- Confirmation that DeepAgents built-in `execute` is no longer agent-visible.
- Confirmation that `shell.execute` internal capability remains intact.
