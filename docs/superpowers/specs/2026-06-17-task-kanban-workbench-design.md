# Task Kanban Workbench Design

## Goal

Roc must redesign the task workbench into a kanban-first task domain that is visibly and behaviorally separate from normal chat.

Target behavior:

- The task workbench entry opens a pure kanban board, not a chat-like mixed surface.
- Creating a task is only available from the task workbench.
- Creating a task never navigates into normal chat.
- Clicking a task card opens a dedicated task detail page.
- The task detail page has a back action that returns to the kanban workbench.
- Background-task transcript, approvals, and user follow-up stay inside the task detail page.
- Normal chat history never shows background-task threads.
- Normal chat cannot create background tasks.

## Current Cause

The current renderer flow still treats task creation and task follow-up as chat-driven behavior.

- `TasksView.submitTaskDescription(...)` sends a `TaskPromptSubmission` with `workflowHint: 'propose_background_task'`.
- `AppShell.queueTaskPrompt(...)` stores that prompt in `queuedTaskPrompt`, forces `activeView = 'chat'`, and clears the current thread selection.
- `ChatView` auto-submits the queued task prompt into the chat runtime.
- `useTaskActions.openInChat(...)` explicitly navigates task interactions back into chat.

This creates three wrong outcomes for the requested design:

- Creating a task jumps into the chat page.
- Task conversation uses the same visible chat surface as normal chat.
- Background task threads still participate in normal history construction unless filtered away by status-specific exceptions.

## Authoritative Constraints

The design follows these confirmed constraints:

- Task workbench page shows only kanban.
- No task navigation rail appears on the left side of the task workbench page.
- Clicking a task card navigates to a dedicated task detail page.
- The task detail page provides a return action back to the task workbench page.
- Task creation starts from the task workbench page.
- Task creation succeeds, then automatically opens the new task detail page.
- Task detail supports continuing the task when the task is waiting for user input.
- Task detail supports approval actions when the task is pending confirmation.
- Normal chat cannot create tasks.
- Kanban is read-only for status display; drag-and-drop status editing is out of scope.
- There is no old data migration requirement because there is currently no old data to preserve.

## Current Relevant Architecture

### Renderer surface

- `AppShell` owns top-level view selection, selected thread state, queued task prompt state, and task surface refresh state.
- `ViewContent` currently has a single `tasks` view and a single `chat` view.
- `TasksView` currently renders both the task list area and the embedded `TaskDetailDrawer`.
- `ChatView` currently owns queued task auto-submission and chat transcript rendering.

### Task data model

Current task states already support kanban grouping:

- `pending_confirmation`
- `running`
- `paused`
- `waiting_user`
- `waiting_next_turn`
- `failed`
- `cancelled`
- `completed`
- `archived`

Current thread model already distinguishes normal chat from background tasks:

- `TaskKind = 'chat' | 'background'`

### History construction

Normal history is currently built from `state.taskSnapshot.threads`.

- `src/renderer/history-sidebar.ts` filters out some background threads only when they are promoted active tasks.
- That means background-task visibility in normal history is controlled by exception logic instead of a hard domain boundary.

This is insufficient for the requested separation. The new design must make `kind === 'background'` fully invisible in normal chat history.

## Chosen Architecture

Use a task-domain two-page renderer design.

### 1. Split the task domain into two views

Replace the single mixed task surface with two task-domain pages:

- `tasks-board`: kanban-only workbench page
- `task-detail`: dedicated task detail page

The task workbench navigation entry opens `tasks-board`.

Task detail is no longer an embedded drawer inside the board. It becomes its own page-level surface with its own heading, body, transcript area, and return action.

### 2. Keep task navigation inside the task domain

Task interactions must not route through normal chat.

Required navigation rules:

- Open task workbench -> `tasks-board`
- Click a kanban card -> `task-detail(taskId)`
- Click `新建任务` -> open create dialog on `tasks-board`
- Create task successfully -> navigate to `task-detail(newTaskId)`
- Click `返回任务工作台` on detail page -> go back to `tasks-board`

The return action should restore prior board context such as active filter and scroll position.

This is task-domain navigation, not a chat-thread navigation alias.

### 3. Remove chat as the task creation surface

Task creation must stop using the queued chat prompt path.

The following renderer pattern is the current source of coupling and must be removed from the task creation flow:

- `TasksView.submitTaskDescription(...)`
- `AppShell.queueTaskPrompt(...)`
- `queuedTaskPrompt`
- `ChatView` auto-submit handling for workbench-created tasks

The task workbench should submit directly to task preview/create capabilities and stay within the task domain.

The design intentionally keeps the backend task model and task event storage. The change is about front-end routing and ownership of the user surface.

## Page Design

### Task workbench page

The workbench page contains only:

- page heading
- `新建任务` action
- kanban status filters for the four confirmed columns
- kanban columns

It must not contain:

- normal chat transcript
- embedded task detail drawer
- left-side task navigation rail
- normal chat history list

Default kanban grouping:

- `待处理`: `pending_confirmation`, `waiting_user`
- `进行中`: `running`, `waiting_next_turn`
- `已暂停`: `paused`
- `已结束`: `failed`, `cancelled`, `completed`, `archived`

This grouping matches the confirmed user preference to keep four columns and not split approval and user-input into separate lanes.

Kanban cards are status views only. No drag-and-drop state mutation is provided.

### Task detail page

The task detail page contains:

- back action to workbench
- task title and current status
- scheduling summary such as next run, last run, trigger, and workspace
- task actions: pause, resume, run now, cancel, delete when valid
- full task transcript
- inline approval controls for `pending_confirmation`
- inline follow-up input for `waiting_user`

The transcript is a task-domain transcript, not a normal chat transcript page. It may reuse existing rendering blocks and event-to-message transformation logic, but its visible ownership is the task detail page.

## Data Flow

### Task creation flow

1. User opens `tasks-board`.
2. User clicks `新建任务`.
3. Renderer opens the existing create dialog or an equivalent modal on the board page.
4. User submits task description.
5. Renderer calls task preview/create capability directly.
6. If creation succeeds:
   - refresh task snapshot and task surface data
   - close the create dialog
   - navigate to `task-detail(newTaskId)`
7. If creation fails:
   - stay on `tasks-board`
   - show the error inside the create flow

No step in this flow navigates to `chat`.

### Task card selection flow

1. User clicks a kanban card on `tasks-board`.
2. Renderer stores board UI context for return.
3. Renderer navigates to `task-detail(taskId)`.
4. Detail page loads task detail data, scheduled runs, transcript, and current live state.

### Task follow-up flow

1. User opens `task-detail`.
2. If task status is `waiting_user`, detail page renders an inline composer.
3. User submits follow-up input directly from detail page.
4. Renderer continues the task thread through task-domain flow.
5. Updated transcript and live task state remain visible on the same detail page.

### Task approval flow

1. User opens `task-detail`.
2. If task status is `pending_confirmation`, detail page renders inline approval UI.
3. User approves or rejects from detail page.
4. Result stays in the same task-domain transcript and state flow.

No follow-up or approval flow routes through normal chat.

## Routing And State Design

Top-level renderer state should explicitly represent task-domain pages instead of treating them as chat variations.

Required state concepts:

- `activeView`
- `activeTaskDetailId`
- `taskBoardUiState`

`taskBoardUiState` should preserve:

- current kanban filter
- board scroll position

This design does not require a deep browser-style navigation stack. A single task-domain return target is sufficient.

`ViewContent` should render:

- `TasksBoardFeature` when `activeView === 'tasks-board'`
- `TaskDetailFeature` when `activeView === 'task-detail'`

The implementation should replace the current single `tasks` view with explicit task-domain page handling. Internal compatibility mapping is out of scope for the spec and should not change the final user-visible two-page behavior.

## History Isolation

Normal chat history must use a hard domain boundary instead of promoted-thread exceptions.

Required final rule:

- only `TaskThread.kind === 'chat'` is eligible for normal chat history
- all `TaskThread.kind === 'background'` is excluded from normal history, regardless of status

This change applies to:

- history sidebar item construction
- search over history items
- new conversation / thread selection semantics

The task detail page becomes the only supported way to view and continue a background-task transcript.

## Chat Boundary Changes

Normal chat must stop exposing background-task creation.

Required behavior:

- normal chat composer and related submission paths must not create background tasks
- task-specific `workflowHint: 'propose_background_task'` must no longer be part of the normal chat path
- task workbench and task detail become the only supported UI for task create / continue / approve

The implementation may still keep backend task tools and task threads. The restriction is on user-facing entry points and renderer routing.

## Error Handling

### No workspace selected

- `tasks-board` still opens
- create action must fail clearly with `当前没有可用于任务的工作区路径。`

### Create task failure

- remain on `tasks-board`
- keep create dialog context
- show actionable error
- do not navigate to detail

### Task not found on detail page

- show a task-domain error state such as `任务不存在` or `任务已删除`
- keep a return action back to `tasks-board`

### Continue task failure

- keep the user on `task-detail`
- display failure inline in the detail page
- do not reroute into chat

### Approval failure

- keep the user on `task-detail`
- display failure inline
- preserve current task context

## Testing Plan

Add focused tests before or alongside implementation.

### Renderer tests

- `tasks-board` renders kanban without embedded task detail drawer
- clicking a kanban card navigates to `task-detail`
- clicking back on detail returns to `tasks-board`
- create success navigates to the newly created task detail page
- `waiting_user` shows inline follow-up input on detail page
- `pending_confirmation` shows inline approval UI on detail page

### State and routing tests

- task-domain page switching updates the right view state
- board filter and scroll context restore when returning from detail
- selected task detail ID tracks the opened task and clears correctly on return

### History isolation tests

- normal history includes only `kind === 'chat'`
- `kind === 'background'` never appears in history, regardless of status

### Behavior regression tests

- task creation no longer uses `queuedTaskPrompt -> ChatView`
- task actions no longer navigate with `openInChat`
- normal chat cannot create a background task

### Smoke coverage

- from task board create a task, land on task detail
- continue a waiting task from task detail
- approve a pending task from task detail
- return from task detail to task board without losing board context

## Acceptance Criteria

- Opening task workbench shows only kanban, not chat transcript or embedded task detail.
- Creating a task from the workbench never navigates to normal chat.
- Creating a task succeeds and opens the new task detail page.
- Clicking a kanban card opens that task's dedicated detail page.
- Task detail page has a return action back to the kanban workbench.
- Returning to the workbench restores prior board context.
- Task transcript is visible only in task detail, not in normal chat.
- Waiting-for-user follow-up happens inside task detail.
- Pending confirmation approval happens inside task detail.
- Normal chat history contains only `kind === 'chat'` threads.
- Normal chat cannot create background tasks.
- Task board does not support drag-and-drop status mutation.

## Out Of Scope

- Drag-and-drop task status changes
- Converting a task thread into a normal chat thread
- Continuing a task from normal chat
- Preserving an `openInChat` compatibility surface
- Old data migration
- Multi-level task-domain navigation stack
- Backend task/thread storage redesign

## Cleanup Scope

Implementation must remove or update now-wrong task/chat coupling code.

Required cleanup targets:

- task creation path through `queuedTaskPrompt`
- workbench task routing through `ChatView`
- `openInChat` task action and related renderer assumptions
- history filtering logic that still allows background threads into normal history by status-specific exceptions
- task workbench layout code that embeds `TaskDetailDrawer` inside the board page
- tests that assume workbench-created tasks open in chat

## Implementation Notes

The safest implementation path is to preserve backend task repository and task event storage, while moving renderer ownership from chat to explicit task-domain pages.

This keeps the change focused:

- backend task model stays stable
- transcript/event rendering can be reused
- main behavior change is page structure, routing, and history isolation

That is sufficient for the requested redesign and avoids unrelated backend refactors.
