# Roc Memory Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Roc auto-memory strictly auto-write high-confidence directly evidenced user preferences to `/memory/global/USER.md` while preserving existing `MEMORY.md` behavior and DeepAgents native memory wiring.

**Architecture:** Keep `CompositeBackend`, `StoreBackend`, `memorySources`, skills, and checkpointer unchanged. Add a Roc governance layer inside the existing auto-memory pipeline: target resolution, stricter `USER.md` admission, compact `USER.md` formatting, target-aware audit, and UI visibility.

**Tech Stack:** TypeScript, Electron main process, React 19 renderer, Vitest, better-sqlite3, DeepAgents, LangGraph Store.

## Global Constraints

- Keep DeepAgents native-first; do not replace `CompositeBackend`, `StoreBackend`, `memorySources`, `skillSources`, or checkpointer wiring.
- `USER.md` auto-write only accepts `user_preference` with `confidence === 'high'` and direct user evidence.
- `AGENTS.md` remains explicit-edit only.
- Workspace `USER.md` remains invalid.
- `USER.md` entries use `<!-- key: ... -->` followed by one bullet summary; audit details do not go into `USER.md`.
- All automatic audit records include `targetPath`; early no-candidate rejection uses `targetPath: null`.
- Reuse `MemoryStoreRepository.writeFile()` for security scan and capacity checks.
- Use PowerShell commands for verification.
- Do not delete code unless current changes prove it unused.

---

## File Structure

- Modify `src/shared/types/memory.ts`: add `targetPath` to `AutoMemoryAuditRecord`.
- Modify `src/main/plugins/memory/schema.ts`: add migration for `memory_auto_audit.target_path`.
- Modify `src/main/plugins/memory/index.ts`: include `targetPath` in the memory capability output schema.
- Modify `src/main/services/memory/auto-memory-audit-repository.ts`: write/read `target_path`.
- Modify `src/main/services/memory/auto-memory-candidates.ts`: add high-confidence `user_preference` rule and `USER.md` formatting / duplicate / conflict helpers.
- Modify `src/main/services/memory/auto-memory-writer.ts`: route candidates to `USER.md` or `MEMORY.md`, record `targetPath`, and handle `USER.md` conflict/duplicate/write behavior.
- Modify `src/main/services/deep-agent/context/prompt-blocks.ts`: update automatic memory prompt text.
- Modify `src/renderer/views/memory/auto-tab.tsx`: display audit target file.
- Modify `src/renderer/settings/sections/memory-section.tsx`: update memory settings explanatory copy.
- Modify tests under `tests/main/services/memory/`, `tests/main/plugins/memory/`, `tests/main/`, and `tests/renderer/` for changed behavior.
- Create no new runtime abstraction unless implementation shows a repeated helper is needed in exactly the auto-memory boundary.

---

### Task 1: Target-Aware Auto-Memory Audit

**Files:**
- Modify: `src/shared/types/memory.ts`
- Modify: `src/main/plugins/memory/schema.ts`
- Modify: `src/main/plugins/memory/index.ts`
- Modify: `src/main/services/memory/auto-memory-audit-repository.ts`
- Modify: `src/main/services/memory/auto-memory-writer.ts`
- Test: `tests/main/plugins/memory/plugin.test.ts`
- Test: `tests/renderer/memory-view.test.tsx`
- Test: `tests/renderer/features/memory-feature.test.tsx`

**Interfaces:**
- Produces: `AutoMemoryAuditRecord.targetPath: string | null`
- Produces: `AutoMemoryAuditInsert.targetPath: string | null`
- Consumes: existing `memory_auto_audit` records without `target_path`; migration adds the column.

- [ ] **Step 1: Add failing type/test expectations for `targetPath`**

Update `tests/renderer/memory-view.test.tsx` fixture audit record:

```ts
{
  id: 'audit-1',
  createdAt: '2026-07-03T00:00:00.000Z',
  action: 'accepted',
  type: 'workspace_fact',
  scope: 'workspace',
  confidence: 'high',
  key: 'roc.memory.auto_candidate',
  summary: 'Auto memory writes use typed candidates.',
  sourceRunId: 'run_1',
  reason: 'accepted',
  workspacePath: 'F:\\Code\\Roc',
  targetPath: '/memory/workspaces/current/MEMORY.md'
}
```

`tests/renderer/features/memory-feature.test.tsx` 的 `recent: []` fixture 不需要修改，因为空数组不构造 `AutoMemoryAuditRecord`。

Add this assertion to `tests/main/plugins/memory/plugin.test.ts` in `writes accepted typed workspace candidates and records audit status`:

```ts
targetPath: '/memory/workspaces/current/MEMORY.md'
```

- [ ] **Step 2: Run focused tests to confirm current failure**

Run:

```powershell
pnpm test -- tests/main/plugins/memory/plugin.test.ts tests/renderer/memory-view.test.tsx
```

Expected: FAIL because `targetPath` is missing from shared types/repository output.

- [ ] **Step 3: Extend shared audit type**

In `src/shared/types/memory.ts`, update `AutoMemoryAuditRecord`:

```ts
export type AutoMemoryAuditRecord = {
  id: string;
  createdAt: string;
  action: AutoMemoryAuditAction;
  type: AutoMemoryCandidateType;
  scope: MemoryScope;
  confidence: AutoMemoryConfidence;
  key: string;
  summary: string;
  sourceRunId: string;
  reason: string;
  workspacePath: string | null;
  targetPath: string | null;
};
```

- [ ] **Step 4: Add SQLite column migration**

In `src/main/plugins/memory/schema.ts`, keep the existing `CREATE TABLE IF NOT EXISTS`, add `target_path TEXT` to the create statement, then add a helper after `db.exec(...)`:

```ts
  ensureMemoryAutoAuditTargetPathColumn(db);
```

Add the helper in the same file:

```ts
function ensureMemoryAutoAuditTargetPathColumn(db: DatabaseConnection): void {
  const columns = db.prepare('PRAGMA table_info(memory_auto_audit)').all() as Array<{ name: string }>;
  const hasTargetPath = columns.some((column) => column.name === 'target_path');
  if (hasTargetPath) {
    return;
  }
  db.exec('ALTER TABLE memory_auto_audit ADD COLUMN target_path TEXT');
}
```

- [ ] **Step 5: Read and write `targetPath` in audit repository**

In `src/main/services/memory/auto-memory-audit-repository.ts`, update insert/read types:

```ts
export type AutoMemoryAuditInsert = {
  action: AutoMemoryAuditAction;
  type: AutoMemoryCandidateType;
  scope: MemoryScope;
  confidence: AutoMemoryConfidence;
  key: string;
  summary: string;
  sourceRunId: string;
  reason: string;
  workspacePath: string | null;
  targetPath: string | null;
  createdAt: string;
};
```

Add `target_path` to `AuditRow`, INSERT column list, VALUES list, SELECT list, and mapper:

```ts
target_path: string | null;
```

```ts
targetPath: input.targetPath,
```

```ts
targetPath: row.target_path,
```

- [ ] **Step 6: Run focused tests**

Run:

```powershell
pnpm test -- tests/main/plugins/memory/plugin.test.ts tests/renderer/memory-view.test.tsx
```

Expected: PASS for Task 1 audit type/repository fixtures.

- [ ] **Step 7: Review Task 1 diff**

Run:

```powershell
git diff -- src/shared/types/memory.ts src/main/plugins/memory/schema.ts src/main/plugins/memory/index.ts src/main/services/memory/auto-memory-audit-repository.ts src/main/services/memory/auto-memory-writer.ts tests/main/plugins/memory/plugin.test.ts tests/renderer/memory-view.test.tsx tests/renderer/features/memory-feature.test.tsx
```

Review for:

- No unrelated schema or IPC changes.
- Existing rows migrate via `ALTER TABLE`.
- All new audit records can represent `targetPath: null`.

- [ ] **Step 8: Commit Task 1**

Run:

```powershell
git add src/shared/types/memory.ts src/main/plugins/memory/schema.ts src/main/plugins/memory/index.ts src/main/services/memory/auto-memory-audit-repository.ts src/main/services/memory/auto-memory-writer.ts tests/main/plugins/memory/plugin.test.ts tests/renderer/memory-view.test.tsx tests/renderer/features/memory-feature.test.tsx docs/superpowers/specs/2026-07-05-roc-memory-refactor-design.md docs/superpowers/plans/2026-07-05-roc-memory-refactor.md
git commit -m "feat(memory): add auto-memory target audit"
```

---

### Task 2: Strict USER.md Auto-Write Routing

**Files:**
- Modify: `src/main/services/memory/auto-memory-candidates.ts`
- Modify: `src/main/services/memory/auto-memory-writer.ts`
- Test: `tests/main/services/memory/auto-memory-writer.test.ts`
- Test: `tests/main/plugins/memory/plugin.test.ts`

**Interfaces:**
- Produces: `formatUserPreferenceEntry(candidate: AutoMemoryCandidate): string`
- Produces: `appendUserPreferenceEntry(existing: string, entry: string): string`
- Produces: `userPreferenceEntryStatus(existing: string, candidate: AutoMemoryCandidate): 'duplicate' | 'conflict' | null`
- Consumes: `MemoryStoreRepository.readFile({ scope, kind }, workspaceOverride)` and `writeFile({ scope, kind, content }, workspaceOverride)`.

- [ ] **Step 1: Add failing writer tests for USER.md**

In `tests/main/services/memory/auto-memory-writer.test.ts`, change the existing test named `writes directly evidenced user preferences to global memory` so it expects global `user`, not global `memory`:

```ts
const content = await repository.readFile({ scope: 'global', kind: 'user' });
expect(content).toContain('<!-- key: user.cli.shell -->');
expect(content).toContain('- User prefers PowerShell.');
await expect(repository.readFile({ scope: 'global', kind: 'memory' })).resolves.toBeNull();
```

Add a new test:

```ts
it('rejects non-high-confidence user preferences from USER.md', async () => {
  const repository = createRepository({ workspace: null });
  const writer = createWriter(repository);

  await writer.handleAgentRunCompleted(
    createPayload({
      summary: 'user_preference: user.cli.shell | medium | user stated: prefer PowerShell | User prefers PowerShell.'
    }),
    '2026-07-03T00:00:00.000Z'
  );

  await expect(repository.readFile({ scope: 'global', kind: 'user' })).resolves.toBeNull();
  await expect(repository.readFile({ scope: 'global', kind: 'memory' })).resolves.toBeNull();
});
```

Add duplicate and conflict tests:

```ts
it('skips duplicate USER.md preferences by key and summary', async () => {
  const repository = createRepository({ workspace: null });
  const writer = createWriter(repository);
  const payload = createPayload({
    summary: 'user_preference: user.cli.shell | high | user stated: prefer PowerShell | User prefers PowerShell.'
  });

  await writer.handleAgentRunCompleted(payload, '2026-07-03T00:00:00.000Z');
  await writer.handleAgentRunCompleted({ ...payload, runId: 'run_2' }, '2026-07-03T00:00:00.000Z');

  const content = await repository.readFile({ scope: 'global', kind: 'user' });
  expect(content?.match(/<!-- key: user\.cli\.shell -->/gu)).toHaveLength(1);
});

it('rejects conflicting USER.md preferences with the same key', async () => {
  const repository = createRepository({ workspace: null });
  const writer = createWriter(repository);

  await writer.handleAgentRunCompleted(
    createPayload({
      summary: 'user_preference: user.cli.shell | high | user stated: prefer PowerShell | User prefers PowerShell.'
    }),
    '2026-07-03T00:00:00.000Z'
  );
  await writer.handleAgentRunCompleted(
    createPayload({
      summary: 'user_preference: user.cli.shell | high | user stated: prefer Bash | User prefers Bash.'
    }),
    '2026-07-03T00:00:00.000Z'
  );

  const content = await repository.readFile({ scope: 'global', kind: 'user' });
  expect(content).toContain('- User prefers PowerShell.');
  expect(content).not.toContain('- User prefers Bash.');
});
```

Add a section-boundary test:

```ts
it('keeps automatic USER.md preferences inside the Preferences section', async () => {
  const repository = createRepository({ workspace: null });
  const writer = createWriter(repository);
  await repository.writeFile({
    scope: 'global',
    kind: 'user',
    content: [
      '## Preferences',
      '',
      '<!-- key: user.editor -->',
      '- User prefers concise diffs.',
      '',
      '## Other',
      '',
      '- Keep this section separate.'
    ].join('\n')
  });

  await writer.handleAgentRunCompleted(
    createPayload({
      summary: 'user_preference: user.cli.shell | high | user stated: prefer PowerShell | User prefers PowerShell.'
    }),
    '2026-07-03T00:00:00.000Z'
  );

  const content = await repository.readFile({ scope: 'global', kind: 'user' });
  expect(content).toContain(
    [
      '<!-- key: user.cli.shell -->',
      '- User prefers PowerShell.',
      '',
      '## Other'
    ].join('\n')
  );
});
```

- [ ] **Step 2: Add failing plugin integration test for USER.md**

In `tests/main/plugins/memory/plugin.test.ts`, add:

```ts
it('writes strict directly evidenced user preferences to global USER.md', async () => {
  const { capabilities, eventBus } = await initializePluginWithBus({ workspace: null });

  await eventBus.publish({
    type: 'agent.run.completed',
    source: '@roc/plugin-agent',
    payload: {
      runId: 'run_1',
      threadId: 'thread_1',
      summary: 'user_preference: user.cli.shell | high | user stated: prefer PowerShell | User prefers PowerShell.',
      assistantMessage: 'done'
    },
    createdAt: '2026-07-05T10:00:00.000Z'
  });

  await expect(capabilities.invoke('memory.file.read', { scope: 'global', kind: 'user' })).resolves.toContain(
    '<!-- key: user.cli.shell -->'
  );
  await expect(capabilities.invoke('memory.file.read', { scope: 'global', kind: 'memory' })).resolves.toBeNull();
  await expect(capabilities.invoke<{}, MemoryStatus>('memory.status.get', {})).resolves.toMatchObject({
    autoMemory: {
      recent: [
        expect.objectContaining({
          action: 'accepted',
          type: 'user_preference',
          targetPath: '/memory/global/USER.md'
        })
      ]
    }
  });
});
```

- [ ] **Step 3: Run tests to verify failures**

Run:

```powershell
pnpm test -- tests/main/services/memory/auto-memory-writer.test.ts tests/main/plugins/memory/plugin.test.ts
```

Expected: FAIL because user preferences still write to `MEMORY.md`, high-confidence rejection does not exist, and `USER.md` helpers are missing.

- [ ] **Step 4: Add `USER.md` helper functions**

In `src/main/services/memory/auto-memory-candidates.ts`, extend `shouldRejectCandidate`:

```ts
  if (candidate.type === 'user_preference' && candidate.confidence !== 'high') {
    return 'user_preference_high_confidence_required';
  }
  if (candidate.type === 'user_preference' && !isSafeUserPreferenceKey(candidate.key)) {
    return 'user_preference_key_unsafe';
  }
```

Add helpers:

```ts
export function formatUserPreferenceEntry(candidate: AutoMemoryCandidate): string {
  return [`<!-- key: ${candidate.key} -->`, `- ${candidate.summary}`].join('\n');
}

export function appendUserPreferenceEntry(existing: string, entry: string): string {
  const trimmed = existing.trimEnd();
  const heading = '## Preferences';
  if (trimmed.length === 0) {
    return [heading, '', entry].join('\n');
  }
  const lines = trimmed.split('\n');
  const headingIndex = lines.findIndex((line) => line.trim() === heading);
  if (headingIndex === -1) {
    return [trimmed, '', heading, '', entry].join('\n');
  }
  return [trimmed, '', entry].join('\n');
}

export function userPreferenceEntryStatus(
  existing: string,
  candidate: AutoMemoryCandidate
): 'duplicate' | 'conflict' | null {
  const entries = parseUserPreferenceEntries(existing);
  const existingEntry = entries.find((entry) => entry.key === candidate.key);
  if (existingEntry === undefined) {
    return null;
  }
  if (normalizeMemoryText(existingEntry.summary) === normalizeMemoryText(candidate.summary)) {
    return 'duplicate';
  }
  return 'conflict';
}

function parseUserPreferenceEntries(existing: string): Array<{ key: string; summary: string }> {
  const entries: Array<{ key: string; summary: string }> = [];
  const lines = existing.split('\n');
  let pendingKey: string | null = null;
  for (const line of lines) {
    const keyMatch = /^<!--\s*key:\s*([a-z0-9._:-]+)\s*-->\s*$/u.exec(line.trim());
    if (keyMatch !== null) {
      pendingKey = keyMatch[1];
      continue;
    }
    if (pendingKey !== null && line.trim().startsWith('- ')) {
      entries.push({ key: pendingKey, summary: line.trim().slice(2).trim() });
      pendingKey = null;
    }
  }
  return entries;
}

function isSafeUserPreferenceKey(key: string): boolean {
  return /^[a-z0-9._:-]+$/u.test(key);
}
```

- [ ] **Step 5: Route candidates in `AutoMemoryWriter`**

In `src/main/services/memory/auto-memory-writer.ts`, import the new helpers:

```ts
  appendUserPreferenceEntry,
  formatUserPreferenceEntry,
  userPreferenceEntryStatus,
```

Add target constants:

```ts
const GLOBAL_USER_TARGET_PATH = '/memory/global/USER.md';
const GLOBAL_MEMORY_TARGET_PATH = '/memory/global/MEMORY.md';
const WORKSPACE_MEMORY_TARGET_PATH = '/memory/workspaces/current/MEMORY.md';
```

Add local type:

```ts
type AutoMemoryTarget = {
  scope: MemoryScope;
  kind: 'user' | 'memory';
  targetPath: string;
};
```

Resolve target before rejection:

```ts
      const target = resolveCandidateTarget(candidate, workspaceOverride, this.options.repository);
      const rejection = shouldRejectCandidate(candidate);
      if (rejection !== null) {
        this.recordCandidateAudit(candidate, 'rejected', rejection, target.targetPath);
        continue;
      }
```

For `target.kind === 'user'`, use a dedicated branch:

```ts
        if (target.kind === 'user') {
          await this.writeUserPreference(candidate, target, workspaceOverride);
          continue;
        }
```

Add method:

```ts
  private async writeUserPreference(
    candidate: AutoMemoryCandidate,
    target: AutoMemoryTarget,
    workspaceOverride: MemoryWorkspaceContext | null | undefined
  ): Promise<void> {
    const current = await this.options.repository.readFile({ scope: target.scope, kind: target.kind }, workspaceOverride);
    const existing = current === null ? '' : current;
    const status = userPreferenceEntryStatus(existing, candidate);
    if (status === 'duplicate') {
      this.recordCandidateAudit(candidate, 'duplicate_skipped', 'duplicate', target.targetPath);
      return;
    }
    if (status === 'conflict') {
      this.recordCandidateAudit(candidate, 'conflict_rejected', 'conflict', target.targetPath);
      return;
    }
    const entry = formatUserPreferenceEntry(candidate);
    const next = appendUserPreferenceEntry(existing, entry);
    const result = await this.options.repository.writeFile({
      scope: target.scope,
      kind: target.kind,
      content: next
    }, workspaceOverride);
    if (!result.ok) {
      this.recordCandidateAudit(candidate, 'write_failed', result.reason, target.targetPath);
      this.options.logger.warn('memory_auto_write_skipped', { reason: result.reason });
      return;
    }
    this.recordCandidateAudit(candidate, 'accepted', 'accepted', target.targetPath);
  }
```

Update `recordCandidateAudit` and `recordAudit` calls to pass `targetPath`.

Add target resolver:

```ts
function resolveCandidateTarget(
  candidate: AutoMemoryCandidate,
  workspaceOverride: MemoryWorkspaceContext | null | undefined,
  repository: MemoryStoreRepository
): AutoMemoryTarget {
  if (candidate.type === 'user_preference') {
    return { scope: 'global', kind: 'user', targetPath: GLOBAL_USER_TARGET_PATH };
  }
  const targetScope = resolveTargetScope(candidate.scope, workspaceOverride, repository);
  if (targetScope === 'workspace') {
    return { scope: 'workspace', kind: 'memory', targetPath: WORKSPACE_MEMORY_TARGET_PATH };
  }
  return { scope: 'global', kind: 'memory', targetPath: GLOBAL_MEMORY_TARGET_PATH };
}
```

For `no_candidates`, pass `targetPath: null`.

- [ ] **Step 6: Run focused tests**

Run:

```powershell
pnpm test -- tests/main/services/memory/auto-memory-writer.test.ts tests/main/plugins/memory/plugin.test.ts
```

Expected: PASS.

- [ ] **Step 7: Review Task 2 diff**

Run:

```powershell
git diff -- src/main/services/memory/auto-memory-candidates.ts src/main/services/memory/auto-memory-writer.ts tests/main/services/memory/auto-memory-writer.test.ts tests/main/plugins/memory/plugin.test.ts
```

Review for:

- `USER.md` does not receive medium/low/model-inferred preferences.
- Conflicts do not overwrite existing user preferences.
- Existing `MEMORY.md` structured entries and capacity retry still work.
- No broad business-logic catch added beyond existing auto-writer boundary.

- [ ] **Step 8: Commit Task 2**

Run:

```powershell
git add src/main/services/memory/auto-memory-candidates.ts src/main/services/memory/auto-memory-writer.ts tests/main/services/memory/auto-memory-writer.test.ts tests/main/plugins/memory/plugin.test.ts
git commit -m "feat(memory): route strict user preferences to USER.md"
```

---

### Task 3: Prompt, Renderer, and Settings Visibility

**Files:**
- Modify: `src/main/services/deep-agent/context/prompt-blocks.ts`
- Modify: `tests/main/deep-agent-prompt.test.ts`
- Modify: `src/renderer/views/memory/auto-tab.tsx`
- Modify: `tests/renderer/memory-view.test.tsx`
- Modify: `src/renderer/settings/sections/memory-section.tsx`
- Test: renderer memory tests and prompt tests.

**Interfaces:**
- Consumes: `AutoMemoryAuditRecord.targetPath`.
- Produces: UI visible target path text in auto-memory records.

- [ ] **Step 1: Add failing prompt and UI expectations**

In `tests/main/deep-agent-prompt.test.ts`, replace expectations for:

```ts
'Automatic writes only append to MEMORY.md; USER.md and AGENTS.md change only through explicit file edits.'
```

with expectations for:

```ts
'Automatic writes may update USER.md only for high-confidence direct user preferences; other accepted facts append to MEMORY.md.'
'AGENTS.md changes only through explicit file edits.'
```

In `tests/renderer/memory-view.test.tsx`, add:

```ts
expect(container.querySelector('[data-testid="memory-auto-records"]')?.textContent).toContain('/memory/workspaces/current/MEMORY.md');
```

- [ ] **Step 2: Run tests to verify failures**

Run:

```powershell
pnpm test -- tests/main/deep-agent-prompt.test.ts tests/renderer/memory-view.test.tsx
```

Expected: FAIL because prompt text and UI target rendering are not updated.

- [ ] **Step 3: Update prompt text**

In `src/main/services/deep-agent/context/prompt-blocks.ts`, replace the old automatic-write line with:

```ts
    'Automatic writes may update USER.md only for high-confidence direct user preferences; other accepted facts append to MEMORY.md.',
    'AGENTS.md changes only through explicit file edits.',
```

- [ ] **Step 4: Render target path in auto tab**

In `src/renderer/views/memory/auto-tab.tsx`, add `record.targetPath` to the metadata row:

```tsx
              {record.targetPath !== null ? <span>{record.targetPath}</span> : <span>not written</span>}
```

Keep the existing action/type/scope/confidence fields.

- [ ] **Step 5: Update settings copy**

In `src/renderer/settings/sections/memory-section.tsx`, replace:

```tsx
这里只管理 DeepAgents native memory 的容量、安全扫描和会话回忆保留期；具体文件在记忆中心编辑。
```

with:

```tsx
这里只管理 DeepAgents native memory 的容量、安全扫描、自动记忆和会话回忆保留期；USER.md 仅接受高置信直接用户偏好自动写入，具体文件在记忆中心编辑。
```

- [ ] **Step 6: Run focused tests**

Run:

```powershell
pnpm test -- tests/main/deep-agent-prompt.test.ts tests/renderer/memory-view.test.tsx tests/renderer/features/memory-feature.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Review Task 3 diff**

Run:

```powershell
git diff -- src/main/services/deep-agent/context/prompt-blocks.ts tests/main/deep-agent-prompt.test.ts src/renderer/views/memory/auto-tab.tsx tests/renderer/memory-view.test.tsx src/renderer/settings/sections/memory-section.tsx tests/renderer/features/memory-feature.test.tsx
```

Review for:

- Prompt no longer claims automatic writes only append to `MEMORY.md`.
- UI displays target file without adding a new workflow.
- Settings copy does not imply an approval queue exists.

- [ ] **Step 8: Commit Task 3**

Run:

```powershell
git add src/main/services/deep-agent/context/prompt-blocks.ts tests/main/deep-agent-prompt.test.ts src/renderer/views/memory/auto-tab.tsx tests/renderer/memory-view.test.tsx src/renderer/settings/sections/memory-section.tsx tests/renderer/features/memory-feature.test.tsx
git commit -m "feat(memory): show auto-memory targets"
```

---

### Task 4: Cleanup, Full Verification, and Final Review

**Files:**
- Inspect: all modified files.
- Inspect: `docs/superpowers/specs/2026-07-05-roc-memory-refactor-design.md`
- Inspect: `docs/superpowers/plans/2026-07-05-roc-memory-refactor.md`

**Interfaces:**
- Consumes all previous task outputs.
- Produces final verified branch state.

- [ ] **Step 1: Search for stale old contract text**

Run:

```powershell
rg -n "Automatic writes only append to MEMORY.md|USER.md and AGENTS.md change only through explicit file edits|target_path|targetPath|user_preference_high_confidence_required|user_preference_key_unsafe" src tests docs
```

Expected:

- No old prompt sentence remains.
- New `targetPath` / `target_path` references exist only in shared types, schema, repository, tests, and UI.
- New rejection reasons appear only in candidate admission/tests/audit expectations.

- [ ] **Step 2: Run focused memory and prompt suites**

Run:

```powershell
pnpm test -- tests/main/services/memory/auto-memory-writer.test.ts tests/main/plugins/memory/plugin.test.ts tests/main/deep-agent-prompt.test.ts tests/renderer/memory-view.test.tsx tests/renderer/features/memory-feature.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```powershell
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Run IPC drift check if shared IPC generated files changed**

Run:

```powershell
git diff --name-only | Select-String -Pattern 'src/shared/ipc'
```

If output is empty, record `pnpm check:ipc` as not required for this change. If output contains IPC schema/generated files, run:

```powershell
pnpm check:ipc
```

Expected: PASS when run.

- [ ] **Step 5: Run whitespace check**

Run:

```powershell
git diff --check
```

Expected: PASS with no output.

- [ ] **Step 6: Final risk review**

Review:

- `USER.md` strict direct-write behavior cannot write to workspace scope.
- `AGENTS.md` remains explicit-only.
- Existing `MEMORY.md` candidates still write with structured entries.
- Existing auto-memory audit retention and status still work.
- No stale tests assert old `MEMORY.md`-only behavior.
- `.planning/` remains uncommitted unless intentionally included by the user.

- [ ] **Step 7: Commit final cleanup when Task 4 changed tracked files**

Run:

```powershell
git status --short
```

If the only remaining output is `.planning/`, do not create a cleanup commit. If Task 4 changed tracked files, run this exact add list and commit:

```powershell
git add src/shared/types/memory.ts src/main/plugins/memory/schema.ts src/main/plugins/memory/index.ts src/main/services/memory/auto-memory-audit-repository.ts src/main/services/memory/auto-memory-candidates.ts src/main/services/memory/auto-memory-writer.ts src/main/services/deep-agent/context/prompt-blocks.ts src/renderer/views/memory/auto-tab.tsx src/renderer/settings/sections/memory-section.tsx tests/main/services/memory/auto-memory-writer.test.ts tests/main/plugins/memory/plugin.test.ts tests/main/deep-agent-prompt.test.ts tests/renderer/memory-view.test.tsx tests/renderer/features/memory-feature.test.tsx docs/superpowers/specs/2026-07-05-roc-memory-refactor-design.md docs/superpowers/plans/2026-07-05-roc-memory-refactor.md
git commit -m "chore(memory): clean up auto-memory refactor"
```

If Task 4 produced no edits, do not create an empty commit.
