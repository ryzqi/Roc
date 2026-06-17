# Task Kanban Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Roc's task workbench into a kanban-only task domain with a separate task detail page, task-local create/continue/approve flows, and a hard boundary from normal chat and chat history.

**Architecture:** Keep the existing backend task repository, task threads, and chat runtime. Replace the renderer's current `tasks -> queueTaskPrompt -> chat` coupling with explicit task-domain pages: `tasks-board` for the kanban board and `task-detail` for transcript and actions. Reuse existing transcript and approval rendering primitives inside the task detail page, while removing `queuedTaskPrompt`, `openInChat`, and background-thread visibility from normal chat history.

**Tech Stack:** TypeScript, React 19, Electron renderer, Vitest, existing Roc IPC/task runtime.

---

## Source Spec

- `docs/superpowers/specs/2026-06-17-task-kanban-workbench-design.md`

## File Structure

- `src/renderer/app/types.ts`
  - Split the single `tasks` view into `tasks-board` and `task-detail`.
  - Add task-domain UI state types for board context restore.

- `src/renderer/app/view-routing.ts`
  - Register the two task-domain views.
  - Update page meta and startup routing labels.

- `src/renderer/startup-load-policy.ts`
  - Keep task surface lazy-loading enabled for both task pages.

- `src/renderer/app/AppShell.tsx`
  - Remove queued task prompt state and chat-based task routing.
  - Add task-domain navigation state, board return context, and task-domain create/run/continue/approve handlers.

- `src/renderer/views/ViewContent.tsx`
  - Stop passing `queuedTaskPrompt` into chat.
  - Render explicit task board and task detail features.

- `src/renderer/features/tasks/index.tsx`
  - Replace the current single `TasksFeature` export with page-scoped task feature wrappers.

- `src/renderer/features/tasks/use-task-feature.ts`
  - Rename the old chat navigation dependency to task-detail navigation.
  - Remove `openInChat`.

- `src/renderer/views/tasks/TasksView.tsx`
  - Reduce responsibility to kanban board only.
  - Replace left rail and embedded drawer layout with four kanban columns.

- `src/renderer/views/tasks/TaskDetailDrawer.tsx`
  - Retire this file after task detail page extraction.

- `src/renderer/views/tasks/TaskDetailView.tsx`
  - New dedicated task detail page with back action, metadata, transcript, approval, and waiting-user follow-up.

- `src/renderer/views/tasks/TaskBoardColumn.tsx`
  - New focused kanban column renderer.

- `src/renderer/views/tasks/TaskBoardCard.tsx`
  - New focused task card renderer.

- `src/renderer/views/tasks/task-board-model.ts`
  - New board grouping helpers for the four confirmed columns and optional filter counts.

- `src/renderer/views/tasks/use-task-actions.ts`
  - Remove `openInChat`.
  - Keep task mutations and add direct refresh helpers for detail view actions.

- `src/renderer/chat/chat-view.tsx`
  - Remove `queuedTaskPrompt` auto-submit path.
  - Keep ordinary chat submission and approval resume behavior for chat threads only.

- `src/renderer/chat/task-run-payload.ts`
  - Delete `QueuedTaskPrompt`.
  - Keep only the payload shape still needed by chat submission.

- `src/renderer/history-sidebar.ts`
  - Enforce `kind === 'chat'` as the only history-eligible thread kind.

- `src/renderer/app/nav-items.ts`
  - Keep workspace nav entry pointing to `tasks-board`.
  - Feed history from the hard task/chat boundary.

- `src/renderer/app/data-loading.ts`
  - Keep task-surface loading reusable for both board and detail.
  - Make selected-task loading deterministic for detail page refresh.

- `src/renderer/styles/shared.css`
  - Replace table/drawer styles with kanban board and standalone detail page styles.

- `src/renderer/styles/responsive.css`
  - Add mobile layout for four-column kanban collapse and detail page stacking.

- Tests to update or add:
  - `tests/main/startup-load-policy.test.ts`
  - `tests/renderer/app-shell.test.tsx`
  - `tests/renderer/history-sidebar.test.ts`
  - `tests/renderer/chat-view.queued-task.test.ts`
  - `tests/renderer/chat-view.test.ts`
  - `tests/renderer/features/chat-feature.test.tsx`
  - `tests/renderer/features/tasks-feature.test.tsx`
  - `tests/renderer/task-actions.test.ts`
  - `tests/renderer/tasks-view.interaction.test.ts`
  - `tests/renderer/task-detail-drawer.test.ts`
  - `tests/renderer/chat-transcript.test.ts`
  - `tests/smoke/electron-smoke.mjs`

---

### Task 1: Split Task Routing Into Explicit Board And Detail Views

**Files:**
- Modify: `src/renderer/app/types.ts`
- Modify: `src/renderer/app/view-routing.ts`
- Modify: `src/renderer/startup-load-policy.ts`
- Modify: `tests/main/startup-load-policy.test.ts`

- [ ] **Step 1: Add red tests for the new task view IDs and startup policy**

In `tests/main/startup-load-policy.test.ts`, replace the old single-task-view case with:

```ts
  it('loads task surface for both task board and task detail pages only', () => {
    const boardIntent = getStartupLoadIntent({
      activeView: 'tasks-board',
      activeWorkbenchTool: 'files',
      workbenchVisible: false
    });
    const detailIntent = getStartupLoadIntent({
      activeView: 'task-detail',
      activeWorkbenchTool: 'files',
      workbenchVisible: false
    });
    const chatIntent = getStartupLoadIntent({
      activeView: 'chat',
      activeWorkbenchTool: 'files',
      workbenchVisible: false
    });

    expectTargets(boardIntent, ['taskSurface']);
    expectTargets(detailIntent, ['taskSurface']);
    expect(chatIntent.targets.has('taskSurface')).toBe(false);
  });
```

- [ ] **Step 2: Run the startup policy test to verify it fails**

Run:

```powershell
pnpm test -- tests/main/startup-load-policy.test.ts
```

Expected:

- FAIL because `StartupLoadViewId` does not yet include `tasks-board` or `task-detail`.
- FAIL because `getStartupLoadIntent` still checks only `activeView === 'tasks'`.

- [ ] **Step 3: Update task view IDs in renderer type and routing files**

In `src/renderer/app/types.ts`, replace:

```ts
export type ViewId =
  | 'chat'
  | 'tasks'
  | 'workspace'
  | 'git'
  | 'terminal'
  | 'preview'
  | 'mcp'
  | 'skills'
  | 'memory'
  | 'settings'
  | 'diagnostics';
```

with:

```ts
export type ViewId =
  | 'chat'
  | 'tasks-board'
  | 'task-detail'
  | 'workspace'
  | 'git'
  | 'terminal'
  | 'preview'
  | 'mcp'
  | 'skills'
  | 'memory'
  | 'settings'
  | 'diagnostics';
```

In `src/renderer/app/view-routing.ts`, replace:

```ts
export const MAIN_VIEW_IDS = new Set<ViewId>([
  'chat',
  'tasks',
  'workspace',
  'git',
  'terminal',
  'preview',
  'mcp',
  'skills',
  'memory',
  'settings',
  'diagnostics'
]);
```

with:

```ts
export const MAIN_VIEW_IDS = new Set<ViewId>([
  'chat',
  'tasks-board',
  'task-detail',
  'workspace',
  'git',
  'terminal',
  'preview',
  'mcp',
  'skills',
  'memory',
  'settings',
  'diagnostics'
]);
```

Replace the old task page meta:

```ts
  tasks: {
    title: '任务工作台',
    topMeta: '任务状态',
    pageLabel: '任务控制'
  },
```

with:

```ts
  'tasks-board': {
    title: '任务工作台',
    topMeta: '任务看板',
    pageLabel: '任务控制'
  },
  'task-detail': {
    title: '任务详情',
    topMeta: '任务执行上下文',
    pageLabel: '任务控制'
  },
```

Update `buildTopMeta`:

```ts
  if (view === 'tasks-board' || view === 'task-detail') {
    return `${state.taskSnapshot.counts.total} 个任务 · 运行中 ${state.taskSnapshot.counts.running}`;
  }
```

In `src/renderer/startup-load-policy.ts`, replace:

```ts
export type StartupLoadViewId =
  | 'chat'
  | 'tasks'
  | 'workspace'
  | 'git'
  | 'terminal'
  | 'preview'
  | 'mcp'
  | 'skills'
  | 'memory'
  | 'settings'
  | 'diagnostics';
```

with:

```ts
export type StartupLoadViewId =
  | 'chat'
  | 'tasks-board'
  | 'task-detail'
  | 'workspace'
  | 'git'
  | 'terminal'
  | 'preview'
  | 'mcp'
  | 'skills'
  | 'memory'
  | 'settings'
  | 'diagnostics';
```

Replace:

```ts
  if (input.activeView === 'tasks') {
    targets.add('taskSurface');
  }
```

with:

```ts
  if (input.activeView === 'tasks-board' || input.activeView === 'task-detail') {
    targets.add('taskSurface');
  }
```

- [ ] **Step 4: Run the startup policy test to verify it passes**

Run:

```powershell
pnpm test -- tests/main/startup-load-policy.test.ts
```

Expected: `PASS`.

- [ ] **Step 5: Commit the routing split**

Run:

```powershell
git add src/renderer/app/types.ts src/renderer/app/view-routing.ts src/renderer/startup-load-policy.ts tests/main/startup-load-policy.test.ts
git commit -m "refactor: split task board and detail views"
```

---

### Task 2: Replace Queued Task Prompt Routing With Task-Domain State In AppShell

**Files:**
- Modify: `src/renderer/app/AppShell.tsx`
- Modify: `src/renderer/chat/task-run-payload.ts`
- Modify: `tests/renderer/app-shell.test.tsx`

- [ ] **Step 1: Add red AppShell tests for task-domain navigation**

In `tests/renderer/app-shell.test.tsx`, add:

```tsx
  it('opens the task workbench entry as the board page instead of chat', async () => {
    const client = createShellClient();
    window.roc = client.api;
    window.history.replaceState(null, '', '/?page=tasks-board');

    await act(async () => {
      root.render(<AppShell bootstrap={createBootstrap()} client={client} />);
    });

    expect(container.textContent).toContain('任务工作台');
    expect(container.querySelector('[data-testid="tasks-board-view"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-view"]')).toBeNull();
  });
```

Add:

```tsx
  it('does not keep queued task prompt state in the task workbench flow', async () => {
    const client = createShellClient();
    window.roc = client.api;

    await act(async () => {
      root.render(<AppShell bootstrap={createBootstrap()} client={client} />);
    });

    expect(container.textContent).not.toContain('请调用 propose_background_task 创建任务');
  });
```

- [ ] **Step 2: Run the AppShell test file to verify it fails**

Run:

```powershell
pnpm test -- tests/renderer/app-shell.test.tsx
```

Expected:

- FAIL because `tasks-board-view` does not exist.
- FAIL because `parseViewId` does not yet route the board page through `ViewContent`.

- [ ] **Step 3: Delete queued-task types that only exist for task creation via chat**

In `src/renderer/chat/task-run-payload.ts`, replace:

```ts
export type ChatTaskSubmitPayload = {
  input: string;
  workflowHint?: WorkflowHint;
  taskSource?: 'workbench' | null;
};

export type QueuedTaskPrompt = {
  input: string;
  workflowHint: WorkflowHint;
  taskSource?: 'workbench' | null;
  workspacePath?: string;
};
```

with:

```ts
export type ChatTaskSubmitPayload = {
  input: string;
  workflowHint?: WorkflowHint;
  taskSource?: 'workbench' | null;
};
```

- [ ] **Step 4: Add task-domain navigation state to AppShell**

In `src/renderer/app/AppShell.tsx`, replace:

```ts
  const [selectedTaskSurfaceTaskId, setSelectedTaskSurfaceTaskId] = useState<string | null | undefined>(undefined);
  const [taskLiveRunState, setTaskLiveRunState] = useState<ChatRunState>(() => createEmptyChatRunState());
  const [chatSelectionVersion, setChatSelectionVersion] = useState(0);
  const [queuedTaskPrompt, setQueuedTaskPrompt] = useState<QueuedTaskPrompt | null>(null);
  const [pendingWorkflowHint, setPendingWorkflowHint] = useState<WorkflowHint>(null);
  const [pendingTaskSource, setPendingTaskSource] = useState<ChatStartRunRequest['taskSource'] | null>(null);
```

with:

```ts
  const [selectedTaskSurfaceTaskId, setSelectedTaskSurfaceTaskId] = useState<string | null | undefined>(undefined);
  const [activeTaskDetailId, setActiveTaskDetailId] = useState<string | null>(null);
  const [taskBoardUiState, setTaskBoardUiState] = useState<{
    railId: 'all' | 'todo' | 'running' | 'paused' | 'done';
    scrollTop: number;
  }>({
    railId: 'all',
    scrollTop: 0
  });
  const [taskLiveRunState, setTaskLiveRunState] = useState<ChatRunState>(() => createEmptyChatRunState());
  const [chatSelectionVersion, setChatSelectionVersion] = useState(0);
  const [pendingWorkflowHint, setPendingWorkflowHint] = useState<WorkflowHint>(null);
  const [pendingTaskSource, setPendingTaskSource] = useState<ChatStartRunRequest['taskSource'] | null>(null);
```

- [ ] **Step 5: Replace old task-chat navigation callbacks with board/detail navigation**

In `src/renderer/app/AppShell.tsx`, replace:

```ts
  const navigateToTaskThread = useCallback((threadId: string, workflowHint?: WorkflowHint, taskSource?: ChatStartRunRequest['taskSource']): void => {
    setActiveView('chat');
    setSelectedThreadId(threadId);
    setPendingWorkflowHint(workflowHint ?? null);
    setPendingTaskSource(taskSource ?? null);
    setHistoryContextMenu(null);
    setChatSelectionVersion((current) => current + 1);
  }, []);
```

with:

```ts
  const openTaskDetail = useCallback((taskId: string, boardUiState?: { railId: 'all' | 'todo' | 'running' | 'paused' | 'done'; scrollTop: number }): void => {
    if (boardUiState !== undefined) {
      setTaskBoardUiState(boardUiState);
    }
    setSelectedTaskSurfaceTaskId(taskId);
    setActiveTaskDetailId(taskId);
    setActiveView('task-detail');
    setHistoryContextMenu(null);
  }, []);

  const returnToTaskBoard = useCallback((): void => {
    setActiveTaskDetailId(null);
    setActiveView('tasks-board');
    setHistoryContextMenu(null);
  }, []);
```

Delete the entire old `queueTaskPrompt` and `handleQueuedTaskPromptHandled` callbacks:

```ts
  const queueTaskPrompt = useCallback(async (payload: TaskPromptSubmission): Promise<{ ok: true } | { ok: false; error: string }> => {
    setSelectedThreadId(null);
    setPendingWorkflowHint(null);
    setPendingTaskSource(null);
    setQueuedTaskPrompt(payload);
    setActiveView('chat');
    setWorkbenchVisible(false);
    setHistoryContextMenu(null);
    setChatSelectionVersion((current) => current + 1);
    return { ok: true };
  }, []);

  const handleQueuedTaskPromptHandled = useCallback((): void => {
    setQueuedTaskPrompt(null);
  }, []);
```

- [ ] **Step 6: Keep task runs local to the task domain**

In `src/renderer/app/AppShell.tsx`, replace `startTaskRun` with:

```ts
  const startTaskRun = useCallback(
    async (payload: ChatTaskSubmitPayload): Promise<{ ok: true; threadId: string } | { ok: false; error: string }> => {
      const workflowHint = payload.workflowHint === undefined ? pendingWorkflowHint : payload.workflowHint;
      const taskSource = payload.taskSource === undefined ? pendingTaskSource : payload.taskSource;
      const result = await chatFeature.startRun({
        input: payload.input,
        mode: 'task',
        threadId: selectedThreadId,
        enabledCapabilities: {
          mcpServers: currentSelectedMcpServers,
          skills: currentSelectedSkills
        },
        workflowHint: workflowHint ?? null,
        taskSource: taskSource ?? null
      });
      setPendingWorkflowHint(null);
      setPendingTaskSource(null);
      if (!result.ok) {
        return { ok: false, error: result.error.message };
      }
      if (result.data.threadId === null) {
        return { ok: false, error: '任务运行没有返回可打开的会话。' };
      }
      setSelectedThreadId(result.data.threadId);
      setHistoryContextMenu(null);
      return { ok: true, threadId: result.data.threadId };
    },
    [chatFeature, currentSelectedMcpServers, currentSelectedSkills, pendingTaskSource, pendingWorkflowHint, selectedThreadId]
  );
```

- [ ] **Step 7: Run the AppShell test again**

Run:

```powershell
pnpm test -- tests/renderer/app-shell.test.tsx
```

Expected: still FAIL, but now the only remaining failures should be because `ViewContent` and the task feature split are not implemented yet.

- [ ] **Step 8: Commit the AppShell state refactor**

Run:

```powershell
git add src/renderer/app/AppShell.tsx src/renderer/chat/task-run-payload.ts tests/renderer/app-shell.test.tsx
git commit -m "refactor: move task routing into task domain state"
```

---

### Task 3: Split ViewContent And Task Features Into Board And Detail Surfaces

**Files:**
- Modify: `src/renderer/views/ViewContent.tsx`
- Modify: `src/renderer/features/tasks/index.tsx`
- Create: `src/renderer/views/tasks/TaskDetailView.tsx`
- Create: `src/renderer/views/tasks/TaskBoardColumn.tsx`
- Create: `src/renderer/views/tasks/TaskBoardCard.tsx`
- Create: `src/renderer/views/tasks/task-board-model.ts`
- Modify: `tests/renderer/features/tasks-feature.test.tsx`

- [ ] **Step 1: Add red feature tests for separate board and detail rendering**

In `tests/renderer/features/tasks-feature.test.tsx`, add:

```tsx
  it('renders the kanban board without a task detail drawer', async () => {
    await act(async () => {
      root.render(
        <TasksBoardFeature
          client={createTasksClient()}
          liveTaskRun={null}
          onCreateTask={vi.fn()}
          onOpenTaskDetail={() => {}}
          onSelectedTaskIdChange={() => {}}
          state={createLoadedState({ activeTasks: [] })}
          updateLoadedState={() => {}}
          boardUiState={{ railId: 'all', scrollTop: 0 }}
          onBoardUiStateChange={() => {}}
        />
      );
    });

    expect(container.querySelector('[data-testid="tasks-board-view"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="task-detail-drawer"]')).toBeNull();
  });
```

Add:

```tsx
  it('renders the standalone task detail page', async () => {
    await act(async () => {
      root.render(
        <TaskDetailFeature
          client={createTasksClient()}
          liveTaskRun={null}
          onBackToBoard={() => {}}
          onSubmitTaskInput={vi.fn()}
          state={createLoadedState({})}
          taskId="task-1"
          updateLoadedState={() => {}}
        />
      );
    });

    expect(container.querySelector('[data-testid="task-detail-view"]')).not.toBeNull();
    expect(container.textContent).toContain('返回任务工作台');
  });
```

- [ ] **Step 2: Run the task feature test file to verify it fails**

Run:

```powershell
pnpm test -- tests/renderer/features/tasks-feature.test.tsx
```

Expected:

- FAIL because `TasksBoardFeature` and `TaskDetailFeature` do not exist.

- [ ] **Step 3: Replace the single tasks feature export with board and detail feature wrappers**

In `src/renderer/features/tasks/index.tsx`, replace the file with:

```tsx
import type { ChatRunState } from '../../chat-run-state';
import type { LoadedState } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import type { TaskPromptSubmission } from '../../views/tasks/TasksView';
import { TaskDetailView } from '../../views/tasks/TaskDetailView';
import { TasksView } from '../../views/tasks/TasksView';

export function TasksBoardFeature(props: {
  client: RocClient;
  liveTaskRun: ChatRunState | null;
  onCreateTask: (payload: TaskPromptSubmission) => Promise<{ ok: true } | { ok: false; error: string }>;
  onOpenTaskDetail: (taskId: string, boardUiState: { railId: 'all' | 'todo' | 'running' | 'paused' | 'done'; scrollTop: number }) => void;
  onSelectedTaskIdChange: (taskId: string | null | undefined) => void;
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
  boardUiState: { railId: 'all' | 'todo' | 'running' | 'paused' | 'done'; scrollTop: number };
  onBoardUiStateChange: (state: { railId: 'all' | 'todo' | 'running' | 'paused' | 'done'; scrollTop: number }) => void;
}): React.JSX.Element {
  return <TasksView {...props} onSubmitTaskPrompt={props.onCreateTask} />;
}

export function TaskDetailFeature(props: {
  client: RocClient;
  liveTaskRun: ChatRunState | null;
  onBackToBoard: () => void;
  onSubmitTaskInput: (payload: { input: string; taskId: string }) => Promise<{ ok: true } | { ok: false; error: string }>;
  state: LoadedState;
  taskId: string;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
}): React.JSX.Element {
  return <TaskDetailView {...props} />;
}
```

- [ ] **Step 4: Render explicit task pages in ViewContent**

In `src/renderer/views/ViewContent.tsx`, remove:

```tsx
import type { ChatTaskSubmitPayload, QueuedTaskPrompt } from '../chat/task-run-payload';
```

and replace it with:

```tsx
import type { ChatTaskSubmitPayload } from '../chat/task-run-payload';
```

Replace:

```tsx
import { TasksFeature } from '../features/tasks';
```

with:

```tsx
import { TaskDetailFeature, TasksBoardFeature } from '../features/tasks';
```

First update `ViewContent` props. Replace:

```tsx
  onNavigateToTaskThread: (threadId: string, workflowHint?: WorkflowHint) => void;
  operationsLoadState: LazyLoadState;
  onQueueTaskPrompt: (prompt: TaskPromptSubmission) => Promise<{ ok: true } | { ok: false; error: string }>;
  queuedTaskPrompt: QueuedTaskPrompt | null;
  onQueuedTaskPromptHandled: () => void;
  onSelectWorkspace: () => Promise<void>;
  onSubmitChatTask: (payload: ChatTaskSubmitPayload) => Promise<{ ok: true } | { ok: false; error: string }>;
  onTaskSurfaceSelectionChange: (taskId: string | null | undefined) => void;
  selectedThreadId: string | null;
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
  workspaceLoadState: LazyLoadState;
```

with:

```tsx
  onOpenTaskDetail: (taskId: string, boardUiState: { railId: 'all' | 'todo' | 'running' | 'paused' | 'done'; scrollTop: number }) => void;
  onBackToTaskBoard: () => void;
  operationsLoadState: LazyLoadState;
  onQueueTaskPrompt: (prompt: TaskPromptSubmission) => Promise<{ ok: true } | { ok: false; error: string }>;
  onSelectWorkspace: () => Promise<void>;
  onSubmitChatTask: (payload: ChatTaskSubmitPayload) => Promise<{ ok: true } | { ok: false; error: string }>;
  onSubmitTaskDetailInput: (payload: { input: string; taskId: string }) => Promise<{ ok: true } | { ok: false; error: string }>;
  onTaskSurfaceSelectionChange: (taskId: string | null | undefined) => void;
  selectedTaskDetailId: string | null;
  selectedThreadId: string | null;
  state: LoadedState;
  taskBoardUiState: { railId: 'all' | 'todo' | 'running' | 'paused' | 'done'; scrollTop: number };
  onTaskBoardUiStateChange: (state: { railId: 'all' | 'todo' | 'running' | 'paused' | 'done'; scrollTop: number }) => void;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
  workspaceLoadState: LazyLoadState;
```

Then replace the task branch:

```tsx
  if (activeView === 'tasks') {
    return (
      <TasksFeature
        client={client}
        liveTaskRun={liveTaskRun}
        onNavigateToThread={onNavigateToTaskThread}
        onSelectedTaskIdChange={onTaskSurfaceSelectionChange}
        onSubmitTaskPrompt={onQueueTaskPrompt}
        state={state}
        updateLoadedState={updateLoadedState}
      />
    );
  }
```

with:

```tsx
  if (activeView === 'tasks-board') {
    return (
      <TasksBoardFeature
        client={client}
        liveTaskRun={liveTaskRun}
        onCreateTask={onQueueTaskPrompt}
        onOpenTaskDetail={onOpenTaskDetail}
        onSelectedTaskIdChange={onTaskSurfaceSelectionChange}
        state={state}
        updateLoadedState={updateLoadedState}
        boardUiState={taskBoardUiState}
        onBoardUiStateChange={onTaskBoardUiStateChange}
      />
    );
  }
  if (activeView === 'task-detail') {
    if (selectedTaskDetailId === null) {
      return (
        <section className="canvas-stage task-detail-page" data-testid="task-detail-view">
          <button className="action-button" type="button" onClick={onBackToTaskBoard}>
            返回任务工作台
          </button>
          <div className="section-empty-state">
            <strong>任务不存在</strong>
            <p>当前任务不存在或已经删除。</p>
          </div>
        </section>
      );
    }
    return (
      <TaskDetailFeature
        client={client}
        liveTaskRun={liveTaskRun}
        onBackToBoard={onBackToTaskBoard}
        onSubmitTaskInput={onSubmitTaskDetailInput}
        state={state}
        taskId={selectedTaskDetailId}
        updateLoadedState={updateLoadedState}
      />
    );
  }
```

- [ ] **Step 5: Create the minimal board/detail view shells**

Create `src/renderer/views/tasks/TaskBoardColumn.tsx`:

```tsx
import type { ActiveTaskItem } from '../../../shared/types';
import { TaskBoardCard } from './TaskBoardCard';

export function TaskBoardColumn({
  items,
  onOpenTask,
  title
}: {
  items: ActiveTaskItem[];
  onOpenTask: (taskId: string) => void;
  title: string;
}): React.JSX.Element {
  return (
    <section className="task-board-column" data-testid={`task-board-column-${title}`}>
      <header className="task-board-column-head">
        <h2 className="section-title">{title}</h2>
        <span className="status-pill info">
          <span>{items.length}</span>
        </span>
      </header>
      <div className="task-board-column-list">
        {items.map((item) => (
          <TaskBoardCard key={item.taskId} item={item} onOpenTask={() => onOpenTask(item.taskId)} />
        ))}
      </div>
    </section>
  );
}
```

Create `src/renderer/views/tasks/TaskBoardCard.tsx`:

```tsx
import type { ActiveTaskItem } from '../../../shared/types';

export function TaskBoardCard({
  item,
  onOpenTask
}: {
  item: ActiveTaskItem;
  onOpenTask: () => void;
}): React.JSX.Element {
  return (
    <button className="task-board-card" data-testid={`task-board-card-${item.taskId}`} type="button" onClick={onOpenTask}>
      <span className="task-board-card-title">{item.goal}</span>
      <span className="task-board-card-meta">{item.status}</span>
      <span className="task-board-card-meta">{item.workspacePath ?? '无工作区'}</span>
    </button>
  );
}
```

Create `src/renderer/views/tasks/task-board-model.ts`:

```ts
import type { ActiveTaskItem, TaskStatus } from '../../../shared/types';

export type TaskBoardLaneId = 'todo' | 'running' | 'paused' | 'done';

export type TaskBoardLane = {
  id: TaskBoardLaneId;
  title: string;
  statuses: TaskStatus[];
  items: ActiveTaskItem[];
};

const laneConfig: Array<{ id: TaskBoardLaneId; title: string; statuses: TaskStatus[] }> = [
  { id: 'todo', title: '待处理', statuses: ['pending_confirmation', 'waiting_user'] },
  { id: 'running', title: '进行中', statuses: ['running', 'waiting_next_turn'] },
  { id: 'paused', title: '已暂停', statuses: ['paused'] },
  { id: 'done', title: '已结束', statuses: ['failed', 'cancelled', 'completed', 'archived'] }
];

export function buildTaskBoardLanes(items: ActiveTaskItem[]): TaskBoardLane[] {
  return laneConfig.map((lane) => ({
    ...lane,
    items: items.filter((item) => lane.statuses.includes(item.status))
  }));
}
```

Create `src/renderer/views/tasks/TaskDetailView.tsx`:

```tsx
export function TaskDetailView({
  onBackToBoard
}: {
  onBackToBoard: () => void;
}): React.JSX.Element {
  return (
    <section className="canvas-stage task-detail-page" data-testid="task-detail-view">
      <button className="action-button" type="button" onClick={onBackToBoard}>
        返回任务工作台
      </button>
    </section>
  );
}
```

- [ ] **Step 6: Run the task feature test again**

Run:

```powershell
pnpm test -- tests/renderer/features/tasks-feature.test.tsx
```

Expected: still FAIL because `TasksView` is still the old mixed table/drawer surface and `ViewContent` wiring is not yet complete.

- [ ] **Step 7: Commit the feature split skeleton**

Run:

```powershell
git add src/renderer/views/ViewContent.tsx src/renderer/features/tasks/index.tsx src/renderer/views/tasks/TaskDetailView.tsx src/renderer/views/tasks/TaskBoardColumn.tsx src/renderer/views/tasks/TaskBoardCard.tsx src/renderer/views/tasks/task-board-model.ts tests/renderer/features/tasks-feature.test.tsx
git commit -m "feat: add separate task board and detail feature shells"
```

---

### Task 4: Convert TasksView Into A Pure Kanban Board

**Files:**
- Modify: `src/renderer/views/tasks/TasksView.tsx`
- Delete: `src/renderer/views/tasks/TaskDetailDrawer.tsx`
- Modify: `tests/renderer/tasks-view.interaction.test.ts`
- Delete: `tests/renderer/task-detail-drawer.test.ts`

- [ ] **Step 1: Replace old interaction tests with board behavior tests**

In `tests/renderer/tasks-view.interaction.test.ts`, remove the drawer-specific test cases and add:

```tsx
  it('renders four kanban columns and no left task rail', async () => {
    await act(async () => {
      root.render(
        React.createElement(TasksView, {
          state: createLoadedState({
            activeTasks: [
              createActiveTask({ taskId: 'pending-1', threadId: 'thread-pending-1', goal: '等待审批', status: 'pending_confirmation' }),
              createActiveTask({ taskId: 'running-1', threadId: 'thread-running-1', goal: '执行中', status: 'running' }),
              createActiveTask({ taskId: 'paused-1', threadId: 'thread-paused-1', goal: '暂停中', status: 'paused' }),
              createActiveTask({ taskId: 'done-1', threadId: 'thread-done-1', goal: '已完成', status: 'completed' })
            ]
          }),
          updateLoadedState: () => {},
          liveTaskRun: null,
          onOpenTaskDetail: () => {},
          onSelectedTaskIdChange: () => {},
          onSubmitTaskPrompt: async () => ({ ok: true as const }),
          boardUiState: { railId: 'all', scrollTop: 0 },
          onBoardUiStateChange: () => {}
        })
      );
    });

    expect(container.querySelector('[data-testid="task-status-rail"]')).toBeNull();
    expect(container.querySelector('[data-testid="task-board-column-待处理"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="task-board-column-进行中"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="task-board-column-已暂停"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="task-board-column-已结束"]')).not.toBeNull();
  });
```

Add:

```tsx
  it('opens task detail when a kanban card is clicked', async () => {
    const onOpenTaskDetail = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(TasksView, {
          state: createLoadedState({
            activeTasks: [createActiveTask({ taskId: 'running-1', threadId: 'thread-running-1', goal: '执行中', status: 'running' })]
          }),
          updateLoadedState: () => {},
          liveTaskRun: null,
          onOpenTaskDetail,
          onSelectedTaskIdChange: () => {},
          onSubmitTaskPrompt: async () => ({ ok: true as const }),
          boardUiState: { railId: 'all', scrollTop: 0 },
          onBoardUiStateChange: () => {}
        })
      );
    });

    const card = container.querySelector('[data-testid="task-board-card-running-1"]');
    expect(card).not.toBeNull();

    await act(async () => {
      card?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onOpenTaskDetail).toHaveBeenCalledWith('running-1', { railId: 'all', scrollTop: 0 });
  });
```

- [ ] **Step 2: Run the TasksView interaction tests to verify they fail**

Run:

```powershell
pnpm test -- tests/renderer/tasks-view.interaction.test.ts
```

Expected:

- FAIL because `TasksView` still renders the rail/table/drawer layout.

- [ ] **Step 3: Rewrite TasksView to board-only responsibility**

In `src/renderer/views/tasks/TasksView.tsx`, replace the current props signature:

```ts
export function TasksView({
  client,
  state,
  updateLoadedState,
  liveTaskRun,
  onNavigateToThread,
  onSelectedTaskIdChange,
  onSubmitTaskPrompt
}: {
  client?: RocClient;
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
  liveTaskRun: ChatRunState | null;
  onNavigateToThread: (threadId: string, workflowHint?: WorkflowHint, taskSource?: ChatStartRunRequest['taskSource']) => void;
  onSelectedTaskIdChange: (taskId: string | null | undefined) => void;
  onSubmitTaskPrompt: (payload: TaskPromptSubmission) => Promise<{ ok: true } | { ok: false; error: string }>;
}): React.JSX.Element {
```

with:

```ts
export function TasksView({
  state,
  onOpenTaskDetail,
  onSelectedTaskIdChange,
  onSubmitTaskPrompt,
  boardUiState,
  onBoardUiStateChange
}: {
  client?: RocClient;
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
  liveTaskRun: ChatRunState | null;
  onOpenTaskDetail: (taskId: string, boardUiState: { railId: 'all' | 'todo' | 'running' | 'paused' | 'done'; scrollTop: number }) => void;
  onSelectedTaskIdChange: (taskId: string | null | undefined) => void;
  onSubmitTaskPrompt: (payload: TaskPromptSubmission) => Promise<{ ok: true } | { ok: false; error: string }>;
  boardUiState: { railId: 'all' | 'todo' | 'running' | 'paused' | 'done'; scrollTop: number };
  onBoardUiStateChange: (state: { railId: 'all' | 'todo' | 'running' | 'paused' | 'done'; scrollTop: number }) => void;
}): React.JSX.Element {
```

Replace the old model/selection setup:

```ts
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(state.activeTasks[0]?.taskId ?? state.activeTasks[0]?.threadId ?? null);
  const [selectedRailId, setSelectedRailId] = useState<TaskRailId>('all');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const model = useMemo(() => buildTaskViewModel(state), [state]);
  const visibleItems = useMemo(() => filterTaskItems(model.allItems, selectedRailId), [model.allItems, selectedRailId]);
  const selectedRail = model.railItems.find((item) => item.id === selectedRailId) ?? model.railItems[0];
  const taskTableTitle = selectedRailId === 'all' ? '全部任务' : `${selectedRail?.title ?? '全部'}任务`;
```

with:

```ts
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const lanes = useMemo(() => buildTaskBoardLanes(state.activeTasks), [state.activeTasks]);
```

Replace the main render branch with:

```tsx
      <section className="canvas-stage stage-grid task-board-page" data-testid="tasks-board-view">
        {state.activeTasks.length === 0 ? (
          <div className="task-empty-shell">
            <EmptyState
              testId="tasks-empty-state"
              title="暂无任务"
              action={
                <button className="action-button" type="button" onClick={() => setCreateDialogOpen(true)}>
                  新建任务
                </button>
              }
            />
            <p className="muted">点击右上角“新建任务”开始创建后台任务。</p>
          </div>
        ) : (
          <div className="task-board-grid">
            {lanes.map((lane) => (
              <TaskBoardColumn
                key={lane.id}
                items={lane.items}
                onOpenTask={(taskId) => {
                  onSelectedTaskIdChange(taskId);
                  onBoardUiStateChange(boardUiState);
                  onOpenTaskDetail(taskId, boardUiState);
                }}
                title={lane.title}
              />
            ))}
          </div>
        )}
      </section>
```

Delete all references to:

```ts
TaskDetailDrawer
TaskRow
buildTaskViewModel
filterTaskItems
TaskRailId
useTaskActions
formatSchedulerMeta
selectedTaskId
selectedRailId
selectedItem
selectedScheduledRuns
```

- [ ] **Step 4: Delete the embedded drawer file and its test**

Delete:

```text
src/renderer/views/tasks/TaskDetailDrawer.tsx
tests/renderer/task-detail-drawer.test.ts
```

- [ ] **Step 5: Run the TasksView interaction tests**

Run:

```powershell
pnpm test -- tests/renderer/tasks-view.interaction.test.ts
```

Expected: `PASS`.

- [ ] **Step 6: Commit the board conversion**

Run:

```powershell
git add src/renderer/views/tasks/TasksView.tsx src/renderer/views/tasks/TaskBoardColumn.tsx src/renderer/views/tasks/TaskBoardCard.tsx src/renderer/views/tasks/task-board-model.ts tests/renderer/tasks-view.interaction.test.ts
git rm src/renderer/views/tasks/TaskDetailDrawer.tsx tests/renderer/task-detail-drawer.test.ts
git commit -m "feat: convert task workbench to kanban board"
```

---

### Task 5: Keep Task Creation In The Task Domain And Auto-Open Detail

**Files:**
- Modify: `src/renderer/app/AppShell.tsx`
- Modify: `src/renderer/views/tasks/TasksView.tsx`
- Modify: `tests/renderer/features/tasks-feature.test.tsx`
- Modify: `tests/renderer/tasks-view.interaction.test.ts`

- [ ] **Step 1: Add red tests for create-success navigation**

In `tests/renderer/tasks-view.interaction.test.ts`, replace the old submission assertion with:

```tsx
  it('submits the new task description through the existing task prompt contract and stays in the task domain', async () => {
    const onSubmitTaskPrompt = vi.fn().mockResolvedValue({ ok: true as const });

    await act(async () => {
      root.render(
        React.createElement(TasksView, {
          state: createLoadedState({
            activeTasks: [],
            workspace: {
              id: 'workspace-1',
              path: 'F:\\\\Code\\\\Roc',
              displayName: 'Roc',
              trustState: 'trusted',
              lastOpenedAt: '2026-05-21T00:00:00.000Z'
            }
          }),
          updateLoadedState: () => {},
          liveTaskRun: null,
          onOpenTaskDetail: () => {},
          onSelectedTaskIdChange: () => {},
          onSubmitTaskPrompt,
          boardUiState: { railId: 'all', scrollTop: 0 },
          onBoardUiStateChange: () => {}
        })
      );
    });

    const trigger = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.trim() === '新建任务');
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    setTextareaValue('task-create-description', '每天晚上 7:40 抓取 AI 最新新闻，并将结果写入当前工作目录下的 docx 文件');

    await act(async () => {
      queryButton('task-create-submit').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(onSubmitTaskPrompt).toHaveBeenCalledWith({
      input: '每天晚上 7:40 抓取 AI 最新新闻，并将结果写入当前工作目录下的 docx 文件',
      workflowHint: 'propose_background_task',
      taskSource: 'workbench',
      workspacePath: 'F:\\\\Code\\\\Roc'
    });
    expect(container.querySelector('[data-testid="chat-view"]')).toBeNull();
  });
```

In `tests/renderer/features/tasks-feature.test.tsx`, add:

```tsx
  it('navigates to the new task detail page after task creation succeeds', async () => {
    const onCreateTask = vi.fn().mockResolvedValue({ ok: true as const });
    const onOpenTaskDetail = vi.fn();

    await act(async () => {
      root.render(
        <TasksBoardFeature
          client={createTasksClient()}
          liveTaskRun={null}
          onCreateTask={onCreateTask}
          onOpenTaskDetail={onOpenTaskDetail}
          onSelectedTaskIdChange={() => {}}
          state={createLoadedState({
            activeTasks: [],
            workspace: {
              id: 'workspace-1',
              path: 'F:\\\\Code\\\\Roc',
              displayName: 'Roc',
              trustState: 'trusted',
              lastOpenedAt: '2026-05-21T00:00:00.000Z'
            }
          })}
          updateLoadedState={() => {}}
          boardUiState={{ railId: 'all', scrollTop: 0 }}
          onBoardUiStateChange={() => {}}
        />
      );
    });

    const trigger = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.trim() === '新建任务');
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    setTextareaValue('task-create-description', '每天晚上总结新闻');
    await act(async () => {
      queryButton('task-create-submit').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(onCreateTask).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run the board and task view tests to verify they fail**

Run:

```powershell
pnpm test -- tests/renderer/features/tasks-feature.test.tsx tests/renderer/tasks-view.interaction.test.ts
```

Expected:

- FAIL because the board feature does not yet auto-open detail after successful creation.

- [ ] **Step 3: Let AppShell create the task run and reopen task surface before entering detail**

In `src/renderer/app/AppShell.tsx`, add this helper near `startTaskRun`:

```ts
  const createTaskFromWorkbench = useCallback(
    async (payload: TaskPromptSubmission): Promise<{ ok: true } | { ok: false; error: string }> => {
      const result = await startTaskRun({
        input: payload.input,
        workflowHint: payload.workflowHint,
        taskSource: payload.taskSource
      });
      if (!result.ok) {
        return result;
      }
      const latestTaskSurface = await loadTaskSurfaceData(undefined, client);
      setState((current) => (current === null ? current : { ...current, ...latestTaskSurface }));
      const detailTargetTaskId =
        latestTaskSurface.activeTasks.find((item) => item.threadId === result.threadId)?.taskId ?? null;
      if (detailTargetTaskId === null) {
        return { ok: false, error: '创建任务后未找到对应的任务详情。' };
      }
      openTaskDetail(detailTargetTaskId, taskBoardUiState);
      return { ok: true };
    },
    [client, openTaskDetail, setState, startTaskRun, taskBoardUiState]
  );
```

- [ ] **Step 4: Point the board page create callback to the new AppShell helper**

In `src/renderer/app/AppShell.tsx`, when rendering `ViewContent`, replace:

```tsx
              onQueueTaskPrompt={queueTaskPrompt}
              onOpenTaskDetail={openTaskDetail}
              onBackToTaskBoard={returnToTaskBoard}
              onSubmitTaskDetailInput={continueTaskFromDetail}
              selectedTaskDetailId={activeTaskDetailId}
              taskBoardUiState={taskBoardUiState}
              onTaskBoardUiStateChange={setTaskBoardUiState}
```

with:

```tsx
              onQueueTaskPrompt={createTaskFromWorkbench}
              onOpenTaskDetail={openTaskDetail}
              onBackToTaskBoard={returnToTaskBoard}
              onSubmitTaskDetailInput={continueTaskFromDetail}
              selectedTaskDetailId={activeTaskDetailId}
              taskBoardUiState={taskBoardUiState}
              onTaskBoardUiStateChange={setTaskBoardUiState}
```

- [ ] **Step 5: Run the task creation tests**

Run:

```powershell
pnpm test -- tests/renderer/features/tasks-feature.test.tsx tests/renderer/tasks-view.interaction.test.ts
```

Expected: `PASS`.

- [ ] **Step 6: Commit task creation flow**

Run:

```powershell
git add src/renderer/app/AppShell.tsx src/renderer/views/tasks/TasksView.tsx tests/renderer/features/tasks-feature.test.tsx tests/renderer/tasks-view.interaction.test.ts
git commit -m "feat: keep task creation inside the kanban domain"
```

---

### Task 6: Build The Standalone Task Detail Page With Transcript, Approval, And Waiting-User Continue

**Files:**
- Modify: `src/renderer/views/tasks/TaskDetailView.tsx`
- Modify: `src/renderer/app/AppShell.tsx`
- Modify: `src/renderer/app/data-loading.ts`
- Modify: `src/renderer/views/tasks/use-task-actions.ts`
- Modify: `tests/renderer/chat-transcript.test.ts`
- Create: `tests/renderer/task-detail-view.test.tsx`

- [ ] **Step 1: Add red task detail tests**

Create `tests/renderer/task-detail-view.test.tsx`:

```tsx
// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskDetailView } from '../../src/renderer/views/tasks/TaskDetailView';
import { createLoadedState } from './view-test-helpers';

describe('TaskDetailView', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('renders the transcript and back action for an existing task', async () => {
    await act(async () => {
      root.render(
        <TaskDetailView
          client={{ api: window.roc } as never}
          liveTaskRun={null}
          onBackToBoard={() => {}}
          onSubmitTaskInput={vi.fn()}
          state={createLoadedState({
            taskDetail: {
              threadId: 'thread-1',
              taskId: 'task-1',
              lastRunId: 'run-1',
              schedulerRegistered: true,
              thread: {
                id: 'thread-1',
                kind: 'background',
                title: '整理工作区变更',
                goal: '整理工作区变更',
                status: 'running',
                createdAt: '2026-05-16T07:00:00.000Z',
                updatedAt: '2026-05-16T07:05:00.000Z'
              },
              backgroundTask: null,
              runHistory: [],
              recentEvents: [
                {
                  id: 'message-user',
                  threadId: 'thread-1',
                  runId: 'run-1',
                  type: 'message',
                  payload: { role: 'user', content: '请整理工作区变更' },
                  createdAt: '2026-05-16T07:00:00.000Z'
                },
                {
                  id: 'message-assistant',
                  threadId: 'thread-1',
                  runId: 'run-1',
                  type: 'message',
                  payload: { role: 'assistant', content: '已经整理完成' },
                  createdAt: '2026-05-16T07:05:00.000Z'
                }
              ]
            }
          })}
          taskId="task-1"
          updateLoadedState={() => {}}
        />
      );
    });

    expect(container.querySelector('[data-testid="task-detail-view"]')).not.toBeNull();
    expect(container.textContent).toContain('返回任务工作台');
    expect(container.textContent).toContain('已经整理完成');
  });

  it('shows inline continue input for waiting_user tasks', async () => {
    await act(async () => {
      root.render(
        <TaskDetailView
          client={{ api: window.roc } as never}
          liveTaskRun={null}
          onBackToBoard={() => {}}
          onSubmitTaskInput={vi.fn()}
          state={createLoadedState({
            taskDetail: {
              threadId: 'thread-1',
              taskId: 'task-1',
              lastRunId: 'run-1',
              schedulerRegistered: true,
              thread: {
                id: 'thread-1',
                kind: 'background',
                title: '等待输入',
                goal: '等待输入',
                status: 'waiting_user',
                createdAt: '2026-05-16T07:00:00.000Z',
                updatedAt: '2026-05-16T07:05:00.000Z'
              },
              backgroundTask: null,
              runHistory: [],
              recentEvents: []
            }
          })}
          taskId="task-1"
          updateLoadedState={() => {}}
        />
      );
    });

    expect(container.querySelector('[data-testid="task-detail-followup-input"]')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the new detail test to verify it fails**

Run:

```powershell
pnpm test -- tests/renderer/task-detail-view.test.tsx
```

Expected: FAIL because the detail page is still a shell.

- [ ] **Step 3: Build the detail transcript from persisted task events**

In `src/renderer/views/tasks/TaskDetailView.tsx`, replace the shell with:

```tsx
import { useMemo, useState } from 'react';
import { buildPersistedTranscriptMessages } from '../../chat-transcript';
import { ChatTranscriptPanel } from '../../chat/chat-transcript-panel';
import { TaskApprovalCard, isTaskApproval } from './TaskApprovalCard';

export function TaskDetailView({
  client,
  liveTaskRun,
  onBackToBoard,
  onSubmitTaskInput,
  state,
  taskId
}: {
  client: { api: Window['roc'] };
  liveTaskRun: import('../../chat-run-state').ChatRunState | null;
  onBackToBoard: () => void;
  onSubmitTaskInput: (payload: { input: string; taskId: string }) => Promise<{ ok: true } | { ok: false; error: string }>;
  state: import('../../loaded-state').LoadedState;
  taskId: string;
  updateLoadedState: (partial: Partial<import('../../loaded-state').LoadedState>) => void;
}): React.JSX.Element {
  const [followupInput, setFollowupInput] = useState('');
  const [inlineError, setInlineError] = useState<string | null>(null);
  const detail = state.taskDetail;
  const transcript = useMemo(() => {
    if (detail === null) {
      return [];
    }
    return buildPersistedTranscriptMessages(detail.recentEvents, detail.threadId);
  }, [detail]);

  if (detail === null || detail.taskId !== taskId) {
    return (
      <section className="canvas-stage task-detail-page" data-testid="task-detail-view">
        <button className="action-button" type="button" onClick={onBackToBoard}>
          返回任务工作台
        </button>
        <div className="section-empty-state">
          <strong>任务不存在</strong>
          <p>当前任务不存在或已经删除。</p>
        </div>
      </section>
    );
  }

  const waitingUser = detail.thread.status === 'waiting_user';
  const latestApproval = transcript.map((message) => message.approval).find((approval) => approval !== null) ?? null;

  return (
    <section className="canvas-stage task-detail-page" data-testid="task-detail-view">
      <div className="task-detail-page-head">
        <button className="action-button" type="button" onClick={onBackToBoard}>
          返回任务工作台
        </button>
        <div className="page-copy">
          <h1 className="page-title mini">{detail.thread.title}</h1>
          <p className="page-meta">{detail.thread.status}</p>
        </div>
      </div>
      <div className="task-detail-page-body">
        <ChatTranscriptPanel
          messages={transcript}
          liveSignal={`${liveTaskRun?.runId ?? ''}|${transcript.length}`}
          scrollContainerRef={{ current: null }}
          onApprovalDecision={() => {}}
        />
        {latestApproval !== null && isTaskApproval(latestApproval) ? (
          <TaskApprovalCard approval={latestApproval} onApprovalDecision={() => {}} />
        ) : null}
        {waitingUser ? (
          <form
            className="task-detail-followup"
            onSubmit={(event) => {
              event.preventDefault();
              void onSubmitTaskInput({ input: followupInput.trim(), taskId }).then((result) => {
                if (result.ok) {
                  setFollowupInput('');
                  setInlineError(null);
                } else {
                  setInlineError(result.error);
                }
              });
            }}
          >
            <textarea
              data-testid="task-detail-followup-input"
              value={followupInput}
              onChange={(event) => setFollowupInput(event.target.value)}
            />
            <button className="action-button" type="submit">
              继续任务
            </button>
            {inlineError === null ? null : <span className="inline-warning">{inlineError}</span>}
          </form>
        ) : null}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Add AppShell detail-page handlers for continue and approval**

In `src/renderer/app/AppShell.tsx`, add:

```ts
  const continueTaskFromDetail = useCallback(
    async ({ input, taskId }: { input: string; taskId: string }): Promise<{ ok: true } | { ok: false; error: string }> => {
      setSelectedTaskSurfaceTaskId(taskId);
      const result = await startTaskRun({
        input,
        workflowHint: 'background_task_change',
        taskSource: 'workbench'
      });
      if (!result.ok) {
        return result;
      }
      await refreshTaskState();
      return { ok: true };
    },
    [refreshTaskState, startTaskRun]
  );
```

Add:

```ts
  const resumeTaskApprovalFromDetail = useCallback(
    async (request: { runId: string; threadId: string; interruptId: string; decisions: import('../../shared/types').ChatResumeDecision[] }) => {
      const result = await chatFeature.resumeRun(request);
      if (!result.ok) {
        return { ok: false as const, error: result.error.message };
      }
      await refreshTaskState();
      return { ok: true as const };
    },
    [chatFeature, refreshTaskState]
  );
```

- [ ] **Step 5: Make detail refresh deterministic for the selected task**

In `src/renderer/app/data-loading.ts`, replace:

```ts
  const firstBackgroundTaskId = activeTasks.find((task) => task.taskId !== null)?.taskId ?? null;
  const primaryTaskId =
    selectedTaskId === undefined
      ? firstBackgroundTaskId
      : selectedTaskId === null
        ? null
        : activeTasks.some((task) => task.taskId === selectedTaskId)
          ? selectedTaskId
          : firstBackgroundTaskId;
```

with:

```ts
  const firstBackgroundTaskId = activeTasks.find((task) => task.taskId !== null)?.taskId ?? null;
  const primaryTaskId =
    selectedTaskId === undefined
      ? firstBackgroundTaskId
      : selectedTaskId === null
        ? null
        : selectedTaskId;
```

This keeps the detail page on the requested task ID long enough to show a not-found state instead of silently switching to another task.

- [ ] **Step 6: Run the task detail test**

Run:

```powershell
pnpm test -- tests/renderer/task-detail-view.test.tsx
```

Expected: `PASS`.

- [ ] **Step 7: Commit the detail page**

Run:

```powershell
git add src/renderer/views/tasks/TaskDetailView.tsx src/renderer/app/AppShell.tsx src/renderer/app/data-loading.ts tests/renderer/task-detail-view.test.tsx
git commit -m "feat: add standalone task detail page"
```

---

### Task 7: Remove Background Tasks From Normal Chat History And Chat Create Flow

**Files:**
- Modify: `src/renderer/history-sidebar.ts`
- Modify: `src/renderer/app/nav-items.ts`
- Modify: `src/renderer/views/tasks/use-task-actions.ts`
- Modify: `src/renderer/features/tasks/use-task-feature.ts`
- Modify: `src/renderer/views/ViewContent.tsx`
- Modify: `src/renderer/chat/chat-view.tsx`
- Modify: `tests/renderer/history-sidebar.test.ts`
- Modify: `tests/renderer/task-actions.test.ts`
- Modify: `tests/renderer/chat-view.queued-task.test.ts`
- Modify: `tests/renderer/chat-view.test.ts`
- Modify: `tests/renderer/features/chat-feature.test.tsx`

- [ ] **Step 1: Add red history and chat boundary tests**

In `tests/renderer/history-sidebar.test.ts`, replace the active-promoted-thread assertion input with:

```ts
    const items = buildHistoryItems([
      createThread('user-thread', '用户真实任务'),
      createThread('background-completed', '后台已完成任务', {
        kind: 'background',
        status: 'completed'
      }),
      createThread('background-running', '后台运行任务', {
        kind: 'background',
        status: 'running'
      })
    ], []);
```

and keep the expectation:

```ts
    expect(items).toEqual([
      {
        id: 'user-thread',
        label: '用户真实任务',
        meta: '2026-05-08 23:30',
        icon: 'history'
      }
    ]);
```

In `tests/renderer/task-actions.test.ts`, replace the old open-in-chat case with:

```ts
  it('does not expose openInChat from task actions anymore', () => {
    const actions = createTaskActions({
      refreshTaskSurface: vi.fn().mockResolvedValue(undefined)
    });

    expect('openInChat' in actions).toBe(false);
  });
```

In `tests/renderer/chat-view.queued-task.test.ts`, delete the queued prompt suite and keep only ordinary chat input and transcript-loading tests.

- [ ] **Step 2: Run history, task actions, and chat view tests to verify they fail**

Run:

```powershell
pnpm test -- tests/renderer/history-sidebar.test.ts tests/renderer/task-actions.test.ts tests/renderer/chat-view.queued-task.test.ts
```

Expected:

- FAIL because background completed tasks still enter history.
- FAIL because `openInChat` still exists.
- FAIL because `ChatView` still accepts `queuedTaskPrompt`.

- [ ] **Step 3: Hard-filter normal history to chat threads only**

In `src/renderer/history-sidebar.ts`, replace:

```ts
export function buildHistoryItems(threads: TaskThread[], promotedThreadIds: Iterable<string>): HistorySidebarItem[] {
  const backgroundThreadIds = new Set(promotedThreadIds);
  return threads
    .filter((thread) => !backgroundThreadIds.has(thread.id))
    .filter((thread) => !isActivePromotedThread(thread))
    .filter((thread) => !SYSTEM_HISTORY_THREAD_TITLES.has(thread.title))
    .map((thread) => ({
      id: thread.id,
      label: thread.title,
      meta: formatBeijingDateTime(thread.updatedAt),
      icon: 'history'
    }));
}

function isActivePromotedThread(thread: TaskThread): boolean {
  return (
    thread.kind === 'background' &&
    ['running', 'waiting_user', 'waiting_next_turn', 'paused', 'pending_confirmation'].includes(thread.status)
  );
}
```

with:

```ts
export function buildHistoryItems(threads: TaskThread[], _promotedThreadIds: Iterable<string>): HistorySidebarItem[] {
  return threads
    .filter((thread) => thread.kind === 'chat')
    .filter((thread) => !SYSTEM_HISTORY_THREAD_TITLES.has(thread.title))
    .map((thread) => ({
      id: thread.id,
      label: thread.title,
      meta: formatBeijingDateTime(thread.updatedAt),
      icon: 'history'
    }));
}
```

- [ ] **Step 4: Remove openInChat from task actions**

In `src/renderer/views/tasks/use-task-actions.ts`, replace:

```ts
export type TaskActions = {
  cancelTask: (item: ActiveTaskItem) => void;
  deleteTask: (item: ActiveTaskItem) => void;
  openInChat: (item: ActiveTaskItem) => void;
  pauseTask: (item: ActiveTaskItem) => void;
  resumeTask: (item: ActiveTaskItem) => void;
  runNow: (item: ActiveTaskItem) => void;
};
```

with:

```ts
export type TaskActions = {
  cancelTask: (item: ActiveTaskItem) => void;
  deleteTask: (item: ActiveTaskItem) => void;
  pauseTask: (item: ActiveTaskItem) => void;
  resumeTask: (item: ActiveTaskItem) => void;
  runNow: (item: ActiveTaskItem) => void;
};
```

Delete the whole `openInChat` branch:

```ts
    openInChat: (item) => {
      const taskId = requireTaskId(item);
      if (taskId === null) {
        input.navigateToChat(item.threadId);
        return;
      }
      const client = resolveClient();
      void client.api.tasks.openInChat({ taskId }).then((result) => {
        if (!result.ok) {
          return;
        }
        input.navigateToChat(result.data.threadId, 'background_task_change', 'workbench');
      });
    },
```

Then remove the now-unused `navigateToChat` callback from the input type and from the forwarding code in `useTaskActions`.

- [ ] **Step 5: Remove queued-task prompt behavior from ChatView and ViewContent**

In `src/renderer/chat/chat-view.tsx`, remove:

```ts
import type { ChatTaskSubmitPayload, QueuedTaskPrompt } from './task-run-payload';
```

and replace it with:

```ts
import type { ChatTaskSubmitPayload } from './task-run-payload';
```

Replace the props type:

```ts
  queuedTaskPrompt: QueuedTaskPrompt | null;
  onQueuedTaskPromptHandled: () => void;
```

with nothing.

Delete the queued-task refs and effect:

```ts
  const queuedTaskPromptInFlightRef = useRef<string | null>(null);
```

and:

```ts
  useEffect(() => {
    if (queuedTaskPrompt === null) {
      return;
    }
    if (state.agent.execution !== 'ready') {
      return;
    }
    const queuedTaskPromptKey = buildQueuedTaskPromptKey(queuedTaskPrompt);
    if (queuedTaskPromptInFlightRef.current === queuedTaskPromptKey) {
      return;
    }

    queuedTaskPromptInFlightRef.current = queuedTaskPromptKey;
    setSubmitting(true);
    void onSubmitChatTask({
      input: queuedTaskPrompt.input,
      workflowHint: queuedTaskPrompt.workflowHint,
      taskSource: queuedTaskPrompt.taskSource ?? null
    })
      .then((result) => {
        if (result.ok) {
          setPendingUserInput(queuedTaskPrompt.input);
          queuedTaskPromptInFlightRef.current = null;
          onQueuedTaskPromptHandled();
        } else {
          chatRun.setError(result.error);
          queuedTaskPromptInFlightRef.current = null;
          onQueuedTaskPromptHandled();
        }
      })
      .finally(() => {
        setSubmitting(false);
      });
  }, [onQueuedTaskPromptHandled, onSubmitChatTask, queuedTaskPrompt, state.agent.execution]);
```

Delete:

```ts
function buildQueuedTaskPromptKey(prompt: QueuedTaskPrompt): string {
  return `${prompt.workflowHint ?? 'none'}\0${prompt.taskSource ?? 'none'}\0${prompt.input}`;
}
```

In `src/renderer/views/ViewContent.tsx`, remove the `queuedTaskPrompt` and `onQueuedTaskPromptHandled` props entirely from `ChatFeature` and `ViewContent`.

- [ ] **Step 6: Run the boundary tests**

Run:

```powershell
pnpm test -- tests/renderer/history-sidebar.test.ts tests/renderer/task-actions.test.ts tests/renderer/chat-view.test.ts tests/renderer/features/chat-feature.test.tsx
```

Expected: `PASS`.

- [ ] **Step 7: Commit the chat/task boundary cleanup**

Run:

```powershell
git add src/renderer/history-sidebar.ts src/renderer/app/nav-items.ts src/renderer/views/tasks/use-task-actions.ts src/renderer/features/tasks/use-task-feature.ts src/renderer/views/ViewContent.tsx src/renderer/chat/chat-view.tsx tests/renderer/history-sidebar.test.ts tests/renderer/task-actions.test.ts tests/renderer/chat-view.queued-task.test.ts tests/renderer/chat-view.test.ts tests/renderer/features/chat-feature.test.tsx
git commit -m "fix: isolate background tasks from normal chat history"
```

---

### Task 8: Finish Detail Actions, Styles, And Smoke Regression

**Files:**
- Modify: `src/renderer/views/tasks/TaskDetailView.tsx`
- Modify: `src/renderer/styles/shared.css`
- Modify: `src/renderer/styles/responsive.css`
- Modify: `tests/smoke/electron-smoke.mjs`

- [ ] **Step 1: Add a red smoke assertion for board-to-detail flow**

In `tests/smoke/electron-smoke.mjs`, add a task workbench smoke block that:

```js
  await openTaskWorkbench(window);
  await clickText(window, '新建任务');
  await fillByTestId(window, 'task-create-description', '每天晚上总结 AI 新闻');
  await clickByTestId(window, 'task-create-submit');
  await waitForTestId(window, 'task-detail-view');
  await clickText(window, '返回任务工作台');
  await waitForTestId(window, 'tasks-board-view');
```

Expected failure before implementation: cannot find `task-detail-view`.

- [ ] **Step 2: Replace legacy task table and drawer styles with board/detail styles**

In `src/renderer/styles/shared.css`, replace the old board/table region:

```css
.task-command-center {
  gap: 18px;
}

.task-workbench-layout {
  display: grid;
  grid-template-columns: 132px minmax(0, 1fr) minmax(320px, 380px);
  gap: 14px;
  align-items: start;
}

.task-status-rail {
  display: grid;
  gap: 8px;
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-soft);
}
```

with:

```css
.task-board-page {
  gap: 18px;
}

.task-board-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
  align-items: start;
}

.task-board-column {
  display: grid;
  gap: 12px;
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: linear-gradient(180deg, rgba(251, 253, 255, 0.98), rgba(255, 255, 255, 0.98));
}

.task-board-column-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.task-board-column-list {
  display: grid;
  gap: 10px;
}

.task-board-card {
  display: grid;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 14px;
  border: 1px solid rgba(215, 225, 236, 0.96);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.96);
  color: var(--text);
  text-align: left;
}

.task-board-card:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.task-board-card-title {
  color: var(--ink);
  font-size: var(--font-body-size);
  font-weight: 500;
  overflow-wrap: anywhere;
}

.task-board-card-meta {
  color: var(--muted);
  font-size: var(--font-meta-size);
}

.task-detail-page {
  display: grid;
  gap: 18px;
}

.task-detail-page-head,
.task-detail-page-body {
  display: grid;
  gap: 14px;
}

.task-detail-followup {
  display: grid;
  gap: 10px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
}

.task-detail-followup textarea {
  width: 100%;
  min-height: 120px;
  padding: 12px;
  border: 1px solid rgba(217, 226, 236, 0.96);
  border-radius: 16px;
  background: rgba(248, 250, 252, 0.98);
  color: var(--ink);
  resize: vertical;
}
```

- [ ] **Step 3: Add responsive collapse for kanban and detail page**

In `src/renderer/styles/responsive.css`, replace:

```css
  .task-status-rail {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .task-detail-drawer .row {
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
  }

  .task-detail-drawer .row > .pill {
    justify-self: start;
  }
```

with:

```css
  .task-board-grid {
    grid-template-columns: 1fr;
  }

  .task-detail-page-head {
    align-items: flex-start;
  }

  .task-detail-followup {
    padding: 14px;
  }
```

Also replace the `@media (max-width: 1080px)` task block:

```css
  .task-workbench-layout,
  .task-create-form-grid {
    grid-template-columns: 1fr;
  }
```

with:

```css
  .task-board-grid,
  .task-create-form-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
```

and add:

```css
  .task-detail-page-body {
    grid-template-columns: 1fr;
  }
```

- [ ] **Step 4: Run smoke and targeted renderer tests**

Run:

```powershell
pnpm test -- tests/renderer/app-shell.test.tsx tests/renderer/features/tasks-feature.test.tsx tests/renderer/tasks-view.interaction.test.ts tests/renderer/task-detail-view.test.tsx tests/renderer/history-sidebar.test.ts tests/renderer/chat-view.test.ts tests/renderer/features/chat-feature.test.tsx
```

Expected: `PASS`.

Then run:

```powershell
pnpm test -- tests/smoke/electron-smoke.mjs
```

Expected:

- PASS on the new board -> create -> detail -> back path.
- PASS on detail-page continue/approval scenarios if fixtures already cover them.

- [ ] **Step 5: Commit styles and smoke coverage**

Run:

```powershell
git add src/renderer/views/tasks/TaskDetailView.tsx src/renderer/styles/shared.css src/renderer/styles/responsive.css tests/smoke/electron-smoke.mjs
git commit -m "style: polish kanban task workbench surfaces"
```

---

### Task 9: Full Verification And Cleanup Review

**Files:**
- Verify only unless a previous step exposed an implementation gap.

- [ ] **Step 1: Run the full targeted renderer and startup suite**

Run:

```powershell
pnpm test -- tests/main/startup-load-policy.test.ts tests/renderer/app-shell.test.tsx tests/renderer/history-sidebar.test.ts tests/renderer/chat-view.test.ts tests/renderer/features/chat-feature.test.tsx tests/renderer/features/tasks-feature.test.tsx tests/renderer/task-actions.test.ts tests/renderer/tasks-view.interaction.test.ts tests/renderer/task-detail-view.test.tsx tests/renderer/chat-transcript.test.ts
```

Expected: `PASS`.

- [ ] **Step 2: Run typecheck**

Run:

```powershell
pnpm typecheck
```

Expected: exits with code `0`.

- [ ] **Step 3: Run the full test suite if the targeted suite and typecheck pass**

Run:

```powershell
pnpm test
```

Expected: exits with code `0`.

Note: if `node-pty` logs `Error: AttachConsole failed` during teardown but Vitest exits `0`, treat it as known Roc teardown noise and record it in final evidence instead of reopening this feature.

- [ ] **Step 4: Run regression searches for removed chat-coupling paths**

Run:

```powershell
rg -n "queuedTaskPrompt|onQueuedTaskPromptHandled|openInChat|TaskDetailDrawer|activeView === 'tasks'|id: 'tasks'|page=tasks" src tests
```

Expected:

- No matches in production renderer code.
- Test files should only reference removed names if they are deletion diffs pending commit; once clean, the search should be empty.

Then run:

```powershell
rg -n "kind === 'background'|thread.kind === 'chat'|background_task_change|propose_background_task" src/renderer tests/renderer
```

Expected:

- History code should contain `thread.kind === 'chat'`.
- Task-domain create and continue flows may still contain `propose_background_task` and `background_task_change`.
- Normal chat tests should not mention workbench-created queued prompts anymore.

- [ ] **Step 5: Commit verification-only fixes if any are needed**

If verification revealed follow-up fixes, stage only those files. Example:

```powershell
git status --short
git add -- src/renderer/app/AppShell.tsx tests/renderer/app-shell.test.tsx
git commit -m "test: verify task kanban workbench flow"
```

If no files changed, do not create an empty commit.

- [ ] **Step 6: Prepare completion summary**

The final implementation summary must include:

- The exact commits created from this plan.
- The verification commands that passed.
- Confirmation that task creation no longer routes through chat.
- Confirmation that background task transcripts no longer appear in normal history.
- Confirmation that task board is kanban-only and task detail is a dedicated page with a back action.
