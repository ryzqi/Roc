# Roc Motion and Interaction Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 persisted 历史不批量入场，Settings 正确执行 exit，dialog 关闭恢复 opener 焦点，历史删除具备显式按钮和完整键盘菜单语义，并移除 paint-heavy reasoning shimmer。

**Architecture:** `ChatTranscriptMessage.source` 与 run-based stable key 决定 motion initial。Settings 的 `AnimatePresence` 位于常驻 `AppSettingsLayer`，TaskCreateDialog 保持自身 presence owner；两者都由打开方捕获 opener，并在 exit complete 后恢复焦点。历史菜单封装为可测的 renderer component，测量后限制到 viewport。Reasoning 使用静态文本和现有固定尺寸 typing indicator。

**Tech Stack:** React 19、Motion 12、Lucide React、jsdom focus/keyboard tests、CSS responsive smoke。

## Global Constraints

- `ChatTranscriptMessage.source` 只有 `'persisted' | 'live'`，不得通过 key 前缀或 `isStreaming` 猜测来源。
- persisted row、approval/question 子卡 mount 时 `initial={false}`；新 live 消息仍执行一次入场。
- live 转 persisted 使用同一个 run-based key，不得重新 mount、闪动或重复 side effect。
- Settings lazy boundary 位于 presence owner 内；关闭时 backdrop/panel exit 完成后才卸载。
- opener 不存在或已脱离 document 时不猜测替代焦点，不把焦点随意送到 body。
- dialog 的 Escape、backdrop、close button 和外部状态关闭走同一个 close callback。
- 历史删除 API 与行为不变；不新增确认步骤、批量操作或第二套 context menu。
- 历史菜单四周至少 `8px` viewport 间距；Enter/Space、Shift+F10、Escape、outside pointer 和 focus return 必须覆盖。
- 删除 `.reasoning-shimmer` 移动渐变；reduced motion 下不运行 pulse。
- 本批只在最终 review 和验证后提交一次。

---

### Task 1: Make transcript motion source-aware with stable live/persisted keys

**Files:**
- Modify: `src/renderer/chat-transcript.ts:85-94,379-423,775-847,926-957`
- Modify: `src/renderer/chat/chat-message-row.tsx:22-185`
- Modify: `tests/renderer/chat-transcript.test.ts`
- Modify: `tests/renderer/chat-transcript-panel.test.tsx`
- Modify: `tests/renderer/chat-transcript-approval.test.ts`

**Interfaces:**
- Consumes: `ChatTranscriptMessage.source` introduced with the paged history state in batch four.
- Produces: stable `user-${runId}` / `assistant-${runId}` keys and `messageInitial(source)` for row/subcard motion.

- [x] **Step 1: Write failing source and stable-key transcript tests**

```ts
const persisted = buildPersistedTranscriptMessages(events, 'thread-1');
expect(persisted).toEqual([
  expect.objectContaining({ key: 'user-run-1', source: 'persisted' }),
  expect.objectContaining({ key: 'assistant-run-1', source: 'persisted' })
]);

const live = appendLiveTranscriptMessages({
  chatRunState: runningState,
  pendingUserInput: 'hello',
  persistedMessages: [],
  selectedThreadId: 'thread-1'
});
expect(live).toEqual([
  expect.objectContaining({ key: 'user-run-1', source: 'live' }),
  expect.objectContaining({ key: 'assistant-run-1', source: 'live' })
]);
```

After the same run's persisted events arrive, assert keys remain identical while source changes to persisted and the array contains no duplicate user/assistant row.

- [x] **Step 2: Write failing motion-initial tests**

Export a pure helper from `chat-message-row.tsx`:

```ts
expect(messageInitial('persisted')).toBe(false);
expect(messageInitial('live')).toBe('initial');
```

Mock `motion.div` in the component test and assert both the outer row and generic approval subcard receive `false` for a persisted message, and `'initial'` for a live message.

- [x] **Step 3: Run Task 1 tests and verify RED**

```powershell
pnpm test -- tests/renderer/chat-transcript.test.ts tests/renderer/chat-transcript-panel.test.tsx tests/renderer/chat-transcript-approval.test.ts
```

Expected: FAIL because current persisted rows use event ids, live rows use `live-*`, and all motion nodes use `initial="initial"`.

- [x] **Step 4: Assign source and run-based keys at construction**

```ts
function createUserMessage(event: MessageTaskEvent): ChatTranscriptMessage {
  return {
    key: `user-${event.runId}`,
    source: 'persisted',
    role: 'user',
    content: event.payload.content,
    attachments: event.payload.attachments === undefined ? [] : event.payload.attachments,
    reasoning: null,
    blocks: [],
    interrupt: null,
    isStreaming: false
  };
}

function createAssistantDraft(runId: string): AssistantDraft {
  return {
    message: {
      key: `assistant-${runId}`,
      source: 'persisted',
      role: 'assistant',
      content: '',
      attachments: [],
      reasoning: null,
      blocks: [],
      interrupt: null,
      isStreaming: false
    },
    reasoningBlock: null,
    toolBlocks: [],
    hookBlocks: [],
    subagentBlocks: []
  };
}
```

Do not overwrite the assistant key with the final message event id. Pending/live constructors use the same run ids and `source: 'live'`. When `runId` is genuinely absent before start, keep the existing pending key only until the run starts; the first `run_started` state update must replace it before any persisted event can match.

- [x] **Step 5: Make row and approval initial source-aware**

```ts
export function messageInitial(source: ChatTranscriptMessage['source']): false | 'initial' {
  return source === 'persisted' ? false : 'initial';
}
```

Use `initial={messageInitial(message.source)}` on the row and generic approval `motion.div`. Task approval and question cards inherit the outer persisted row and contain no separate mount animation; if a child motion wrapper is added by batch four, pass the same initial value explicitly.

Update the memo comparator to include `prev.message.source === next.message.source`.

- [x] **Step 6: Run Task 1 tests and verify GREEN**

```powershell
pnpm test -- tests/renderer/chat-transcript.test.ts tests/renderer/chat-transcript-panel.test.tsx tests/renderer/chat-transcript-approval.test.ts
```

Expected: PASS; 100 persisted rows report false initial state and a new live row animates exactly once without a persistence remount.

### Task 2: Move Settings presence ownership up and restore dialog focus

**Files:**
- Modify: `src/renderer/dialog-focus.ts`
- Modify: `src/renderer/app/AppShell.tsx`
- Modify: `src/renderer/app/AppSidebar.tsx`
- Modify: `src/renderer/app/AppSettingsLayer.tsx`
- Modify: `src/renderer/settings/settings-modal.tsx`
- Modify: `src/renderer/views/tasks/TasksView.tsx`
- Modify: `src/renderer/views/tasks/TaskCreateDialog.tsx`
- Create: `tests/renderer/dialog-focus.test.ts`
- Modify: `tests/renderer/settings-modal.test.ts`
- Modify: `tests/renderer/app-shell.test.tsx`
- Modify: `tests/renderer/tasks-view.interaction.test.ts`

**Interfaces:**
- Consumes: existing initial-focus/tab-trap helpers and Motion `AnimatePresence.onExitComplete`.
- Produces: `captureDialogOpener()` / `restoreDialogFocus()` and focus-safe Settings/TaskCreate lifecycles.

- [x] **Step 1: Write failing helper tests**

```ts
const opener = document.createElement('button');
document.body.appendChild(opener);
opener.focus();

expect(captureDialogOpener()).toBe(opener);
otherButton.focus();
expect(restoreDialogFocus(opener)).toBe(true);
expect(document.activeElement).toBe(opener);

opener.remove();
const focusBeforeRestore = document.activeElement;
expect(restoreDialogFocus(opener)).toBe(false);
expect(document.activeElement).toBe(focusBeforeRestore);
```

Also assert capture returns null when active element is not an HTMLElement or is `document.body`.

- [x] **Step 2: Write failing Settings exit/focus tests**

Open Settings by clicking `settings-gear`, close with Escape and assert the modal remains mounted until the mocked `onExitComplete` fires; after completion, gear regains focus. Repeat for backdrop and close button. Change `open` externally and assert the same exit/focus path.

- [x] **Step 3: Write failing TaskCreate opener tests**

Run the same focus flow for both the PageHeading “新建任务” button and empty-state “新建任务” button. Close via Escape, backdrop, close button and successful submit; focus returns to the exact opener only after exit completion.

- [x] **Step 4: Run Task 2 tests and verify RED**

```powershell
pnpm test -- tests/renderer/dialog-focus.test.ts tests/renderer/settings-modal.test.ts tests/renderer/app-shell.test.tsx tests/renderer/tasks-view.interaction.test.ts
```

Expected: FAIL because AppSettingsLayer unmounts the presence owner immediately and no dialog captures/restores opener focus.

- [x] **Step 5: Extend the focus helper without adding fallback guesses**

```ts
export function captureDialogOpener(): HTMLElement | null {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement) || activeElement === document.body) {
    return null;
  }
  return activeElement;
}

export function restoreDialogFocus(opener: HTMLElement | null): boolean {
  if (opener === null || !opener.isConnected) {
    return false;
  }
  opener.focus();
  return document.activeElement === opener;
}
```

Keep `focusDialogInitialElement()` and `trapDialogTabFocus()` unchanged except for shared internal focusable-element reuse.

- [x] **Step 6: Make AppSettingsLayer the persistent presence owner**

AppShell stores `settingsOpenerRef` and passes an explicit open callback to AppSidebar:

```ts
const settingsOpenerRef = useRef<HTMLElement | null>(null);
const openSettings = useCallback((opener: HTMLElement) => {
  settingsOpenerRef.current = opener;
  setSettingsOpen(true);
}, []);
```

When `app.onNavigate('settings')` or the initial URL opens Settings without a DOM trigger, set `settingsOpenerRef.current = null` before setting `open`; closing that path performs no fallback focus.

AppSidebar uses `onOpenSettings(event.currentTarget)` instead of setting state directly. `AppSettingsLayer` always renders:

```tsx
<AnimatePresence
  onExitComplete={() => {
    onExitComplete();
  }}
>
  {open ? (
    <SettingsModal key="settings-modal" onClose={onClose}>
      <Suspense fallback={<div className="boot">Roc 正在加载设置</div>}>
        <SettingsFeature client={client} state={state} updateLoadedState={updateLoadedState} />
      </Suspense>
    </SettingsModal>
  ) : null}
</AnimatePresence>
```

`SettingsModal` removes its internal `AnimatePresence`; backdrop/panel keep `motion` exit props. AppShell's exit callback calls `restoreDialogFocus(settingsOpenerRef.current)` then clears the ref.

- [x] **Step 7: Capture TaskCreate opener in TasksView**

Use one `createDialogOpenerRef`. Both open buttons call:

```ts
function openCreateDialog(opener: HTMLElement): void {
  createDialogOpenerRef.current = opener;
  setCreateDialogOpen(true);
}
```

Pass `onExitComplete` to TaskCreateDialog. Its `AnimatePresence` invokes the callback, which restores and clears the opener. Every internal close trigger calls the same `onClose` prop; successful submit also calls it.

- [x] **Step 8: Run Task 2 tests and verify GREEN**

```powershell
pnpm test -- tests/renderer/dialog-focus.test.ts tests/renderer/settings-modal.test.ts tests/renderer/app-shell.test.tsx tests/renderer/tasks-view.interaction.test.ts
```

Expected: PASS; exit completes before unmount/focus return, and disconnected openers receive no guessed fallback.

### Task 3: Add an explicit accessible history menu with viewport clamping

**Files:**
- Create: `src/renderer/app/sidebar/HistoryThreadMenu.tsx`
- Modify: `src/renderer/app/AppSidebar.tsx:90-154`
- Modify: `src/renderer/app/AppShell.tsx:52-169,319-333`
- Modify: `src/renderer/app/types.ts:35-39` to remove the old shared context-menu state
- Modify: `src/renderer/styles/app-sidebar.css:169-230`
- Create: `tests/renderer/history-thread-menu.test.tsx`
- Modify: `tests/renderer/app-shell.test.tsx`
- Modify: `tests/smoke/responsive-layout-smoke.mjs`

**Interfaces:**
- Consumes: existing `deleteHistoryThread(threadId)` and selected-thread navigation.
- Produces: `HistoryThreadRow` with main select button + Lucide `MoreHorizontal` opener + `role="menu"` delete item.

- [x] **Step 1: Write failing menu position and keyboard tests**

Test a pure clamp helper:

```ts
expect(clampHistoryMenuPosition({
  requestedX: 310,
  requestedY: 470,
  menuWidth: 112,
  menuHeight: 40,
  viewportWidth: 320,
  viewportHeight: 480,
  margin: 8
})).toEqual({ x: 200, y: 432 });
```

Component flow:

1. Enter and Space on the More button open the menu and focus the delete `menuitem`.
2. Shift+F10 on the main row button opens at the row rectangle.
3. ContextMenu opens at pointer coordinates.
4. Escape closes and restores the exact opener.
5. Pointerdown outside closes and restores opener.
6. Delete calls the existing callback once with thread id and closes.
7. `role="menu"`, `role="menuitem"`, `aria-label="更多历史会话操作"`, `aria-haspopup="menu"`, `aria-expanded` are exact.

- [x] **Step 2: Run Task 3 tests and verify RED**

```powershell
pnpm test -- tests/renderer/history-thread-menu.test.tsx tests/renderer/app-shell.test.tsx
```

Expected: FAIL because history is one button, deletion is right-click-only, menu has no roles/focus/Escape/clamp.

- [x] **Step 3: Implement the focused menu component**

Export the row and position helper from the focused module:

```ts
export function HistoryThreadRow(props: {
  item: HistorySidebarItem;
  selected: boolean;
  onSelect(threadId: string): void;
  onDelete(threadId: string): Promise<void>;
}): React.JSX.Element;

export function clampHistoryMenuPosition(input: {
  requestedX: number;
  requestedY: number;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  margin: number;
}): { x: number; y: number };
```

`HistoryThreadRow` owns `mainButtonRef`, `moreButtonRef` and nullable menu state `{ requestedX, requestedY, opener }`. Use `useLayoutEffect` to measure the menu, clamp to `window.innerWidth/innerHeight` with an 8px margin, set final coordinates, then focus the first `[role="menuitem"]`. A document keydown handler closes on Escape; a pointerdown handler ignores targets inside the menu. Both call `restoreDialogFocus(opener)` after closing.

- [x] **Step 4: Split each history row into select and More buttons**

```tsx
<div className={selected ? 'history-row active' : 'history-row'} onContextMenu={openContextMenu}>
  <button
    ref={mainButtonRef}
    className="history-row-main"
    data-testid={`history-thread-${sanitizeTestId(item.id)}`}
    type="button"
    onClick={() => onSelect(item.id)}
    onKeyDown={(event) => {
      if (event.key === 'F10' && event.shiftKey) {
        event.preventDefault();
        openFromElement(mainButtonRef.current);
      }
    }}
  >
    <PreviewIcon name={item.icon} />
    <span className="nav-copy">
      <span className="nav-label">{item.label}</span>
      <span className="nav-meta">{item.meta}</span>
    </span>
  </button>
  <button
    ref={moreButtonRef}
    className="history-row-more"
    type="button"
    aria-label="更多历史会话操作"
    aria-haspopup="menu"
    aria-expanded={menuState !== null}
    title="更多操作"
    onClick={(event) => openFromElement(event.currentTarget)}
  >
    <MoreHorizontal aria-hidden="true" size={16} />
  </button>
</div>
```

`openContextMenu()` uses `event.clientX/clientY` and `mainButtonRef.current` as the opener. `openFromElement()` uses the element's `getBoundingClientRect()` and requests the point `{ x: rect.right, y: rect.bottom }`. AppSidebar maps `visibleHistoryItems` to `HistoryThreadRow`. Remove AppShell's old `historyContextMenu` state/effect and all `setHistoryContextMenu(null)` calls made unused by this change. Do not nest buttons. Keep the existing primary selection behavior and delete API.

- [x] **Step 5: Style stable dimensions and viewport-safe menu**

Use a two-column row with a fixed 32px icon-button track; keep card radius at `8px` or less. Menu fixed dimensions must not change on hover. Add `:focus-visible` states for both buttons and destructive menuitem. Remove the old `.nav-button` coupling only for history rows; leave other navigation unchanged.

- [x] **Step 6: Extend responsive smoke for 320px and desktop**

In `history-thread-menu.test.tsx`, set 320px and desktop `window.innerWidth/innerHeight`, mock the last row/button rectangle near the bottom-right corner, open the real component menu, and assert `left >= 8`, `top >= 8`, `right <= viewportWidth - 8`, `bottom <= viewportHeight - 8`. In `responsive-layout-smoke.mjs`, add static history-row/menu markup using the clamped coordinates and assert the same bounding constraints so the real CSS is covered at both viewports.

- [x] **Step 7: Run Task 3 tests and verify GREEN**

```powershell
pnpm test -- tests/renderer/history-thread-menu.test.tsx tests/renderer/app-shell.test.tsx
node tests\smoke\responsive-layout-smoke.mjs
```

Expected: PASS; all keyboard/focus paths work and menu remains inside both viewports.

### Task 4: Remove the reasoning shimmer animation

**Files:**
- Modify: `src/renderer/styles/chat.css:362-382`
- Modify: `src/renderer/chat/reasoning/ReasoningBlock.tsx`
- Modify: `tests/renderer/chat-transcript-live-state.test.ts`
- Create: `tests/renderer/reasoning-motion.test.ts`

**Interfaces:**
- Consumes: existing static reasoning text and fixed-size `.chat-typing-cursor`/waiting indicator.
- Produces: no moving gradient or large-area background-position animation.

- [x] **Step 1: Write a failing CSS residue test**

```ts
const css = readFileSync('src/renderer/styles/chat.css', 'utf8');
expect(css).not.toContain('.reasoning-shimmer');
expect(css).not.toContain('@keyframes reasoning-shimmer');
expect(css).not.toMatch(/background-position[^;]*;[\s\S]*animation/iu);
```

Render a streaming reasoning block and assert its text remains visible and the existing fixed-size typing indicator is present. Under `prefers-reduced-motion: reduce`, assert no pulse animation class is applied.

- [x] **Step 2: Run Task 4 tests and verify RED**

```powershell
pnpm test -- tests/renderer/reasoning-motion.test.ts tests/renderer/chat-transcript-live-state.test.ts
```

Expected: FAIL because `.reasoning-shimmer` and its infinite background-position keyframes remain.

- [x] **Step 3: Remove the moving gradient and keep static feedback**

Delete the selector/keyframes. Render reasoning content with the existing muted text class. If `ReasoningBlock` currently applies `reasoning-shimmer`, remove that class. Keep only the existing fixed-size typing cursor/indicator for streaming state; do not add a new animation. The global reduced-motion rule continues disabling the indicator's pulse.

- [x] **Step 4: Run Task 4 tests and verify GREEN**

```powershell
pnpm test -- tests/renderer/reasoning-motion.test.ts tests/renderer/chat-transcript-live-state.test.ts
```

Expected: PASS; streaming reasoning remains readable and CSS contains no shimmer motion.

### Task 5: Review, verify, and commit the motion/interaction batch

**Files:**
- Review: all files changed in Tasks 1-4
- Verify: renderer tests and responsive smoke

**Interfaces:**
- Consumes: final source-aware transcript, presence owner, focus helper and history menu.
- Produces: one reviewed interaction commit.

- [x] **Step 1: Run the complete motion/interaction focused suite**

```powershell
pnpm test -- tests/renderer/chat-transcript.test.ts tests/renderer/chat-transcript-panel.test.tsx tests/renderer/chat-transcript-approval.test.ts tests/renderer/dialog-focus.test.ts tests/renderer/settings-modal.test.ts tests/renderer/app-shell.test.tsx tests/renderer/tasks-view.interaction.test.ts tests/renderer/history-thread-menu.test.tsx tests/renderer/reasoning-motion.test.ts tests/renderer/chat-transcript-live-state.test.ts
node tests\smoke\responsive-layout-smoke.mjs
```

Expected: PASS.

- [x] **Step 2: Review the current diff before committing**

```powershell
git diff -- src/renderer tests/renderer tests/smoke/responsive-layout-smoke.mjs
```

Review in this order:

1. High: persisted rows or subcards still animate, live-to-persisted changes key, or live rows no longer animate once.
2. High: Settings presence owner unmounts early, lazy content sits outside presence, or close paths bypass exit/focus restoration.
3. High: focus restoration targets body/arbitrary element, restores before exit, or fails when opener remains connected.
4. High: history delete is inaccessible by keyboard, buttons are nested, Escape/outside loses focus, or menu can leave the viewport.
5. Medium: menu changes delete semantics, adds confirmation/bulk behavior, or style changes leak into other nav groups.
6. Medium: shimmer CSS/keyframes remain or reduced motion still runs a large-area animation.

Record findings with file and line. Fix every finding and rerun its direct test. If none exist, record `未发现问题` and note that OS/browser focus behavior after a physically removed opener intentionally has no fallback target.

- [x] **Step 3: Run final batch verification**

```powershell
pnpm typecheck
pnpm test -- tests/renderer/chat-transcript.test.ts tests/renderer/chat-transcript-panel.test.tsx tests/renderer/chat-transcript-approval.test.ts tests/renderer/dialog-focus.test.ts tests/renderer/settings-modal.test.ts tests/renderer/app-shell.test.tsx tests/renderer/tasks-view.interaction.test.ts tests/renderer/history-thread-menu.test.tsx tests/renderer/reasoning-motion.test.ts tests/renderer/chat-transcript-live-state.test.ts
node tests\smoke\responsive-layout-smoke.mjs
git diff --check
```

Expected: every command exit code `0`.

- [x] **Step 4: Commit only the reviewed motion/interaction batch**

```powershell
$batchFiles = @(
  'src/renderer/chat-transcript.ts'
  'src/renderer/chat/chat-message-row.tsx'
  'src/renderer/dialog-focus.ts'
  'src/renderer/app/AppShell.tsx'
  'src/renderer/app/AppSidebar.tsx'
  'src/renderer/app/AppSettingsLayer.tsx'
  'src/renderer/app/types.ts'
  'src/renderer/app/sidebar/HistoryThreadMenu.tsx'
  'src/renderer/settings/settings-modal.tsx'
  'src/renderer/views/tasks/TasksView.tsx'
  'src/renderer/views/tasks/TaskCreateDialog.tsx'
  'src/renderer/chat/reasoning/ReasoningBlock.tsx'
  'src/renderer/styles/app-sidebar.css'
  'src/renderer/styles/chat.css'
  'tests/renderer/app-shell.test.tsx'
  'tests/renderer/chat-transcript.test.ts'
  'tests/renderer/chat-transcript-panel.test.tsx'
  'tests/renderer/chat-transcript-approval.test.ts'
  'tests/renderer/chat-transcript-live-state.test.ts'
  'tests/renderer/dialog-focus.test.ts'
  'tests/renderer/settings-modal.test.ts'
  'tests/renderer/tasks-view.interaction.test.ts'
  'tests/renderer/history-thread-menu.test.tsx'
  'tests/renderer/reasoning-motion.test.ts'
  'tests/smoke/responsive-layout-smoke.mjs'
)
git add -- $batchFiles
git diff --cached --check
git commit -m "fix: complete dialog and history interactions"
```

Expected: commit succeeds and `git status --short` contains no motion/interaction leftovers.
