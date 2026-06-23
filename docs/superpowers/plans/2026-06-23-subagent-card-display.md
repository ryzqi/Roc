# Subagent Card Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the renderer-only subagent transcript block as a Codex-style independent work card.

**Architecture:** Keep the existing transcript and event contracts unchanged. Replace the inline `SubagentActivityView` rendering in `chat-message-row.tsx` with a focused `SubagentActivityCard` component that consumes the current `ChatTranscriptActivityBlock.kind === 'subagent'` shape, reuses existing reasoning/tool/Markdown renderers, and adds a dedicated stylesheet imported by the renderer CSS entrypoint.

**Tech Stack:** TypeScript, React 19, Vitest, server-side React markup tests, CSS modules by convention via global CSS imports, lucide-react icons.

## Global Constraints

- User-facing UI copy is Simplified Chinese unless it is an existing protocol/status/code identifier.
- This is renderer-only: do not modify `src/renderer/chat-transcript.ts`, shared types, main process code, or event payload contracts.
- Do not display `identity.taskInput` anywhere in the subagent card.
- Do not add a sidebar, global subagent panel, task detail layout rewrite, or new subagent state field.
- Preserve existing chat/task transcript reuse: the same component must work in chat and task detail surfaces.
- Current worktree contains unrelated modified files from earlier NVIDIA/subagent inheritance work; do not stage or commit them while implementing this plan.

---

## File Structure

- Modify: `tests/renderer/chat-message-row.test.ts`
  - Owns renderer SSR behavior coverage for assistant activity blocks.
  - Add concrete assertions for subagent card markup, default expansion, Chinese status labels, no task summary leakage, nested children, and meta chips.

- Create: `src/renderer/chat/subagent/SubagentActivityCard.tsx`
  - Owns rendering for `ChatTranscriptActivityBlock.kind === 'subagent'`.
  - Computes display-only meta chips from existing block data.
  - Recursively renders child subagents with a lightweight nested variant.

- Modify: `src/renderer/chat/chat-message-row.tsx`
  - Replaces local `SubagentActivityView` with `SubagentActivityCard`.
  - Keeps `ChatActivityBlockView` as the dispatch point for activity block kinds.

- Create: `src/renderer/styles/subagent.css`
  - Owns visual styling for the subagent work card.
  - Keeps the style language close to `tool-call-modern` while making the card read as an independent work item.

- Modify: `src/renderer/styles/index.css`
  - Imports `subagent.css` after `tool-call.css`.

---

### Task 1: Add Failing Renderer Coverage For Subagent Work Cards

**Files:**
- Modify: `tests/renderer/chat-message-row.test.ts`

**Interfaces:**
- Consumes: existing `ChatMessageRow` component from `../../src/renderer/chat/chat-message-row`.
- Produces: failing behavior expectations that Tasks 2 and 3 must satisfy.

- [ ] **Step 1: Replace the existing structured subagent test**

In `tests/renderer/chat-message-row.test.ts`, replace the test named `renders structured subagent tree with partial transcript and failed status` with this test:

```tsx
  it('renders failed subagent work cards open with status, meta, nested children, and no task summary', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatMessageRow, {
        message: {
          key: 'assistant-subagent',
          role: 'assistant',
          content: '',
          reasoning: null,
          approval: null,
          isStreaming: false,
          blocks: [
            {
              id: 'subagent-root',
              kind: 'subagent',
              identity: {
                subagentId: 'subagent-root',
                parentSubagentId: null,
                name: 'general-purpose',
                depth: 0,
                path: ['general-purpose#0'],
                execution: 'async',
                taskInput: 'Search docs and do not show this text',
                asyncTaskId: 'async-1'
              },
              status: 'failed',
              summary: '已完成部分调查。',
              error: 'remote failed',
              blocks: [
                {
                  id: 'subagent-root-text',
                  kind: 'text',
                  content: 'partial'
                },
                {
                  id: 'subagent-root-reasoning',
                  kind: 'reasoning',
                  content: '检查上下文',
                  isStreaming: false
                },
                {
                  id: 'subagent-root-tool',
                  kind: 'tool_call',
                  name: 'read_file',
                  status: 'end',
                  input: { path: 'F:\\\\Code\\\\Roc\\\\README.md' },
                  output: { bytes: 128 },
                  error: null
                }
              ],
              children: [
                {
                  id: 'subagent-child',
                  kind: 'subagent',
                  identity: {
                    subagentId: 'subagent-child',
                    parentSubagentId: 'subagent-root',
                    name: 'research',
                    depth: 1,
                    path: ['general-purpose#0', 'research#0'],
                    execution: 'sync',
                    taskInput: 'Nested task input should also stay hidden'
                  },
                  status: 'completed',
                  summary: '子任务完成。',
                  error: null,
                  blocks: [],
                  children: []
                }
              ]
            }
          ]
        }
      })
    );

    expect(html).toContain('data-testid="chat-activity-subagent"');
    expect(html).toMatch(/data-testid="chat-activity-subagent"[^>]*open="">/);
    expect(html).toContain('Subagent · general-purpose');
    expect(html).toContain('失败');
    expect(html).toContain('async');
    expect(html).toContain('1 tool');
    expect(html).toContain('1 child');
    expect(html).toContain('reasoning');
    expect(html).toContain('remote failed');
    expect(html).toContain('已完成部分调查。');
    expect(html).toContain('partial');
    expect(html).toContain('read_file');
    expect(html).toContain('data-testid="chat-activity-subagent-child"');
    expect(html).toContain('Subagent · research');
    expect(html).toContain('完成');
    expect(html).not.toContain('Search docs and do not show this text');
    expect(html).not.toContain('Nested task input should also stay hidden');
  });
```

- [ ] **Step 2: Add a collapsed non-failed behavior test**

Add this test immediately after the failed-card test:

```tsx
  it('keeps non-failed subagent work cards collapsed by default', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatMessageRow, {
        message: {
          key: 'assistant-subagent-running',
          role: 'assistant',
          content: '',
          reasoning: null,
          approval: null,
          isStreaming: true,
          blocks: [
            {
              id: 'subagent-running',
              kind: 'subagent',
              identity: {
                subagentId: 'subagent-running',
                parentSubagentId: null,
                name: 'research',
                depth: 0,
                path: ['research#0'],
                execution: 'sync',
                taskInput: null
              },
              status: 'running',
              summary: null,
              error: null,
              blocks: [],
              children: []
            }
          ]
        }
      })
    );

    expect(html).toContain('data-testid="chat-activity-subagent"');
    expect(html).toMatch(/data-testid="chat-activity-subagent"(?![^>]*open)/);
    expect(html).toContain('Subagent · research');
    expect(html).toContain('运行中');
    expect(html).toContain('sync');
  });
```

- [ ] **Step 3: Run the focused test and confirm it fails**

Run:

```powershell
pnpm test -- tests/renderer/chat-message-row.test.ts
```

Expected: FAIL. At least one assertion should fail because the current implementation renders the old `chat-bubble-subagent` details and English status labels, not the new card copy and meta chips.

- [ ] **Step 4: Commit the failing tests only if using strict red-green commits**

Most Roc changes can keep tests and implementation in one final commit. If the executor is explicitly using red-green commits, commit only this file:

```powershell
git add -- tests/renderer/chat-message-row.test.ts
git commit -m "test: cover subagent work card display"
```

If not committing red separately, leave the test unstaged until Task 2.

---

### Task 2: Implement The Subagent Work Card Component And Wiring

**Files:**
- Create: `src/renderer/chat/subagent/SubagentActivityCard.tsx`
- Modify: `src/renderer/chat/chat-message-row.tsx`
- Test: `tests/renderer/chat-message-row.test.ts`

**Interfaces:**
- Consumes: `Extract<ChatTranscriptActivityBlock, { kind: 'subagent' }>` from `src/renderer/chat-transcript.ts`.
- Consumes: `ReasoningBlock`, `ToolCallView`, `StreamingMarkdownView`, `ActivityBlockShell`, and `useActivityBlockState`.
- Produces: `SubagentActivityCard({ block }: { block: Extract<ChatTranscriptActivityBlock, { kind: 'subagent' }> }): React.JSX.Element`.

- [ ] **Step 1: Create the subagent card component**

Create `src/renderer/chat/subagent/SubagentActivityCard.tsx` with this content:

```tsx
import { Bot, CheckCircle2, ChevronDown, CirclePlay, LoaderCircle, XCircle } from 'lucide-react';
import type { ChatTranscriptActivityBlock, ChatTranscriptSubagentBlock } from '../../chat-transcript';
import { ActivityBlockShell } from '../activity-block/ActivityBlockShell';
import { useActivityBlockState } from '../activity-block/use-activity-block-state';
import { ReasoningBlock } from '../reasoning/ReasoningBlock';
import { StreamingMarkdownView } from '../streaming-markdown-view';
import { ToolCallView } from '../tool-call-view';

type SubagentBlockModel = Extract<ChatTranscriptActivityBlock, { kind: 'subagent' }>;

type SubagentActivityCardProps = {
  block: SubagentBlockModel;
  depth?: number;
};

const STATUS_LABEL = {
  started: '开始',
  running: '运行中',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消'
} satisfies Record<SubagentBlockModel['status'], string>;

function SubagentStatusIcon({ status }: { status: SubagentBlockModel['status'] }): React.JSX.Element {
  if (status === 'started') {
    return <CirclePlay aria-hidden="true" size={13} strokeWidth={2.4} />;
  }
  if (status === 'running') {
    return <LoaderCircle aria-hidden="true" size={13} strokeWidth={2.4} />;
  }
  if (status === 'completed') {
    return <CheckCircle2 aria-hidden="true" size={13} strokeWidth={2.4} />;
  }
  return <XCircle aria-hidden="true" size={13} strokeWidth={2.4} />;
}

function countToolBlocks(blocks: readonly ChatTranscriptSubagentBlock[]): number {
  return blocks.filter((block) => block.kind === 'tool_call').length;
}

function hasReasoningBlock(blocks: readonly ChatTranscriptSubagentBlock[]): boolean {
  return blocks.some((block) => block.kind === 'reasoning');
}

function buildMetaChips(block: SubagentBlockModel): string[] {
  const chips = [block.identity.execution];
  const toolCount = countToolBlocks(block.blocks);
  if (toolCount > 0) {
    chips.push(`${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}`);
  }
  const childCount = block.children.length;
  if (childCount > 0) {
    chips.push(`${childCount} ${childCount === 1 ? 'child' : 'children'}`);
  }
  if (hasReasoningBlock(block.blocks)) {
    chips.push('reasoning');
  }
  return chips;
}

function renderSubagentBlock(block: ChatTranscriptSubagentBlock, isStreaming: boolean): React.JSX.Element {
  if (block.kind === 'text') {
    return <StreamingMarkdownView key={block.id} text={block.content} isStreaming={isStreaming} />;
  }
  if (block.kind === 'reasoning') {
    return <ReasoningBlock key={block.id} id={block.id} content={block.content} isStreaming={block.isStreaming} />;
  }
  return <ToolCallView key={block.id} block={block} />;
}

export function SubagentActivityCard({ block, depth = 0 }: SubagentActivityCardProps): React.JSX.Element {
  const isNested = depth > 0;
  const isStreaming = block.status === 'started' || block.status === 'running';
  const metaChips = buildMetaChips(block);
  const hasBody =
    block.error !== null ||
    block.summary !== null ||
    block.blocks.length > 0 ||
    block.children.length > 0;
  const { open, setOpen } = useActivityBlockState({
    defaultOpen: block.status === 'failed'
  });
  const className = [
    'subagent-card',
    `subagent-card--${block.status}`,
    isNested ? 'subagent-card--nested' : ''
  ]
    .filter((part) => part.length > 0)
    .join(' ');

  return (
    <ActivityBlockShell
      className={className}
      dataTestId="chat-activity-subagent"
      open={hasBody && open}
      onToggle={setOpen}
      header={
        <summary className="subagent-card__header">
          <span className="subagent-card__icon">
            <SubagentStatusIcon status={block.status} />
          </span>
          <span className="subagent-card__title">
            <Bot aria-hidden="true" size={13} strokeWidth={2.4} />
            <span>{`Subagent · ${block.identity.name}`}</span>
          </span>
          <span className={`subagent-card__badge subagent-card__badge--${block.status}`}>
            {STATUS_LABEL[block.status]}
          </span>
          {hasBody ? <ChevronDown className="subagent-card__expand" aria-hidden="true" size={14} strokeWidth={2.2} /> : null}
        </summary>
      }
    >
      {metaChips.length === 0 ? null : (
        <div className="subagent-card__meta" aria-label="子代理元信息">
          {metaChips.map((chip) => (
            <span key={chip} className="subagent-card__chip">
              {chip}
            </span>
          ))}
        </div>
      )}
      {hasBody ? (
        <div className="subagent-card__body">
          {block.error === null ? null : <pre className="subagent-card__error">{block.error}</pre>}
          {block.summary === null ? null : <p className="subagent-card__summary">{block.summary}</p>}
          {block.blocks.map((child) => renderSubagentBlock(child, isStreaming))}
          {block.children.map((child) => (
            <div key={child.id} className="subagent-card__child" data-testid="chat-activity-subagent-child">
              <SubagentActivityCard block={child} depth={depth + 1} />
            </div>
          ))}
        </div>
      ) : null}
    </ActivityBlockShell>
  );
}
```

- [ ] **Step 2: Wire the component into `chat-message-row.tsx`**

In `src/renderer/chat/chat-message-row.tsx`, add this import:

```tsx
import { SubagentActivityCard } from './subagent/SubagentActivityCard';
```

Change the `block.kind === 'subagent'` branch in `ChatActivityBlockView` to:

```tsx
  if (block.kind === 'subagent') {
    return <SubagentActivityCard block={block} />;
  }
```

Delete the old local `SubagentActivityView` function entirely. Do not change other activity block branches.

- [ ] **Step 3: Run the focused test**

Run:

```powershell
pnpm test -- tests/renderer/chat-message-row.test.ts
```

Expected: PASS for behavior if only markup expectations are asserted. If the run fails with a TypeScript or JSX import issue, fix only `SubagentActivityCard.tsx` and `chat-message-row.tsx`.

- [ ] **Step 4: Run typecheck**

Run:

```powershell
pnpm typecheck
```

Expected: PASS. If typecheck reports `ToolCallView` type incompatibility for `ChatTranscriptSubagentBlock`, change only `renderSubagentBlock` to construct the structurally equivalent object inline:

```tsx
  return (
    <ToolCallView
      key={block.id}
      block={{
        id: block.id,
        kind: 'tool_call',
        name: block.name,
        status: block.status,
        input: block.input,
        output: block.output,
        error: block.error
      }}
    />
  );
```

- [ ] **Step 5: Commit component wiring if tests and typecheck pass**

If Task 1 was not committed separately, include the test file in this commit:

```powershell
git add -- tests/renderer/chat-message-row.test.ts src/renderer/chat/chat-message-row.tsx src/renderer/chat/subagent/SubagentActivityCard.tsx
git commit -m "feat: render subagent work cards"
```

If Task 1 was already committed:

```powershell
git add -- src/renderer/chat/chat-message-row.tsx src/renderer/chat/subagent/SubagentActivityCard.tsx
git commit -m "feat: render subagent work cards"
```

---

### Task 3: Add Subagent Card Styling And Final Verification

**Files:**
- Create: `src/renderer/styles/subagent.css`
- Modify: `src/renderer/styles/index.css`
- Test: `tests/renderer/chat-message-row.test.ts`

**Interfaces:**
- Consumes: class names emitted by `SubagentActivityCard`.
- Produces: visual styling for the subagent work card and imports it into the renderer stylesheet bundle.

- [ ] **Step 1: Create the subagent stylesheet**

Create `src/renderer/styles/subagent.css` with this content:

```css
.subagent-card {
  width: min(100%, 620px);
  display: grid;
  gap: 8px;
  margin: 4px 0;
  padding: 10px 12px;
  border: 1px solid rgba(120, 144, 184, 0.16);
  border-radius: 8px;
  background: rgba(248, 250, 252, 0.78);
}

.subagent-card--nested {
  width: 100%;
  margin: 2px 0 0;
  background: rgba(255, 255, 255, 0.58);
}

.subagent-card__header {
  list-style: none;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 9px;
  cursor: pointer;
}

.subagent-card__header::-webkit-details-marker,
.subagent-card__header::marker {
  display: none;
  content: '';
}

.subagent-card__icon {
  width: 22px;
  height: 22px;
  border-radius: 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(17, 24, 39, 0.08);
  color: var(--ink);
  flex-shrink: 0;
}

.subagent-card__title {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text);
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1.35;
}

.subagent-card__title span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.subagent-card__badge {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  line-height: 1.4;
  flex-shrink: 0;
}

.subagent-card__badge--started {
  background: var(--tool-st-start-bg);
  color: var(--tool-st-start-text);
}

.subagent-card__badge--running {
  background: var(--tool-st-progress-bg);
  color: var(--tool-st-progress-text);
}

.subagent-card__badge--completed {
  background: var(--tool-st-end-bg);
  color: var(--tool-st-end-text);
}

.subagent-card__badge--failed,
.subagent-card__badge--cancelled {
  background: var(--tool-st-error-bg);
  color: var(--tool-st-error-text);
}

.subagent-card__expand {
  color: var(--subtle);
  transition: transform var(--duration-fast) var(--easing-standard);
}

.subagent-card[open] .subagent-card__expand {
  transform: rotate(180deg);
}

.subagent-card--running .subagent-card__icon svg {
  animation: tool-spin 1s linear infinite;
}

.subagent-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-left: 31px;
}

.subagent-card__chip {
  padding: 2px 7px;
  border: 1px solid rgba(120, 144, 184, 0.16);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.72);
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1.35;
  font-feature-settings: var(--font-feature-mono);
}

.subagent-card__body {
  display: grid;
  gap: 8px;
  padding: 8px 0 0 31px;
  border-top: 1px solid rgba(120, 144, 184, 0.12);
  animation: tool-expand var(--duration-base) var(--easing-standard);
}

.subagent-card__summary {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.6;
}

.subagent-card__error {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid rgba(244, 63, 94, 0.22);
  border-radius: 7px;
  background: rgba(255, 241, 242, 0.78);
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.subagent-card__child {
  display: grid;
  padding-left: 12px;
  border-left: 2px solid rgba(120, 144, 184, 0.16);
}

:root[data-theme='dark'] .subagent-card {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(190, 205, 228, 0.12);
}

:root[data-theme='dark'] .subagent-card--nested {
  background: rgba(255, 255, 255, 0.035);
}

:root[data-theme='dark'] .subagent-card__icon {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text);
}

:root[data-theme='dark'] .subagent-card__chip {
  background: rgba(0, 0, 0, 0.18);
  border-color: rgba(190, 205, 228, 0.12);
}

:root[data-theme='dark'] .subagent-card__body {
  border-top-color: rgba(190, 205, 228, 0.12);
}

:root[data-theme='dark'] .subagent-card__error {
  background: rgba(127, 29, 29, 0.2);
  border-color: rgba(248, 113, 113, 0.26);
}
```

- [ ] **Step 2: Import the stylesheet**

In `src/renderer/styles/index.css`, add this import immediately after `@import './tool-call.css';`:

```css
@import './subagent.css';
```

- [ ] **Step 3: Run focused renderer tests**

Run:

```powershell
pnpm test -- tests/renderer/chat-message-row.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run typecheck**

Run:

```powershell
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Check whitespace and staged scope**

Run:

```powershell
git diff --check
git status --short
```

Expected:

- `git diff --check` reports no whitespace errors.
- `git status --short` includes only the files touched by this plan plus the pre-existing unrelated modified files. Do not stage the unrelated modified files:
  - `src/main/services/deep-agent/agent-builder.ts`
  - `src/main/services/langchain-openai-compatible-models.ts`
  - `tests/main/deep-agent-build-wiring.test.ts`
  - `tests/main/langchain-model-factory-nvidia-options.test.ts`

- [ ] **Step 6: Commit style and final wiring**

If Task 2 was already committed:

```powershell
git add -- src/renderer/styles/index.css src/renderer/styles/subagent.css
git commit -m "style: polish subagent work cards"
```

If Tasks 1 and 2 were not committed separately:

```powershell
git add -- tests/renderer/chat-message-row.test.ts src/renderer/chat/chat-message-row.tsx src/renderer/chat/subagent/SubagentActivityCard.tsx src/renderer/styles/index.css src/renderer/styles/subagent.css
git commit -m "feat: render subagent work cards"
```

---

## Final Verification

After all tasks are complete, run:

```powershell
pnpm test -- tests/renderer/chat-message-row.test.ts
pnpm typecheck
git diff --check
git status --short
```

Expected:

- Focused renderer test passes.
- Typecheck passes.
- No whitespace errors.
- Only unrelated pre-existing modifications remain unstaged, unless the executor intentionally includes this feature in uncommitted working tree instead of commits.

## Self-Review

- Spec coverage: The plan covers renderer-only scope, Codex-style independent work card, default failed-only expansion, no `identity.taskInput`, Chinese status labels, meta chips, recursive children, reused internal block renderers, and focused renderer tests.
- Red-flag scan: No unfinished markers or unspecified testing steps remain.
- Type consistency: The produced component signature is `SubagentActivityCard({ block }: { block: Extract<ChatTranscriptActivityBlock, { kind: 'subagent' }> })`; `chat-message-row.tsx` consumes the same component from the `subagent` folder; tests exercise only existing `ChatMessageRow` public behavior.
