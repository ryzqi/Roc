# Roc DeepAgents File Tool Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Roc DeepAgents file tools fail closed so agent-visible file access is limited to `/workspace/`, `/skills/`, and `/memory/`, with shell access remaining on real Windows paths through Roc's `run_shell_command`.

**Architecture:** Put the Roc file-tool route contract in one TypeScript module, then enforce it in two runtime layers: LangChain tool-call middleware and the DeepAgents backend wrapper. Keep prompts aligned with the same contract, but treat prompts as guidance only; all safety-critical behavior lives in schemas, middleware, backend methods, and tests.

**Tech Stack:** TypeScript ESM, Electron main process, DeepAgents JS `1.10.5`, LangChain middleware, Vitest, PowerShell.

## Global Constraints

- User-facing file tools may access only Roc virtual routes: `/workspace/`, `/skills/`, `/memory/`.
- `run_shell_command` and `shell.execute` use real Windows cwd/path semantics and must continue rejecting `/workspace/...` shell paths.
- DeepAgents native `execute` must remain unavailable from Roc's DeepAgents backend; shell execution stays in Roc-owned `run_shell_command`.
- Do not rely on prompt wording for enforcement. Runtime tool, middleware, backend, and tests own the boundary.
- Do not add compatibility aliases such as `/agents/`, POSIX home paths, or automatic Windows-path-to-`/workspace/` rewrites.
- Keep changes surgical and inside existing main-process DeepAgents/forge-guardrails/plugin-agent boundaries.
- Use PowerShell commands for verification.

---

## Research Evidence

Official and installed-package sources checked before writing this plan:

- DeepAgents JS official docs via Context7 `/langchain-ai/deepagentsjs`: DeepAgents follows a "trust the LLM" model; the agent can do anything its tools allow, so boundaries must be enforced at tool/sandbox/backend level.
- `node_modules/deepagents/README.md`: DeepAgents is a batteries-included agent harness with filesystem tools `read_file`, `write_file`, `edit_file`, `ls`, `glob`, `grep`; security boundaries belong in tools/sandboxes, not model self-policing.
- `node_modules/deepagents/dist/agent-DURA4_mf.d.ts:685-688`: `FilesystemPermission` rules are first-match-wins, and if no rule matches, access is allowed.
- `node_modules/deepagents/dist/agent-DURA4_mf.d.ts:764-778`: permissions apply to `ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`; `execute` is not governed by path permissions.
- `node_modules/deepagents/dist/agent-DURA4_mf.d.ts:740`: DeepAgents filesystem middleware tool names include `execute`.
- `node_modules/deepagents/dist/agent-DURA4_mf.d.ts:3138-3145`: `FilesystemBackend({ virtualMode: true })` treats incoming paths as virtual absolute paths under its root and blocks traversal/outside-root access.
- `node_modules/deepagents/dist/agent-DURA4_mf.d.ts:3236-3248`: `CompositeBackend` routes by path prefix and strips/re-adds route prefixes around delegated calls.
- `node_modules/deepagents/dist/langsmith-wdF8zG42.js:1460-1489`: official permission enforcement is permissive when rules are empty and `filterByPermissions` keeps entries with unparsable paths.

Current Roc evidence:

- `src/main/services/deep-agent/filesystem-path-policy.ts` currently rewrites Windows absolute paths inside the selected workspace to `/workspace/...`, and missing/non-string path args pass through.
- `src/main/services/deep-agent/backend.ts` currently denies unknown routes for `read`, `write`, and `edit`, but `ls`, `glob`, and `grep` on unknown routes return empty results.
- `src/main/services/deep-agent/backend.ts` wraps `CompositeBackend` in `RocNonExecutingCompositeBackend`, which removes `execute` but does not validate every incoming backend path before delegation.
- `src/main/plugins/agent/deep-agent-executor.ts` exposes Roc `delete_file` as `{ relativePath }`, outside the `/workspace/...` file-tool contract visible to the agent.
- `src/main/services/forge-guardrails/middleware/filesystem-tool-errors.ts`, `src/main/services/deep-agent/prompt.ts`, and `src/main/services/deep-agent/prompt-builder.ts` duplicate route/error text.

Root cause:

The current implementation communicates the desired contract in prompts and permissions, but the runtime boundary is split and partially permissive. DeepAgents permissions are not a full sandbox because their default is allow, `execute` is not path-permission-bound, and Roc still has soft paths where invalid routes become empty `ls/glob/grep` results or where Windows paths get converted instead of rejected.

## File Structure

- Create `src/main/services/deep-agent/filesystem-tool-contract.ts`
  - Single source of truth for allowed route prefixes, file-tool names, path argument fields, error messages, prompt lines, permission rules, and `/workspace/...` to `relativePath` conversion for `delete_file`.
- Modify `src/main/services/deep-agent/filesystem-path-policy.ts`
  - Import the contract module.
  - Reject Windows absolute paths and UNC paths without rewrite.
  - Reject missing/non-string file-tool path fields.
  - Apply the same path policy to Roc `delete_file`.
- Modify `src/main/services/deep-agent/backend.ts`
  - Import contract constants/helpers.
  - Remove local route error/permission definitions.
  - Make `RocRouteRejectingFilesystemBackend.ls`, `grep`, and `glob` hard errors.
  - Add backend-wrapper path validation before every routed file operation.
- Modify `src/main/services/forge-guardrails/middleware/filesystem-tool-errors.ts`
  - Use contract constants for file-tool names and hard route/permission messages.
- Modify `src/main/services/deep-agent/prompt.ts`
  - Use shared prompt lines for Roc file-tool and shell-path semantics.
- Modify `src/main/services/deep-agent/prompt-builder.ts`
  - Use shared prompt lines for the same semantics as `prompt.ts`.
- Modify `src/main/plugins/agent/deep-agent-executor.ts`
  - Change `delete_file` schema from `{ relativePath }` to `{ file_path }`.
  - Reject non-`/workspace/...` delete paths and call existing `files.delete` with an internal `relativePath`.
- Modify tests:
  - `tests/main/services/deep-agent/filesystem-tool-contract.test.ts`
  - `tests/main/services/deep-agent/deep-agent-official-contracts.test.ts`
  - `tests/main/services/deep-agent/filesystem-path-policy.test.ts`
  - `tests/main/services/deep-agent/backend.test.ts`
  - `tests/main/services/forge-guardrails/middleware/filesystem-tool-errors.test.ts`
  - `tests/main/deep-agent-prompt.test.ts`
  - `tests/main/services/deep-agent/prompt-builder.test.ts`
  - `tests/main/plugins/agent/deep-agent-executor-tools.test.ts`
  - `tests/main/plugins/agent/deep-agent-executor-test-helpers.ts`

---

### Task 1: Lock The Shared File-Tool Contract

**Files:**
- Create: `src/main/services/deep-agent/filesystem-tool-contract.ts`
- Create: `tests/main/services/deep-agent/filesystem-tool-contract.test.ts`
- Modify: `tests/main/services/deep-agent/deep-agent-official-contracts.test.ts`

**Interfaces:**
- Produces: `ROC_FILE_TOOL_ROUTE_ERROR: string`
- Produces: `ROC_FILE_TOOL_WINDOWS_PATH_ERROR: string`
- Produces: `ROC_FILE_TOOL_TRAVERSAL_ERROR: string`
- Produces: `ROC_FILE_TOOL_MISSING_PATH_ERROR: string`
- Produces: `ROC_DELETE_FILE_WORKSPACE_ERROR: string`
- Produces: `ROC_FILE_TOOL_ALLOWED_ROUTE_PREFIXES: readonly ['/workspace', '/skills', '/memory']`
- Produces: `ROC_FILE_TOOL_PATH_FIELDS: Record<RocFileToolName, 'path' | 'file_path'>`
- Produces: `ROC_FILE_TOOL_PROMPT_LINES: readonly string[]`
- Produces: `createRocFilesystemPermissions(): FilesystemPermission[]`
- Produces: `isRocFileToolName(name: string): name is RocFileToolName`
- Produces: `getRocFileToolPathField(name: string): 'path' | 'file_path' | null`
- Produces: `validateRocFileToolPath(path: string): PathValidationResult`
- Produces: `normalizeRocFileToolPath(path: string): PathNormalizationResult`
- Produces: `toWorkspaceRelativePath(filePath: string): WorkspaceRelativePathResult`
- Consumes: DeepAgents exported `FilesystemPermission` type.

- [ ] **Step 1: Write contract tests**

Create `tests/main/services/deep-agent/filesystem-tool-contract.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  ROC_DELETE_FILE_WORKSPACE_ERROR,
  ROC_FILE_TOOL_ALLOWED_ROUTE_PREFIXES,
  ROC_FILE_TOOL_MISSING_PATH_ERROR,
  ROC_FILE_TOOL_PATH_FIELDS,
  ROC_FILE_TOOL_PROMPT_LINES,
  ROC_FILE_TOOL_ROUTE_ERROR,
  ROC_FILE_TOOL_TRAVERSAL_ERROR,
  ROC_FILE_TOOL_WINDOWS_PATH_ERROR,
  createRocFilesystemPermissions,
  getRocFileToolPathField,
  isRocFileToolName,
  normalizeRocFileToolPath,
  toWorkspaceRelativePath,
  validateRocFileToolPath
} from '../../../../src/main/services/deep-agent/filesystem-tool-contract';

describe('Roc DeepAgents file-tool contract', () => {
  it('defines the only agent-visible file routes', () => {
    expect(ROC_FILE_TOOL_ALLOWED_ROUTE_PREFIXES).toEqual(['/workspace', '/skills', '/memory']);
    expect(ROC_FILE_TOOL_ROUTE_ERROR).toBe('Roc 文件工具只允许访问 /workspace/、/skills/、/memory/ 路径。');
    expect(ROC_FILE_TOOL_WINDOWS_PATH_ERROR).toBe('Roc 文件工具使用虚拟路径；请改用 /workspace/...。');
    expect(ROC_FILE_TOOL_TRAVERSAL_ERROR).toBe('Roc 文件工具路径不能包含 .. 路径段。');
    expect(ROC_FILE_TOOL_MISSING_PATH_ERROR).toBe('Roc 文件工具调用缺少 path/file_path 字符串参数。');
    expect(ROC_DELETE_FILE_WORKSPACE_ERROR).toBe('delete_file 只允许删除 /workspace/ 路径下的文件或空目录。');
  });

  it('maps every Roc file-like tool to its path argument', () => {
    expect(ROC_FILE_TOOL_PATH_FIELDS).toEqual({
      ls: 'path',
      read_file: 'file_path',
      write_file: 'file_path',
      edit_file: 'file_path',
      glob: 'path',
      grep: 'path',
      delete_file: 'file_path'
    });
    expect(isRocFileToolName('read_file')).toBe(true);
    expect(isRocFileToolName('execute')).toBe(false);
    expect(getRocFileToolPathField('delete_file')).toBe('file_path');
    expect(getRocFileToolPathField('web_read')).toBeNull();
  });

  it.each([
    '/workspace',
    '/workspace/create_docx.py',
    '/memory/global/MEMORY.md',
    '/memory/global/AGENTS.md',
    '/memory/workspaces/current/AGENTS.md',
    '/skills/python/SKILL.md'
  ])('accepts Roc virtual path %s', (path) => {
    expect(validateRocFileToolPath(path)).toEqual({ ok: true });
    expect(normalizeRocFileToolPath(path)).toEqual({ ok: true, path });
  });

  it.each([
    ['/home/user/workarea/create_docx.py', ROC_FILE_TOOL_ROUTE_ERROR],
    ['/tmp/create_docx.py', ROC_FILE_TOOL_ROUTE_ERROR],
    ['F:\\Code\\Roc\\create_docx.py', ROC_FILE_TOOL_WINDOWS_PATH_ERROR],
    ['\\\\server\\share\\file.txt', ROC_FILE_TOOL_WINDOWS_PATH_ERROR],
    ['relative/file.txt', ROC_FILE_TOOL_ROUTE_ERROR],
    ['/agents/AGENTS.md', ROC_FILE_TOOL_ROUTE_ERROR],
    ['/workspace/../secret.txt', ROC_FILE_TOOL_TRAVERSAL_ERROR]
  ])('rejects invalid file-tool path %s', (path, error) => {
    expect(validateRocFileToolPath(path)).toEqual({ ok: false, error });
    expect(normalizeRocFileToolPath(path)).toEqual({ ok: false, error });
  });

  it('uses an explicit final deny because DeepAgents permissions default to allow', () => {
    expect(createRocFilesystemPermissions()).toEqual([
      { operations: ['read'], paths: ['/workspace/**', '/memory/**', '/skills/**'], mode: 'allow' },
      { operations: ['write'], paths: ['/workspace/**', '/memory/**'], mode: 'allow' },
      { operations: ['write'], paths: ['/skills/**'], mode: 'deny' },
      { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' }
    ]);
  });

  it('converts delete_file /workspace paths to existing files.delete relative paths', () => {
    expect(toWorkspaceRelativePath('/workspace/src/remove-me.ts')).toEqual({
      ok: true,
      relativePath: 'src/remove-me.ts'
    });
    expect(toWorkspaceRelativePath('/workspace')).toEqual({
      ok: false,
      error: ROC_DELETE_FILE_WORKSPACE_ERROR
    });
    expect(toWorkspaceRelativePath('/memory/global/MEMORY.md')).toEqual({
      ok: false,
      error: ROC_DELETE_FILE_WORKSPACE_ERROR
    });
  });

  it('keeps prompt guidance aligned with the runtime contract', () => {
    expect(ROC_FILE_TOOL_PROMPT_LINES).toEqual([
      'DeepAgents file tools accept only Roc virtual routes: /workspace/, /memory/, and /skills/.',
      'Agent memory files live under /memory/.../AGENTS.md, matching DeepAgents memory-source semantics.',
      'Use run_shell_command for local Windows commands; its default cwd is the selected Roc workspace root.',
      'Never pass /workspace/... to run_shell_command; use a relative path from the default cwd or a real Windows path.',
      'Do not pass Windows absolute paths or Linux paths to read_file, write_file, edit_file, ls, glob, grep, or delete_file.'
    ]);
  });
});
```

- [ ] **Step 2: Add official DeepAgents contract tests**

Append these tests inside `tests/main/services/deep-agent/deep-agent-official-contracts.test.ts`:

```typescript
import { createFilesystemMiddleware } from 'deepagents';
```

```typescript
  it('documents that DeepAgents filesystem middleware registers execute with file tools', () => {
    const middleware = createFilesystemMiddleware();
    const toolNames = middleware.tools.map((tool) => tool.name);

    expect(toolNames).toEqual(expect.arrayContaining([
      'ls',
      'read_file',
      'write_file',
      'edit_file',
      'glob',
      'grep',
      'execute'
    ]));
    expect(DEEP_AGENT_BUILT_IN_TOOLS).not.toContain('execute');
  });

  it('documents that empty DeepAgents permissions are permissive for file tools', async () => {
    const backend = {
      ls: async () => ({
        files: [{ path: '/outside/file.txt', is_dir: false, size: 5 }]
      }),
      read: async () => ({
        content: 'hello'
      }),
      readRaw: async () => ({
        content: { data: 'hello', mimeType: 'text/plain' }
      }),
      write: async (filePath: string) => ({
        path: filePath,
        filesUpdate: null
      }),
      edit: async (filePath: string) => ({
        path: filePath,
        occurrences: 1,
        filesUpdate: null
      }),
      glob: async () => ({
        files: [{ path: '/outside/file.txt', is_dir: false, size: 5 }]
      }),
      grep: async () => ({
        matches: [{ path: '/outside/file.txt', line: 1, text: 'hello' }]
      }),
      uploadFiles: async () => [],
      downloadFiles: async () => []
    };
    const middleware = createFilesystemMiddleware({ backend, permissions: [] });
    const readTool = middleware.tools.find((tool) => tool.name === 'read_file');
    if (readTool === undefined) {
      throw new Error('expected_read_file_tool');
    }

    await expect(readTool.invoke({ file_path: '/outside/file.txt' })).resolves.toEqual([
      { type: 'text', text: '     1\\thello' }
    ]);
  });
```

- [ ] **Step 3: Verify contract tests fail before implementation**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/filesystem-tool-contract.test.ts tests/main/services/deep-agent/deep-agent-official-contracts.test.ts
```

Expected:

```text
FAIL tests/main/services/deep-agent/filesystem-tool-contract.test.ts
Cannot find module '../../../../src/main/services/deep-agent/filesystem-tool-contract'
```

- [ ] **Step 4: Create the contract module**

Create `src/main/services/deep-agent/filesystem-tool-contract.ts`:

```typescript
import type { FilesystemPermission } from 'deepagents';

export const ROC_FILE_TOOL_ROUTE_ERROR = 'Roc 文件工具只允许访问 /workspace/、/skills/、/memory/ 路径。';
export const ROC_FILE_TOOL_WINDOWS_PATH_ERROR = 'Roc 文件工具使用虚拟路径；请改用 /workspace/...。';
export const ROC_FILE_TOOL_TRAVERSAL_ERROR = 'Roc 文件工具路径不能包含 .. 路径段。';
export const ROC_FILE_TOOL_MISSING_PATH_ERROR = 'Roc 文件工具调用缺少 path/file_path 字符串参数。';
export const ROC_DELETE_FILE_WORKSPACE_ERROR = 'delete_file 只允许删除 /workspace/ 路径下的文件或空目录。';

export const ROC_FILE_TOOL_ALLOWED_ROUTE_PREFIXES = ['/workspace', '/skills', '/memory'] as const;

export const ROC_FILE_TOOL_PATH_FIELDS = {
  ls: 'path',
  read_file: 'file_path',
  write_file: 'file_path',
  edit_file: 'file_path',
  glob: 'path',
  grep: 'path',
  delete_file: 'file_path'
} as const;

export const ROC_FILE_TOOL_PROMPT_LINES = [
  'DeepAgents file tools accept only Roc virtual routes: /workspace/, /memory/, and /skills/.',
  'Agent memory files live under /memory/.../AGENTS.md, matching DeepAgents memory-source semantics.',
  'Use run_shell_command for local Windows commands; its default cwd is the selected Roc workspace root.',
  'Never pass /workspace/... to run_shell_command; use a relative path from the default cwd or a real Windows path.',
  'Do not pass Windows absolute paths or Linux paths to read_file, write_file, edit_file, ls, glob, grep, or delete_file.'
] as const;

export type RocFileToolName = keyof typeof ROC_FILE_TOOL_PATH_FIELDS;
export type RocFileToolPathField = (typeof ROC_FILE_TOOL_PATH_FIELDS)[RocFileToolName];

export type PathValidationResult =
  | { ok: true }
  | { ok: false; error: string };

export type PathNormalizationResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

export type WorkspaceRelativePathResult =
  | { ok: true; relativePath: string }
  | { ok: false; error: string };

const ROC_FILE_TOOL_NAME_SET = new Set<string>(Object.keys(ROC_FILE_TOOL_PATH_FIELDS));

export function createRocFilesystemPermissions(): FilesystemPermission[] {
  return [
    { operations: ['read'], paths: ['/workspace/**', '/memory/**', '/skills/**'], mode: 'allow' },
    { operations: ['write'], paths: ['/workspace/**', '/memory/**'], mode: 'allow' },
    { operations: ['write'], paths: ['/skills/**'], mode: 'deny' },
    { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' }
  ];
}

export function isRocFileToolName(name: string): name is RocFileToolName {
  return ROC_FILE_TOOL_NAME_SET.has(name);
}

export function getRocFileToolPathField(name: string): RocFileToolPathField | null {
  if (!isRocFileToolName(name)) {
    return null;
  }
  return ROC_FILE_TOOL_PATH_FIELDS[name];
}

export function validateRocFileToolPath(path: string): PathValidationResult {
  const normalized = normalizeRocFileToolPath(path);
  if (!normalized.ok) {
    return { ok: false, error: normalized.error };
  }
  return { ok: true };
}

export function normalizeRocFileToolPath(path: string): PathNormalizationResult {
  if (containsTraversal(path)) {
    return { ok: false, error: ROC_FILE_TOOL_TRAVERSAL_ERROR };
  }
  if (isWindowsAbsolutePath(path) || isUncPath(path)) {
    return { ok: false, error: ROC_FILE_TOOL_WINDOWS_PATH_ERROR };
  }
  if (isAllowedRoutePath(path)) {
    return { ok: true, path };
  }
  return { ok: false, error: ROC_FILE_TOOL_ROUTE_ERROR };
}

export function toWorkspaceRelativePath(filePath: string): WorkspaceRelativePathResult {
  const validation = validateRocFileToolPath(filePath);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }
  if (!filePath.startsWith('/workspace/')) {
    return { ok: false, error: ROC_DELETE_FILE_WORKSPACE_ERROR };
  }
  const relativePath = filePath.slice('/workspace/'.length);
  if (relativePath.length === 0) {
    return { ok: false, error: ROC_DELETE_FILE_WORKSPACE_ERROR };
  }
  return { ok: true, relativePath };
}

function isAllowedRoutePath(path: string): boolean {
  return ROC_FILE_TOOL_ALLOWED_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function containsTraversal(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => segment === '..');
}

function isWindowsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path);
}

function isUncPath(path: string): boolean {
  return path.startsWith('\\\\');
}
```

- [ ] **Step 5: Verify Task 1**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/filesystem-tool-contract.test.ts tests/main/services/deep-agent/deep-agent-official-contracts.test.ts
```

Expected:

```text
PASS tests/main/services/deep-agent/filesystem-tool-contract.test.ts
PASS tests/main/services/deep-agent/deep-agent-official-contracts.test.ts
```

- [ ] **Step 6: Commit Task 1**

Run:

```powershell
git add src/main/services/deep-agent/filesystem-tool-contract.ts tests/main/services/deep-agent/filesystem-tool-contract.test.ts tests/main/services/deep-agent/deep-agent-official-contracts.test.ts
git commit -m "test: lock Roc DeepAgents file tool contract"
```

---

### Task 2: Make File Tool Middleware Fail Closed

**Files:**
- Modify: `src/main/services/deep-agent/filesystem-path-policy.ts`
- Modify: `src/main/services/deep-agent/agent-builder.ts`
- Modify: `tests/main/services/deep-agent/filesystem-path-policy.test.ts`

**Interfaces:**
- Consumes: `getRocFileToolPathField(name)`, `normalizeRocFileToolPath(path)`, and `ROC_FILE_TOOL_MISSING_PATH_ERROR`.
- Produces: `createRocFilesystemPathPolicyMiddleware()` with no workspace rewrite option.
- Produces: file-tool calls missing `path` or `file_path` return an error `ToolMessage`.
- Produces: Windows absolute paths are rejected even when they point inside the current workspace.

- [ ] **Step 1: Replace the rewrite test with fail-closed tests**

In `tests/main/services/deep-agent/filesystem-path-policy.test.ts`, update imports:

```typescript
import {
  ROC_FILE_TOOL_MISSING_PATH_ERROR,
  ROC_FILE_TOOL_WINDOWS_PATH_ERROR
} from '../../../../src/main/services/deep-agent/filesystem-tool-contract';
```

Replace the current `normalizeRocFileToolPath` block:

```typescript
describe('normalizeRocFileToolPath', () => {
  it('rejects selected workspace Windows paths instead of rewriting them', () => {
    expect(normalizeRocFileToolPath('F:\\Code\\Roc\\scripts\\probe.ts')).toEqual({
      ok: false,
      error: ROC_FILE_TOOL_WINDOWS_PATH_ERROR
    });
  });

  it('rejects Windows paths outside the selected workspace', () => {
    expect(normalizeRocFileToolPath('F:\\Other\\probe.ts')).toEqual({
      ok: false,
      error: ROC_FILE_TOOL_WINDOWS_PATH_ERROR
    });
  });
});
```

Add middleware tests:

```typescript
  it('returns an error ToolMessage when a file tool omits its path field', async () => {
    const middleware = createRocFilesystemPathPolicyMiddleware();
    const handler = vi.fn(async () => new ToolMessage({
      tool_call_id: 'call-missing',
      name: 'read_file',
      content: 'handler reached'
    }));

    const result = await middleware.wrapToolCall!(
      {
        toolCall: {
          id: 'call-missing',
          name: 'read_file',
          args: {}
        },
        state: { messages: [] }
      } as never,
      handler
    );

    expect(handler).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      tool_call_id: 'call-missing',
      name: 'read_file',
      status: 'error',
      content: ROC_FILE_TOOL_MISSING_PATH_ERROR
    });
  });

  it('returns an error ToolMessage when a file tool path field is not a string', async () => {
    const middleware = createRocFilesystemPathPolicyMiddleware();
    const handler = vi.fn(async () => new ToolMessage({
      tool_call_id: 'call-non-string',
      name: 'ls',
      content: 'handler reached'
    }));

    const result = await middleware.wrapToolCall!(
      {
        toolCall: {
          id: 'call-non-string',
          name: 'ls',
          args: { path: 42 }
        },
        state: { messages: [] }
      } as never,
      handler
    );

    expect(handler).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      tool_call_id: 'call-non-string',
      name: 'ls',
      status: 'error',
      content: ROC_FILE_TOOL_MISSING_PATH_ERROR
    });
  });

  it('applies the same virtual path policy to delete_file', async () => {
    const middleware = createRocFilesystemPathPolicyMiddleware();
    const handler = vi.fn(async () => new ToolMessage({
      tool_call_id: 'call-delete',
      name: 'delete_file',
      content: 'handler reached'
    }));

    const result = await middleware.wrapToolCall!(
      {
        toolCall: {
          id: 'call-delete',
          name: 'delete_file',
          args: {
            file_path: 'src/remove-me.ts'
          }
        },
        state: { messages: [] }
      } as never,
      handler
    );

    expect(handler).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      tool_call_id: 'call-delete',
      name: 'delete_file',
      status: 'error',
      content: 'Roc 文件工具只允许访问 /workspace/、/skills/、/memory/ 路径。'
    });
  });
```

- [ ] **Step 2: Run middleware tests to verify failure**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/filesystem-path-policy.test.ts
```

Expected:

```text
FAIL tests/main/services/deep-agent/filesystem-path-policy.test.ts
```

The failure should show the old Windows rewrite behavior or missing path calls reaching the handler.

- [ ] **Step 3: Replace path-policy internals with contract helpers**

Change `src/main/services/deep-agent/filesystem-path-policy.ts` to:

```typescript
import { ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';

import {
  ROC_FILE_TOOL_MISSING_PATH_ERROR,
  getRocFileToolPathField,
  normalizeRocFileToolPath,
  validateRocFileToolPath
} from './filesystem-tool-contract';
import type { PathNormalizationResult, PathValidationResult } from './filesystem-tool-contract';

type ToolCallNormalizationResult<TRequest extends ToolCallRequest> =
  | { ok: true; path: string; request: TRequest }
  | { ok: false; error: string };

type ToolCallRequest = {
  toolCall: {
    args?: unknown;
    id?: string;
    name: string;
  };
};

export { normalizeRocFileToolPath, validateRocFileToolPath };
export type { PathNormalizationResult, PathValidationResult };

export function createRocFilesystemPathPolicyMiddleware() {
  return createMiddleware({
    name: 'RocFilesystemPathPolicyMiddleware',
    wrapToolCall: async (request, handler) => {
      const validation = normalizeFilesystemToolCall(request);
      if (validation.ok) {
        return await handler(validation.request);
      }
      return new ToolMessage({
        tool_call_id: request.toolCall.id ?? 'unknown-tool-call',
        name: request.toolCall.name,
        content: validation.error,
        status: 'error'
      });
    }
  });
}

function normalizeFilesystemToolCall<TRequest extends ToolCallRequest>(
  request: TRequest
): ToolCallNormalizationResult<TRequest> {
  const pathField = getRocFileToolPathField(request.toolCall.name);
  if (pathField === null) {
    return { ok: true, path: '', request };
  }
  if (!isRecord(request.toolCall.args)) {
    return { ok: false, error: ROC_FILE_TOOL_MISSING_PATH_ERROR };
  }
  const path = request.toolCall.args[pathField];
  if (typeof path !== 'string') {
    return { ok: false, error: ROC_FILE_TOOL_MISSING_PATH_ERROR };
  }
  const normalized = normalizeRocFileToolPath(path);
  if (!normalized.ok) {
    return normalized;
  }
  return { ok: true, path, request };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
```

Remove `replaceToolCallPath`, `tryConvertWorkspacePath`, `isWindowsAbsolutePath`, `isUncPath`, and the `win32` import from this file.

- [ ] **Step 4: Remove the unused path-policy option from builder wiring**

Change `src/main/services/deep-agent/agent-builder.ts`:

```typescript
    createForgeIterationTrackingMiddleware(),
    createRocFilesystemPathPolicyMiddleware(),
    createFilesystemToolErrorMiddleware(),
```

Keep `workspacePath` in `DeepAgentBuildInput`; it is still used by shell path policy and prompt construction.

- [ ] **Step 5: Verify Task 2**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/filesystem-path-policy.test.ts
```

Expected:

```text
PASS tests/main/services/deep-agent/filesystem-path-policy.test.ts
```

- [ ] **Step 6: Commit Task 2**

Run:

```powershell
git add src/main/services/deep-agent/filesystem-path-policy.ts src/main/services/deep-agent/agent-builder.ts tests/main/services/deep-agent/filesystem-path-policy.test.ts
git commit -m "fix: fail closed on DeepAgents file tool paths"
```

---

### Task 3: Enforce Routes Inside The Backend

**Files:**
- Modify: `src/main/services/deep-agent/backend.ts`
- Modify: `tests/main/services/deep-agent/backend.test.ts`

**Interfaces:**
- Consumes: `ROC_FILE_TOOL_ROUTE_ERROR`, `createRocFilesystemPermissions()`, and `validateRocFileToolPath(path)`.
- Produces: unknown routes are hard errors for `ls`, `read`, `readRaw`, `write`, `edit`, `glob`, and `grep`.
- Produces: direct backend calls cannot bypass middleware path validation.
- Produces: backend still exposes no `execute`.

- [ ] **Step 1: Add backend fail-closed tests**

Update imports in `tests/main/services/deep-agent/backend.test.ts`:

```typescript
import { createBackend } from '../../../../src/main/services/deep-agent/backend';
import {
  ROC_FILE_TOOL_ROUTE_ERROR,
  ROC_FILE_TOOL_WINDOWS_PATH_ERROR,
  createRocFilesystemPermissions
} from '../../../../src/main/services/deep-agent/filesystem-tool-contract';
```

Add these tests:

```typescript
  it.each([
    ['ls', async (backend: ReturnType<typeof createTestBackend>['backend']) => await backend.ls('/')],
    ['glob', async (backend: ReturnType<typeof createTestBackend>['backend']) => await backend.glob('**/*', '/')],
    ['grep', async (backend: ReturnType<typeof createTestBackend>['backend']) => await backend.grep('needle', '/')]
  ])('rejects root %s instead of returning an empty result', async (_name, call) => {
    const { backend } = createTestBackend();

    await expect(call(backend)).resolves.toEqual({ error: ROC_FILE_TOOL_ROUTE_ERROR });
  });

  it.each([
    ['ls', async (backend: ReturnType<typeof createTestBackend>['backend']) => await backend.ls('/agents')],
    ['read', async (backend: ReturnType<typeof createTestBackend>['backend']) => await backend.read('/agents/AGENTS.md')],
    ['readRaw', async (backend: ReturnType<typeof createTestBackend>['backend']) => await backend.readRaw('/agents/AGENTS.md')],
    ['write', async (backend: ReturnType<typeof createTestBackend>['backend']) => await backend.write('/agents/notes.md', 'x')],
    ['edit', async (backend: ReturnType<typeof createTestBackend>['backend']) => await backend.edit('/agents/notes.md', 'x', 'y')],
    ['glob', async (backend: ReturnType<typeof createTestBackend>['backend']) => await backend.glob('**/*', '/agents')],
    ['grep', async (backend: ReturnType<typeof createTestBackend>['backend']) => await backend.grep('needle', '/agents')]
  ])('rejects unknown route through backend method %s', async (_name, call) => {
    const { backend } = createTestBackend();

    await expect(call(backend)).resolves.toEqual({ error: ROC_FILE_TOOL_ROUTE_ERROR });
  });

  it('rejects Windows absolute paths at the backend boundary', async () => {
    const { backend } = createTestBackend();

    await expect(backend.read('F:\\Code\\Roc\\package.json')).resolves.toEqual({
      error: ROC_FILE_TOOL_WINDOWS_PATH_ERROR
    });
  });

  it('allows routed workspace paths through the backend boundary', async () => {
    const { backend } = createTestBackend();

    await expect(backend.ls('/workspace/')).resolves.toHaveProperty('files');
  });
```

- [ ] **Step 2: Run backend tests to verify failure**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/backend.test.ts
```

Expected:

```text
FAIL tests/main/services/deep-agent/backend.test.ts
```

At least one failure should show `{ files: [] }` or `{ matches: [] }` where the new expected value is `{ error: ROC_FILE_TOOL_ROUTE_ERROR }`.

- [ ] **Step 3: Import the shared contract in the backend**

Change the top of `src/main/services/deep-agent/backend.ts`:

```typescript
import {
  ROC_FILE_TOOL_ROUTE_ERROR,
  createRocFilesystemPermissions,
  validateRocFileToolPath
} from './filesystem-tool-contract';
```

Remove local `UNKNOWN_ROUTE_ERROR` and local `createRocFilesystemPermissions()`.

If other modules still import `createRocFilesystemPermissions` from `backend.ts`, update them to import from `filesystem-tool-contract.ts` in this task. The known caller is `src/main/plugins/agent/deep-agent-executor.ts`.

- [ ] **Step 4: Make the rejecting backend hard-error on all methods**

Change `RocRouteRejectingFilesystemBackend` methods:

```typescript
  ls(_path: string): Promise<LsResult> {
    return Promise.resolve({ error: ROC_FILE_TOOL_ROUTE_ERROR });
  }

  read(_filePath: string, _offset?: number, _limit?: number): Promise<ReadResult> {
    return Promise.resolve({ error: ROC_FILE_TOOL_ROUTE_ERROR });
  }

  readRaw(_filePath: string): Promise<ReadRawResult> {
    return Promise.resolve({ error: ROC_FILE_TOOL_ROUTE_ERROR });
  }

  grep(_pattern: string, _path?: string | null, _glob?: string | null): Promise<GrepResult> {
    return Promise.resolve({ error: ROC_FILE_TOOL_ROUTE_ERROR });
  }

  glob(_pattern: string, _path?: string): Promise<GlobResult> {
    return Promise.resolve({ error: ROC_FILE_TOOL_ROUTE_ERROR });
  }

  write(_filePath: string, _content: string): Promise<import('deepagents').WriteResult> {
    return Promise.resolve({ error: ROC_FILE_TOOL_ROUTE_ERROR });
  }

  edit(_filePath: string, _oldString: string, _newString: string, _replaceAll?: boolean): Promise<EditResult> {
    return Promise.resolve({ error: ROC_FILE_TOOL_ROUTE_ERROR });
  }
```

- [ ] **Step 5: Add validation to the non-executing backend wrapper**

Replace `RocNonExecutingCompositeBackend` with:

```typescript
class RocNonExecutingCompositeBackend {
  constructor(private readonly delegate: CompositeBackend) {}

  get routePrefixes(): string[] {
    return this.delegate.routePrefixes;
  }

  ls(path: string): Promise<LsResult> {
    const validation = validateRocFileToolPath(path);
    if (!validation.ok) {
      return Promise.resolve({ error: validation.error });
    }
    return this.delegate.ls(path);
  }

  read(filePath: string, offset?: number, limit?: number): Promise<ReadResult> {
    const validation = validateRocFileToolPath(filePath);
    if (!validation.ok) {
      return Promise.resolve({ error: validation.error });
    }
    return this.delegate.read(filePath, offset, limit);
  }

  readRaw(filePath: string): Promise<ReadRawResult> {
    const validation = validateRocFileToolPath(filePath);
    if (!validation.ok) {
      return Promise.resolve({ error: validation.error });
    }
    return this.delegate.readRaw(filePath);
  }

  grep(pattern: string, path?: string | null, glob?: string | null): Promise<GrepResult> {
    if (typeof path !== 'string') {
      return Promise.resolve({ error: ROC_FILE_TOOL_ROUTE_ERROR });
    }
    const validation = validateRocFileToolPath(path);
    if (!validation.ok) {
      return Promise.resolve({ error: validation.error });
    }
    return this.delegate.grep(pattern, path, glob);
  }

  glob(pattern: string, path?: string): Promise<GlobResult> {
    if (typeof path !== 'string') {
      return Promise.resolve({ error: ROC_FILE_TOOL_ROUTE_ERROR });
    }
    const validation = validateRocFileToolPath(path);
    if (!validation.ok) {
      return Promise.resolve({ error: validation.error });
    }
    return this.delegate.glob(pattern, path);
  }

  write(filePath: string, content: string): Promise<import('deepagents').WriteResult> {
    const validation = validateRocFileToolPath(filePath);
    if (!validation.ok) {
      return Promise.resolve({ error: validation.error });
    }
    return this.delegate.write(filePath, content);
  }

  edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean): Promise<EditResult> {
    const validation = validateRocFileToolPath(filePath);
    if (!validation.ok) {
      return Promise.resolve({ error: validation.error });
    }
    return this.delegate.edit(filePath, oldString, newString, replaceAll);
  }

  uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    const invalid = files.find(([path]) => !validateRocFileToolPath(path).ok);
    if (invalid !== undefined) {
      return Promise.resolve(files.map(([path]) => ({ path, error: 'permission_denied' })));
    }
    return this.delegate.uploadFiles(files);
  }

  downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const invalid = paths.find((path) => !validateRocFileToolPath(path).ok);
    if (invalid !== undefined) {
      return Promise.resolve(paths.map((path) => ({ path, content: null, error: 'permission_denied' })));
    }
    return this.delegate.downloadFiles(paths);
  }
}
```

This intentionally rejects missing `grep`/`glob` paths at the backend layer. DeepAgents defaults these paths to `/`; Roc does not expose `/` as an allowed file-tool root.

- [ ] **Step 6: Verify Task 3**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/backend.test.ts
```

Expected:

```text
PASS tests/main/services/deep-agent/backend.test.ts
```

- [ ] **Step 7: Commit Task 3**

Run:

```powershell
git add src/main/services/deep-agent/backend.ts src/main/plugins/agent/deep-agent-executor.ts tests/main/services/deep-agent/backend.test.ts
git commit -m "fix: enforce Roc file routes in DeepAgents backend"
```

---

### Task 4: Align Prompt And Error Middleware With The Runtime Contract

**Files:**
- Modify: `src/main/services/forge-guardrails/middleware/filesystem-tool-errors.ts`
- Modify: `src/main/services/deep-agent/prompt.ts`
- Modify: `src/main/services/deep-agent/prompt-builder.ts`
- Modify: `tests/main/services/forge-guardrails/middleware/filesystem-tool-errors.test.ts`
- Modify: `tests/main/deep-agent-prompt.test.ts`
- Modify: `tests/main/services/deep-agent/prompt-builder.test.ts`

**Interfaces:**
- Consumes: `ROC_FILE_TOOL_PATH_FIELDS`, `ROC_FILE_TOOL_PROMPT_LINES`, and route/permission error constants.
- Produces: one prompt contract for both production executor prompt paths.
- Produces: forge filesystem error middleware marks route/permission failures as `ToolMessage.status = 'error'` using shared constants.

- [ ] **Step 1: Update prompt tests for the new delete_file wording**

In `tests/main/deep-agent-prompt.test.ts` and `tests/main/services/deep-agent/prompt-builder.test.ts`, replace:

```typescript
expect(prompt).toContain('Do not pass Windows absolute paths or Linux paths to read_file, write_file, edit_file, ls, glob, or grep.');
```

with:

```typescript
expect(prompt).toContain('Do not pass Windows absolute paths or Linux paths to read_file, write_file, edit_file, ls, glob, grep, or delete_file.');
```

Apply the same replacement for `content` variables in `prompt-builder.test.ts`.

- [ ] **Step 2: Update error middleware tests to use shared constants**

In `tests/main/services/forge-guardrails/middleware/filesystem-tool-errors.test.ts`, import:

```typescript
import {
  ROC_FILE_TOOL_ROUTE_ERROR,
  ROC_FILE_TOOL_WINDOWS_PATH_ERROR
} from '../../../../../src/main/services/deep-agent/filesystem-tool-contract';
```

Replace literal route error assertions with `ROC_FILE_TOOL_ROUTE_ERROR`. Add this test:

```typescript
  it('marks Windows virtual-route violations as hard file-tool errors', async () => {
    const middleware = createFilesystemToolErrorMiddleware();

    const result = await middleware.wrapToolCall!(
      {
        toolCall: {
          id: 'call-windows-path',
          name: 'read_file',
          args: {
            file_path: 'F:\\Code\\Roc\\package.json'
          }
        },
        state: { messages: [] }
      } as never,
      async () => new ToolMessage({
        tool_call_id: 'call-windows-path',
        name: 'read_file',
        content: `Error: ${ROC_FILE_TOOL_WINDOWS_PATH_ERROR}`
      })
    );

    expect(result).toMatchObject({
      tool_call_id: 'call-windows-path',
      name: 'read_file',
      status: 'error'
    });
  });
```

- [ ] **Step 3: Run prompt/error tests to verify failure**

Run:

```powershell
pnpm test -- tests/main/services/forge-guardrails/middleware/filesystem-tool-errors.test.ts tests/main/deep-agent-prompt.test.ts tests/main/services/deep-agent/prompt-builder.test.ts
```

Expected:

```text
FAIL tests/main/deep-agent-prompt.test.ts
FAIL tests/main/services/deep-agent/prompt-builder.test.ts
```

The failures should point to the old prompt line that omits `delete_file`.

- [ ] **Step 4: Update filesystem error middleware**

Change `src/main/services/forge-guardrails/middleware/filesystem-tool-errors.ts` imports:

```typescript
import {
  ROC_FILE_TOOL_PATH_FIELDS,
  ROC_FILE_TOOL_ROUTE_ERROR,
  ROC_FILE_TOOL_WINDOWS_PATH_ERROR,
  ROC_FILE_TOOL_TRAVERSAL_ERROR
} from '../../deep-agent/filesystem-tool-contract';
```

Replace local file-tool names and route patterns:

```typescript
const FILESYSTEM_TOOL_NAMES = new Set(Object.keys(ROC_FILE_TOOL_PATH_FIELDS));

const ROUTE_OR_PERMISSION_ERROR_PATTERNS = [
  ROC_FILE_TOOL_ROUTE_ERROR,
  ROC_FILE_TOOL_WINDOWS_PATH_ERROR,
  ROC_FILE_TOOL_TRAVERSAL_ERROR,
  'Roc 已将 /skills/ 挂载为只读能力目录。',
  'Roc 当前回合未启用这个 skill。',
  'permission_denied'
] as const;
```

- [ ] **Step 5: Update prompts to use shared lines**

In `src/main/services/deep-agent/prompt.ts`, import:

```typescript
import { ROC_FILE_TOOL_PROMPT_LINES } from './filesystem-tool-contract';
```

Replace the hardcoded file-tool block inside `buildSystemPrompt()`:

```typescript
  sections.push(...ROC_FILE_TOOL_PROMPT_LINES);
```

In `src/main/services/deep-agent/prompt-builder.ts`, import the same constant and replace the matching `sections.push(...)` lines:

```typescript
      sections.push(...ROC_FILE_TOOL_PROMPT_LINES);
```

Keep existing background-task prompt lines about not using `/workspace/` as `workspacePath`; that is a separate workflow contract.

- [ ] **Step 6: Verify Task 4**

Run:

```powershell
pnpm test -- tests/main/services/forge-guardrails/middleware/filesystem-tool-errors.test.ts tests/main/deep-agent-prompt.test.ts tests/main/services/deep-agent/prompt-builder.test.ts
```

Expected:

```text
PASS tests/main/services/forge-guardrails/middleware/filesystem-tool-errors.test.ts
PASS tests/main/deep-agent-prompt.test.ts
PASS tests/main/services/deep-agent/prompt-builder.test.ts
```

- [ ] **Step 7: Commit Task 4**

Run:

```powershell
git add src/main/services/forge-guardrails/middleware/filesystem-tool-errors.ts src/main/services/deep-agent/prompt.ts src/main/services/deep-agent/prompt-builder.ts tests/main/services/forge-guardrails/middleware/filesystem-tool-errors.test.ts tests/main/deep-agent-prompt.test.ts tests/main/services/deep-agent/prompt-builder.test.ts
git commit -m "refactor: share Roc file tool boundary contract"
```

---

### Task 5: Move delete_file To The /workspace File-Tool Contract

**Files:**
- Modify: `src/main/plugins/agent/deep-agent-executor.ts`
- Modify: `tests/main/plugins/agent/deep-agent-executor-tools.test.ts`
- Modify: `tests/main/plugins/agent/deep-agent-executor-test-helpers.ts`

**Interfaces:**
- Consumes: `toWorkspaceRelativePath(filePath)`.
- Produces: agent-facing `delete_file` schema `{ file_path: string }`.
- Produces: Roc internal capability call `files.delete` still receives `{ relativePath: string }`.

- [ ] **Step 1: Add delete_file behavior tests**

Update imports in `tests/main/plugins/agent/deep-agent-executor-tools.test.ts`:

```typescript
  readJson,
```

Add these tests:

```typescript
  it('converts delete_file /workspace file_path to files.delete relativePath', async () => {
    const capabilityCalls: Array<{ name: string; input: unknown }> = [];
    await buildExecutorOnce(createCapabilities(capabilityCalls), {
      mode: 'chat',
      workflowHint: null,
      taskSource: null
    });

    const output = await invokeTool(findTool(readBuiltTools(), 'delete_file'), {
      file_path: '/workspace/src/remove-me.ts'
    });

    expect(readJson(output)).toMatchObject({
      relativePath: 'src/remove-me.ts'
    });
    expect(capabilityCalls).toContainEqual({
      name: 'files.delete',
      input: {
        relativePath: 'src/remove-me.ts'
      }
    });
  });

  it.each([
    ['relative path', { file_path: 'src/remove-me.ts' }, 'Roc 文件工具只允许访问 /workspace/、/skills/、/memory/ 路径。'],
    ['memory path', { file_path: '/memory/global/MEMORY.md' }, 'delete_file 只允许删除 /workspace/ 路径下的文件或空目录。'],
    ['workspace root', { file_path: '/workspace/' }, 'delete_file 只允许删除 /workspace/ 路径下的文件或空目录。']
  ])('rejects delete_file %s', async (_label, input, message) => {
    await buildExecutorOnce(createCapabilities([]), {
      mode: 'chat',
      workflowHint: null,
      taskSource: null
    });

    await expect(invokeTool(findTool(readBuiltTools(), 'delete_file'), input)).rejects.toThrow(message);
  });
```

- [ ] **Step 2: Add files.delete test capability**

In `tests/main/plugins/agent/deep-agent-executor-test-helpers.ts`, add `FileDeleteResult` and `RecoveryPoint` to the type imports:

```typescript
  FileDeleteResult,
  RecoveryPoint,
```

Add a helper near `createTaskDetail()`:

```typescript
function createRecoveryPoint(relativePath: string): RecoveryPoint {
  return {
    id: 'recovery-1',
    relativePath,
    snapshotPath: 'F:\\Code\\Roc\\.roc-test\\recovery-1',
    contentSha256: 'sha256-test',
    source: 'agent',
    createdAt: '2026-06-04T00:00:00.000Z',
    restored: false
  };
}
```

Add this branch in `createCapabilities().invoke` before the final unexpected capability error:

```typescript
      if (name === 'files.delete') {
        const request = input as { relativePath: string };
        return {
          relativePath: request.relativePath,
          recoveryPoint: createRecoveryPoint(request.relativePath)
        } satisfies FileDeleteResult as TOutput;
      }
```

- [ ] **Step 3: Run delete_file tests to verify failure**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/deep-agent-executor-tools.test.ts
```

Expected:

```text
FAIL tests/main/plugins/agent/deep-agent-executor-tools.test.ts
```

The first new test should fail because the current tool expects `relativePath`, not `file_path`.

- [ ] **Step 4: Change delete_file implementation**

In `src/main/plugins/agent/deep-agent-executor.ts`, update imports:

```typescript
import { createBackend } from '../../services/deep-agent/backend';
import { createRocFilesystemPermissions, toWorkspaceRelativePath } from '../../services/deep-agent/filesystem-tool-contract';
```

Replace `createDeleteFileTool()` with:

```typescript
function createDeleteFileTool(capabilities: RocCapabilityRegistry): DynamicStructuredTool<any, any, any, string> {
  const schema = z.object({
    file_path: z.string().trim().min(1)
  });
  return new DynamicStructuredTool<typeof schema, { file_path: string }, { file_path: string }, string>({
    name: 'delete_file',
    description: '删除 /workspace/... 下的文件或空目录，会先写入恢复点；仅当确实需要删除目标时使用。',
    schema,
    func: async (request) => {
      const relativePath = toWorkspaceRelativePath(request.file_path);
      if (!relativePath.ok) {
        throw new Error(relativePath.error);
      }
      return JSON.stringify(
        await capabilities.invoke<{ relativePath: string }, FileDeleteResult>('files.delete', {
          relativePath: relativePath.relativePath
        }),
        null,
        2
      );
    }
  });
}
```

- [ ] **Step 5: Verify Task 5**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/deep-agent-executor-tools.test.ts
```

Expected:

```text
PASS tests/main/plugins/agent/deep-agent-executor-tools.test.ts
```

- [ ] **Step 6: Commit Task 5**

Run:

```powershell
git add src/main/plugins/agent/deep-agent-executor.ts tests/main/plugins/agent/deep-agent-executor-tools.test.ts tests/main/plugins/agent/deep-agent-executor-test-helpers.ts
git commit -m "fix: expose delete_file with Roc virtual paths"
```

---

### Task 6: Final Verification And Drift Scan

**Files:**
- No new implementation files.
- Validate all files touched in Tasks 1-5.

**Interfaces:**
- Consumes: all previous task deliverables.
- Produces: evidence that route enforcement, prompt alignment, and type safety all pass together.

- [ ] **Step 1: Run focused regression tests**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/filesystem-tool-contract.test.ts tests/main/services/deep-agent/deep-agent-official-contracts.test.ts tests/main/services/deep-agent/filesystem-path-policy.test.ts tests/main/services/deep-agent/backend.test.ts tests/main/services/forge-guardrails/middleware/filesystem-tool-errors.test.ts tests/main/deep-agent-prompt.test.ts tests/main/services/deep-agent/prompt-builder.test.ts tests/main/plugins/agent/deep-agent-executor-tools.test.ts tests/main/services/deep-agent/command-tool.test.ts tests/main/services/deep-agent/shell-path-policy.test.ts
```

Expected:

```text
Test Files 10 passed
```

The exact Vitest summary may include per-test counts; every listed file must pass.

- [ ] **Step 2: Run TypeScript**

Run:

```powershell
pnpm typecheck
```

Expected:

```text
Exit code 0
```

- [ ] **Step 3: Check IPC drift**

Run:

```powershell
pnpm check:ipc
```

Expected:

```text
Exit code 0
```

No IPC contract is expected to change in this plan. A failure means an unrelated shared schema change is present and must be inspected before claiming completion.

- [ ] **Step 4: Run formatting whitespace check**

Run:

```powershell
git diff --check
```

Expected:

```text
Exit code 0
```

- [ ] **Step 5: Search for drift-prone duplicated route text**

Run:

```powershell
rg -n "Roc 文件工具只允许访问|Roc 文件工具使用虚拟路径|DeepAgents file tools accept only Roc virtual routes|Do not pass Windows absolute paths" src tests
```

Expected remaining matches:

```text
src/main/services/deep-agent/filesystem-tool-contract.ts
tests/main/services/deep-agent/filesystem-tool-contract.test.ts
tests/main/services/deep-agent/filesystem-path-policy.test.ts
tests/main/services/deep-agent/backend.test.ts
tests/main/services/forge-guardrails/middleware/filesystem-tool-errors.test.ts
tests/main/deep-agent-prompt.test.ts
tests/main/services/deep-agent/prompt-builder.test.ts
tests/main/plugins/agent/deep-agent-executor-tools.test.ts
```

If matches remain in runtime files outside `filesystem-tool-contract.ts`, move them to the shared contract unless the string is a separate workflow-specific instruction.

- [ ] **Step 6: Run the full test suite if the focused suite and typecheck pass**

Run:

```powershell
pnpm test
```

Expected:

```text
Exit code 0
```

- [ ] **Step 7: Inspect final diff**

Run:

```powershell
git diff --stat HEAD
git diff -- src/main/services/deep-agent src/main/services/forge-guardrails/middleware src/main/plugins/agent tests/main/services/deep-agent tests/main/services/forge-guardrails/middleware tests/main/plugins/agent tests/main/deep-agent-prompt.test.ts
```

Expected:

```text
Diff only touches the files listed in this plan.
No renderer, IPC, packaging, or shell execution implementation changes appear outside the planned imports.
```

- [ ] **Step 8: Commit verification-only adjustments if needed**

If Step 5 reveals duplicated runtime strings or Step 2 reveals import/type drift caused by the plan's own edits, make the smallest direct correction and run Steps 1-4 again.

Run:

```powershell
git add src tests
git commit -m "test: verify Roc file tool boundaries"
```

Skip this commit if no verification-only correction was required.

---

## Acceptance Criteria

- `read_file`, `write_file`, `edit_file`, `ls`, `glob`, `grep`, and Roc `delete_file` reject paths outside `/workspace`, `/skills`, and `/memory`.
- Windows absolute paths such as `F:\Code\Roc\package.json` are rejected by file tools, even when the path is inside the selected workspace.
- Missing or non-string file-tool path args fail before the DeepAgents handler runs.
- Unknown routes such as `/agents/`, `/tmp/`, `/home/...`, and `/` return hard errors for `ls`, `glob`, and `grep`; they do not return empty success results.
- Backend direct calls enforce the same route policy as middleware.
- `createRocFilesystemPermissions()` has an explicit final deny rule.
- DeepAgents native `execute` remains unavailable from Roc backend and is not added to `DEEP_AGENT_BUILT_IN_TOOLS`.
- `run_shell_command` behavior remains unchanged: it uses real Windows cwd/path semantics and rejects `/workspace/...` in command text or cwd.
- Prompt text and error middleware draw route-boundary text from one shared contract module.
- Focused tests, `pnpm typecheck`, `pnpm check:ipc`, and `git diff --check` pass.

## Boundaries / Not Doing

- Do not implement a Windows path bridge from file tools to real filesystem paths.
- Do not add `/agents/`, `/home/`, `/tmp/`, or other aliases.
- Do not make `run_shell_command` accept `/workspace/...`.
- Do not expose DeepAgents native `execute`.
- Do not change renderer UI, IPC schemas, packaging, memory slot layout, or shell execution service behavior.
- Do not broaden skill access; `/skills/` remains read-only and selected-skill scoped.

## Self-Review

- Spec coverage: The plan covers official DeepAgents security semantics, Roc runtime enforcement, backend bypass prevention, `delete_file` contract alignment, prompt/error drift, and verification.
- Placeholder scan: No steps depend on unspecified future code; each implementation step names exact files and code shapes.
- Type consistency: `file_path` is agent-facing for file tools, `relativePath` remains internal for `files.delete`, and permission exports move to the shared contract module.
