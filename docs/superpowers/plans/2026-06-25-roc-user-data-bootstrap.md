# Roc User Data Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lock Roc's first-launch user data bootstrap so `%USERPROFILE%\.roc` creates exactly the approved directories and files, with no omissions and no extra install-time artifacts.

**Architecture:** Keep `RocPaths.ensureTree()` as the authoritative directory skeleton. Keep first-launch files split across existing services: `ConfigService.initialize()` writes `config/settings.json` and `rtk/config.toml`; `LogService.initialize()` writes `logs/app.jsonl`. Add regression coverage that enumerates the exact tree and verifies runtime-only files stay absent before kernel start.

**Tech Stack:** TypeScript ESM, Node fs/path APIs, Vitest, Electron main-process services.

## Global Constraints

- User data root defaults to `join(homedir(), '.roc')`; tests must use temporary explicit roots.
- Install/first-launch directory skeleton is limited to `config`, `skills`, `indexes/fts`, `indexes/vector_store`, `tasks/artifacts`, `tasks/async-subagents`, `tasks/diagnostics`, `tasks/recovery`, `terminal/sessions`, `terminal/logs`, `rtk/tee`, `rtk/filters`, `rtk/audit`, `logs`, `diagnostics`, `tools`, and `secrets`, including required parent directories.
- First-launch files are limited to `config/settings.json`, `rtk/config.toml`, and `logs/app.jsonl`.
- Do not create `.roc/memory`, `.roc/plugin-data`, `.roc/hooks.json`, `.roc/config/hooks-trust.json`, `.roc/config/window-state.json`, `.roc/rtk/history.db`, `.roc/secrets/*.bin`, `.roc/skills/<id>`, `.roc/tasks/recovery/<id>`, `.roc/terminal/logs/<session>.log`, or legacy split config files during install/first launch.
- Preserve existing style: 2 spaces, semicolons, single quotes, TypeScript ESM.
- Use UTF-8 without BOM.
- Run the smallest verification first, then `pnpm typecheck`.

---

## File Structure

- Create `tests/main/services/roc-paths.test.ts`: focused unit test for `RocPaths.ensureTree()` exact directory creation and no file creation.
- Modify `tests/main/kernel-main-integration.test.ts`: integration test that `createMainKernelBootstrap()` creates the approved first-launch files before `start()`, while not creating runtime-only artifacts.
- Modify `src/main/services/paths.ts` only if the new `RocPaths` test fails. The approved tree is already expected to match current code.
- Modify `src/main/services/config-service.ts` only if the bootstrap file test shows missing or extra config files.
- Modify `src/main/services/log-service.ts` only if the bootstrap file test shows missing `logs/app.jsonl` or extra log files.

---

### Task 1: Lock Exact Directory Skeleton

**Files:**
- Create: `tests/main/services/roc-paths.test.ts`
- Possible Modify: `src/main/services/paths.ts:38-63`

**Interfaces:**
- Consumes: `new RocPaths(root: string)` and `paths.ensureTree(): void`.
- Produces: Regression coverage proving the directory skeleton is exact and `ensureTree()` creates no files.

- [ ] **Step 1: Write the failing test**

Create `tests/main/services/roc-paths.test.ts`:

```typescript
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RocPaths } from '../../../src/main/services/paths';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-paths-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('RocPaths user data tree', () => {
  it('creates exactly the approved install directories and no files', () => {
    const paths = new RocPaths(root);

    paths.ensureTree();

    expect(listRelativeDirectories(root)).toEqual([
      'config',
      'diagnostics',
      'indexes',
      'indexes/fts',
      'indexes/vector_store',
      'logs',
      'rtk',
      'rtk/audit',
      'rtk/filters',
      'rtk/tee',
      'secrets',
      'skills',
      'tasks',
      'tasks/artifacts',
      'tasks/async-subagents',
      'tasks/diagnostics',
      'tasks/recovery',
      'terminal',
      'terminal/logs',
      'terminal/sessions',
      'tools'
    ]);
    expect(listRelativeFiles(root)).toEqual([]);
    expect(existsSync(join(root, 'memory'))).toBe(false);
    expect(existsSync(join(root, 'plugin-data'))).toBe(false);
    expect(existsSync(join(root, 'hooks.json'))).toBe(false);
  });
});

function listRelativeDirectories(base: string): string[] {
  return listRelativeEntries(base, 'directory');
}

function listRelativeFiles(base: string): string[] {
  return listRelativeEntries(base, 'file');
}

function listRelativeEntries(base: string, kind: 'directory' | 'file'): string[] {
  const entries: string[] = [];
  collectRelativeEntries(base, base, kind, entries);
  return entries.sort();
}

function collectRelativeEntries(base: string, current: string, kind: 'directory' | 'file', entries: string[]): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolutePath = join(current, entry.name);
    if (entry.isDirectory()) {
      if (kind === 'directory') {
        entries.push(toRelativePath(base, absolutePath));
      }
      collectRelativeEntries(base, absolutePath, kind, entries);
      continue;
    }
    if (kind === 'file' && statSync(absolutePath).isFile()) {
      entries.push(toRelativePath(base, absolutePath));
    }
  }
}

function toRelativePath(base: string, absolutePath: string): string {
  return relative(base, absolutePath).replaceAll('\\', '/');
}
```

- [ ] **Step 2: Run test to verify current behavior**

Run:

```powershell
pnpm test -- tests/main/services/roc-paths.test.ts
```

Expected: PASS if current `RocPaths.ensureTree()` already matches the approved directory skeleton. FAIL means production code is creating too much or too little.

- [ ] **Step 3: Apply minimal production fix only if Step 2 fails**

If the failure is a directory mismatch, edit only the `dirs` array in `src/main/services/paths.ts` to match this body:

```typescript
  ensureTree(): void {
    const dirs = [
      this.root,
      this.configDir,
      this.skillsDir,
      join(this.indexesDir, 'fts'),
      join(this.indexesDir, 'vector_store'),
      this.artifactsDir,
      join(this.tasksDir, 'async-subagents'),
      join(this.tasksDir, 'diagnostics'),
      join(this.tasksDir, 'recovery'),
      join(this.terminalDir, 'sessions'),
      join(this.terminalDir, 'logs'),
      join(this.rtkDir, 'tee'),
      join(this.rtkDir, 'filters'),
      join(this.rtkDir, 'audit'),
      this.logsDir,
      this.diagnosticsDir,
      this.toolsDir,
      this.secretsDir
    ];

    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
    }
  }
```

Do not add `this.memoryDir`, `join(this.root, 'plugin-data')`, hook paths, window state paths, RTK database paths, or any skill/task/session child paths.

- [ ] **Step 4: Run direct verification**

Run:

```powershell
pnpm test -- tests/main/services/roc-paths.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit task**

Run:

```powershell
git add tests/main/services/roc-paths.test.ts src/main/services/paths.ts
git commit -m "test: lock roc user data directory tree"
```

If `src/main/services/paths.ts` was not changed, omit it from `git add`.

---

### Task 2: Lock First-Launch Files Before Kernel Start

**Files:**
- Modify: `tests/main/kernel-main-integration.test.ts`
- Possible Modify: `src/main/services/config-service.ts:56-60`
- Possible Modify: `src/main/services/log-service.ts:75-83`

**Interfaces:**
- Consumes: `createMainKernelBootstrap({ dataRoot, plugins, safeStorage })`.
- Produces: Regression coverage proving bootstrap construction creates only `config/settings.json`, `rtk/config.toml`, and `logs/app.jsonl` before `kernel.start()`.

- [ ] **Step 1: Add imports and helper functions to the integration test**

In `tests/main/kernel-main-integration.test.ts`, change the first import from `node:fs` to include `readdirSync` and `statSync`, and change the `node:path` import to include `relative`:

```typescript
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
```

Add these helpers near the bottom of the file, before existing helper functions if present:

```typescript
function listRelativeFiles(base: string): string[] {
  const entries: string[] = [];
  collectRelativeFiles(base, base, entries);
  return entries.sort();
}

function collectRelativeFiles(base: string, current: string, entries: string[]): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolutePath = join(current, entry.name);
    if (entry.isDirectory()) {
      collectRelativeFiles(base, absolutePath, entries);
      continue;
    }
    if (statSync(absolutePath).isFile()) {
      entries.push(relative(base, absolutePath).replaceAll('\\', '/'));
    }
  }
}
```

- [ ] **Step 2: Write the first-launch file test**

Add this test inside `describe('main kernel bootstrap integration', () => {`, near the existing bootstrap construction test:

```typescript
  it('creates only approved first-launch user data files before kernel start', () => {
    const bootstrap = createMainKernelBootstrap({
      dataRoot: root,
      plugins: [],
      safeStorage: safeStorage()
    });

    expect(bootstrap.paths.root).toBe(root);
    expect(listRelativeFiles(root)).toEqual([
      'config/settings.json',
      'logs/app.jsonl',
      'rtk/config.toml'
    ]);
    expect(JSON.parse(readFileSync(join(root, 'config', 'settings.json'), 'utf8'))).toMatchObject({
      schemaVersion: 4,
      settings: { schemaVersion: 2 },
      providers: { schemaVersion: 1 },
      mcp: { schemaVersion: 1 },
      permissions: { schemaVersion: 3 },
      shortcuts: { schemaVersion: 1 }
    });
    expect(readFileSync(join(root, 'rtk', 'config.toml'), 'utf8')).toContain('[tracking]');
    expect(readFileSync(join(root, 'logs', 'app.jsonl'), 'utf8')).toBe('');
    expect(existsSync(join(root, 'memory'))).toBe(false);
    expect(existsSync(join(root, 'plugin-data'))).toBe(false);
    expect(existsSync(join(root, 'hooks.json'))).toBe(false);
    expect(existsSync(join(root, 'config', 'hooks-trust.json'))).toBe(false);
    expect(existsSync(join(root, 'config', 'window-state.json'))).toBe(false);
    expect(existsSync(join(root, 'rtk', 'history.db'))).toBe(false);
  });
```

- [ ] **Step 3: Run test to verify current behavior**

Run:

```powershell
pnpm test -- tests/main/kernel-main-integration.test.ts
```

Expected: PASS if bootstrap construction already creates exactly the approved first-launch files. FAIL means `ConfigService.initialize()`, `LogService.initialize()`, or another bootstrap dependency is creating too much or too little.

- [ ] **Step 4: Apply minimal production fix only if Step 3 fails**

If `settings.json` or `rtk/config.toml` is missing, keep `ConfigService.initialize()` limited to:

```typescript
  initialize(): void {
    this.ensureSettingsDocument();
    this.ensureTextAtPath(join(this.paths.rtkDir, 'config.toml'), this.defaultRtkConfig());
    this.getSettingsDocument();
  }
```

If `logs/app.jsonl` is missing, keep `LogService.initialize()` limited to:

```typescript
  initialize(): void {
    if (!existsSync(this.appLogPath)) {
      writeFileSync(this.appLogPath, '', 'utf8');
    }
    this.currentSizeBytes = statSync(this.appLogPath).size;
    if (this.writeStream === null) {
      this.openWriteStream();
    }
    if (this.writeQueue.length > 0) {
      this.scheduleFlush();
    }
  }
```

If extra files are created before `bootstrap.start()`, remove only the premature creation path. Do not change runtime-on-demand creators for hooks, window state, plugin databases, secrets, skills, tasks, terminal sessions, or RTK history.

- [ ] **Step 5: Run direct verification**

Run:

```powershell
pnpm test -- tests/main/kernel-main-integration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit task**

Run:

```powershell
git add tests/main/kernel-main-integration.test.ts src/main/services/config-service.ts src/main/services/log-service.ts
git commit -m "test: lock roc first launch user data files"
```

If production files were not changed, omit them from `git add`.

---

### Task 3: Final Verification

**Files:**
- No code files expected.

**Interfaces:**
- Consumes: Tests from Tasks 1 and 2.
- Produces: Verified evidence that the approved install/first-launch tree is locked and TypeScript still passes.

- [ ] **Step 1: Run focused tests**

Run:

```powershell
pnpm test -- tests/main/services/roc-paths.test.ts tests/main/kernel-main-integration.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```powershell
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Run whitespace verification**

Run:

```powershell
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 4: Report final state**

Report these facts:

```text
Verified passing:
- RocPaths.ensureTree creates exactly the approved directory skeleton.
- createMainKernelBootstrap creates only config/settings.json, rtk/config.toml, and logs/app.jsonl before kernel start.
- Runtime-only files remain absent before kernel start.
- pnpm typecheck passed.
- git diff --check passed.
```

Do not claim packaged installer behavior unless `pnpm package:dir` or equivalent package-level verification is run.

---

## Self-Review

- Spec coverage: Task 1 covers the approved directory skeleton; Task 2 covers approved first-launch files and prohibited runtime-only artifacts; Task 3 covers verification.
- Placeholder scan: No placeholder steps remain; every code and command block is concrete.
- Type consistency: `RocPaths`, `createMainKernelBootstrap`, `ConfigService.initialize`, and `LogService.initialize` names match current repository code.
- Scope check: The plan does not add an installer hook, migration, compatibility path, or new abstraction. It locks the existing startup bootstrap contract with focused tests and only changes production code if verification exposes a mismatch.
