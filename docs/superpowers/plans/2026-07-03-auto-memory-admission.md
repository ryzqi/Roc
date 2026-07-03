# Auto Memory Admission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace direct completed-run summary appends with an automatic typed memory candidate pipeline that filters noise, writes useful durable memories, and exposes recent automatic write audit records.

**Architecture:** Keep the existing DeepAgents `/memory` route and Store-backed Markdown files. Add deterministic candidate extraction, type policies, duplicate checks, capacity maintenance retry, and a plugin-local audit table surfaced through `MemoryStatus`. Avoid a new IPC channel by extending the existing `memory.status` result.

**Tech Stack:** TypeScript ESM, Electron main/preload IPC, React 19 renderer, Vitest, better-sqlite3, Zod.

## Global Constraints

- Windows 11 and PowerShell are the default environment.
- User-facing replies use Simplified Chinese; code identifiers and protocol fields stay in English.
- Preserve main/preload/renderer/shared boundaries.
- Do not replace DeepAgents built-in filesystem, Store backend, or `/memory` route semantics.
- Do not auto-edit `USER.md` or `AGENTS.md` from model-inferred memory.
- Keep automatic writes enabled by default.
- No manual approval queue.
- No new vector database or graph memory store.
- Automatic memory failure must not fail the completed agent run.
- Use deterministic rules only; no LLM utility scorer in this implementation.

---

## File Structure

- Modify `src/shared/types/settings.ts`
  - Add `AutoMemorySettings`.
  - Add `memory.autoMemory`.
- Modify `src/main/services/config/defaults.ts`
  - Add default auto memory settings.
- Modify `src/main/services/config/schema.ts`
  - Validate `memory.autoMemory`.
- Modify `src/main/services/config/migration.ts`
  - Backfill `autoMemory` for legacy/current settings documents.
- Modify `tests/main/config-memory-defaults.test.ts`
  - Lock defaults and removed legacy fields.
- Modify `src/shared/types/memory.ts`
  - Add candidate/audit shared types and `MemoryStatus.autoMemory`.
- Modify `src/main/plugins/memory/schema.ts`
  - Add `memory_auto_audit` table.
- Create `src/main/services/memory/auto-memory-candidates.ts`
  - Candidate extraction, rule policy, Markdown formatting, duplicate detection, and maintenance helpers.
- Create `src/main/services/memory/auto-memory-audit-repository.ts`
  - Insert/list/prune automatic memory audit records.
- Modify `src/main/services/memory/auto-memory-writer.ts`
  - Replace direct append path with candidate pipeline.
- Modify `src/main/plugins/memory/memory-store-repository.ts`
  - Include audit summary in `MemoryStatus`.
- Modify `src/main/plugins/memory/index.ts`
  - Wire audit repository, settings, and safe event subscriber.
- Add `tests/main/services/memory/auto-memory-writer.test.ts`
  - Direct unit coverage for admission behavior.
- Modify `tests/main/plugins/memory/plugin.test.ts`
  - Integration coverage for event safety, workspace routing, and audit records.
- Modify `src/renderer/views/memory/MemoryView.tsx`
  - Add an `auto` tab.
- Create `src/renderer/views/memory/auto-tab.tsx`
  - Render recent automatic write audit records.
- Modify `src/renderer/styles/memory.css`
  - Add compact audit list styles.
- Modify `tests/renderer/memory-view.test.tsx`
  - Cover audit tab rendering.

---

## Task 1: Settings And Shared Types

**Files:**
- Modify: `src/shared/types/settings.ts`
- Modify: `src/shared/types/memory.ts`
- Modify: `src/main/services/config/defaults.ts`
- Modify: `src/main/services/config/schema.ts`
- Modify: `src/main/services/config/migration.ts`
- Modify: `tests/main/config-memory-defaults.test.ts`
- Modify: `tests/main/config-service-helpers.test.ts`
- Modify: `tests/main/config-service-settings.test.ts`

**Interfaces:**
- Produces: `AutoMemorySettings`
- Produces: `AutoMemoryAuditRecord`
- Produces: `MemoryStatus['autoMemory']`

- [ ] **Step 1: Write failing default-settings test**

In `tests/main/config-memory-defaults.test.ts`, update the expected memory object:

```ts
expect(defaultSettings.memory).toEqual({
  charLimits: { user: 1375, agents: 800, memory: 2200 },
  sessionRetentionDays: 90,
  securityScan: {
    promptInjection: true,
    credential: true,
    sshBackdoor: true,
    invisibleUnicode: true
  },
  autoMemory: {
    enabled: true,
    lowConfidenceTtlDays: 30,
    auditRetentionDays: 30,
    maxCandidatesPerRun: 8
  }
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```powershell
pnpm test -- tests/main/config-memory-defaults.test.ts
```

Expected: fail because `defaultSettings.memory.autoMemory` does not exist.

- [ ] **Step 3: Add shared settings type**

In `src/shared/types/settings.ts`, add:

```ts
export type AutoMemorySettings = {
  enabled: boolean;
  lowConfidenceTtlDays: number;
  auditRetentionDays: number;
  maxCandidatesPerRun: number;
};
```

Then add this field under `AppSettings['memory']`:

```ts
autoMemory: AutoMemorySettings;
```

- [ ] **Step 4: Add shared memory audit types**

In `src/shared/types/memory.ts`, add:

```ts
export type AutoMemoryCandidateType =
  | 'user_preference'
  | 'workspace_fact'
  | 'decision'
  | 'pitfall'
  | 'verification'
  | 'transient_task_result';

export type AutoMemoryConfidence = 'high' | 'medium' | 'low';

export type AutoMemoryAuditAction =
  | 'accepted'
  | 'rejected'
  | 'duplicate_skipped'
  | 'conflict_rejected'
  | 'maintenance_merged'
  | 'maintenance_deleted'
  | 'write_failed';

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
};
```

Then extend `MemoryStatus`:

```ts
autoMemory: {
  enabled: boolean;
  auditRetentionDays: number;
  recent: AutoMemoryAuditRecord[];
};
```

- [ ] **Step 5: Add defaults and schema**

In `src/main/services/config/defaults.ts`, add:

```ts
autoMemory: {
  enabled: true,
  lowConfidenceTtlDays: 30,
  auditRetentionDays: 30,
  maxCandidatesPerRun: 8
}
```

In `src/main/services/config/schema.ts`, add under `memory`:

```ts
autoMemory: z.object({
  enabled: z.boolean(),
  lowConfidenceTtlDays: z.number().int().positive(),
  auditRetentionDays: z.number().int().positive(),
  maxCandidatesPerRun: z.number().int().positive()
})
```

- [ ] **Step 6: Add migration backfill**

In `src/main/services/config/migration.ts`, read `value.autoMemory` and return:

```ts
autoMemory: {
  enabled: readBoolean(autoMemory.enabled, defaultSettings.memory.autoMemory.enabled),
  lowConfidenceTtlDays: readPositiveInteger(
    autoMemory.lowConfidenceTtlDays,
    defaultSettings.memory.autoMemory.lowConfidenceTtlDays
  ),
  auditRetentionDays: readPositiveInteger(
    autoMemory.auditRetentionDays,
    defaultSettings.memory.autoMemory.auditRetentionDays
  ),
  maxCandidatesPerRun: readPositiveInteger(
    autoMemory.maxCandidatesPerRun,
    defaultSettings.memory.autoMemory.maxCandidatesPerRun
  )
}
```

- [ ] **Step 7: Update config migration tests**

In settings tests that assert exact memory objects, add `autoMemory` with the default object unless the test explicitly supplies custom values.

- [ ] **Step 8: Run targeted settings tests**

Run:

```powershell
pnpm test -- tests/main/config-memory-defaults.test.ts tests/main/config-service-helpers.test.ts tests/main/config-service-settings.test.ts
```

Expected: pass.

---

## Task 2: Candidate Pipeline

**Files:**
- Create: `src/main/services/memory/auto-memory-candidates.ts`
- Modify: `src/main/services/memory/auto-memory-writer.ts`
- Add: `tests/main/services/memory/auto-memory-writer.test.ts`
- Modify: `tests/main/services/deep-agent/context/memory-promotion.test.ts`

**Interfaces:**
- Consumes: `AutoMemorySettings`, `AutoMemoryCandidateType`, `AutoMemoryConfidence`
- Produces: `extractAutoMemoryCandidates(payload, settings, createdAt)`
- Produces: `formatAutoMemoryEntry(candidate)`
- Produces: `appendAutoMemoryEntry(existing, date, entry)`

- [ ] **Step 1: Write failing candidate tests**

Create `tests/main/services/memory/auto-memory-writer.test.ts` with tests for:

```ts
it('rejects generic completed run summaries', async () => {});
it('writes typed workspace facts only when evidence is present', async () => {});
it('writes low-confidence pitfalls with a ttl', async () => {});
it('rejects transient task results', async () => {});
it('skips duplicate candidate keys', async () => {});
it('does not throw when repository writes fail', async () => {});
```

Use fake repository and logger objects instead of the full plugin.

- [ ] **Step 2: Run new test to verify failure**

Run:

```powershell
pnpm test -- tests/main/services/memory/auto-memory-writer.test.ts
```

Expected: fail because new module/functions do not exist.

- [ ] **Step 3: Implement candidate extraction**

Create `src/main/services/memory/auto-memory-candidates.ts` with:

```ts
export type AutoMemoryCandidate = {
  type: AutoMemoryCandidateType;
  scope: MemoryScope;
  confidence: AutoMemoryConfidence;
  key: string;
  summary: string;
  evidence: string[];
  sourceRunId: string;
  sourceThreadId: string | null;
  workspacePath: string | null;
  createdAt: string;
  ttlDays: number | null;
  revalidate: string | null;
};
```

Implement deterministic extraction from summary lines using prefixes:

```text
workspace_fact: key | confidence | evidence | summary
decision: key | confidence | evidence | summary
pitfall: key | confidence | evidence | summary
verification: key | confidence | evidence | summary
transient_task_result: key | confidence | evidence | summary
```

Reject unprefixed generic summaries in this first implementation. This is intentional because `agent.run.completed` does not currently include raw user messages.

- [ ] **Step 4: Implement policy helpers**

Implement:

```ts
export function shouldRejectCandidate(candidate: AutoMemoryCandidate): string | null
export function formatAutoMemoryEntry(candidate: AutoMemoryCandidate): string
export function autoMemoryEntryExists(existing: string, candidate: AutoMemoryCandidate): boolean
export function appendAutoMemoryEntry(existing: string, date: string, entry: string): string
```

Rules:

- `workspace_fact` requires evidence.
- `pitfall` accepts low confidence only when `ttlDays` or `revalidate` exists.
- `transient_task_result` is rejected.
- duplicate `key` plus normalized `summary` is skipped.

- [ ] **Step 5: Replace direct append in writer**

Modify `AutoMemoryWriter.handleAgentRunCompleted()`:

- Return early when `settings.autoMemory.enabled` is false.
- Extract candidates with `maxCandidatesPerRun`.
- Resolve scope per candidate.
- Read target `MEMORY.md`.
- Skip duplicate entries.
- Write structured Markdown.
- Catch write failures and log/audit instead of throwing.

- [ ] **Step 6: Preserve existing security and capacity behavior**

Keep writes through `MemoryStoreRepository.writeFile()` so security scan and capacity checks remain authoritative.

On `capacity_exceeded`, call a local maintenance helper once, then retry once. The first implementation may only remove exact duplicate same-key entries; it must not delete unrelated memory.

- [ ] **Step 7: Run candidate tests**

Run:

```powershell
pnpm test -- tests/main/services/memory/auto-memory-writer.test.ts tests/main/services/deep-agent/context/memory-promotion.test.ts
```

Expected: pass.

---

## Task 3: Audit Repository And Plugin Integration

**Files:**
- Modify: `src/main/plugins/memory/schema.ts`
- Create: `src/main/services/memory/auto-memory-audit-repository.ts`
- Modify: `src/main/plugins/memory/memory-store-repository.ts`
- Modify: `src/main/plugins/memory/index.ts`
- Modify: `tests/main/plugins/memory/plugin.test.ts`

**Interfaces:**
- Produces: `AutoMemoryAuditRepository.record(record)`
- Produces: `AutoMemoryAuditRepository.listRecent(limit)`
- Produces: `AutoMemoryAuditRepository.prune(retentionDays, now)`

- [ ] **Step 1: Write failing plugin tests**

Update plugin tests to assert:

```ts
expect(status.autoMemory.enabled).toBe(true);
expect(status.autoMemory.recent[0]).toMatchObject({
  action: 'accepted',
  type: 'workspace_fact',
  sourceRunId: 'run_1'
});
```

Add an event with a generic summary and assert:

```ts
expect(status.autoMemory.recent[0]).toMatchObject({
  action: 'rejected',
  reason: expect.stringContaining('generic')
});
```

Add a repository failure case proving `eventBus.publish()` resolves.

- [ ] **Step 2: Run plugin tests to verify failure**

Run:

```powershell
pnpm test -- tests/main/plugins/memory/plugin.test.ts
```

Expected: fail because audit table and `MemoryStatus.autoMemory` do not exist.

- [ ] **Step 3: Add audit schema**

In `src/main/plugins/memory/schema.ts`, add:

```sql
CREATE TABLE IF NOT EXISTS memory_auto_audit (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  scope TEXT NOT NULL,
  confidence TEXT NOT NULL,
  memory_key TEXT NOT NULL,
  summary TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  workspace_path TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_auto_audit_created
ON memory_auto_audit(created_at DESC);
```

- [ ] **Step 4: Implement audit repository**

Create `src/main/services/memory/auto-memory-audit-repository.ts`.

Use `crypto.randomUUID()` for ids when the caller does not provide one. Store `workspacePath` as nullable text.

- [ ] **Step 5: Wire audit into status**

Modify `MemoryStoreRepository` constructor to accept:

```ts
auditRepository?: AutoMemoryAuditRepository;
```

Set `MemoryStatus.autoMemory` from settings and `auditRepository.listRecent(20)`.

- [ ] **Step 6: Wire plugin subscriber safely**

In `src/main/plugins/memory/index.ts`, instantiate audit repository from plugin DB and pass it to `AutoMemoryWriter`.

Wrap the `agent.run.completed` subscription body:

```ts
try {
  await autoMemoryWriter.handleAgentRunCompleted(event.payload, event.createdAt);
} catch (error) {
  context.logger.warn('memory_auto_write_failed', {
    error: error instanceof Error ? error.message : String(error)
  });
}
```

Invalid payload remains an error because that is a contract violation, not a memory write failure.

- [ ] **Step 7: Run plugin tests**

Run:

```powershell
pnpm test -- tests/main/plugins/memory/plugin.test.ts
```

Expected: pass.

---

## Task 4: Memory Center Audit UI

**Files:**
- Modify: `src/renderer/views/memory/MemoryView.tsx`
- Create: `src/renderer/views/memory/auto-tab.tsx`
- Modify: `src/renderer/styles/memory.css`
- Modify: `tests/renderer/memory-view.test.tsx`

**Interfaces:**
- Consumes: `MemoryStatus.autoMemory.recent`
- Produces: `data-testid="memory-tab-auto"`
- Produces: `data-testid="memory-auto-records"`

- [ ] **Step 1: Write failing renderer test**

In `tests/renderer/memory-view.test.tsx`, add an audit record to `createMemoryStatus()` and test:

```ts
queryButton('memory-tab-auto').dispatchEvent(new MouseEvent('click', { bubbles: true }));
expect(container.querySelector('[data-testid="memory-auto-records"]')?.textContent).toContain('workspace_fact');
expect(container.querySelector('[data-testid="memory-auto-records"]')?.textContent).toContain('accepted');
```

- [ ] **Step 2: Run renderer test to verify failure**

Run:

```powershell
pnpm test -- tests/renderer/memory-view.test.tsx
```

Expected: fail because the tab does not exist.

- [ ] **Step 3: Add AutoTab component**

Create `src/renderer/views/memory/auto-tab.tsx`.

Render a compact list. Empty state test id: `memory-auto-empty`. Records container test id: `memory-auto-records`.

- [ ] **Step 4: Add MemoryView tab**

Change:

```ts
type MemoryTab = 'files' | 'sessions' | 'snapshot';
```

to:

```ts
type MemoryTab = 'files' | 'sessions' | 'snapshot' | 'auto';
```

Add a tab button labeled `自动写入` and render `<AutoTab status={state.memoryStatus} />`.

- [ ] **Step 5: Add CSS**

Add `.memory-auto-shell`, `.memory-auto-records`, `.memory-auto-record`, `.memory-auto-meta`, and `.memory-auto-summary` styles in `src/renderer/styles/memory.css`.

- [ ] **Step 6: Run renderer test**

Run:

```powershell
pnpm test -- tests/renderer/memory-view.test.tsx
```

Expected: pass.

---

## Task 5: Integration Verification And Cleanup

**Files:**
- Modify tests only if direct failures reveal outdated exact expectations.
- Do not edit generated IPC unless `pnpm check:ipc` reports drift.

**Interfaces:**
- Consumes all previous tasks.
- Produces verified automatic memory admission behavior.

- [ ] **Step 1: Run focused memory test set**

Run:

```powershell
pnpm test -- tests/main/services/memory/auto-memory-writer.test.ts tests/main/plugins/memory/plugin.test.ts tests/renderer/memory-view.test.tsx tests/main/config-memory-defaults.test.ts tests/main/config-service-helpers.test.ts tests/main/config-service-settings.test.ts
```

Expected: pass.

- [ ] **Step 2: Run typecheck**

Run:

```powershell
pnpm typecheck
```

Expected: pass.

- [ ] **Step 3: Run IPC drift check**

Run:

```powershell
pnpm check:ipc
```

Expected: pass. If it fails because shared IPC schemas need regeneration, run `pnpm generate:ipc`, inspect generated diffs, then rerun `pnpm check:ipc`.

- [ ] **Step 4: Run whitespace check**

Run:

```powershell
git diff --check
```

Expected: no output.

- [ ] **Step 5: Review current diff**

Inspect:

```powershell
git diff --stat
git diff -- src/main/services/memory src/main/plugins/memory src/shared/types src/renderer/views/memory tests/main tests/renderer docs/superpowers/plans
```

Look for unrelated refactors, broad formatting churn, and legacy direct summary append code.

- [ ] **Step 6: Cleanup current-change dead code**

Remove only imports, helpers, tests, or compatibility code made unused by this change. Do not delete unrelated memory code.

- [ ] **Step 7: Rerun focused verification after cleanup**

Run:

```powershell
pnpm test -- tests/main/services/memory/auto-memory-writer.test.ts tests/main/plugins/memory/plugin.test.ts tests/renderer/memory-view.test.tsx
pnpm typecheck
git diff --check
```

Expected: pass.

---

## Self-Review

- Spec coverage: Tasks cover settings, candidate extraction, typed policies, dedupe, audit, UI visibility, error isolation, maintenance retry, and verification.
- Scope check: The plan avoids a vector store, manual approval queue, LLM utility scoring, and DeepAgents route changes.
- Type consistency: `AutoMemoryAuditRecord`, `AutoMemorySettings`, `AutoMemoryCandidateType`, and `MemoryStatus.autoMemory` are introduced before use.
- IPC strategy: Existing `memory.status` is extended through shared types and plugin output; no new IPC channel is required.
- Known implementation constraint: `agent.run.completed` does not include raw user messages, so direct user-preference proof is not inferred in this implementation. The deterministic extractor accepts only typed summaries with evidence and rejects generic summaries.
