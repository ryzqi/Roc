# Roc Context Harness Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor Roc's DeepAgents context harness so session recall, workspace scope, prompt blocks, prompt caching, and memory promotion are one coherent production path.

**Architecture:** Add a focused `src/main/services/deep-agent/context/` layer that assembles prompt blocks, session recall tools, workspace identity, and memory promotion policy while keeping DeepAgents as the owner of low-level memory, filesystem, skills, subagents, checkpointer, and store-backed routes. `deep-agent-executor.ts` remains the coordinator and passes assembled context into `buildDeepAgent()`.

**Tech Stack:** TypeScript ESM, Electron main process, React renderer, Vitest, better-sqlite3, LangChain JS tools, LangGraph `MemorySaver`, DeepAgents JS `createDeepAgent`, Roc `BaseStore`.

## Global Constraints

- Use DeepAgents-native memory behavior: `memory` sources, `StoreBackend`, `CompositeBackend`, filesystem routes, `checkpointer`, and `thread_id`.
- Do not introduce a second memory namespace, `/agents/` alias, path compatibility layer, vector database, embedding index, or separate long-term memory store.
- Preserve the file and shell boundary: file tools use `/workspace/`, `/memory/`, and `/skills/`; shell tools use real Windows cwd/path semantics.
- Do not expose DeepAgents native `execute`.
- `session_messages.workspace_hash` is the source of truth for workspace-scoped session recall.
- Existing rows with `workspace_hash = null` are visible only to `scope=all`.
- Automatic memory promotion writes only to memory kind `memory`, which maps to `MEMORY.md`; it must not write `USER.md` or `AGENTS.md`.
- Keep changes scoped to the context harness refactor and leave unrelated dead code untouched.

---

## File Structure

Create:

- `src/main/services/deep-agent/context/workspace-scope.ts`
  - Computes and resolves workspace hashes for session recall and run completion.
- `src/main/services/deep-agent/context/session-search-tool.ts`
  - Builds the `session_search` LangChain tool and formats compact search output.
- `src/main/services/deep-agent/context/prompt-blocks.ts`
  - Single source of truth for production system prompt blocks.
- `src/main/services/deep-agent/context/prompt-serialization.ts`
  - Serializes prompt blocks with stable block markers.
- `src/main/services/deep-agent/context/run-summary.ts`
  - Builds deterministic, bounded completion summaries for promotion.
- `src/main/services/deep-agent/context/memory-promotion.ts`
  - Converts completed runs into safe `MEMORY.md` promotion bullets.
- `src/main/services/deep-agent/context/context-assembler.ts`
  - Assembles prompt, tools, memory sources, skill sources, and workspace scope metadata for one run.
- `tests/main/services/deep-agent/context/workspace-scope.test.ts`
- `tests/main/services/deep-agent/context/session-search-tool.test.ts`
- `tests/main/services/deep-agent/context/prompt-blocks.test.ts`
- `tests/main/services/deep-agent/context/run-summary.test.ts`
- `tests/main/services/deep-agent/context/memory-promotion.test.ts`
- `tests/main/services/deep-agent/context/context-assembler.test.ts`

Modify:

- `src/shared/types/memory.ts`
  - Add `workspaceHash` to session entries and remove unsupported `global` scope from search requests.
- `src/main/plugins/agent/schema.ts`
  - Add `session_messages.workspace_hash` and a workspace search index.
- `src/main/plugins/agent/session-repository.ts`
  - Persist, map, and filter `workspace_hash`.
- `src/main/plugins/agent/runtime.ts`
  - Record assistant session messages with the run workspace hash.
- `src/main/plugins/agent/index.ts`
  - Update zod schemas for `workspaceHash` and `workspaceScope`.
- `src/main/plugins/agent/deep-agent-executor.ts`
  - Use `ContextAssembler`, include `session_search`, and use structured run summaries.
- `src/main/services/deep-agent/prompt.ts`
  - Keep only thin compatibility exports or delegate to the new prompt block builder.
- `src/main/services/deep-agent/prompt-builder.ts`
  - Remove duplicated prompt content or re-export new prompt block types only.
- `src/main/services/forge-guardrails/middleware/prompt-caching.ts`
  - Import prompt block types from the new context module and parse production markers.
- `src/main/services/memory/auto-memory-writer.ts`
  - Use memory promotion policy instead of direct `Completed run ...` bullet construction.
- `src/renderer/views/memory/sessions-tab.tsx`
  - Remove unsupported `global` selection.
- Existing tests that reference session search, prompt building, prompt caching, runtime completion, executor tools, and renderer memory search.

---

### Task 1: Workspace-Scoped Session Message Storage

**Files:**
- Modify: `src/shared/types/memory.ts`
- Modify: `src/main/plugins/agent/schema.ts`
- Modify: `src/main/plugins/agent/session-repository.ts`
- Modify: `src/main/plugins/agent/index.ts`
- Modify: `tests/main/plugins/agent/session-repository.test.ts`

**Interfaces:**
- Produces: `SessionMessageEntry.workspaceHash: string | null`
- Produces: `SessionMessageSearchRequest.workspaceScope: 'current' | 'all'`
- Produces: `SessionMessageSearchRequest.workspaceHash?: string | null`
- Produces: `AgentSessionRepository.recordSessionMessage(input: { ..., workspaceHash?: string | null }): SessionMessageEntry`
- Produces: `AgentSessionRepository.searchSessionMessages(input: SessionMessageSearchRequest): SessionMessageSearchResult`

- [ ] **Step 1: Write the failing schema and mapper test**

Add these expectations to `tests/main/plugins/agent/session-repository.test.ts`:

```typescript
it('persists workspace hash on session messages', () => {
  applyAgentPluginSchema(db);
  const repository = new AgentSessionRepository(db);
  const run = repository.createTaskRun({
    enabledCapabilities,
    modelId: 'openai:gpt-4.1',
    threadKind: 'chat',
    userInput: 'Remember workspace context'
  });

  const message = repository.recordSessionMessage({
    content: 'Workspace specific answer',
    role: 'assistant',
    threadId: run.threadId,
    workspaceHash: 'workspace_hash_a'
  });

  expect(columnNames('session_messages')).toContain('workspace_hash');
  expect(message.workspaceHash).toBe('workspace_hash_a');
  expect(rawRow('session_messages', message.id)).toMatchObject({
    workspace_hash: 'workspace_hash_a'
  });
  expect(repository.listSessionMessages({ threadId: run.threadId })).toEqual([message]);
});
```

- [ ] **Step 2: Write the failing search scope test**

Add this test to the same file:

```typescript
it('filters current workspace search by workspace hash and keeps unscoped rows only in all scope', () => {
  applyAgentPluginSchema(db);
  const repository = new AgentSessionRepository(db);
  const runA = repository.createTaskRun({
    enabledCapabilities,
    modelId: 'openai:gpt-4.1',
    threadKind: 'chat',
    userInput: 'Workspace A'
  });
  const runB = repository.createTaskRun({
    enabledCapabilities,
    modelId: 'openai:gpt-4.1',
    threadKind: 'chat',
    userInput: 'Workspace B'
  });

  repository.recordSessionMessage({
    content: 'alpha recall from workspace a',
    role: 'assistant',
    threadId: runA.threadId,
    workspaceHash: 'workspace_hash_a'
  });
  repository.recordSessionMessage({
    content: 'alpha recall from workspace b',
    role: 'assistant',
    threadId: runB.threadId,
    workspaceHash: 'workspace_hash_b'
  });
  repository.recordSessionMessage({
    content: 'alpha recall from unscoped history',
    role: 'assistant',
    threadId: runB.threadId,
    workspaceHash: null
  });

  const current = repository.searchSessionMessages({
    query: 'alpha',
    workspaceScope: 'current',
    workspaceHash: 'workspace_hash_a'
  });
  expect(current.items.map(item => item.content)).toEqual(['alpha recall from workspace a']);

  const all = repository.searchSessionMessages({
    query: 'alpha',
    workspaceScope: 'all'
  });
  expect(all.items.map(item => item.content).sort()).toEqual([
    'alpha recall from unscoped history',
    'alpha recall from workspace a',
    'alpha recall from workspace b'
  ]);
});
```

- [ ] **Step 3: Run the focused failing test**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/session-repository.test.ts
```

Expected before implementation:

```text
FAIL tests/main/plugins/agent/session-repository.test.ts
```

The failure should mention missing `workspace_hash` or missing `workspaceHash`.

- [ ] **Step 4: Update shared types and IPC schema**

Change `src/shared/types/memory.ts` to this shape:

```typescript
export type SessionMessageEntry = {
  id: string;
  threadId: string;
  threadTitle: string | null;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  phase: SessionMessagePhase;
  tokenCount: number | null;
  workspaceHash: string | null;
  createdAt: string;
};

export type SessionMessageSearchRequest = {
  query: string;
  workspaceScope: 'current' | 'all';
  workspaceHash?: string | null;
  threadId?: string;
  sinceDays?: number;
  limit?: number;
};
```

Change `src/main/plugins/agent/index.ts` schemas:

```typescript
const sessionMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  threadTitle: z.string().nullable(),
  role: z.enum(['user', 'assistant', 'tool', 'system']),
  content: z.string(),
  phase: z.enum(['visible', 'pre_compaction_flush']),
  tokenCount: z.number().int().nullable(),
  workspaceHash: z.string().nullable(),
  createdAt: z.string()
}) satisfies z.ZodType<SessionMessageEntry>;

const sessionSearchInputSchema = z.object({
  query: z.string(),
  workspaceScope: z.enum(['current', 'all']),
  workspaceHash: z.string().nullable().optional(),
  threadId: z.string().optional(),
  sinceDays: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional()
}) satisfies z.ZodType<SessionMessageSearchRequest>;
```

- [ ] **Step 5: Update schema**

Change `src/main/plugins/agent/schema.ts` `session_messages` table and indexes:

```sql
CREATE TABLE IF NOT EXISTS session_messages (
  id             TEXT PRIMARY KEY,
  thread_id      TEXT NOT NULL,
  role           TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
  content        TEXT NOT NULL,
  token_count    INTEGER,
  phase          TEXT NOT NULL DEFAULT 'visible' CHECK(phase IN ('visible','pre_compaction_flush')),
  workspace_hash TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_session_messages_workspace_created
ON session_messages(workspace_hash, created_at);
```

Because this schema function is currently used for fresh local databases, do not add a migration framework in this task. If later evidence shows existing production DBs need online migration, add a separate migration task instead of silently hiding it here.

- [ ] **Step 6: Update repository mapper and insert**

Change `SessionMessageRow`, `recordSessionMessage`, `listSessionMessages`, search selects, and `mapSessionMessage`:

```typescript
type SessionMessageRow = {
  id: string;
  thread_id: string;
  thread_title: string | null;
  role: SessionMessageEntry['role'];
  content: string;
  phase: SessionMessagePhase;
  token_count: number | null;
  workspace_hash: string | null;
  created_at: string;
};

recordSessionMessage(input: {
  threadId: string;
  role: SessionMessageEntry['role'];
  content: string;
  tokenCount?: number | null;
  phase?: SessionMessagePhase;
  workspaceHash?: string | null;
}): SessionMessageEntry {
  const createdAt = new Date().toISOString();
  const tokenCount = input.tokenCount === undefined ? null : input.tokenCount;
  const phase = input.phase === undefined ? 'visible' : input.phase;
  const workspaceHash = input.workspaceHash === undefined ? null : input.workspaceHash;
  const id = `smsg_${randomUUID()}`;
  this.db
    .prepare(
      `INSERT INTO session_messages (id, thread_id, role, content, token_count, phase, workspace_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, input.threadId, input.role, input.content, tokenCount, phase, workspaceHash, createdAt);
  return {
    id,
    threadId: input.threadId,
    threadTitle: this.findThreadTitle(input.threadId),
    role: input.role,
    content: input.content,
    phase,
    tokenCount,
    workspaceHash,
    createdAt
  };
}
```

Update select lists to include `sm.workspace_hash`, and map it:

```typescript
function mapSessionMessage(row: SessionMessageRow): SessionMessageEntry {
  return {
    id: row.id,
    threadId: row.thread_id,
    threadTitle: row.thread_title,
    role: row.role,
    content: row.content,
    phase: row.phase,
    tokenCount: row.token_count,
    workspaceHash: row.workspace_hash,
    createdAt: row.created_at
  };
}
```

- [ ] **Step 7: Enforce current/all filtering**

Inside `searchRows`, add the workspace filter before building `whereClause`:

```typescript
if (input.workspaceScope === 'current') {
  if (input.workspaceHash === undefined || input.workspaceHash === null || input.workspaceHash.trim().length === 0) {
    throw new Error('session_search_workspace_required');
  }
  filters.push('sm.workspace_hash = ?');
  params.push(input.workspaceHash);
}
```

Keep `workspaceScope: 'all'` unfiltered.

- [ ] **Step 8: Run focused verification**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/session-repository.test.ts
```

Expected:

```text
PASS tests/main/plugins/agent/session-repository.test.ts
```

---

### Task 2: Workspace Scope Utilities

**Files:**
- Create: `src/main/services/deep-agent/context/workspace-scope.ts`
- Create: `tests/main/services/deep-agent/context/workspace-scope.test.ts`

**Interfaces:**
- Consumes: `buildWorkspaceHash(workspacePath: string)` from `src/main/services/paths`
- Produces: `type RuntimeWorkspaceIdentity = { path: string; hash: string } | null`
- Produces: `resolveRuntimeWorkspaceIdentity(workspacePath: string | null): RuntimeWorkspaceIdentity`
- Produces: `resolveSessionSearchWorkspaceHash(input: { scope: 'current' | 'all'; runtimeWorkspacePath: string | null }): string | null`

- [ ] **Step 1: Write failing tests**

Create `tests/main/services/deep-agent/context/workspace-scope.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import {
  resolveRuntimeWorkspaceIdentity,
  resolveSessionSearchWorkspaceHash
} from '../../../../../src/main/services/deep-agent/context/workspace-scope';
import { buildWorkspaceHash } from '../../../../../src/main/services/paths';

describe('workspace scope utilities', () => {
  it('derives workspace hash from the real Windows workspace path', () => {
    const identity = resolveRuntimeWorkspaceIdentity('F:\\Code\\Roc');

    expect(identity).toEqual({
      path: 'F:\\Code\\Roc',
      hash: buildWorkspaceHash('F:\\Code\\Roc')
    });
  });

  it('returns null identity when no workspace exists', () => {
    expect(resolveRuntimeWorkspaceIdentity(null)).toBeNull();
  });

  it('requires a runtime workspace for current scoped session search', () => {
    expect(() =>
      resolveSessionSearchWorkspaceHash({
        scope: 'current',
        runtimeWorkspacePath: null
      })
    ).toThrow('session_search_workspace_required');
  });

  it('does not require workspace hash for all scoped session search', () => {
    expect(
      resolveSessionSearchWorkspaceHash({
        scope: 'all',
        runtimeWorkspacePath: null
      })
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run failing test**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/context/workspace-scope.test.ts
```

Expected before implementation:

```text
FAIL tests/main/services/deep-agent/context/workspace-scope.test.ts
```

- [ ] **Step 3: Implement workspace scope utilities**

Create `src/main/services/deep-agent/context/workspace-scope.ts`:

```typescript
import { buildWorkspaceHash } from '../../paths';

export type RuntimeWorkspaceIdentity = {
  path: string;
  hash: string;
};

export function resolveRuntimeWorkspaceIdentity(workspacePath: string | null): RuntimeWorkspaceIdentity | null {
  if (workspacePath === null) {
    return null;
  }
  const trimmed = workspacePath.trim();
  if (trimmed.length === 0) {
    throw new Error('workspace_path_empty');
  }
  return {
    path: trimmed,
    hash: buildWorkspaceHash(trimmed)
  };
}

export function resolveSessionSearchWorkspaceHash(input: {
  scope: 'current' | 'all';
  runtimeWorkspacePath: string | null;
}): string | null {
  if (input.scope === 'all') {
    return null;
  }
  const identity = resolveRuntimeWorkspaceIdentity(input.runtimeWorkspacePath);
  if (identity === null) {
    throw new Error('session_search_workspace_required');
  }
  return identity.hash;
}
```

- [ ] **Step 4: Run focused verification**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/context/workspace-scope.test.ts
```

Expected:

```text
PASS tests/main/services/deep-agent/context/workspace-scope.test.ts
```

---

### Task 3: Session Search Tool

**Files:**
- Create: `src/main/services/deep-agent/context/session-search-tool.ts`
- Create: `tests/main/services/deep-agent/context/session-search-tool.test.ts`

**Interfaces:**
- Consumes: `resolveSessionSearchWorkspaceHash(input)`
- Consumes: adapter function `(request: SessionMessageSearchRequest) => Promise<SessionMessageSearchResult> | SessionMessageSearchResult`
- Produces: `createSessionSearchTool(input: { runtimeWorkspacePath: string | null; search: SessionSearchAdapter }): DynamicStructuredTool`
- Produces compact JSON string results with only `threadId`, `threadTitle`, `role`, `snippet`, `createdAt`

- [ ] **Step 1: Write failing tests**

Create `tests/main/services/deep-agent/context/session-search-tool.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { createSessionSearchTool } from '../../../../../src/main/services/deep-agent/context/session-search-tool';
import { buildWorkspaceHash } from '../../../../../src/main/services/paths';
import type { SessionMessageSearchRequest, SessionMessageSearchResult } from '../../../../../src/shared/types';

describe('createSessionSearchTool', () => {
  it('creates a session_search tool that defaults to current scope when a workspace exists', async () => {
    const requests: SessionMessageSearchRequest[] = [];
    const tool = createSessionSearchTool({
      runtimeWorkspacePath: 'F:\\Code\\Roc',
      search: (request) => {
        requests.push(request);
        return resultWithContent('Full content should not be returned', 'matching **snippet**');
      }
    });

    const output = await tool.invoke({ query: 'memory' });
    const parsed = JSON.parse(output);

    expect(tool.name).toBe('session_search');
    expect(requests).toEqual([
      {
        query: 'memory',
        workspaceScope: 'current',
        workspaceHash: buildWorkspaceHash('F:\\Code\\Roc'),
        limit: 5
      }
    ]);
    expect(parsed.items).toEqual([
      {
        threadId: 'thread_1',
        threadTitle: 'Thread title',
        role: 'assistant',
        snippet: 'matching **snippet**',
        createdAt: '2026-06-24T00:00:00.000Z'
      }
    ]);
    expect(JSON.stringify(parsed)).not.toContain('Full content should not be returned');
  });

  it('defaults to all scope when no workspace exists', async () => {
    const requests: SessionMessageSearchRequest[] = [];
    const tool = createSessionSearchTool({
      runtimeWorkspacePath: null,
      search: (request) => {
        requests.push(request);
        return resultWithContent('content', 'snippet');
      }
    });

    await tool.invoke({ query: 'memory' });

    expect(requests[0]).toMatchObject({
      query: 'memory',
      workspaceScope: 'all',
      workspaceHash: null,
      limit: 5
    });
  });

  it('returns a clear error when current scope is requested without a workspace', async () => {
    const tool = createSessionSearchTool({
      runtimeWorkspacePath: null,
      search: () => resultWithContent('content', 'snippet')
    });

    await expect(tool.invoke({ query: 'memory', scope: 'current' })).rejects.toThrow('session_search_workspace_required');
  });
});

function resultWithContent(content: string, snippet: string): SessionMessageSearchResult {
  return {
    query: 'memory',
    total: 1,
    items: [
      {
        id: 'smsg_1',
        threadId: 'thread_1',
        threadTitle: 'Thread title',
        role: 'assistant',
        content,
        phase: 'visible',
        tokenCount: null,
        workspaceHash: 'workspace_hash',
        createdAt: '2026-06-24T00:00:00.000Z',
        snippet
      }
    ]
  };
}
```

- [ ] **Step 2: Run failing test**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/context/session-search-tool.test.ts
```

Expected before implementation:

```text
FAIL tests/main/services/deep-agent/context/session-search-tool.test.ts
```

- [ ] **Step 3: Implement the tool**

Create `src/main/services/deep-agent/context/session-search-tool.ts`:

```typescript
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

import type { SessionMessageSearchRequest, SessionMessageSearchResult } from '../../../../shared/types';
import { resolveSessionSearchWorkspaceHash } from './workspace-scope';

export type SessionSearchAdapter = (
  request: SessionMessageSearchRequest
) => Promise<SessionMessageSearchResult> | SessionMessageSearchResult;

const sessionSearchSchema = z.object({
  query: z.string().min(1),
  scope: z.enum(['current', 'all']).optional(),
  sinceDays: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(20).optional()
});

export function createSessionSearchTool(input: {
  runtimeWorkspacePath: string | null;
  search: SessionSearchAdapter;
}): DynamicStructuredTool<typeof sessionSearchSchema> {
  return new DynamicStructuredTool({
    name: 'session_search',
    description:
      'Search compact snippets from past Roc conversations. Use scope=current for this workspace, or scope=all for all visible history.',
    schema: sessionSearchSchema,
    func: async (args) => {
      const normalizedQuery = args.query.trim();
      if (normalizedQuery.length === 0) {
        return JSON.stringify({ query: '', total: 0, items: [] });
      }
      const scope = args.scope === undefined ? (input.runtimeWorkspacePath === null ? 'all' : 'current') : args.scope;
      const workspaceHash = resolveSessionSearchWorkspaceHash({
        scope,
        runtimeWorkspacePath: input.runtimeWorkspacePath
      });
      const result = await input.search({
        query: normalizedQuery,
        workspaceScope: scope,
        workspaceHash,
        ...(args.sinceDays === undefined ? {} : { sinceDays: args.sinceDays }),
        limit: args.limit === undefined ? 5 : args.limit
      });
      return JSON.stringify({
        query: result.query,
        total: result.total,
        items: result.items.map(item => ({
          threadId: item.threadId,
          threadTitle: item.threadTitle,
          role: item.role,
          snippet: item.snippet,
          createdAt: item.createdAt
        }))
      });
    }
  });
}
```

- [ ] **Step 4: Run focused verification**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/context/session-search-tool.test.ts tests/main/services/deep-agent/context/workspace-scope.test.ts
```

Expected:

```text
PASS tests/main/services/deep-agent/context/session-search-tool.test.ts
PASS tests/main/services/deep-agent/context/workspace-scope.test.ts
```

---

### Task 4: Prompt Blocks And Serialization

**Files:**
- Create: `src/main/services/deep-agent/context/prompt-blocks.ts`
- Create: `src/main/services/deep-agent/context/prompt-serialization.ts`
- Modify: `src/main/services/deep-agent/prompt.ts`
- Modify: `src/main/services/deep-agent/prompt-builder.ts`
- Modify: `tests/main/deep-agent-prompt.test.ts`
- Create: `tests/main/services/deep-agent/context/prompt-blocks.test.ts`

**Interfaces:**
- Produces: `enum BlockStability`
- Produces: `type PromptBlockType = 'static' | 'workspace' | 'tools' | 'capability' | 'context_recall' | 'workflow'`
- Produces: `type PromptBlock = { type: PromptBlockType; content: string; stability: BlockStability; hash: string }`
- Produces: `buildPromptBlocks(input): PromptBlock[]`
- Produces: `serializePromptBlocks(blocks: readonly PromptBlock[]): string`
- Produces: `buildSystemPrompt(input): string` as a thin compatibility wrapper

- [ ] **Step 1: Write failing prompt block tests**

Create `tests/main/services/deep-agent/context/prompt-blocks.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { buildPromptBlocks } from '../../../../../src/main/services/deep-agent/context/prompt-blocks';
import { serializePromptBlocks } from '../../../../../src/main/services/deep-agent/context/prompt-serialization';

const enabledCapabilities = {
  mcpServers: ['filesystem'],
  skills: ['typescript']
};

describe('prompt blocks', () => {
  it('builds production blocks in stable order', () => {
    const blocks = buildPromptBlocks({
      enabledCapabilities,
      workspacePath: 'F:\\Code\\Roc',
      workflowHint: null,
      tools: [
        {
          name: 'session_search',
          description: 'Search prior conversations'
        }
      ]
    });

    expect(blocks.map(block => block.type)).toEqual([
      'static',
      'workspace',
      'tools',
      'capability',
      'context_recall',
      'workflow'
    ]);
  });

  it('serializes production prompt with block markers', () => {
    const prompt = serializePromptBlocks(
      buildPromptBlocks({
        enabledCapabilities,
        workspacePath: 'F:\\Code\\Roc',
        workflowHint: null,
        tools: [
          {
            name: 'session_search',
            description: 'Search prior conversations'
          }
        ]
      })
    );

    expect(prompt).toContain('<!-- BLOCK:static:static:');
    expect(prompt).toContain('<!-- BLOCK:workspace:workspace:');
    expect(prompt).toContain('<!-- BLOCK:tools:capability:');
    expect(prompt).toContain('<!-- BLOCK:context_recall:workspace:');
    expect(prompt).toContain('session_search');
    expect(prompt).toContain('F:\\Code\\Roc');
  });
});
```

- [ ] **Step 2: Update compatibility prompt tests to require markers**

In `tests/main/deep-agent-prompt.test.ts`, add or update one assertion in the existing `buildSystemPrompt` tests:

```typescript
expect(prompt).toContain('<!-- BLOCK:static:static:');
expect(prompt).toContain('<!-- BLOCK:context_recall:workspace:');
```

- [ ] **Step 3: Run failing prompt tests**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/context/prompt-blocks.test.ts tests/main/deep-agent-prompt.test.ts
```

Expected before implementation:

```text
FAIL tests/main/services/deep-agent/context/prompt-blocks.test.ts
```

- [ ] **Step 4: Implement prompt block builder**

Create `src/main/services/deep-agent/context/prompt-blocks.ts`:

```typescript
import { createHash } from 'node:crypto';

import type { ChatStartRunRequest, WorkflowHint } from '../../../../shared/types';
import { ROC_FILE_TOOL_PROMPT_LINES } from '../filesystem-tool-contract';
import { BACKGROUND_TASK_CREATION_WORKFLOW_OVERVIEW, createCapabilitySummary } from '../prompt';

export enum BlockStability {
  STATIC = 'static',
  WORKSPACE = 'workspace',
  CAPABILITY = 'capability',
  REQUEST = 'request'
}

export type PromptBlockType = 'static' | 'workspace' | 'tools' | 'capability' | 'context_recall' | 'workflow';

export type PromptToolDescriptor = {
  name: string;
  description: string;
};

export type PromptBlock = {
  type: PromptBlockType;
  content: string;
  stability: BlockStability;
  hash: string;
};

export function buildPromptBlocks(input: {
  enabledCapabilities: ChatStartRunRequest['enabledCapabilities'];
  workspacePath: string | null;
  workflowHint: WorkflowHint;
  tools: readonly PromptToolDescriptor[];
}): PromptBlock[] {
  return [
    createBlock('static', BlockStability.STATIC, buildStaticPrompt()),
    createBlock('workspace', BlockStability.WORKSPACE, buildWorkspacePrompt(input.workspacePath)),
    createBlock('tools', BlockStability.CAPABILITY, buildToolsPrompt(input.tools)),
    createBlock('capability', BlockStability.CAPABILITY, `Capabilities: ${createCapabilitySummary(input.enabledCapabilities)}`),
    createBlock('context_recall', BlockStability.WORKSPACE, buildContextRecallPrompt(input.workspacePath)),
    createBlock('workflow', BlockStability.REQUEST, buildWorkflowPrompt(input.workflowHint))
  ];
}

function buildStaticPrompt(): string {
  return [
    'You are Roc, a long-running personal assistant on Windows. Be concise; claim only inspected evidence.',
    'Before changing files, inspect the relevant source, tests, and configuration.',
    'Keep edits scoped to the user request; do not refactor or touch adjacent code as cleanup.',
    'For code or configuration changes, run direct verification before claiming completion.',
    '',
    'Persistent memory is stored in Roc SQLite through DeepAgents memory and is visible in later sessions:',
    '  /memory/global/USER.md      - user identity, preferences, comm style (~500 tok cap)',
    '  /memory/global/AGENTS.md    - global default rules (~300 tok cap)',
    '  /memory/global/MEMORY.md    - global long-term facts (~800 tok cap)',
    '  /memory/workspaces/current/AGENTS.md   - workspace-specific rules (overrides global if exists)',
    '  /memory/workspaces/current/MEMORY.md   - workspace-specific facts (overrides global if exists)',
    '',
    'Use Edit/Write on those paths. On capacity overflow you receive "X/Y, please consolidate" - read the file, merge/drop redundant entries via Edit, then retry.',
    'Automatic writes only append to MEMORY.md; USER.md and AGENTS.md change only through explicit file edits.',
    '',
    'For SKILL.md: read silently; never quote, paraphrase, or summarize.'
  ].join('\n');
}

function buildWorkspacePrompt(workspacePath: string | null): string {
  if (workspacePath === null) {
    return [
      'Workspace: not selected.',
      'Default command cwd: unavailable; ask user to select workspace before local command operations.'
    ].join('\n');
  }
  return [
    `Workspace: ${workspacePath}`,
    ...ROC_FILE_TOOL_PROMPT_LINES,
    'After write_file or edit_file, verify the target via read_file or ls before saying the file was created or changed.'
  ].join('\n');
}

function buildToolsPrompt(tools: readonly PromptToolDescriptor[]): string {
  if (tools.length === 0) {
    return 'Available Tools: none';
  }
  return ['Available Tools:', ...tools.map(tool => `- ${tool.name}: ${tool.description}`)].join('\n');
}

function buildContextRecallPrompt(workspacePath: string | null): string {
  const defaultScope = workspacePath === null ? 'all' : 'current';
  return [
    'Use session_search to recall compact snippets from past Roc conversations only when prior context is needed.',
    `Default session_search scope: ${defaultScope}.`,
    'Use scope=all only when the user asks for cross-workspace history or current scoped recall is insufficient.',
    'Session search returns snippets, not full transcript content.'
  ].join('\n');
}

function buildWorkflowPrompt(workflowHint: WorkflowHint): string {
  if (workflowHint === 'propose_background_task') {
    return BACKGROUND_TASK_CREATION_WORKFLOW_OVERVIEW.join('\n');
  }
  if (workflowHint === 'background_task_change') {
    return [
      '本轮工作流：修改已有后台任务。',
      '可用工具：read_background_task / update_background_task / cancel_background_task。',
      'update / cancel 会触发用户审批；read 用于先看清楚再改。',
      '如果缺少 taskId、当前状态或触发规则，先调用 read_background_task；信息已经明确时可以直接 update 或 cancel。',
      'update patch 只包含用户明确要求改变的字段；不要猜测未提及配置。'
    ].join('\n');
  }
  return 'Workflow: default chat run.';
}

function createBlock(type: PromptBlockType, stability: BlockStability, content: string): PromptBlock {
  return {
    type,
    content,
    stability,
    hash: createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16)
  };
}
```

- [ ] **Step 5: Implement prompt serialization**

Create `src/main/services/deep-agent/context/prompt-serialization.ts`:

```typescript
import type { PromptBlock } from './prompt-blocks';

export function serializePromptBlocks(blocks: readonly PromptBlock[]): string {
  return blocks
    .map(block => [`<!-- BLOCK:${block.type}:${block.stability}:${block.hash} -->`, block.content].join('\n'))
    .join('\n');
}
```

- [ ] **Step 6: Make old prompt entrypoints delegate**

In `src/main/services/deep-agent/prompt.ts`, keep `BACKGROUND_TASK_CREATION_WORKFLOW_OVERVIEW` and `createCapabilitySummary`, but replace `buildSystemPrompt` body with:

```typescript
import { buildPromptBlocks } from './context/prompt-blocks';
import { serializePromptBlocks } from './context/prompt-serialization';

export function buildSystemPrompt(input: {
  enabledCapabilities: ChatStartRunRequest['enabledCapabilities'];
  workspacePath: string | null;
  workflowHint: WorkflowHint;
}): string {
  return serializePromptBlocks(
    buildPromptBlocks({
      enabledCapabilities: input.enabledCapabilities,
      workspacePath: input.workspacePath,
      workflowHint: input.workflowHint,
      tools: []
    })
  );
}
```

In `src/main/services/deep-agent/prompt-builder.ts`, remove duplicated prompt content and re-export the new prompt block API:

```typescript
export {
  BlockStability,
  buildPromptBlocks,
  type PromptBlock,
  type PromptBlockType,
  type PromptToolDescriptor
} from './context/prompt-blocks';
export { serializePromptBlocks } from './context/prompt-serialization';
```

- [ ] **Step 7: Run focused verification**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/context/prompt-blocks.test.ts tests/main/deep-agent-prompt.test.ts
```

Expected:

```text
PASS tests/main/services/deep-agent/context/prompt-blocks.test.ts
PASS tests/main/deep-agent-prompt.test.ts
```

---

### Task 5: Prompt Caching Uses Production Markers

**Files:**
- Modify: `src/main/services/forge-guardrails/middleware/prompt-caching.ts`
- Modify: `tests/main/services/forge-guardrails/middleware/prompt-caching.test.ts`
- Modify: `tests/main/services/forge-guardrails/prompt-caching.test.ts`

**Interfaces:**
- Consumes: `PromptBlock`, `BlockStability` from `src/main/services/deep-agent/context/prompt-blocks.ts`
- Consumes: production prompt string from `serializePromptBlocks(buildPromptBlocks(...))`
- Produces: Anthropic-compatible middleware with `cache_control` injected for marked blocks

- [ ] **Step 1: Write production prompt caching test**

Add this test to `tests/main/services/forge-guardrails/middleware/prompt-caching.test.ts`:

```typescript
import { SystemMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';

import { buildPromptBlocks } from '../../../../../src/main/services/deep-agent/context/prompt-blocks';
import { serializePromptBlocks } from '../../../../../src/main/services/deep-agent/context/prompt-serialization';
import { createPromptCachingMiddleware } from '../../../../../src/main/services/forge-guardrails/middleware/prompt-caching';

it('injects cache_control from a production serialized prompt for Anthropic-compatible providers', async () => {
  const prompt = serializePromptBlocks(
    buildPromptBlocks({
      enabledCapabilities: { mcpServers: [], skills: [] },
      workspacePath: 'F:\\Code\\Roc',
      workflowHint: null,
      tools: [{ name: 'session_search', description: 'Search prior conversations' }]
    })
  );
  const middleware = createPromptCachingMiddleware({
    providerType: 'anthropic_compatible',
    strategy: 'balanced'
  });
  const handler = vi.fn(async request => request);

  const result = await middleware.wrapModelCall(
    {
      messages: [new SystemMessage(prompt)]
    } as never,
    handler as never
  );
  const systemMessage = result.messages[0] as SystemMessage;

  expect(handler).toHaveBeenCalledTimes(1);
  expect(systemMessage.content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'text',
        cache_control: { type: 'ephemeral' }
      })
    ])
  );
});
```

If the existing middleware test helper calls `wrapModelCall` differently, keep the local helper style but use the same production prompt construction.

- [ ] **Step 2: Run failing prompt caching test**

Run:

```powershell
pnpm test -- tests/main/services/forge-guardrails/middleware/prompt-caching.test.ts tests/main/services/forge-guardrails/prompt-caching.test.ts
```

Expected before implementation:

```text
FAIL
```

The expected failure is an import path mismatch or marker parsing mismatch.

- [ ] **Step 3: Update imports and parser type source**

In `src/main/services/forge-guardrails/middleware/prompt-caching.ts`, change imports:

```typescript
import type { PromptBlock } from '../../deep-agent/context/prompt-blocks';
import { BlockStability } from '../../deep-agent/context/prompt-blocks';
```

Keep parser marker format:

```typescript
const blockRegex = /<!-- BLOCK:(\w+):(\w+):(\w+) -->\n([\s\S]*?)(?=<!-- BLOCK:|\n*$)/g;
```

Verify the `PromptBlock['type']` union accepts `context_recall` and `workflow`.

- [ ] **Step 4: Run focused verification**

Run:

```powershell
pnpm test -- tests/main/services/forge-guardrails/middleware/prompt-caching.test.ts tests/main/services/forge-guardrails/prompt-caching.test.ts
```

Expected:

```text
PASS
```

---

### Task 6: Memory Promotion And Run Summary Policy

**Files:**
- Create: `src/main/services/deep-agent/context/run-summary.ts`
- Create: `src/main/services/deep-agent/context/memory-promotion.ts`
- Modify: `src/main/services/memory/auto-memory-writer.ts`
- Create: `tests/main/services/deep-agent/context/run-summary.test.ts`
- Create: `tests/main/services/deep-agent/context/memory-promotion.test.ts`
- Add or update: `tests/main/services/memory/auto-memory-writer.test.ts` if this file exists; otherwise keep coverage in `memory-promotion.test.ts`.

**Interfaces:**
- Produces: `buildRunSummary(input: RunSummaryInput): string | null`
- Produces: `buildMemoryPromotionBullet(input: MemoryPromotionInput): string | null`
- Consumes: `AgentRunCompletedPayload`
- Preserves: `AutoMemoryWriter` writes through `MemoryStoreRepository.writeFile({ scope, kind: 'memory', content }, workspaceOverride)`

- [ ] **Step 1: Write run summary tests**

Create `tests/main/services/deep-agent/context/run-summary.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { buildRunSummary } from '../../../../../src/main/services/deep-agent/context/run-summary';

describe('buildRunSummary', () => {
  it('returns a bounded factual summary from final assistant text', () => {
    const summary = buildRunSummary({
      assistantMessage: 'Implemented workspace scoped session search and verified focused tests.',
      successfulToolNames: ['session_search'],
      workflowHint: null
    });

    expect(summary).toBe('Implemented workspace scoped session search and verified focused tests.');
  });

  it('skips empty output and tool-only noise', () => {
    expect(
      buildRunSummary({
        assistantMessage: '',
        successfulToolNames: ['ls', 'grep'],
        workflowHint: null
      })
    ).toBeNull();
  });

  it('bounds long summaries', () => {
    const summary = buildRunSummary({
      assistantMessage: 'A'.repeat(500),
      successfulToolNames: [],
      workflowHint: null
    });

    expect(summary).toHaveLength(240);
  });
});
```

- [ ] **Step 2: Write memory promotion tests**

Create `tests/main/services/deep-agent/context/memory-promotion.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { buildMemoryPromotionBullet } from '../../../../../src/main/services/deep-agent/context/memory-promotion';

describe('buildMemoryPromotionBullet', () => {
  it('builds a factual MEMORY.md bullet with run traceability', () => {
    expect(
      buildMemoryPromotionBullet({
        runId: 'run_123',
        summary: 'Verified workspace scoped session recall.'
      })
    ).toBe('- run_123: Verified workspace scoped session recall.');
  });

  it('skips empty summaries', () => {
    expect(
      buildMemoryPromotionBullet({
        runId: 'run_123',
        summary: ''
      })
    ).toBeNull();
  });

  it('does not create USER.md or AGENTS.md targets', () => {
    const bullet = buildMemoryPromotionBullet({
      runId: 'run_123',
      summary: 'Updated memory promotion.'
    });

    expect(bullet).not.toContain('USER.md');
    expect(bullet).not.toContain('AGENTS.md');
  });
});
```

- [ ] **Step 3: Run failing tests**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/context/run-summary.test.ts tests/main/services/deep-agent/context/memory-promotion.test.ts
```

Expected before implementation:

```text
FAIL
```

- [ ] **Step 4: Implement run summary**

Create `src/main/services/deep-agent/context/run-summary.ts`:

```typescript
import type { WorkflowHint } from '../../../../shared/types';

export type RunSummaryInput = {
  assistantMessage: string;
  successfulToolNames: readonly string[];
  workflowHint: WorkflowHint;
};

const MAX_SUMMARY_CHARS = 240;

export function buildRunSummary(input: RunSummaryInput): string | null {
  const normalized = normalizeWhitespace(input.assistantMessage);
  if (normalized.length === 0) {
    return null;
  }
  if (isToolOnlyNoise(normalized, input.successfulToolNames)) {
    return null;
  }
  if (normalized.length <= MAX_SUMMARY_CHARS) {
    return normalized;
  }
  return normalized.slice(0, MAX_SUMMARY_CHARS);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function isToolOnlyNoise(message: string, toolNames: readonly string[]): boolean {
  if (message.length > 0) {
    return false;
  }
  return toolNames.length > 0;
}
```

- [ ] **Step 5: Implement memory promotion bullet**

Create `src/main/services/deep-agent/context/memory-promotion.ts`:

```typescript
export type MemoryPromotionInput = {
  runId: string;
  summary: string | null;
};

export function buildMemoryPromotionBullet(input: MemoryPromotionInput): string | null {
  if (input.summary === null) {
    return null;
  }
  const summary = input.summary.trim();
  if (summary.length === 0) {
    return null;
  }
  const runId = input.runId.trim();
  if (runId.length === 0) {
    throw new Error('memory_promotion_run_id_empty');
  }
  return `- ${runId}: ${summary}`;
}
```

- [ ] **Step 6: Wire AutoMemoryWriter to policy**

In `src/main/services/memory/auto-memory-writer.ts`, import:

```typescript
import { buildMemoryPromotionBullet } from '../deep-agent/context/memory-promotion';
```

Replace direct bullet construction:

```typescript
const bullet = buildMemoryPromotionBullet({
  runId: payload.runId,
  summary
});
if (bullet === null) {
  return;
}
```

Keep the existing target:

```typescript
const targetScope: MemoryScope = this.options.repository.hasWorkspace(workspaceOverride) ? 'workspace' : 'global';
await this.options.repository.writeFile({
  scope: targetScope,
  kind: 'memory',
  content: next
}, workspaceOverride);
```

Do not add writes for `kind: 'user'` or `kind: 'agents'`.

- [ ] **Step 7: Run focused verification**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/context/run-summary.test.ts tests/main/services/deep-agent/context/memory-promotion.test.ts
```

Expected:

```text
PASS
```

---

### Task 7: Context Assembler And Executor Integration

**Files:**
- Create: `src/main/services/deep-agent/context/context-assembler.ts`
- Create: `tests/main/services/deep-agent/context/context-assembler.test.ts`
- Modify: `src/main/plugins/agent/deep-agent-executor.ts`
- Modify: `tests/main/plugins/agent/deep-agent-executor-tools.test.ts`
- Modify: `tests/main/deep-agent-build-wiring.test.ts`

**Interfaces:**
- Consumes: `createSessionSearchTool`
- Consumes: `buildPromptBlocks` and `serializePromptBlocks`
- Consumes: existing run tools from `createExecutorTools`
- Produces: `type ContextHarness = { systemPrompt: string; tools: ClientTool[]; memorySources: string[]; skillSources: string[]; workspaceIdentity: RuntimeWorkspaceIdentity | null }`
- Produces: `assembleContextHarness(input): ContextHarness`

- [ ] **Step 1: Write context assembler test**

Create `tests/main/services/deep-agent/context/context-assembler.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { assembleContextHarness } from '../../../../../src/main/services/deep-agent/context/context-assembler';

describe('assembleContextHarness', () => {
  it('adds session_search and serializes prompt markers', () => {
    const harness = assembleContextHarness({
      enabledCapabilities: { mcpServers: [], skills: [] },
      workflowHint: null,
      workspacePath: 'F:\\Code\\Roc',
      memorySources: ['/memory/global/AGENTS.md'],
      baseTools: [],
      searchSessions: () => ({ query: 'x', total: 0, items: [] })
    });

    expect(harness.tools.map(tool => tool.name)).toContain('session_search');
    expect(harness.systemPrompt).toContain('<!-- BLOCK:static:static:');
    expect(harness.systemPrompt).toContain('<!-- BLOCK:context_recall:workspace:');
    expect(harness.skillSources).toEqual([]);
    expect(harness.memorySources).toEqual(['/memory/global/AGENTS.md']);
    expect(harness.workspaceIdentity).toMatchObject({
      path: 'F:\\Code\\Roc'
    });
  });

  it('exposes selected skills through /skills/', () => {
    const harness = assembleContextHarness({
      enabledCapabilities: { mcpServers: [], skills: ['typescript'] },
      workflowHint: null,
      workspacePath: null,
      memorySources: [],
      baseTools: [],
      searchSessions: () => ({ query: 'x', total: 0, items: [] })
    });

    expect(harness.skillSources).toEqual(['/skills/']);
  });
});
```

- [ ] **Step 2: Update executor tool test expectation**

In `tests/main/plugins/agent/deep-agent-executor-tools.test.ts`, add an assertion to the test that inspects run tool names:

```typescript
expect(toolNames).toContain('session_search');
```

If the helper currently only sees tools before context assembly, move the assertion to `tests/main/deep-agent-build-wiring.test.ts` where `buildDeepAgent` input is captured.

- [ ] **Step 3: Run failing integration tests**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/context/context-assembler.test.ts tests/main/plugins/agent/deep-agent-executor-tools.test.ts tests/main/deep-agent-build-wiring.test.ts
```

Expected before implementation:

```text
FAIL
```

- [ ] **Step 4: Implement context assembler**

Create `src/main/services/deep-agent/context/context-assembler.ts`:

```typescript
import type { ClientTool } from '@langchain/core/tools';

import type { ChatStartRunRequest, SessionMessageSearchResult, WorkflowHint } from '../../../../shared/types';
import { buildPromptBlocks } from './prompt-blocks';
import { serializePromptBlocks } from './prompt-serialization';
import { createSessionSearchTool } from './session-search-tool';
import { resolveRuntimeWorkspaceIdentity, type RuntimeWorkspaceIdentity } from './workspace-scope';
import type { SessionSearchAdapter } from './session-search-tool';

export type ContextHarness = {
  systemPrompt: string;
  tools: ClientTool[];
  memorySources: string[];
  skillSources: string[];
  workspaceIdentity: RuntimeWorkspaceIdentity | null;
};

export function assembleContextHarness(input: {
  enabledCapabilities: ChatStartRunRequest['enabledCapabilities'];
  workflowHint: WorkflowHint;
  workspacePath: string | null;
  memorySources: string[];
  baseTools: ClientTool[];
  searchSessions: SessionSearchAdapter;
}): ContextHarness {
  const sessionSearchTool = createSessionSearchTool({
    runtimeWorkspacePath: input.workspacePath,
    search: input.searchSessions
  });
  const tools = [...input.baseTools, sessionSearchTool];
  const promptBlocks = buildPromptBlocks({
    enabledCapabilities: input.enabledCapabilities,
    workspacePath: input.workspacePath,
    workflowHint: input.workflowHint,
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description
    }))
  });
  return {
    systemPrompt: serializePromptBlocks(promptBlocks),
    tools,
    memorySources: input.memorySources,
    skillSources: input.enabledCapabilities.skills.length === 0 ? [] : ['/skills/'],
    workspaceIdentity: resolveRuntimeWorkspaceIdentity(input.workspacePath)
  };
}
```

- [ ] **Step 5: Wire executor to assembler**

In `src/main/plugins/agent/deep-agent-executor.ts`, import:

```typescript
import { assembleContextHarness } from '../../services/deep-agent/context/context-assembler';
```

Replace `buildSystemPrompt` and direct skill source wiring:

```typescript
const contextHarness = assembleContextHarness({
  enabledCapabilities: input.request.enabledCapabilities,
  workflowHint: input.request.workflowHint === undefined ? null : input.request.workflowHint,
  workspacePath: runtimeWorkspace === null ? null : runtimeWorkspace.path,
  memorySources: runtimeBackend.memorySources,
  baseTools: tools.runTools,
  searchSessions: request => options.capabilities.invoke('agent.sessions.search', request)
});
const agent = buildDeepAgent({
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
  filesystemPermissions: createRocFilesystemPermissions(),
  workspacePath: runtimeWorkspace === null ? null : runtimeWorkspace.path,
  interruptOn: await readInterruptPolicy(options.capabilities, input.request.enabledCapabilities, input.request),
  checkpointer,
  providerType: handle.runtime.providerType,
  workflowHint: input.request.workflowHint ?? null,
  contextBudgetTokens: handle.runtime.contextBudgetTokens
});
```

Remove the now-unused `buildSystemPrompt` import.

- [ ] **Step 6: Run focused integration verification**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/context/context-assembler.test.ts tests/main/plugins/agent/deep-agent-executor-tools.test.ts tests/main/deep-agent-build-wiring.test.ts
```

Expected:

```text
PASS
```

---

### Task 8: Runtime Completion Workspace Hash And Summary

**Files:**
- Modify: `src/main/plugins/agent/runtime.ts`
- Modify: `src/main/plugins/agent/deep-agent-executor.ts`
- Modify: `tests/main/plugins/agent/runtime-approval.test.ts`
- Modify: `tests/main/plugins/agent/runtime-executor.test.ts`
- Modify: `tests/main/plugins/agent/runtime.test.ts`
- Modify: `tests/main/plugins/agent/deep-agent-executor.test.ts`

**Interfaces:**
- Consumes: `resolveRuntimeWorkspaceIdentity(workspacePath)`
- Consumes: `buildRunSummary(input)`
- Produces: `completeRun` records `workspaceHash` on assistant session message
- Produces: `agent.run.completed.summary` from deterministic summary builder when possible

- [ ] **Step 1: Write runtime completion test**

Add this test to the runtime test file that already covers `completeRun`:

```typescript
it('records assistant session messages with workspace hash on completion', async () => {
  const runtime = createRuntimeUnderTest();
  const run = runtime.startRun({
    input: 'Summarize',
    modelId: 'openai:gpt-4.1',
    enabledCapabilities,
    workspacePath: 'F:\\Code\\Roc'
  });

  const result = await runtime.completeRun({
    runId: run.id,
    assistantMessage: 'Done',
    summary: 'Done',
    durationMs: 10,
    providerId: 'openai',
    modelId: 'gpt-4.1',
    workspacePath: 'F:\\Code\\Roc'
  });

  expect(result.message.workspaceHash).toBe(buildWorkspaceHash('F:\\Code\\Roc'));
});
```

Use the local runtime factory names from the existing test file. Import `buildWorkspaceHash` from `src/main/services/paths`.

- [ ] **Step 2: Write executor summary test**

In `tests/main/plugins/agent/deep-agent-executor.test.ts`, add or update the completion expectation so `summary` is not a blind `slice(0, 120)` when final assistant text is longer than 120 characters:

```typescript
expect(completedPayload.summary).toBe('Implemented workspace scoped session search and verified focused tests.');
```

Use the existing stream fixture style to make the final assistant text exactly that sentence.

- [ ] **Step 3: Run failing runtime tests**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/runtime.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts
```

Expected before implementation:

```text
FAIL
```

- [ ] **Step 4: Record workspace hash in runtime**

In `src/main/plugins/agent/runtime.ts`, import:

```typescript
import { resolveRuntimeWorkspaceIdentity } from '../../services/deep-agent/context/workspace-scope';
```

Update `completeRun`:

```typescript
const workspaceIdentity = resolveRuntimeWorkspaceIdentity(input.workspacePath === undefined ? null : input.workspacePath);
const message = this.options.repository.recordSessionMessage({
  content: input.assistantMessage,
  role: 'assistant',
  threadId: run.threadId,
  workspaceHash: workspaceIdentity === null ? null : workspaceIdentity.hash
});
```

Keep `completedPayload.workspacePath` behavior unchanged.

- [ ] **Step 5: Build summary in executor**

In `src/main/plugins/agent/deep-agent-executor.ts`, import:

```typescript
import { buildRunSummary } from '../../services/deep-agent/context/run-summary';
```

Where `execution.summary` is currently derived from `assistantMessage.slice(0, 120)`, replace it with:

```typescript
const summary = buildRunSummary({
  assistantMessage: execution.assistantMessage,
  successfulToolNames: readFinalToolBlockEvents(execution.events)
    .filter(event => event.status === 'completed')
    .map(event => event.name),
  workflowHint: input.request.workflowHint ?? null
});
```

If the local event structure has different names, use the existing tool block event fields and keep the summary builder input type exact.

When `summary === null`, pass an empty string to the completion payload so `AutoMemoryWriter` skips promotion:

```typescript
summary: summary === null ? '' : summary
```

- [ ] **Step 6: Run focused verification**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/runtime.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts
```

Expected:

```text
PASS
```

---

### Task 9: Renderer And IPC Cleanup For Unsupported Global Scope

**Files:**
- Modify: `src/renderer/views/memory/sessions-tab.tsx`
- Modify: `tests/renderer/features/memory-feature.test.tsx`
- Modify: `tests/renderer/memory-view.test.tsx`
- Modify: `tests/main/ipc-plugin-adapter.test.ts`

**Interfaces:**
- Consumes: `SessionMessageSearchRequest.workspaceScope: 'current' | 'all'`
- Removes: UI and test references to `workspaceScope: 'global'`

- [ ] **Step 1: Write/update renderer expectations**

Update renderer tests so the memory session search request only uses `current` or `all`:

```typescript
expect(client.api.sessions.search).toHaveBeenCalledWith({
  query: 'memory',
  workspaceScope: 'current',
  sinceDays: 30,
  limit: 50
});
```

Add a select test that chooses `all` and expects `workspaceScope: 'all'`.

- [ ] **Step 2: Run failing renderer tests**

Run:

```powershell
pnpm test -- tests/renderer/features/memory-feature.test.tsx tests/renderer/memory-view.test.tsx tests/main/ipc-plugin-adapter.test.ts
```

Expected before cleanup:

```text
FAIL
```

The expected failure is either `global` still being present or zod schema rejection.

- [ ] **Step 3: Remove global from the UI**

In `src/renderer/views/memory/sessions-tab.tsx`, change:

```typescript
type WorkspaceScope = 'current' | 'all';
```

Remove:

```tsx
<option value="global">global</option>
```

Update parser:

```typescript
function readWorkspaceScope(value: string): WorkspaceScope {
  if (value === 'all') {
    return 'all';
  }
  return 'current';
}
```

- [ ] **Step 4: Update IPC adapter test fixture**

In `tests/main/ipc-plugin-adapter.test.ts`, keep the existing `sessions.search` mapping case but ensure the request fixture uses:

```typescript
{ query: 'memory', workspaceScope: 'current' }
```

or:

```typescript
{ query: 'memory', workspaceScope: 'all' }
```

- [ ] **Step 5: Run focused verification**

Run:

```powershell
pnpm test -- tests/renderer/features/memory-feature.test.tsx tests/renderer/memory-view.test.tsx tests/main/ipc-plugin-adapter.test.ts
```

Expected:

```text
PASS
```

---

### Task 10: Prompt Duplication And Boundary Regression Cleanup

**Files:**
- Modify: `src/main/services/deep-agent/prompt.ts`
- Modify: `src/main/services/deep-agent/prompt-builder.ts`
- Modify: `tests/main/deep-agent-prompt.test.ts`
- Modify: `tests/main/services/forge-guardrails/middleware/prompt-caching.test.ts`
- Run existing boundary tests without changing their contracts.

**Interfaces:**
- Ensures: There is one prompt content source under `src/main/services/deep-agent/context/prompt-blocks.ts`
- Ensures: File-tool routes remain `/workspace/`, `/memory/`, `/skills/`
- Ensures: Shell rejects `/workspace/...`
- Ensures: DeepAgents native `execute` remains unavailable

- [ ] **Step 1: Search for duplicate prompt body**

Run:

```powershell
rg -n "You are Roc|Use session_search|Persistent memory is stored|BACKGROUND_TASK_CREATION_WORKFLOW_OVERVIEW|SystemPromptBuilder" src tests
```

Expected after Tasks 4 to 9:

```text
src/main/services/deep-agent/context/prompt-blocks.ts:...
src/main/services/deep-agent/prompt.ts:...
tests/main/deep-agent-prompt.test.ts:...
```

There must not be a second static prompt body in `prompt-builder.ts`.

- [ ] **Step 2: Remove stale fixture-only assumptions**

If any prompt-caching test only parses hand-written marker fixtures, keep one degraded-path fixture test but ensure at least one test uses:

```typescript
serializePromptBlocks(buildPromptBlocks(...))
```

Do not delete degraded-path coverage for missing markers.

- [ ] **Step 3: Run context and boundary regression tests**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/filesystem-tool-contract.test.ts tests/main/services/deep-agent/filesystem-path-policy.test.ts tests/main/services/deep-agent/backend.test.ts tests/main/services/deep-agent/shell-path-policy.test.ts tests/main/deep-agent-build-wiring.test.ts tests/main/deep-agent-prompt.test.ts tests/main/plugins/agent/deep-agent-executor-tools.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts tests/main/plugins/agent/session-repository.test.ts
```

Expected:

```text
PASS
```

- [ ] **Step 4: Verify no unsupported `/agents/` or native execute path returned**

Run:

```powershell
rg -n "\"/agents|'/agents|execute\" src/main/services/deep-agent src/main/plugins/agent tests/main/services/deep-agent tests/main/plugins/agent
```

Expected:

```text
No new /agents route. No DeepAgents native execute exposure.
```

If `execute` appears in tests that assert it is blocked or absent, keep those tests.

---

### Task 11: Final Verification And Review

**Files:**
- No source files by default.
- Review all files changed by Tasks 1 to 10.

**Interfaces:**
- Produces: Verified passing evidence for the full context harness refactor.

- [ ] **Step 1: Run the focused context harness test set**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/context/workspace-scope.test.ts tests/main/services/deep-agent/context/session-search-tool.test.ts tests/main/services/deep-agent/context/prompt-blocks.test.ts tests/main/services/deep-agent/context/run-summary.test.ts tests/main/services/deep-agent/context/memory-promotion.test.ts tests/main/services/deep-agent/context/context-assembler.test.ts tests/main/services/forge-guardrails/middleware/prompt-caching.test.ts tests/main/plugins/agent/session-repository.test.ts
```

Expected:

```text
PASS
```

- [ ] **Step 2: Run existing high-value DeepAgents regression tests**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/filesystem-tool-contract.test.ts tests/main/services/deep-agent/filesystem-path-policy.test.ts tests/main/services/deep-agent/backend.test.ts tests/main/services/deep-agent/shell-path-policy.test.ts tests/main/deep-agent-build-wiring.test.ts tests/main/deep-agent-prompt.test.ts tests/main/plugins/agent/deep-agent-executor-tools.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts tests/main/plugins/agent/session-repository.test.ts
```

Expected:

```text
PASS
```

- [ ] **Step 3: Run renderer and IPC tests touched by scope cleanup**

Run:

```powershell
pnpm test -- tests/renderer/features/memory-feature.test.tsx tests/renderer/memory-view.test.tsx tests/main/ipc-plugin-adapter.test.ts
```

Expected:

```text
PASS
```

- [ ] **Step 4: Run typecheck**

Run:

```powershell
pnpm typecheck
```

Expected:

```text
No TypeScript errors.
```

- [ ] **Step 5: Run broad test suite if focused checks pass**

Run:

```powershell
pnpm test
```

Expected:

```text
PASS
```

- [ ] **Step 6: Run diff whitespace check**

Run:

```powershell
git diff --check
```

Expected:

```text
No output.
```

- [ ] **Step 7: Review changed files**

Run:

```powershell
git status --short
git diff -- src/shared/types/memory.ts src/main/plugins/agent/schema.ts src/main/plugins/agent/session-repository.ts src/main/plugins/agent/runtime.ts src/main/plugins/agent/deep-agent-executor.ts src/main/services/deep-agent src/main/services/forge-guardrails/middleware/prompt-caching.ts src/main/services/memory/auto-memory-writer.ts src/renderer/views/memory/sessions-tab.tsx
```

Expected review results:

```text
Session recall filters by session_messages.workspace_hash.
session_search is present in DeepAgent run tools.
Production prompt contains <!-- BLOCK:... --> markers.
Prompt caching test uses a production serialized prompt.
Automatic promotion writes only kind: 'memory'.
No /agents route is introduced.
No DeepAgents native execute is exposed.
Shell/file route boundaries are unchanged.
```

## Self-Review

Spec coverage:

- Working `session_search` tool: Task 3 and Task 7.
- Workspace-scoped session recall: Task 1, Task 2, Task 8.
- Production prompt markers: Task 4 and Task 7.
- Prompt caching on production prompt: Task 5.
- Memory promotion only to `MEMORY.md`: Task 6.
- Real Windows workspace identity: Task 2 and Task 8.
- DeepAgents native memory preserved: Global Constraints and Task 7 integration keep `memorySources`, `skillSources`, `backend`, `store`, and `checkpointer` in the DeepAgents path.
- File/shell boundaries preserved: Task 10 and Task 11.
- Unsupported `global` scope removed from public search shape: Task 1 and Task 9.

Placeholder scan:

- No unresolved placeholder keywords or unnamed edge handling steps.
- Each implementation task has exact file paths, function names, test snippets, and verification commands.

Type consistency:

- `workspaceHash` is consistently camelCase in TypeScript and `workspace_hash` in SQLite.
- Agent tool schema uses `scope?: 'current' | 'all'`; repository search request uses `workspaceScope: 'current' | 'all'`.
- `PromptBlock` and `BlockStability` move to `src/main/services/deep-agent/context/prompt-blocks.ts`, with old `prompt-builder.ts` as a re-export only.
