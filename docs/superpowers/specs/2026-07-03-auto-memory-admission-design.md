# Auto Memory Admission Design

## Goal

Roc should keep automatic memory writes enabled while preventing low-value run summaries, transient task state, and duplicate observations from polluting long-term memory. The system should minimize manual review. Human involvement is limited to audit, deletion, and explicit correction, not default approval.

## Background

Roc already has the durable memory foundation:

- DeepAgents sees memory through Roc virtual routes under `/memory`.
- `RocStoreMemoryBackend` enforces writable memory paths, security scanning, and character limits.
- `MemoryStoreRepository` stores memory as Markdown content in the LangGraph Store-backed SQLite layer.
- `AutoMemoryWriter` currently appends the completed run summary to `MEMORY.md` when the summary is non-empty.
- Session search and context artifacts preserve raw conversational and compacted context for later recall.

The weak point is admission control. The current automatic writer treats a completed-run summary as a durable memory candidate without classifying its type, provenance, confidence, scope, conflict behavior, or future retrieval utility.

## External Research Summary

The design follows the common production guidance from current agent-memory systems:

- LangChain separates thread-scoped short-term memory from cross-thread long-term memory, and frames long-term memory as semantic, episodic, and procedural memory stored under namespaces.
- Letta separates always-visible memory blocks, searchable archival memory, files, and external retrieval stores by importance and scale.
- Mem0 treats memory as structured extracted facts with entity scope, metadata, optional raw storage, and additive processing.
- Recent memory-admission guidance recommends a two-stage write path: cheap deterministic filtering first, then higher-cost utility scoring only for survivors.
- CoALA treats procedural memory as higher risk than semantic or episodic memory because bad procedures can compound future errors.

For Roc, this means the write path must decide what should be durable before it writes. Storage and retrieval are necessary but not sufficient.

## Scope

In scope:

- Replace direct run-summary append with an automatic memory candidate pipeline.
- Keep automatic writes as the default.
- Classify candidates by memory type and apply type-specific admission rules.
- Keep the existing `/memory` virtual routes and Store-backed Markdown files.
- Add structured audit records for accepted, rejected, merged, and failed candidates.
- Add lightweight Memory Center visibility for recent automatic memory activity.
- Add tests proving noisy summaries are not written and useful typed memories are written.

Out of scope:

- Replacing the LangGraph Store or `RocStoreMemoryBackend`.
- Adding a vector database or graph memory store.
- Rewriting session search.
- Creating a manual approval queue.
- Automatically editing `USER.md` or `AGENTS.md` from inferred model output.
- Changing DeepAgents filesystem route semantics.

## Architecture

The current event subscriber remains the entry point:

```text
agent.run.completed
  -> AutoMemoryWriter.handleAgentRunCompleted()
  -> MemoryCandidateExtractor
  -> RuleAdmissionFilter
  -> TypePolicyRouter
  -> ConflictAndDedupeChecker
  -> StructuredMemoryFormatter
  -> MemoryStoreRepository.writeFile()
  -> AutoMemoryAuditRepository
```

The pipeline is automatic. It does not ask the user before writing normal accepted candidates.

The writer still writes to `MEMORY.md` only. `USER.md` and `AGENTS.md` remain explicit-edit targets unless the user directly asks Roc to remember a preference or rule through the visible memory editing path.

## Candidate Shape

Each candidate is a first-class object before it becomes Markdown:

```ts
type AutoMemoryCandidate = {
  type: AutoMemoryCandidateType;
  scope: 'global' | 'workspace';
  confidence: 'high' | 'medium' | 'low';
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

`key` is a deterministic dedupe key. It is not a user-facing title. It is derived from the normalized type, scope, and durable subject of the candidate.

## Candidate Types

### `user_preference`

Durable user preference, communication style, workflow constraint, or recurring choice.

Admission:

- Accept only when the user directly stated the preference.
- Reject model-inferred preferences.
- Default scope: `global`.
- Confidence: `high` for direct explicit statements, otherwise reject.

### `workspace_fact`

Verified project structure, path semantics, architecture boundary, or contract.

Admission:

- Accept only with evidence from source inspection, tests, command output, or explicit project documentation.
- Reject if evidence is empty.
- Default scope: `workspace`.
- Confidence: `high` when verified by tests or source, `medium` when verified by project docs only.

### `decision`

Approved design choice, branch strategy, scope boundary, or user-selected option.

Admission:

- Accept when the user explicitly chose or approved the decision.
- Default scope: `workspace` when tied to a workspace, otherwise `global`.
- Confidence: `high`.

### `pitfall`

Reproducible failure, environment issue, wrong assumption, root cause, or recovery rule.

Admission:

- Accept when it includes a trigger condition and evidence.
- Low-confidence entries are allowed if they include `ttlDays` or `revalidate`.
- Default scope: `workspace`.

### `verification`

Reusable verification strategy or command set.

Admission:

- Accept only when the command or verification set is reusable for a class of future changes.
- Reject ordinary one-off test results.
- Default scope: `workspace`.

### `transient_task_result`

One-run outcome, temporary state, generic completion note, or task-local progress.

Admission:

- Reject from long-term memory.
- Leave available through session search and context artifacts.

## Rule Admission Filter

The deterministic filter runs before any model-based utility assessment. It rejects:

- Empty or whitespace-only summaries.
- Generic completion summaries such as "completed task", "updated code", or "fixed issue" without reusable content.
- Boilerplate tool errors with no root cause or recovery rule.
- Pure command output without a durable conclusion.
- Single-run test pass/fail logs unless promoted to a reusable verification strategy.
- Duplicates by normalized summary or candidate key.
- Content blocked by the existing security scan.
- Candidates with no source run id.

The first implementation must stay deterministic. Adding an LLM utility scorer requires a separate approved design because it changes latency, cost, and failure modes.

## Conflict And Dedupe

The writer reads the target `MEMORY.md` before writing.

Behavior:

- Same `key` and same normalized summary: skip as duplicate.
- Same `key` with newer summary: append a new entry with `supersedes` metadata instead of silently overwriting.
- User-stated preference conflicts with older model-inferred or lower-confidence content: new user-stated preference wins.
- Model-inferred content conflicts with user-stated content: reject.
- Workspace facts with conflicting evidence: reject and audit as `conflict_unresolved`.

No destructive cleanup runs as part of normal admission unless the duplicate or superseded item can be proven from the same key.

## Markdown Format

Accepted candidates are written as structured Markdown bullets under date headings:

```md
## 2026-07-03

- type: pitfall
  key: roc.deepagents.shell.workspace_path
  confidence: high
  source: run_123
  evidence: tests/main/services/deep-agent/shell-path-policy.test.ts
  summary: DeepAgents shell commands must reject `/workspace`; shell cwd uses the real Windows workspace path.
  revalidate: when shell adapter or file tool routing changes
```

The format is line-oriented and intentionally simple so existing Markdown memory files remain readable and editable.

## Maintenance

Maintenance runs automatically when a write would exceed capacity, and may also run after a successful write if the target memory file is close to its limit.

Allowed maintenance actions:

- Merge duplicate entries with identical `key`.
- Remove entries superseded by newer entries with the same `key`.
- Remove expired low-confidence pitfall or verification entries.
- Consolidate multiple entries with the same `key` into one structured entry when evidence is preserved.

Forbidden maintenance actions:

- Delete user-stated preferences unless they are explicitly superseded.
- Delete workspace facts without a newer same-key replacement.
- Rewrite `USER.md` or `AGENTS.md`.
- Delete entries only because they look old.

Every maintenance action writes an audit record.

## Audit

Add a lightweight audit store for automatic memory activity.

Audit actions:

- `accepted`
- `rejected`
- `duplicate_skipped`
- `conflict_rejected`
- `maintenance_merged`
- `maintenance_deleted`
- `write_failed`

Each audit record includes:

- `id`
- `createdAt`
- `action`
- `type`
- `scope`
- `confidence`
- `key`
- `summary`
- `sourceRunId`
- `reason`
- `workspacePath`

Audit retention defaults to 30 days. Audit records are for visibility and debugging; they are not part of the agent prompt.

## Settings

Add these settings under `settings.memory.autoMemory`:

```ts
type AutoMemorySettings = {
  enabled: boolean;
  lowConfidenceTtlDays: number;
  auditRetentionDays: number;
  maxCandidatesPerRun: number;
};
```

Defaults:

- `enabled: true`
- `lowConfidenceTtlDays: 30`
- `auditRetentionDays: 30`
- `maxCandidatesPerRun: 8`

## Memory Center UI

Add an "Automatic Writes" section to Memory Center.

It shows recent audit records with:

- action
- type
- scope
- confidence
- summary
- reason
- source run id

It does not implement a review queue. The user can inspect what happened and use existing memory editing if a correction is needed.

## Error Handling

Automatic memory failure must not fail the completed agent run.

Rules:

- `security_scan`: reject candidate, audit `write_failed` or `rejected`.
- `capacity_exceeded`: run maintenance and retry once.
- Invalid candidate: reject and audit.
- Unresolved conflict: reject and audit.
- Store or SQLite failure: audit if possible and log through the plugin logger.

## Testing Requirements

Tests must prove:

- Generic run summaries are not written.
- A direct user preference candidate writes to global memory.
- A workspace fact without evidence is rejected.
- A verified workspace fact writes to workspace memory.
- A pitfall with evidence can write with low confidence and a TTL.
- A transient task result is rejected from long-term memory.
- Duplicate candidates are skipped.
- Conflicting model-inferred memory cannot override user-stated memory.
- Capacity overflow triggers maintenance and one retry.
- Security scan still blocks unsafe content.
- Automatic memory failure does not fail `agent.run.completed`.
- Memory Center can display recent automatic memory audit records.

## Verification

Expected verification commands:

```powershell
pnpm test -- tests/main/services/memory/auto-memory-writer.test.ts
pnpm test -- tests/main/services/deep-agent/context/memory-promotion.test.ts
pnpm test -- tests/main/plugins/memory/plugin.test.ts
pnpm test -- tests/renderer/memory-view.test.tsx
pnpm typecheck
pnpm check:ipc
git diff --check
```

If no IPC contract changes are needed, `pnpm check:ipc` should still pass and prove generated IPC did not drift.

## Non-Goals

- No new vector database.
- No manual approval queue.
- No broad memory UI redesign.
- No replacement of DeepAgents memory backend.
- No changes to shell cwd or `/workspace` path semantics.
- No migration of old Markdown memory entries unless capacity maintenance must touch the active target file.
