# Chat Streaming Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复聊天页面流式输出卡顿，降低 token 流期间的渲染、Markdown 解析和滚动开销，同时保持样式与现有交互不变。

**Architecture:** 先收敛流式事件和 state 更新热路径，再把 persisted transcript 与 live transcript 分开计算，随后用专用流式 Markdown 渲染 live 内容，最后把消息列表切到虚拟化。所有变化只围绕聊天渲染链路展开，不碰样式文件和无关页面。

**Tech Stack:** React 19, TypeScript, `streamdown@2.5.0`, `react-virtuoso@4.18.7`, Vitest, Electron smoke tests.

---

### Task 1: Add regression coverage for the hot path

**Files:**
- Modify: `tests/renderer/use-chat-run.test.ts`
- Modify: `tests/renderer/chat-transcript.test.ts`
- Modify: `tests/renderer/chat-view.test.ts`
- Modify: `tests/renderer/chat-message-row.test.tsx`
- Create: `tests/renderer/chat-transcript-panel.test.tsx`

- [ ] **Step 1: Write failing tests for event coalescing and streaming renderer boundaries**

Add this test to `tests/renderer/use-chat-run.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { coalesceChatRunEvents } from '../../src/renderer/chat/use-chat-run';
import type { ChatRunEvent } from '../../src/shared/types';

it('merges same-frame text and reasoning deltas', () => {
  const events: ChatRunEvent[] = [
    { type: 'assistant_block', runId: 'run_1', block: { kind: 'text', blockId: 'a', text: 'Hel' } },
    { type: 'assistant_block', runId: 'run_1', block: { kind: 'text', blockId: 'a', text: 'lo' } },
    { type: 'assistant_block', runId: 'run_1', block: { kind: 'reasoning', blockId: 'r', text: '思' } },
    { type: 'assistant_block', runId: 'run_1', block: { kind: 'reasoning', blockId: 'r', text: '考' } }
  ];

  expect(coalesceChatRunEvents(events)).toHaveLength(2);
  expect(coalesceChatRunEvents(events)).toEqual([
    { type: 'assistant_block', runId: 'run_1', block: { kind: 'text', blockId: 'a', text: 'Hello' } },
    { type: 'assistant_block', runId: 'run_1', block: { kind: 'reasoning', blockId: 'r', text: '思考' } }
  ]);
});
```

Add this test to `tests/renderer/chat-message-row.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { StreamingMarkdownView } from '../../src/renderer/chat/streaming-markdown-view';

it('uses streaming renderer while assistant message is still flowing', () => {
  render(<StreamingMarkdownView text="**hi**" isStreaming />);
  expect(screen.getByTestId('streaming-markdown')).toBeInTheDocument();
});
```

Create `tests/renderer/chat-transcript-panel.test.tsx` with this initial regression:

```tsx
import { render } from '@testing-library/react';
import { ChatTranscriptPanel } from '../../src/renderer/chat/chat-transcript-panel';

it('does not depend on full message DOM for auto-follow state', () => {
  render(
    <ChatTranscriptPanel
      messages={Array.from({ length: 200 }, (_, index) => ({
        key: String(index),
        role: 'assistant',
        content: `msg-${index}`,
        reasoning: null,
        blocks: [],
        approval: null,
        isStreaming: false
      }))}
      liveSignal="run_1|10|0"
      scrollContainerRef={{ current: document.createElement('div') }}
    />
  );
});
```

- [ ] **Step 2: Run the tests and confirm they fail for the intended reasons**

Run: `pnpm test -- tests/renderer/use-chat-run.test.ts tests/renderer/chat-transcript.test.ts tests/renderer/chat-view.test.ts tests/renderer/chat-message-row.test.tsx tests/renderer/chat-transcript-panel.test.tsx`

Expected: fail because `coalesceChatRunEvents`, `StreamingMarkdownView`, and the new virtualization boundary do not exist yet.

- [ ] **Step 3: Commit the test-only baseline**

```powershell
git add tests/renderer/use-chat-run.test.ts tests/renderer/chat-transcript.test.ts tests/renderer/chat-view.test.ts tests/renderer/chat-message-row.test.tsx tests/renderer/chat-transcript-panel.test.tsx
git commit -m "test: add chat streaming performance regressions"
```

### Task 2: Coalesce stream events and make chat state updates non-urgent

**Files:**
- Modify: `src/renderer/chat/use-chat-run.ts`
- Modify: `tests/renderer/use-chat-run.test.ts`

- [ ] **Step 1: Implement event coalescing and transition-wrapped flush**

```ts
import { startTransition, useEffect, useRef, useState } from 'react';

export function coalesceChatRunEvents(events: ChatRunEvent[]): ChatRunEvent[] {
  const result: ChatRunEvent[] = [];
  for (const event of events) {
    const previous = result[result.length - 1];
    if (previous !== undefined && canMergeChatRunEvents(previous, event)) {
      result[result.length - 1] = mergeChatRunEvents(previous, event);
      continue;
    }
    result.push(event);
  }
  return result;
}

function canMergeChatRunEvents(left: ChatRunEvent, right: ChatRunEvent): boolean {
  if (left.type !== 'assistant_block' || right.type !== 'assistant_block') {
    return false;
  }
  if (left.runId !== right.runId) {
    return false;
  }
  if (left.block.kind !== right.block.kind) {
    return false;
  }
  if (left.block.kind !== 'text' && left.block.kind !== 'reasoning') {
    return false;
  }
  if (right.block.kind !== 'text' && right.block.kind !== 'reasoning') {
    return false;
  }
  return left.block.blockId === right.block.blockId;
}

function mergeChatRunEvents(left: ChatRunEvent, right: ChatRunEvent): ChatRunEvent {
  if (left.type !== 'assistant_block' || right.type !== 'assistant_block') {
    return right;
  }
  if (left.block.kind === 'text' && right.block.kind === 'text') {
    return {
      ...right,
      block: {
        ...right.block,
        text: `${left.block.text}${right.block.text}`
      }
    };
  }
  if (left.block.kind === 'reasoning' && right.block.kind === 'reasoning') {
    return {
      ...right,
      block: {
        ...right.block,
        text: `${left.block.text}${right.block.text}`
      }
    };
  }
  return right;
}

function flush(): void {
  rafHandleRef.current = null;
  const buffered = coalesceChatRunEvents(pendingEventsRef.current);
  if (buffered.length === 0) {
    return;
  }
  pendingEventsRef.current = [];
  startTransition(() => {
    setState((current) => applyChatRunEventBatch(current, buffered));
  });
}
```

- [ ] **Step 2: Run the hot-path tests**

Run: `pnpm test -- tests/renderer/use-chat-run.test.ts`

Expected: pass after merging text/reasoning chunks and preserving run finalization behavior.

- [ ] **Step 3: Commit the hot-path change**

```powershell
git add src/renderer/chat/use-chat-run.ts tests/renderer/use-chat-run.test.ts
git commit -m "perf: coalesce streaming chat events"
```

### Task 3: Split transcript construction and stabilize persisted message references

**Files:**
- Modify: `src/renderer/chat/chat-view.tsx`
- Modify: `src/renderer/chat-transcript.ts`
- Modify: `tests/renderer/chat-transcript.test.ts`
- Modify: `tests/renderer/chat-view.test.ts`

- [ ] **Step 1: Refactor transcript building into persisted and live parts**

```ts
const promotedThreadIds = useMemo(
  () =>
    new Set(
      state.activeTasks
        .filter((item) => item.kind === 'background')
        .map((item) => item.threadId)
    ),
  [state.activeTasks]
);

const persistedTranscript = useMemo(
  () =>
    activeThreadId === null
      ? []
      : buildPersistedTranscriptMessages({
          promotedThreadIds,
          recentEvents: persistedMessages,
          threadId: activeThreadId
        }),
  [activeThreadId, persistedMessages, promotedThreadIds]
);

const chatTranscript = useMemo(
  () =>
    appendLiveTranscriptMessages({
      chatRunState: {
        ...chatRun.state,
        assistantMessage: deferredAssistantMessage,
        activityBlocks: deferredActivityBlocks
      },
      persistedMessages: persistedTranscript,
      pendingUserInput,
      selectedThreadId
    }),
  [
    persistedTranscript,
    chatRun.state.runId,
    chatRun.state.threadId,
    chatRun.state.status,
    chatRun.state.pendingApprovals,
    chatRun.state.subagents,
    deferredAssistantMessage,
    deferredActivityBlocks,
    pendingUserInput,
    selectedThreadId
  ]
);
```

```ts
export function buildPersistedTranscriptMessages(input: {
  promotedThreadIds: Set<string>;
  recentEvents: TaskEvent[];
  threadId: string;
}): ChatTranscriptMessage[] {
  const messages = buildPersistedThreadMessages(input.recentEvents, input.threadId);
  if (input.promotedThreadIds.has(input.threadId)) {
    return messages;
  }
  return messages;
}

export function appendLiveTranscriptMessages(input: {
  chatRunState: ChatRunState;
  pendingUserInput: string | null;
  persistedMessages: ChatTranscriptMessage[];
  selectedThreadId: string | null;
}): ChatTranscriptMessage[] {
  const activeThreadId = resolveActiveThreadId(input.selectedThreadId, input.chatRunState);
  const messages = input.persistedMessages.slice();
  if (activeThreadId === null) {
    return input.pendingUserInput === null ? [] : [createPendingUserMessage(input.pendingUserInput)];
  }
  if (input.pendingUserInput !== null && !messages.some((message) => message.role === 'user' && message.content === input.pendingUserInput)) {
    messages.push(createPendingUserMessage(input.pendingUserInput));
  }
  if (input.chatRunState.threadId !== activeThreadId) {
    return messages;
  }
  const liveMessage = buildLiveAssistantMessage(input.chatRunState);
  if (liveMessage !== null) {
    messages.push(liveMessage);
  }
  return messages;
}
```

- [ ] **Step 2: Update transcript tests to assert stable object identity for unchanged history**

```ts
const first = buildChatTranscript(input);
const second = buildChatTranscript({
  ...input,
  chatRunState: { ...input.chatRunState, assistantMessage: `${input.chatRunState.assistantMessage}x` }
});

expect(second[0]).toBe(first[0]);
```

- [ ] **Step 3: Run transcript and view tests**

Run: `pnpm test -- tests/renderer/chat-transcript.test.ts tests/renderer/chat-view.test.ts`

Expected: pass with stable persisted message references and narrower memo dependencies.

- [ ] **Step 4: Commit the transcript split**

```powershell
git add src/renderer/chat/chat-view.tsx src/renderer/chat-transcript.ts tests/renderer/chat-transcript.test.ts tests/renderer/chat-view.test.ts
git commit -m "perf: split chat transcript hot path"
```

### Task 4: Add a streaming Markdown boundary for live assistant content

**Files:**
- Add dependency: `package.json`, `pnpm-lock.yaml`
- Create: `src/renderer/chat/streaming-markdown-view.tsx`
- Modify: `src/renderer/chat/chat-message-row.tsx`
- Modify: `tests/renderer/chat-message-row.test.tsx`

- [ ] **Step 1: Wire in `streamdown` for live assistant rendering**

Install dependency:

```powershell
pnpm add streamdown@2.5.0
```

```tsx
import Streamdown from 'streamdown';
import { MarkdownView } from './markdown-view';

export function StreamingMarkdownView({ text, isStreaming }: { text: string; isStreaming: boolean }): React.JSX.Element {
  if (!isStreaming) {
    return <MarkdownView text={text} />;
  }
  return (
    <div data-testid="streaming-markdown">
      <Streamdown>{text}</Streamdown>
    </div>
  );
}
```

```tsx
{message.content.length === 0 ? null : (
  <StreamingMarkdownView text={message.content} isStreaming={message.isStreaming} />
)}
```

- [ ] **Step 2: Add tests for live versus settled message rendering**

```tsx
render(<StreamingMarkdownView text="```ts\nconst a = 1;\n```" isStreaming />);
expect(screen.getByTestId('streaming-markdown')).toBeInTheDocument();

render(<StreamingMarkdownView text="```ts\nconst a = 1;\n```" isStreaming={false} />);
expect(screen.queryByTestId('streaming-markdown')).toBeNull();
```

- [ ] **Step 3: Run renderer tests**

Run: `pnpm test -- tests/renderer/chat-message-row.test.tsx`

Expected: pass, with live assistant content going through the streaming boundary only while streaming.

- [ ] **Step 4: Commit the Markdown boundary**

```powershell
git add package.json pnpm-lock.yaml src/renderer/chat/streaming-markdown-view.tsx src/renderer/chat/chat-message-row.tsx tests/renderer/chat-message-row.test.tsx
git commit -m "perf: stream chat markdown separately"
```

### Task 5: Virtualize the transcript list without changing chat styling

**Files:**
- Add dependency: `package.json`, `pnpm-lock.yaml`
- Create: `src/renderer/chat/chat-transcript-virtual-list.tsx`
- Modify: `src/renderer/chat/chat-transcript-panel.tsx`
- Modify: `tests/renderer/chat-transcript-panel.test.tsx`

- [ ] **Step 1: Replace direct `.map()` rendering with a Virtuoso-backed list**

Install dependency:

```powershell
pnpm add react-virtuoso@4.18.7
```

```tsx
import { Virtuoso } from 'react-virtuoso';

export function ChatTranscriptVirtualList({ messages, onApprovalDecision }: Props): React.JSX.Element {
  return (
    <Virtuoso
      data={messages}
      followOutput={(isAtBottom) => (isAtBottom ? 'auto' : false)}
      itemContent={(index, message) => (
        <ChatMessageRow key={message.key} message={message} onApprovalDecision={onApprovalDecision} />
      )}
    />
  );
}
```

```tsx
<div className="chat-transcript" data-testid="chat-transcript">
  <ChatTranscriptVirtualList messages={messages} onApprovalDecision={onApprovalDecision} />
</div>
```

- [ ] **Step 2: Keep auto-follow and bottom button behavior intact**

```ts
const [isAtBottom, setIsAtBottom] = useState(true);
<Virtuoso
  atBottomStateChange={setIsAtBottom}
  followOutput={isAtBottom ? 'auto' : false}
/>
```

- [ ] **Step 3: Mock Virtuoso in the panel test and assert the prop contract**

```tsx
vi.mock('react-virtuoso', () => ({
  Virtuoso: ({ data, followOutput }: { data: unknown[]; followOutput: unknown }) => {
    expect(data).toHaveLength(200);
    expect(followOutput).toBeTruthy();
    return <div data-testid="virtuoso-mock" />;
  }
}));
```

- [ ] **Step 4: Run chat panel tests**

Run: `pnpm test -- tests/renderer/chat-transcript-panel.test.tsx`

Expected: pass with virtualization in place and no style file changes.

- [ ] **Step 5: Commit the virtualization layer**

```powershell
git add package.json pnpm-lock.yaml src/renderer/chat/chat-transcript-virtual-list.tsx src/renderer/chat/chat-transcript-panel.tsx tests/renderer/chat-transcript-panel.test.tsx
git commit -m "perf: virtualize chat transcript"
```

### Task 6: Extend performance verification and run the full check set

**Files:**
- Modify: `scripts/smoke-performance.mjs`
- Modify: `tests/renderer/chat-view.test.ts`

- [ ] **Step 1: Add a streaming-heavy smoke case**

```js
const chunks = Array.from({ length: 5000 }, (_, index) => ({
  type: 'assistant_block',
  block: { kind: 'text', blockId: 'stream_1', text: String(index % 10) }
}));
```

- [ ] **Step 2: Measure visible regressions with the existing smoke harness**

Run: `pnpm smoke:performance`

Expected: lower long-task pressure and no visible input freeze during chat streaming.

- [ ] **Step 3: Run final verification**

Run:

```powershell
pnpm typecheck
pnpm test -- tests/renderer/use-chat-run.test.ts tests/renderer/chat-run-state.test.ts tests/renderer/chat-transcript.test.ts tests/renderer/chat-view.test.ts tests/renderer/chat-message-row.test.tsx tests/renderer/chat-transcript-panel.test.tsx
pnpm smoke:performance
```

Expected: all pass.

- [ ] **Step 4: Commit the verification updates**

```powershell
git add scripts/smoke-performance.mjs tests/renderer/chat-view.test.ts
git commit -m "test: verify chat streaming performance"
```

### Self-Check

- Spec coverage: hot path batching, transcript memoization, streaming Markdown, virtualization, performance smoke.
- Placeholder scan: no unfinished implementation placeholders.
- Type consistency: `coalesceChatRunEvents`, `StreamingMarkdownView`, and `ChatTranscriptVirtualList` are introduced before subsequent tasks reference them.
- Scope: one subsystem, one plan.
