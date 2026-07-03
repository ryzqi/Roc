# Roc Context Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Roc's context-management closed loop for long DeepAgents runs across chat, task/background, and Plan Mode.

**Architecture:** Keep DeepAgents and LangGraph as the native harness: `createDeepAgent()`, routed backends, `thread_id`, SQLite checkpointer, and LangChain context editing remain the base. Add only Roc-owned gap fillers: context artifact storage, a context compaction pipeline, current-model summarization, protected digest reinsertion, and searchable compaction flush records.

**Tech Stack:** TypeScript ESM, Electron main process, DeepAgents `1.10.5`, LangGraph `1.4.7`, LangChain `1.5.2`, `better-sqlite3`, Vitest.

## Global Constraints

- User-facing replies use Simplified Chinese; code identifiers, commands, logs, errors, and protocol fields stay in original language.
- Windows 11 and PowerShell are the target environment.
- Use DeepAgents and LangGraph native capabilities wherever they already cover the requirement.
- Do not create a second agent runtime.
- Do not replace DeepAgents built-in filesystem, planning, subagent, memory, or checkpointer semantics.
- Do not change DeepAgents tool names or backend protocol.
- Do not rewrite `/workspace/` into shell paths; `/workspace/` remains a DeepAgents file-tool route.
- Shell execution continues to use real Windows cwd.
- Summaries are runtime context hints, not authoritative recovery state.
- Plan Mode internal context maintenance is allowed, but model-visible mutation tools remain blocked.
- Keep `buildPromptBlocks()` static prefix stable during summarization.

---

## File Structure

- Create `src/main/services/deep-agent/context/context-artifact-store.ts`
  - Owns Roc context artifact persistence and searchable `pre_compaction_flush` summary/index rows.
  - Uses the agent plugin database, not LangGraph checkpoint state.

- Create `tests/main/services/deep-agent/context/context-artifact-store.test.ts`
  - Verifies schema, full artifact readback, hash checking, and searchable flush rows.

- Create `src/main/services/deep-agent/context/context-summary.ts`
  - Owns summary schema, prompt construction, JSON parsing, validation, and digest conversion.
  - Uses the current run model passed from `buildDeepAgent()`.

- Create `tests/main/services/deep-agent/context/context-summary.test.ts`
  - Verifies valid summary parsing, invalid summary retry boundary, and digest conversion.

- Create `src/main/services/deep-agent/context/context-compaction-pipeline.ts`
  - Owns cheap-first stage orchestration.
  - Uses LangChain `createMiddleware()` and existing `createForgeTieredCompactionEdits()`.
  - Preserves tool-call/tool-result boundaries.

- Create `tests/main/services/deep-agent/context/context-compaction-pipeline.test.ts`
  - Verifies stage order, artifact replacement, deterministic compaction, summary threshold, and safe boundaries.

- Modify `src/main/services/deep-agent/agent-builder.ts`
  - Adds optional context compaction wiring.
  - Replaces direct `createForgeTieredCompactionMiddleware()` only when the new pipeline is configured.

- Modify `src/main/plugins/agent/deep-agent-executor.ts`
  - Creates the context compaction runtime options per run.
  - Passes `runId`, `threadId`, `mode`, `workspaceHash`, model, store, and event callback into `buildDeepAgent()`.

- Modify `src/main/plugins/agent/index.ts`
  - Creates `ContextArtifactStore` from the agent plugin DB and passes it into `createAgentDeepAgentExecutor()`.

- Modify `src/shared/types/chat.ts`
  - Adds a typed `context_maintenance` run event for observability.

- Modify tests:
  - `tests/main/deep-agent-build-wiring.test.ts`
  - `tests/main/plugins/agent/deep-agent-executor-test-helpers.ts`
  - `tests/main/plugins/agent/deep-agent-executor.test.ts`
  - `tests/main/plugins/agent/session-repository.test.ts`
  - `tests/main/services/forge-guardrails/middleware/forge-tiered-compaction.test.ts`
  - `tests/main/services/deep-agent/context/session-search-tool.test.ts`

---

### Task 1: Persist Context Artifacts And Searchable Flush Records

**Files:**
- Create: `src/main/services/deep-agent/context/context-artifact-store.ts`
- Create: `tests/main/services/deep-agent/context/context-artifact-store.test.ts`

**Interfaces:**
- Produces:
  - `type ContextArtifactKind = 'tool_result' | 'transcript' | 'summary_index'`
  - `type PersistContextArtifactInput`
  - `type PersistedContextArtifact`
  - `class ContextArtifactStore`
  - `ContextArtifactStore.persistArtifact(input): PersistedContextArtifact`
  - `ContextArtifactStore.readArtifact(input): PersistedContextArtifact | null`
  - `ContextArtifactStore.recordPreCompactionFlush(input): void`
  - `formatContextArtifactReference(artifact): string`

- Consumes:
  - `better-sqlite3` `DatabaseConnection`
  - existing `session_messages` table created by `applyAgentPluginSchema()`

- Later tasks rely on:
  - `persistArtifact()` returning stable `artifactId`, `sha256`, `preview`, and `originalChars`
  - `formatContextArtifactReference()` returning the compact runtime replacement string
  - `recordPreCompactionFlush()` writing `session_messages.phase = 'pre_compaction_flush'`

- [ ] **Step 1: Write failing store tests**

Create `tests/main/services/deep-agent/context/context-artifact-store.test.ts`:

```typescript
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyAgentPluginSchema } from '../../../../../src/main/plugins/agent/schema';
import {
  ContextArtifactStore,
  formatContextArtifactReference
} from '../../../../../src/main/services/deep-agent/context/context-artifact-store';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  applyAgentPluginSchema(db);
});

afterEach(() => {
  db.close();
});

describe('ContextArtifactStore', () => {
  it('persists a large tool result with hash, preview, and full readback', () => {
    const store = new ContextArtifactStore(db);
    const content = `${'alpha '.repeat(100)}final evidence`;

    const artifact = store.persistArtifact({
      content,
      kind: 'tool_result',
      runId: 'run_ctx_1',
      threadId: 'thread_ctx_1',
      toolCallId: 'call_read_1',
      toolName: 'read_file',
      workspaceHash: 'workspace_hash_a'
    });

    expect(artifact.artifactId).toMatch(/^ctx_artifact_/u);
    expect(artifact.kind).toBe('tool_result');
    expect(artifact.originalChars).toBe(content.length);
    expect(artifact.preview).toBe(content.slice(0, 2000));
    expect(artifact.sha256).toHaveLength(64);

    const loaded = store.readArtifact({
      artifactId: artifact.artifactId,
      expectedSha256: artifact.sha256
    });

    expect(loaded?.content).toBe(content);
    expect(loaded?.toolCallId).toBe('call_read_1');
    expect(loaded?.toolName).toBe('read_file');
  });

  it('rejects artifact readback when the expected hash does not match', () => {
    const store = new ContextArtifactStore(db);
    const artifact = store.persistArtifact({
      content: 'stored evidence',
      kind: 'tool_result',
      runId: 'run_ctx_2',
      threadId: 'thread_ctx_2',
      toolCallId: 'call_shell_1',
      toolName: 'run_shell_command',
      workspaceHash: null
    });

    expect(() =>
      store.readArtifact({
        artifactId: artifact.artifactId,
        expectedSha256: '0'.repeat(64)
      })
    ).toThrow('context_artifact_hash_mismatch');
  });

  it('formats a compact artifact reference for runtime ToolMessage content', () => {
    const store = new ContextArtifactStore(db);
    const artifact = store.persistArtifact({
      content: 'large tool output',
      kind: 'tool_result',
      runId: 'run_ctx_3',
      threadId: 'thread_ctx_3',
      toolCallId: 'call_read_2',
      toolName: 'read_file',
      workspaceHash: 'workspace_hash_b'
    });

    const reference = formatContextArtifactReference(artifact);

    expect(reference).toContain('<roc_context_artifact>');
    expect(reference).toContain(`artifactId: ${artifact.artifactId}`);
    expect(reference).toContain(`sha256: ${artifact.sha256}`);
    expect(reference).toContain('retrievalHint: use session_search for the summary/index and artifactId for exact old output');
  });

  it('records a searchable pre-compaction flush row scoped to the workspace', () => {
    const store = new ContextArtifactStore(db);

    store.recordPreCompactionFlush({
      content: 'Context summary mentions deterministic compaction and payment service evidence.',
      runId: 'run_ctx_4',
      threadId: 'thread_ctx_4',
      tokenCount: 42,
      workspaceHash: 'workspace_hash_c'
    });

    const row = db
      .prepare('SELECT thread_id, role, content, phase, token_count, workspace_hash FROM session_messages WHERE thread_id = ?')
      .get('thread_ctx_4') as Record<string, unknown>;

    expect(row).toEqual({
      thread_id: 'thread_ctx_4',
      role: 'system',
      content: 'Context summary mentions deterministic compaction and payment service evidence.',
      phase: 'pre_compaction_flush',
      token_count: 42,
      workspace_hash: 'workspace_hash_c'
    });

    const found = db
      .prepare(
        `SELECT sm.content
         FROM session_messages_fts
         JOIN session_messages sm ON sm.rowid = session_messages_fts.rowid
         WHERE session_messages_fts MATCH ?`
      )
      .all('payment') as Array<{ content: string }>;

    expect(found.map((item) => item.content)).toEqual([
      'Context summary mentions deterministic compaction and payment service evidence.'
    ]);
  });
});
```

- [ ] **Step 2: Run failing store tests**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/context/context-artifact-store.test.ts
```

Expected: FAIL with module-not-found for `context-artifact-store`.

- [ ] **Step 3: Implement `ContextArtifactStore`**

Create `src/main/services/deep-agent/context/context-artifact-store.ts`:

```typescript
import { createHash, randomUUID } from 'node:crypto';

import type { Database as DatabaseConnection } from 'better-sqlite3';

export type ContextArtifactKind = 'tool_result' | 'transcript' | 'summary_index';

export type PersistContextArtifactInput = {
  content: string;
  kind: ContextArtifactKind;
  runId: string;
  threadId: string;
  toolCallId?: string | null;
  toolName?: string | null;
  workspaceHash: string | null;
};

export type PersistedContextArtifact = {
  artifactId: string;
  content: string;
  kind: ContextArtifactKind;
  originalChars: number;
  preview: string;
  runId: string;
  sha256: string;
  threadId: string;
  toolCallId: string | null;
  toolName: string | null;
  workspaceHash: string | null;
};

type ContextArtifactRow = {
  id: string;
  run_id: string;
  thread_id: string;
  kind: ContextArtifactKind;
  tool_call_id: string | null;
  tool_name: string | null;
  sha256: string;
  original_chars: number;
  preview: string;
  content: string;
  workspace_hash: string | null;
};

export class ContextArtifactStore {
  constructor(private readonly db: DatabaseConnection) {
    applyContextArtifactStoreSchema(db);
  }

  persistArtifact(input: PersistContextArtifactInput): PersistedContextArtifact {
    const content = requireNonEmpty(input.content, 'context_artifact_content_empty');
    const artifactId = `ctx_artifact_${randomUUID()}`;
    const sha256 = hashContent(content);
    const preview = content.slice(0, 2000);
    this.db
      .prepare(
        `INSERT INTO context_artifacts
         (id, run_id, thread_id, kind, tool_call_id, tool_name, sha256, original_chars, preview, content, workspace_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        artifactId,
        requireNonEmpty(input.runId, 'context_artifact_run_id_empty'),
        requireNonEmpty(input.threadId, 'context_artifact_thread_id_empty'),
        input.kind,
        normalizeOptional(input.toolCallId),
        normalizeOptional(input.toolName),
        sha256,
        content.length,
        preview,
        content,
        input.workspaceHash,
        new Date().toISOString()
      );
    return {
      artifactId,
      content,
      kind: input.kind,
      originalChars: content.length,
      preview,
      runId: input.runId,
      sha256,
      threadId: input.threadId,
      toolCallId: normalizeOptional(input.toolCallId),
      toolName: normalizeOptional(input.toolName),
      workspaceHash: input.workspaceHash
    };
  }

  readArtifact(input: { artifactId: string; expectedSha256?: string }): PersistedContextArtifact | null {
    const artifactId = requireNonEmpty(input.artifactId, 'context_artifact_id_empty');
    const row = this.db
      .prepare(
        `SELECT id, run_id, thread_id, kind, tool_call_id, tool_name, sha256, original_chars, preview, content, workspace_hash
         FROM context_artifacts
         WHERE id = ?`
      )
      .get(artifactId) as ContextArtifactRow | undefined;
    if (row === undefined) {
      return null;
    }
    if (input.expectedSha256 !== undefined && input.expectedSha256 !== row.sha256) {
      throw new Error('context_artifact_hash_mismatch');
    }
    return {
      artifactId: row.id,
      content: row.content,
      kind: row.kind,
      originalChars: row.original_chars,
      preview: row.preview,
      runId: row.run_id,
      sha256: row.sha256,
      threadId: row.thread_id,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      workspaceHash: row.workspace_hash
    };
  }

  recordPreCompactionFlush(input: {
    content: string;
    runId: string;
    threadId: string;
    tokenCount?: number | null;
    workspaceHash: string | null;
  }): void {
    const content = requireNonEmpty(input.content, 'context_flush_content_empty');
    this.db
      .prepare(
        `INSERT INTO session_messages (id, thread_id, role, content, token_count, phase, workspace_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        `smsg_${randomUUID()}`,
        requireNonEmpty(input.threadId, 'context_flush_thread_id_empty'),
        'system',
        content,
        input.tokenCount === undefined ? null : input.tokenCount,
        'pre_compaction_flush',
        input.workspaceHash,
        new Date().toISOString()
      );
  }
}

export function applyContextArtifactStoreSchema(db: DatabaseConnection): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_artifacts (
      id             TEXT PRIMARY KEY,
      run_id         TEXT NOT NULL,
      thread_id      TEXT NOT NULL,
      kind           TEXT NOT NULL CHECK(kind IN ('tool_result','transcript','summary_index')),
      tool_call_id   TEXT,
      tool_name      TEXT,
      sha256         TEXT NOT NULL,
      original_chars INTEGER NOT NULL,
      preview        TEXT NOT NULL,
      content        TEXT NOT NULL,
      workspace_hash TEXT,
      created_at     TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_context_artifacts_thread_created
      ON context_artifacts(thread_id, created_at);
  `);
}

export function formatContextArtifactReference(artifact: PersistedContextArtifact): string {
  return [
    '<roc_context_artifact>',
    `artifactId: ${artifact.artifactId}`,
    `sha256: ${artifact.sha256}`,
    `originalChars: ${artifact.originalChars}`,
    'preview:',
    artifact.preview,
    'retrievalHint: use session_search for the summary/index and artifactId for exact old output',
    '</roc_context_artifact>'
  ].join('\n');
}

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function normalizeOptional(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function requireNonEmpty(value: string, code: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(code);
  }
  return value;
}
```

- [ ] **Step 4: Run store tests**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/context/context-artifact-store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

Run:

```powershell
git add src/main/services/deep-agent/context/context-artifact-store.ts tests/main/services/deep-agent/context/context-artifact-store.test.ts
git commit -m "feat: persist context artifacts"
```

---

### Task 2: Add Summary Schema, Prompt, Validation, And Digest Conversion

**Files:**
- Create: `src/main/services/deep-agent/context/context-summary.ts`
- Create: `tests/main/services/deep-agent/context/context-summary.test.ts`

**Interfaces:**
- Consumes:
  - `BaseMessage` values from LangGraph runtime state.
  - Existing `createContextDigestMessage(digest)` from `src/main/services/forge-guardrails/context-digest.ts`.

- Produces:
  - `type ContextSummary`
  - `type ContextSummaryInput`
  - `parseContextSummary(text): ContextSummary`
  - `buildContextSummaryPrompt(input): string`
  - `contextSummaryToDigestMessage(summary): AIMessage`
  - `summarizeWithCurrentModel(input): Promise<ContextSummary>`

- Later tasks rely on:
  - `parseContextSummary()` throwing `context_summary_invalid` on malformed output.
  - `contextSummaryToDigestMessage()` producing a `forge:context_digest` message.

- [ ] **Step 1: Write failing summary tests**

Create `tests/main/services/deep-agent/context/context-summary.test.ts`:

```typescript
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';

import { isContextDigestMessage } from '../../../../../src/main/services/forge-guardrails/context-digest';
import {
  buildContextSummaryPrompt,
  contextSummaryToDigestMessage,
  parseContextSummary,
  summarizeWithCurrentModel
} from '../../../../../src/main/services/deep-agent/context/context-summary';

describe('context-summary', () => {
  it('parses a strict JSON context summary', () => {
    const summary = parseContextSummary(JSON.stringify({
      goal: 'Optimize context management.',
      facts: ['DeepAgents remains the harness.'],
      decisions: ['Use current run model for active summaries.'],
      filesTouched: ['src/main/services/deep-agent/context/context-summary.ts'],
      toolEvidence: ['read_file returned existing compaction middleware.'],
      verification: ['pnpm test target passed.'],
      openQuestions: ['None.'],
      nextActions: ['Wire middleware.']
    }));

    expect(summary.goal).toBe('Optimize context management.');
    expect(summary.decisions).toEqual(['Use current run model for active summaries.']);
  });

  it('rejects missing summary fields', () => {
    expect(() => parseContextSummary(JSON.stringify({
      goal: 'Missing fields.'
    }))).toThrow('context_summary_invalid');
  });

  it('builds a summarization prompt without mutating system prompt blocks', () => {
    const prompt = buildContextSummaryPrompt({
      artifactReferences: ['artifactId: ctx_artifact_1'],
      goal: 'Keep context compact.',
      messages: [
        new HumanMessage({ id: 'user-old', content: 'Original request' }),
        new ToolMessage({
          id: 'tool-old',
          tool_call_id: 'call-old',
          name: 'read_file',
          content: 'file evidence',
          status: 'success'
        })
      ],
      recentMessages: [new AIMessage({ id: 'recent-ai', content: 'Recent analysis' })],
      userConstraints: ['Use DeepAgents native features first.'],
      workspacePath: 'F:\\Code\\Roc'
    });

    expect(prompt).toContain('Summarize old Roc DeepAgents runtime context.');
    expect(prompt).toContain('Use DeepAgents native features first.');
    expect(prompt).toContain('artifactId: ctx_artifact_1');
    expect(prompt).not.toContain('<!-- BLOCK:static:static:');
  });

  it('converts a valid summary to a protected context digest message', () => {
    const digest = contextSummaryToDigestMessage({
      goal: 'Finish context pipeline.',
      facts: ['Workspace is F:\\Code\\Roc.'],
      decisions: ['Use artifact store.'],
      filesTouched: ['src/main/services/deep-agent/context/context-artifact-store.ts'],
      toolEvidence: ['read_file showed existing context digest.'],
      verification: ['target tests pass'],
      openQuestions: ['None.'],
      nextActions: ['Wire middleware.']
    });

    expect(isContextDigestMessage(digest)).toBe(true);
    expect(String(digest.content)).toContain('Workspace is F:\\Code\\Roc.');
    expect(String(digest.content)).toContain('Use artifact store.');
    expect(String(digest.content)).toContain('read_file showed existing context digest.');
  });

  it('uses the current model and retries invalid JSON once', async () => {
    const model = {
      invoke: vi
        .fn()
        .mockResolvedValueOnce(new AIMessage('not json'))
        .mockResolvedValueOnce(new AIMessage(JSON.stringify({
          goal: 'Recovered summary.',
          facts: [],
          decisions: [],
          filesTouched: [],
          toolEvidence: [],
          verification: [],
          openQuestions: [],
          nextActions: ['Continue.']
        })))
    };

    const summary = await summarizeWithCurrentModel({
      artifactReferences: [],
      goal: 'Summarize.',
      messages: [new HumanMessage('old')],
      model: model as never,
      recentMessages: [],
      userConstraints: [],
      workspacePath: null
    });

    expect(summary.goal).toBe('Recovered summary.');
    expect(model.invoke).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run failing summary tests**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/context/context-summary.test.ts
```

Expected: FAIL with module-not-found for `context-summary`.

- [ ] **Step 3: Implement summary module**

Create `src/main/services/deep-agent/context/context-summary.ts`:

```typescript
import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { z } from 'zod';

import { createContextDigestMessage } from '../../forge-guardrails/context-digest';

const contextSummarySchema = z.object({
  goal: z.string(),
  facts: z.array(z.string()),
  decisions: z.array(z.string()),
  filesTouched: z.array(z.string()),
  toolEvidence: z.array(z.string()),
  verification: z.array(z.string()),
  openQuestions: z.array(z.string()),
  nextActions: z.array(z.string())
});

export type ContextSummary = z.infer<typeof contextSummarySchema>;

export type ContextSummaryInput = {
  artifactReferences: readonly string[];
  goal: string;
  messages: readonly BaseMessage[];
  recentMessages: readonly BaseMessage[];
  userConstraints: readonly string[];
  workspacePath: string | null;
};

export type SummarizeWithCurrentModelInput = ContextSummaryInput & {
  model: Pick<BaseChatModel, 'invoke'>;
};

export async function summarizeWithCurrentModel(input: SummarizeWithCurrentModelInput): Promise<ContextSummary> {
  const prompt = buildContextSummaryPrompt(input);
  const first = await invokeSummaryModel(input.model, prompt);
  try {
    return parseContextSummary(first);
  } catch (error) {
    const correctivePrompt = [
      'Return only valid JSON matching the required context summary schema.',
      'Do not include Markdown fences or explanatory text.',
      'Previous invalid output:',
      first
    ].join('\n');
    const second = await invokeSummaryModel(input.model, correctivePrompt);
    try {
      return parseContextSummary(second);
    } catch {
      throw new Error('context_summary_failed');
    }
  }
}

export function buildContextSummaryPrompt(input: ContextSummaryInput): string {
  return [
    'Summarize old Roc DeepAgents runtime context.',
    'Return only JSON with keys: goal, facts, decisions, filesTouched, toolEvidence, verification, openQuestions, nextActions.',
    'Do not invent facts. Keep summaries compact and evidence-linked.',
    `Current goal: ${input.goal}`,
    `Workspace: ${input.workspacePath === null ? 'not selected' : input.workspacePath}`,
    'User constraints:',
    ...formatList(input.userConstraints),
    'Persisted artifact references:',
    ...formatList(input.artifactReferences),
    'Old messages:',
    serializeMessages(input.messages),
    'Recent messages to preserve continuity:',
    serializeMessages(input.recentMessages)
  ].join('\n');
}

export function parseContextSummary(text: string): ContextSummary {
  try {
    const parsed = JSON.parse(text);
    return contextSummarySchema.parse(parsed);
  } catch {
    throw new Error('context_summary_invalid');
  }
}

export function contextSummaryToDigestMessage(summary: ContextSummary): AIMessage {
  return createContextDigestMessage({
    facts: summary.facts,
    decisions: summary.decisions,
    filesTouched: summary.filesTouched,
    verifications: [...summary.toolEvidence, ...summary.verification],
    openQuestions: summary.openQuestions,
    nextActions: summary.nextActions
  });
}

async function invokeSummaryModel(model: Pick<BaseChatModel, 'invoke'>, prompt: string): Promise<string> {
  const response = await model.invoke([
    new SystemMessage('You summarize old runtime context for Roc.'),
    new HumanMessage(prompt)
  ] as never);
  if (typeof response.content === 'string') {
    return response.content;
  }
  return JSON.stringify(response.content);
}

function formatList(values: readonly string[]): string[] {
  if (values.length === 0) {
    return ['- none'];
  }
  return values.map((value) => `- ${value}`);
}

function serializeMessages(messages: readonly BaseMessage[]): string {
  return JSON.stringify(
    messages.map((message) => ({
      id: message.id,
      type: message.getType(),
      content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
      additional_kwargs: message.additional_kwargs
    })),
    null,
    2
  );
}
```

- [ ] **Step 4: Run summary tests**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/context/context-summary.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

Run:

```powershell
git add src/main/services/deep-agent/context/context-summary.ts tests/main/services/deep-agent/context/context-summary.test.ts
git commit -m "feat: summarize compacted context"
```

---

### Task 3: Build The Cheap-First Context Compaction Pipeline

**Files:**
- Create: `src/main/services/deep-agent/context/context-compaction-pipeline.ts`
- Create: `tests/main/services/deep-agent/context/context-compaction-pipeline.test.ts`
- Modify: `src/main/services/forge-guardrails/middleware/forge-tiered-compaction.ts`
- Modify: `tests/main/services/forge-guardrails/middleware/forge-tiered-compaction.test.ts`

**Interfaces:**
- Consumes:
  - `ContextArtifactStore`
  - `formatContextArtifactReference()`
  - `summarizeWithCurrentModel()`
  - `contextSummaryToDigestMessage()`
  - `createForgeTieredCompactionEdits()`

- Produces:
  - `type ContextCompactionMode = 'chat' | 'task' | 'plan'`
  - `type ContextMaintenanceEvent`
  - `type RocContextCompactionOptions`
  - `createRocContextCompactionMiddleware(options)`
  - `runContextCompactionForTest(options)`

- Later tasks rely on:
  - middleware name `RocContextCompactionPipeline`
  - event names from the spec
  - deterministic compaction edits running after artifact persistence and before LLM summary

- [ ] **Step 1: Export deterministic edit options for reuse**

Modify `src/main/services/forge-guardrails/middleware/forge-tiered-compaction.ts`:

```typescript
export type RequiredForgeTieredCompactionOptions = {
  budgetTokens: number;
  keepRecent: number;
  phaseThresholds: readonly [number, number, number];
};
```

Change the existing non-exported `type RequiredForgeTieredCompactionOptions` into the exported version above. Do not change behavior.

- [ ] **Step 2: Run existing deterministic compaction tests**

Run:

```powershell
pnpm test -- tests/main/services/forge-guardrails/middleware/forge-tiered-compaction.test.ts
```

Expected: PASS.

- [ ] **Step 3: Write failing pipeline tests**

Create `tests/main/services/deep-agent/context/context-compaction-pipeline.test.ts`:

```typescript
import Database from 'better-sqlite3';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyAgentPluginSchema } from '../../../../../src/main/plugins/agent/schema';
import { ContextArtifactStore } from '../../../../../src/main/services/deep-agent/context/context-artifact-store';
import {
  runContextCompactionForTest,
  type ContextMaintenanceEvent
} from '../../../../../src/main/services/deep-agent/context/context-compaction-pipeline';
import { isContextDigestMessage } from '../../../../../src/main/services/forge-guardrails/context-digest';
import { markIterationOnMessage } from '../../../../../src/main/services/forge-guardrails';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  applyAgentPluginSchema(db);
});

afterEach(() => {
  db.close();
});

function mark<M extends BaseMessage>(message: M, iteration: number): M {
  return markIterationOnMessage(message, iteration) as M;
}

describe('RocContextCompactionPipeline', () => {
  it('persists oversized tool results before deterministic compaction and summarization', async () => {
    const store = new ContextArtifactStore(db);
    const events: ContextMaintenanceEvent[] = [];
    const summarize = vi.fn(async () => ({
      goal: 'Keep context compact.',
      facts: ['Large tool output was persisted.'],
      decisions: [],
      filesTouched: [],
      toolEvidence: ['ctx artifact created'],
      verification: [],
      openQuestions: [],
      nextActions: ['Continue.']
    }));
    const messages: BaseMessage[] = [
      new SystemMessage({ id: 'system', content: 'system' }),
      new HumanMessage({ id: 'user', content: 'start' }),
      mark(
        new ToolMessage({
          id: 'tool-large',
          tool_call_id: 'call-large',
          name: 'read_file',
          content: 'x'.repeat(5000),
          status: 'success'
        }),
        1
      ),
      mark(new AIMessage({ id: 'recent-ai', content: 'recent' }), 5)
    ];

    await runContextCompactionForTest({
      artifactStore: store,
      budgetTokens: 100,
      emitEvent: (event) => events.push(event),
      mode: 'chat',
      model: {} as never,
      runId: 'run_ctx_pipeline_1',
      summarize,
      threadId: 'thread_ctx_pipeline_1',
      toolResultPersistChars: 1000,
      workspaceHash: 'workspace_hash_a',
      workspacePath: 'F:\\Code\\Roc',
      messages,
      countTokens: async () => 1200
    });

    expect(String(messages.find((message) => message.id === 'tool-large')?.content)).toContain('<roc_context_artifact>');
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      'context_compaction_started',
      'context_tool_result_persisted',
      'context_deterministic_compacted',
      'context_summary_started',
      'context_summary_completed'
    ]));
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(messages.some(isContextDigestMessage)).toBe(true);
  });

  it('does not call the summarizer when deterministic stages bring context below threshold', async () => {
    const store = new ContextArtifactStore(db);
    const summarize = vi.fn();
    const messages: BaseMessage[] = [
      new SystemMessage({ id: 'system', content: 'system' }),
      new HumanMessage({ id: 'user', content: 'start' }),
      mark(
        new ToolMessage({
          id: 'tool-small',
          tool_call_id: 'call-small',
          name: 'read_file',
          content: 'small output',
          status: 'success'
        }),
        1
      ),
      mark(new AIMessage({ id: 'recent-ai', content: 'recent' }), 5)
    ];

    await runContextCompactionForTest({
      artifactStore: store,
      budgetTokens: 1000,
      emitEvent: () => {},
      mode: 'task',
      model: {} as never,
      runId: 'run_ctx_pipeline_2',
      summarize,
      threadId: 'thread_ctx_pipeline_2',
      toolResultPersistChars: 1000,
      workspaceHash: null,
      workspacePath: null,
      messages,
      countTokens: async () => 100
    });

    expect(summarize).not.toHaveBeenCalled();
  });

  it('preserves complete tool call and tool result boundaries', async () => {
    const store = new ContextArtifactStore(db);
    const messages: BaseMessage[] = [
      new HumanMessage({ id: 'user', content: 'start' }),
      mark(
        new AIMessage({
          id: 'ai-tool-call',
          content: '',
          tool_calls: [{ id: 'call-1', name: 'read_file', args: { file_path: '/workspace/a.ts' }, type: 'tool_call' }]
        }),
        1
      ),
      mark(
        new ToolMessage({
          id: 'tool-result',
          tool_call_id: 'call-1',
          name: 'read_file',
          content: 'x'.repeat(5000),
          status: 'success'
        }),
        1
      ),
      mark(new AIMessage({ id: 'recent-ai', content: 'recent' }), 5)
    ];

    await runContextCompactionForTest({
      artifactStore: store,
      budgetTokens: 100,
      emitEvent: () => {},
      mode: 'plan',
      model: {} as never,
      runId: 'run_ctx_pipeline_3',
      summarize: async () => ({
        goal: 'Boundary test.',
        facts: [],
        decisions: [],
        filesTouched: [],
        toolEvidence: [],
        verification: [],
        openQuestions: [],
        nextActions: []
      }),
      threadId: 'thread_ctx_pipeline_3',
      toolResultPersistChars: 1000,
      workspaceHash: 'workspace_hash_boundary',
      workspacePath: 'F:\\Code\\Roc',
      messages,
      countTokens: async () => 1200
    });

    expect(messages.some((message) => message.id === 'ai-tool-call')).toBe(true);
    expect(messages.some((message) => message.id === 'tool-result')).toBe(true);
  });
});
```

- [ ] **Step 4: Run failing pipeline tests**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/context/context-compaction-pipeline.test.ts
```

Expected: FAIL with module-not-found for `context-compaction-pipeline`.

- [ ] **Step 5: Implement pipeline module**

Create `src/main/services/deep-agent/context/context-compaction-pipeline.ts`:

```typescript
import { AIMessage, BaseMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createMiddleware } from 'langchain';

import {
  createForgeTieredCompactionEdits,
  type ForgeTieredCompactionOptions
} from '../../forge-guardrails/middleware/forge-tiered-compaction';
import { isContextDigestMessage } from '../../forge-guardrails/context-digest';
import { ContextArtifactStore, formatContextArtifactReference } from './context-artifact-store';
import {
  contextSummaryToDigestMessage,
  summarizeWithCurrentModel,
  type ContextSummary,
  type ContextSummaryInput
} from './context-summary';

export type ContextCompactionMode = 'chat' | 'task' | 'plan';

export type ContextMaintenanceEvent = {
  type:
    | 'context_compaction_started'
    | 'context_tool_result_persisted'
    | 'context_deterministic_compacted'
    | 'context_summary_started'
    | 'context_summary_completed'
    | 'context_summary_skipped'
    | 'context_compaction_failed';
  runId: string;
  threadId: string;
  mode: ContextCompactionMode;
  persistedChars?: number;
  removedChars?: number;
  stage: 'persist' | 'deterministic' | 'summary';
};

export type RocContextCompactionOptions = {
  artifactStore: ContextArtifactStore;
  budgetTokens: number;
  emitEvent: (event: ContextMaintenanceEvent) => void;
  mode: ContextCompactionMode;
  model: Pick<BaseChatModel, 'invoke'>;
  runId: string;
  threadId: string;
  toolResultPersistChars?: number;
  workspaceHash: string | null;
  workspacePath: string | null;
};

type RunCompactionInput = RocContextCompactionOptions & {
  countTokens: (messages: BaseMessage[]) => Promise<number>;
  messages: BaseMessage[];
  summarize?: (input: ContextSummaryInput) => Promise<ContextSummary>;
};

const DEFAULT_TOOL_RESULT_PERSIST_CHARS = 30_000;
const SUMMARY_THRESHOLD = 0.9;

export function createRocContextCompactionMiddleware(options: RocContextCompactionOptions) {
  return createMiddleware({
    name: 'RocContextCompactionPipeline',
    beforeModel: async (state) => {
      await runContextCompactionForTest({
        ...options,
        messages: state.messages,
        countTokens: async (messages) => estimateTokens(messages),
        summarize: async (input) => await summarizeWithCurrentModel({ ...input, model: options.model })
      });
      return undefined;
    }
  });
}

export async function runContextCompactionForTest(input: RunCompactionInput): Promise<void> {
  try {
    input.emitEvent(createEvent(input, 'context_compaction_started', 'persist'));
    const artifactReferences = persistLargeToolResults(input);
    const beforeDeterministicChars = measureMessages(input.messages);
    await runDeterministicCompaction(input);
    const afterDeterministicChars = measureMessages(input.messages);
    input.emitEvent({
      ...createEvent(input, 'context_deterministic_compacted', 'deterministic'),
      removedChars: Math.max(0, beforeDeterministicChars - afterDeterministicChars)
    });

    const tokens = await input.countTokens(input.messages);
    if (tokens < input.budgetTokens * SUMMARY_THRESHOLD) {
      return;
    }
    input.emitEvent(createEvent(input, 'context_summary_started', 'summary'));
    const summarize = input.summarize ?? (async (summaryInput) => await summarizeWithCurrentModel({ ...summaryInput, model: input.model }));
    const summary = await summarize({
      artifactReferences,
      goal: readInitialUserGoal(input.messages),
      messages: selectOldMessages(input.messages),
      recentMessages: selectRecentMessages(input.messages),
      userConstraints: ['Use DeepAgents and LangGraph native capabilities before Roc custom code.'],
      workspacePath: input.workspacePath
    });
    upsertDigest(input.messages, contextSummaryToDigestMessage(summary));
    input.artifactStore.recordPreCompactionFlush({
      content: JSON.stringify(summary),
      runId: input.runId,
      threadId: input.threadId,
      tokenCount: tokens,
      workspaceHash: input.workspaceHash
    });
    input.emitEvent(createEvent(input, 'context_summary_completed', 'summary'));
  } catch (error) {
    input.emitEvent(createEvent(input, 'context_compaction_failed', 'summary'));
    throw error;
  }
}

function persistLargeToolResults(input: RunCompactionInput): string[] {
  const threshold = input.toolResultPersistChars ?? DEFAULT_TOOL_RESULT_PERSIST_CHARS;
  const references: string[] = [];
  for (let index = 0; index < input.messages.length; index += 1) {
    const message = input.messages[index];
    if (!ToolMessage.isInstance(message) || typeof message.content !== 'string' || message.content.length < threshold) {
      continue;
    }
    const artifact = input.artifactStore.persistArtifact({
      content: message.content,
      kind: 'tool_result',
      runId: input.runId,
      threadId: input.threadId,
      toolCallId: message.tool_call_id,
      toolName: message.name ?? null,
      workspaceHash: input.workspaceHash
    });
    input.messages[index] = new ToolMessage({
      id: message.id,
      tool_call_id: message.tool_call_id,
      name: message.name,
      content: formatContextArtifactReference(artifact),
      status: message.status,
      artifact: message.artifact,
      additional_kwargs: message.additional_kwargs,
      response_metadata: message.response_metadata,
      metadata: message.metadata
    });
    references.push(formatContextArtifactReference(artifact));
    input.emitEvent({
      ...createEvent(input, 'context_tool_result_persisted', 'persist'),
      persistedChars: artifact.originalChars
    });
  }
  return references;
}

async function runDeterministicCompaction(input: RunCompactionInput): Promise<void> {
  const opts: ForgeTieredCompactionOptions = {
    budgetTokens: input.budgetTokens
  };
  const edits = createForgeTieredCompactionEdits(opts);
  for (const edit of edits) {
    await edit.apply({
      messages: input.messages,
      countTokens: input.countTokens
    });
  }
}

function upsertDigest(messages: BaseMessage[], digest: AIMessage): void {
  const existing = messages.findIndex(isContextDigestMessage);
  if (existing >= 0) {
    messages[existing] = digest;
    return;
  }
  const systemIndex = messages.findIndex((message) => message.getType() === 'system');
  messages.splice(systemIndex >= 0 ? systemIndex + 1 : 0, 0, digest);
}

function selectOldMessages(messages: BaseMessage[]): BaseMessage[] {
  return messages.slice(0, Math.max(0, messages.length - 3));
}

function selectRecentMessages(messages: BaseMessage[]): BaseMessage[] {
  return messages.slice(Math.max(0, messages.length - 3));
}

function readInitialUserGoal(messages: readonly BaseMessage[]): string {
  const firstHuman = messages.find((message) => message.getType() === 'human');
  if (firstHuman === undefined) {
    return '';
  }
  return typeof firstHuman.content === 'string' ? firstHuman.content : JSON.stringify(firstHuman.content);
}

function measureMessages(messages: readonly BaseMessage[]): number {
  return messages.reduce((sum, message) => sum + String(message.content).length, 0);
}

function estimateTokens(messages: readonly BaseMessage[]): number {
  return Math.ceil(JSON.stringify(messages.map((message) => message.content)).length / 4);
}

function createEvent(
  input: Pick<RocContextCompactionOptions, 'mode' | 'runId' | 'threadId'>,
  type: ContextMaintenanceEvent['type'],
  stage: ContextMaintenanceEvent['stage']
): ContextMaintenanceEvent {
  return {
    type,
    runId: input.runId,
    threadId: input.threadId,
    mode: input.mode,
    stage
  };
}
```

- [ ] **Step 6: Run pipeline tests**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/context/context-compaction-pipeline.test.ts tests/main/services/forge-guardrails/middleware/forge-tiered-compaction.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

Run:

```powershell
git add src/main/services/deep-agent/context/context-compaction-pipeline.ts src/main/services/forge-guardrails/middleware/forge-tiered-compaction.ts tests/main/services/deep-agent/context/context-compaction-pipeline.test.ts tests/main/services/forge-guardrails/middleware/forge-tiered-compaction.test.ts
git commit -m "feat: add context compaction pipeline"
```

---

### Task 4: Wire The Pipeline Into DeepAgents Runtime

**Files:**
- Modify: `src/shared/types/chat.ts`
- Modify: `src/main/services/deep-agent/agent-builder.ts`
- Modify: `src/main/plugins/agent/deep-agent-executor.ts`
- Modify: `src/main/plugins/agent/index.ts`
- Modify: `tests/main/deep-agent-build-wiring.test.ts`
- Modify: `tests/main/plugins/agent/deep-agent-executor-test-helpers.ts`
- Modify: `tests/main/plugins/agent/deep-agent-executor.test.ts`

**Interfaces:**
- Consumes:
  - `ContextArtifactStore`
  - `createRocContextCompactionMiddleware()`
  - `ContextMaintenanceEvent`
  - `contextHarness.workspaceIdentity`

- Produces:
  - `ChatRunEvent` variant with `type: 'context_maintenance'`, `event`, `mode`, `stage`, and optional character counts
  - `AgentDeepAgentExecutorOptions.contextArtifactStore`
  - `DeepAgentBuildInput.contextCompaction`

- [ ] **Step 1: Add typed context maintenance event test in build wiring**

Append this test to `tests/main/deep-agent-build-wiring.test.ts`:

```typescript
  it('wires Roc context compaction pipeline in normal runs when context options are provided', () => {
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
      contextBudgetTokens: 4096,
      contextCompaction: {
        artifactStore: {} as never,
        emitEvent: vi.fn(),
        mode: 'chat',
        runId: 'run_context_1',
        threadId: 'thread_context_1',
        workspaceHash: 'workspace_hash_context'
      }
    } as unknown as DeepAgentBuildInput;

    buildDeepAgent(input);

    const createDeepAgentInput = vi.mocked(createDeepAgent).mock.calls[0]?.[0];
    const middlewareNames = createDeepAgentInput?.middleware?.map((middleware) => Reflect.get(middleware as object, 'name')) ?? [];

    expect(middlewareNames).toContain('RocContextCompactionPipeline');
    expect(middlewareNames.indexOf('ForgeIterationTrackingMiddleware')).toBeLessThan(
      middlewareNames.indexOf('RocContextCompactionPipeline')
    );
    expect(middlewareNames.indexOf('RocContextCompactionPipeline')).toBeLessThan(
      middlewareNames.indexOf('ForgeRescueParsingMiddleware')
    );
    expect(middlewareNames.filter((name) => name === 'ContextEditingMiddleware')).toHaveLength(0);
  });
```

- [ ] **Step 2: Run failing build wiring test**

Run:

```powershell
pnpm test -- tests/main/deep-agent-build-wiring.test.ts
```

Expected: FAIL because `DeepAgentBuildInput` does not contain `contextCompaction` and middleware is missing.

- [ ] **Step 3: Add shared event type**

Modify `src/shared/types/chat.ts` by adding this union member before `run_completed`:

```typescript
  | {
      type: 'context_maintenance';
      runId: string;
      threadId: string | null;
      event:
        | 'context_compaction_started'
        | 'context_tool_result_persisted'
        | 'context_deterministic_compacted'
        | 'context_summary_started'
        | 'context_summary_completed'
        | 'context_summary_skipped'
        | 'context_compaction_failed';
      mode: ChatRunMode;
      stage: 'persist' | 'deterministic' | 'summary';
      persistedChars?: number;
      removedChars?: number;
    }
```

- [ ] **Step 4: Modify `DeepAgentBuildInput` and middleware wiring**

In `src/main/services/deep-agent/agent-builder.ts`, add imports:

```typescript
import {
  createRocContextCompactionMiddleware,
  type ContextCompactionMode
} from './context/context-compaction-pipeline';
import type { ContextArtifactStore } from './context/context-artifact-store';
```

Add to `DeepAgentBuildInput`:

```typescript
  contextCompaction?: {
    artifactStore: ContextArtifactStore;
    emitEvent: Parameters<typeof createRocContextCompactionMiddleware>[0]['emitEvent'];
    mode: ContextCompactionMode;
    runId: string;
    threadId: string;
    workspaceHash: string | null;
  };
```

Replace the direct tiered compaction middleware entry:

```typescript
    createForgeTieredCompactionMiddleware({
      budgetTokens: input.contextBudgetTokens
    }),
```

with:

```typescript
    ...createContextCompactionMiddleware(input),
```

Add helper near `createToolEffectMiddleware()`:

```typescript
function createContextCompactionMiddleware(input: DeepAgentBuildInput) {
  if (input.contextCompaction === undefined) {
    return [
      createForgeTieredCompactionMiddleware({
        budgetTokens: input.contextBudgetTokens
      })
    ];
  }
  return [
    createRocContextCompactionMiddleware({
      artifactStore: input.contextCompaction.artifactStore,
      budgetTokens: input.contextBudgetTokens === undefined ? 7168 : input.contextBudgetTokens,
      emitEvent: input.contextCompaction.emitEvent,
      mode: input.contextCompaction.mode,
      model: input.model,
      runId: input.contextCompaction.runId,
      threadId: input.contextCompaction.threadId,
      workspaceHash: input.contextCompaction.workspaceHash,
      workspacePath: input.workspacePath
    })
  ];
}
```

- [ ] **Step 5: Add executor options and event forwarding**

In `src/main/plugins/agent/deep-agent-executor.ts`, import:

```typescript
import type { ContextArtifactStore } from '../../services/deep-agent/context/context-artifact-store';
import type { ContextMaintenanceEvent } from '../../services/deep-agent/context/context-compaction-pipeline';
```

Add to `AgentDeepAgentExecutorOptions`:

```typescript
  contextArtifactStore: ContextArtifactStore;
```

Before the `buildDeepAgent()` call object is created, add:

```typescript
      const emitContextMaintenanceEvent = (event: ContextMaintenanceEvent) => {
        eventQueue.push({
          type: 'context_maintenance',
          runId: input.run.id,
          threadId: input.run.threadId,
          event: event.type,
          mode: input.request.mode,
          stage: event.stage,
          ...(event.persistedChars === undefined ? {} : { persistedChars: event.persistedChars }),
          ...(event.removedChars === undefined ? {} : { removedChars: event.removedChars })
        });
      };
```

Add to the `buildDeepAgent()` input:

```typescript
        contextCompaction: {
          artifactStore: options.contextArtifactStore,
          emitEvent: emitContextMaintenanceEvent,
          mode: input.request.mode,
          runId: input.run.id,
          threadId: input.run.threadId,
          workspaceHash: contextHarness.workspaceIdentity === null ? null : contextHarness.workspaceIdentity.hash
        },
```

- [ ] **Step 6: Instantiate store in plugin index**

In `src/main/plugins/agent/index.ts`, import:

```typescript
import { ContextArtifactStore } from '../../services/deep-agent/context/context-artifact-store';
```

In `resolveDeepAgentExecutor()`, create the agent DB and pass the store:

```typescript
  const agentDb = context.database.getConnection();
  const coreDb = context.database.getCoreConnection();
  return createAgentDeepAgentExecutor({
    capabilities: context.capabilities,
    checkpointer: new RocSqliteCheckpointer(coreDb),
    contextArtifactStore: new ContextArtifactStore(agentDb),
    getMemorySettings: option.getMemorySettings,
    hookRuntime: option.hookRuntime,
    paths: option.paths,
    store: new RocSqliteStore(coreDb),
    toolEffectStore: new AgentToolEffectStore(coreDb)
  });
```

- [ ] **Step 7: Update executor test helper**

In `tests/main/plugins/agent/deep-agent-executor-test-helpers.ts`, import `ContextArtifactStore` and add it to `createAgentDeepAgentExecutor()` options:

```typescript
import { ContextArtifactStore } from '../../../../src/main/services/deep-agent/context/context-artifact-store';
```

Inside the helper where `AgentToolEffectStore` is created:

```typescript
    contextArtifactStore: new ContextArtifactStore(toolEffectDb),
```

Use the same in-memory database that already has `applyAgentPluginSchema()` applied. If the helper currently has only a tool-effect DB without agent schema, apply `applyAgentPluginSchema(toolEffectDb)` before creating `ContextArtifactStore`.

- [ ] **Step 8: Add executor event test**

Append to `tests/main/plugins/agent/deep-agent-executor.test.ts` a focused assertion using the existing mocked `buildDeepAgent()` path:

```typescript
  it('passes context maintenance events through the chat run event stream', async () => {
    const harness = createDeepAgentExecutorHarness();
    const events: ChatRunEvent[] = [];

    harness.mockDeepAgentStream({
      messages: async function* () {
        yield {
          text: async function* () {
            yield 'done';
          }
        };
      },
      toolCalls: async function* () {},
      subagents: async function* () {},
      output: Promise.resolve({ messages: [new AIMessage('done')] }),
      interrupted: false
    });
    harness.triggerContextMaintenance({
      type: 'context_summary_completed',
      runId: harness.run.id,
      threadId: harness.run.threadId,
      mode: 'chat',
      stage: 'summary'
    });

    for await (const event of await harness.executor.execute(harness.input)) {
      events.push(event);
    }

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'context_maintenance',
        event: 'context_summary_completed',
        stage: 'summary'
      })
    ]));
  });
```

If the current helper does not expose `triggerContextMaintenance`, add a helper method that captures `contextCompaction.emitEvent` from the mocked `buildDeepAgent()` input and invokes it.

- [ ] **Step 9: Run wiring tests**

Run:

```powershell
pnpm test -- tests/main/deep-agent-build-wiring.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit Task 4**

Run:

```powershell
git add src/shared/types/chat.ts src/main/services/deep-agent/agent-builder.ts src/main/plugins/agent/deep-agent-executor.ts src/main/plugins/agent/index.ts tests/main/deep-agent-build-wiring.test.ts tests/main/plugins/agent/deep-agent-executor-test-helpers.ts tests/main/plugins/agent/deep-agent-executor.test.ts
git commit -m "feat: wire context compaction into deepagents"
```

---

### Task 5: Prove Recall, Plan Mode Boundaries, And Prompt Cache Stability

**Files:**
- Modify: `tests/main/plugins/agent/session-repository.test.ts`
- Modify: `tests/main/services/deep-agent/context/session-search-tool.test.ts`
- Modify: `tests/main/services/deep-agent/context/prompt-blocks.test.ts`
- Modify: `tests/main/services/forge-guardrails/middleware/prompt-caching.test.ts`
- Modify: `tests/main/deep-agent-build-wiring.test.ts`

**Interfaces:**
- Consumes:
  - `ContextArtifactStore.recordPreCompactionFlush()`
  - existing `AgentSessionRepository.searchSessionMessages()`
  - existing `serializePromptBlocks()` and `createPromptCachingMiddleware()`

- Produces:
  - Verification that `pre_compaction_flush` rows are searchable.
  - Verification that Plan Mode keeps mutation blocking when context compaction is wired.
  - Verification that runtime summary insertion does not alter prompt block ordering.

- [ ] **Step 1: Add repository search test for pre-compaction rows**

Append to `tests/main/plugins/agent/session-repository.test.ts`:

```typescript
  it('includes pre-compaction flush rows in workspace-scoped session search', () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);
    const run = repository.createTaskRun({
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      threadKind: 'chat',
      userInput: 'Create a long context summary'
    });

    repository.recordSessionMessage({
      content: 'summary index includes context artifact payment-service-evidence',
      phase: 'pre_compaction_flush',
      role: 'system',
      threadId: run.threadId,
      tokenCount: 120,
      workspaceHash: 'workspace_hash_summary'
    });

    const result = repository.searchSessionMessages({
      query: 'payment-service-evidence',
      workspaceHash: 'workspace_hash_summary',
      workspaceScope: 'current'
    });

    expect(result.items.map((item) => ({
      content: item.content,
      phase: item.phase,
      workspaceHash: item.workspaceHash
    }))).toEqual([
      {
        content: 'summary index includes context artifact payment-service-evidence',
        phase: 'pre_compaction_flush',
        workspaceHash: 'workspace_hash_summary'
      }
    ]);
  });
```

- [ ] **Step 2: Add Plan Mode wiring assertion**

Extend the existing `builds plan mode without file mutation tools while preserving non-file tools` test in `tests/main/deep-agent-build-wiring.test.ts` by adding `contextCompaction` to its input:

```typescript
      contextCompaction: {
        artifactStore: {} as never,
        emitEvent: vi.fn(),
        mode: 'plan',
        runId: 'run_plan_context',
        threadId: 'thread_plan_context',
        workspaceHash: 'workspace_hash_plan'
      }
```

Add assertion:

```typescript
    expect(middlewareNames).toContain('RocContextCompactionPipeline');
    expect(middlewareNames).toContain('RocPlanRuntimeToolGuardMiddleware');
    expect(toolNames).not.toEqual(expect.arrayContaining(['write_file', 'edit_file', 'delete_file']));
```

- [ ] **Step 3: Add prompt block stability test**

Append to `tests/main/services/deep-agent/context/prompt-blocks.test.ts`:

```typescript
  it('keeps stable prompt block ordering independent of runtime context summaries', () => {
    const blocks = buildPromptBlocks({
      mode: 'chat',
      enabledCapabilities: { mcpServers: [], skills: [] },
      workspacePath: 'F:\\Code\\Roc',
      workflowHint: null,
      tools: [{ name: 'session_search', description: 'Search prior conversations' }],
      explicitSkillContexts: []
    });

    expect(blocks.map((block) => block.type)).toEqual([
      'static',
      'workspace',
      'tools',
      'capability',
      'context_recall',
      'workflow'
    ]);
    expect(blocks.some((block) => block.content.includes('roc_context_digest'))).toBe(false);
  });
```

- [ ] **Step 4: Run recall and stability tests**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/session-repository.test.ts tests/main/services/deep-agent/context/prompt-blocks.test.ts tests/main/deep-agent-build-wiring.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

Run:

```powershell
git add tests/main/plugins/agent/session-repository.test.ts tests/main/services/deep-agent/context/prompt-blocks.test.ts tests/main/deep-agent-build-wiring.test.ts
git commit -m "test: cover context recall and plan mode boundaries"
```

---

### Task 6: Final Verification And Cleanup

**Files:**
- Review all files changed by Tasks 1-5.

**Interfaces:**
- Consumes all previous task outputs.
- Produces final evidence that context management is wired, tested, and whitespace-clean.

- [ ] **Step 1: Run focused context-management tests**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/context/context-artifact-store.test.ts tests/main/services/deep-agent/context/context-summary.test.ts tests/main/services/deep-agent/context/context-compaction-pipeline.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run DeepAgents wiring and runtime tests**

Run:

```powershell
pnpm test -- tests/main/deep-agent-build-wiring.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run recall and prompt-cache related tests**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/session-repository.test.ts tests/main/services/deep-agent/context/session-search-tool.test.ts tests/main/services/deep-agent/context/prompt-blocks.test.ts tests/main/services/forge-guardrails/middleware/prompt-caching.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run TypeScript verification**

Run:

```powershell
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Run whitespace verification**

Run:

```powershell
git diff --check
```

Expected: no output and exit code `0`.

- [ ] **Step 6: Inspect changed files for accidental broad scope**

Run:

```powershell
git diff --stat HEAD~5..HEAD
git diff -- src/main/services/deep-agent src/main/services/forge-guardrails src/main/plugins/agent src/shared/types tests/main/services/deep-agent tests/main/plugins/agent tests/main/deep-agent-build-wiring.test.ts
```

Expected:

- No changes under `dist/`, `release/`, or `node_modules/`.
- No DeepAgents tool name changes.
- No `/workspace/` to Windows path rewriting.
- No Plan Mode mutation-tool exposure.
- New code paths trace to context management only.

- [ ] **Step 7: Commit verification-only cleanup if needed**

If Step 6 reveals only small test or type cleanup, commit it:

```powershell
git add src/main/services/deep-agent src/main/services/forge-guardrails src/main/plugins/agent src/shared/types tests/main/services/deep-agent tests/main/plugins/agent tests/main/deep-agent-build-wiring.test.ts
git commit -m "chore: verify context management integration"
```

If Step 6 reveals no changes after prior task commits, do not create an empty commit.

---

## Self-Review

- Spec coverage:
  - Native-first DeepAgents/LangGraph rule: Task 4 keeps `createDeepAgent()` and existing middleware; Task 3 reuses `createForgeTieredCompactionEdits()` / LangChain context editing semantics.
  - Artifact persistence: Task 1.
  - Deterministic compaction before LLM summary: Task 3.
  - Current run model summarization: Task 2 and Task 4.
  - Digest reinsertion: Task 2 and Task 3.
  - Searchable compaction flush: Task 1 and Task 5.
  - Chat/task/background/plan shared wiring: Task 4 and Task 5.
  - Prompt cache stability: Task 5.
  - Verification: Task 6.

- Placeholder scan:
  - No unfinished marker text, no incomplete file paths, no unnamed tests.

- Type consistency:
  - `ContextArtifactStore`, `ContextMaintenanceEvent`, `RocContextCompactionOptions`, and `ContextSummary` names are consistent across tasks.
  - Middleware name is consistently `RocContextCompactionPipeline`.
  - Run event type is consistently `context_maintenance`.
