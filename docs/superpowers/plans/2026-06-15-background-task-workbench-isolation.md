# Background Task Workbench Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 后台任务创建、修改、取消、查看只允许从任务工作台进入，普通聊天不暴露相关工具；任务工作台显示可观测运行状态，任务失败后默认暂停并记录失败。

**Architecture:** 在共享合同上增加显式 `taskSource: 'workbench'`，从 `TasksView -> AppShell -> chat.startRun -> AgentPluginRuntime -> AgentDeepAgentExecutor` 传递。Deep Agent 只在 `taskSource === 'workbench'` 且有后台任务 `workflowHint` 时装配后台任务工具和工作流 prompt；任务插件在运行失败事件中暂停对应后台任务并写入可见事件。Renderer 只补工作台状态展示，不给普通聊天添加替代入口。

**Tech Stack:** TypeScript ESM、Electron main/preload/renderer、React 19、Vitest、better-sqlite3、Deep Agents/LangChain tools。

---

## File Structure

- Modify `src/shared/types/chat.ts`: 给 `ChatStartRunRequest` 增加 `taskSource?: 'workbench' | null`。
- Modify `src/main/plugins/agent/index.ts`: IPC/capability schema 接受 `taskSource`。
- Modify `src/renderer/chat/task-run-payload.ts`: 任务工作台排队 prompt 和任务提交 payload 携带 `taskSource`。
- Modify `src/renderer/views/tasks/TasksView.tsx`: 新建任务提交时设置 `taskSource: 'workbench'`，空状态文案去掉“在聊天里告诉我”。
- Modify `src/renderer/chat/chat-view.tsx`: queued task prompt 自动提交时透传 `taskSource`；普通聊天输入不设置该字段。
- Modify `src/renderer/app/AppShell.tsx`: `startTaskRun` 透传 `taskSource` 到 `chatFeature.startRun`。
- Modify `src/main/plugins/agent/runtime.ts`: run start/resume 记录并恢复 `taskSource`，避免审批恢复丢失工作台来源。
- Modify `src/main/plugins/agent/deep-agent-executor.ts`: 只在工作台后台任务流程中装配后台任务工具；普通聊天和非工作台任务不包含后台任务工具和 prompt。
- Modify `src/main/plugins/agent/capability-preview.ts`: 普通能力预览不再展示后台任务工具卡，`interruptOn` 不再默认包含 `update_background_task` / `cancel_background_task`。
- Modify `src/main/plugins/task/task-repository.ts`: `recordAgentRunFailed` 对关联后台任务执行失败时暂停任务、记录 `background_task_paused` 事件、写入错误 payload。
- Modify `src/main/plugins/task/scheduler.ts`: 定时触发后台任务时传 `taskSource: 'workbench'`，保持调度运行可用。
- Modify `src/main/plugins/task/index.ts`: `task.background.runNow` 传 `taskSource: 'workbench'`。
- Modify `src/renderer/views/tasks/TasksView.tsx`: 增强调度器状态区，展示 skipped 和 lastError。
- Modify `src/renderer/views/tasks/TaskDetailDrawer.tsx`: 在概览里展示最近失败原因。
- Test `tests/main/plugins/agent/deep-agent-executor.test.ts`
- Test `tests/main/plugins/agent/runtime.test.ts`
- Test `tests/main/plugins/agent/capability-preview.test.ts`
- Test `tests/main/plugins/task/scheduler.test.ts`
- Test `tests/main/plugins/task/plugin.test.ts`
- Test `tests/renderer/chat-view.queued-task.test.ts`
- Test `tests/renderer/tasks-view.test.ts`
- Test `tests/renderer/task-detail-drawer.test.ts`

---

### Task 1: Shared Workbench Source Contract

**Files:**
- Modify: `src/shared/types/chat.ts`
- Modify: `src/main/plugins/agent/index.ts`
- Modify: `src/renderer/chat/task-run-payload.ts`
- Test: `tests/renderer/chat-view.queued-task.test.ts`

- [ ] **Step 1: Add failing queued prompt test for workbench source**

In `tests/renderer/chat-view.queued-task.test.ts`, update the first queued prompt test so the queued prompt includes `taskSource: 'workbench'` and the submit assertion expects it:

```typescript
queuedTaskPrompt: {
  input: '请调用 propose_background_task 创建任务',
  workflowHint: 'propose_background_task',
  taskSource: 'workbench'
}
```

Expected assertion:

```typescript
expect(onSubmitChatTask).toHaveBeenCalledWith({
  input: '请调用 propose_background_task 创建任务',
  workflowHint: 'propose_background_task',
  taskSource: 'workbench'
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
pnpm test -- tests/renderer/chat-view.queued-task.test.ts
```

Expected: FAIL because `ChatView` currently passes only `input` and `workflowHint`.

- [ ] **Step 3: Add shared type field**

In `src/shared/types/chat.ts`, change `ChatStartRunRequest`:

```typescript
export type ChatStartRunRequest = {
  input: string;
  mode: ChatRunMode;
  enabledCapabilities: EnabledCapabilities;
  threadId?: string | null;
  workflowHint?: WorkflowHint;
  taskSource?: 'workbench' | null;
};
```

- [ ] **Step 4: Accept field in agent start schema**

In `src/main/plugins/agent/index.ts`, extend `chatStartRunRequestSchema`:

```typescript
const chatStartRunRequestSchema = z.object({
  input: z.string(),
  mode: z.enum(['chat', 'task']),
  enabledCapabilities: enabledCapabilitiesSchema,
  threadId: z.string().nullable().optional(),
  workflowHint: z.enum(['propose_background_task', 'background_task_change']).nullable().optional(),
  taskSource: z.enum(['workbench']).nullable().optional()
}) satisfies z.ZodType<ChatStartRunRequest>;
```

- [ ] **Step 5: Add renderer payload fields**

In `src/renderer/chat/task-run-payload.ts`, change both exported types:

```typescript
export type ChatTaskSubmitPayload = {
  input: string;
  workflowHint?: WorkflowHint;
  taskSource?: 'workbench' | null;
};

export type QueuedTaskPrompt = {
  input: string;
  workflowHint: WorkflowHint;
  workspacePath?: string;
  taskSource?: 'workbench' | null;
};
```

- [ ] **Step 6: Pass queued source through ChatView**

In `src/renderer/chat/chat-view.tsx`, update the queued submit call:

```typescript
void onSubmitChatTask({
  input: queuedTaskPrompt.input,
  workflowHint: queuedTaskPrompt.workflowHint,
  taskSource: queuedTaskPrompt.taskSource ?? null
})
```

- [ ] **Step 7: Include source in duplicate key**

In `src/renderer/chat/chat-view.tsx`, update `buildQueuedTaskPromptKey`:

```typescript
function buildQueuedTaskPromptKey(prompt: QueuedTaskPrompt): string {
  return `${prompt.workflowHint ?? 'none'}\0${prompt.taskSource ?? 'none'}\0${prompt.input}`;
}
```

- [ ] **Step 8: Run queued prompt test**

Run:

```powershell
pnpm test -- tests/renderer/chat-view.queued-task.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```powershell
git add src/shared/types/chat.ts src/main/plugins/agent/index.ts src/renderer/chat/task-run-payload.ts src/renderer/chat/chat-view.tsx tests/renderer/chat-view.queued-task.test.ts
git commit -m "feat: add task workbench source contract"
```

---

### Task 2: Workbench Source From Tasks UI

**Files:**
- Modify: `src/renderer/views/tasks/TasksView.tsx`
- Modify: `src/renderer/app/AppShell.tsx`
- Test: `tests/renderer/tasks-view.test.ts`
- Test: `tests/renderer/chat-view.queued-task.test.ts`

- [ ] **Step 1: Add failing TasksView submission test**

In `tests/renderer/tasks-view.test.ts`, add a test that opens the create dialog, submits a description, and verifies the prompt source. Use the existing render style, but switch this test to jsdom if needed by adding a separate `tests/renderer/tasks-view.interaction.test.tsx` test instead. Expected assertion:

```typescript
expect(onSubmitTaskPrompt).toHaveBeenCalledWith({
  input: '每天 09:00 检查测试',
  workflowHint: 'propose_background_task',
  workspacePath: 'F:\\Code\\Roc',
  taskSource: 'workbench'
});
```

- [ ] **Step 2: Run renderer tests to verify failure**

Run:

```powershell
pnpm test -- tests/renderer/tasks-view.test.ts tests/renderer/chat-view.queued-task.test.ts
```

Expected: FAIL because `TasksView.submitTaskDescription` does not include `taskSource`.

- [ ] **Step 3: Set source in TasksView submission**

In `src/renderer/views/tasks/TasksView.tsx`, update `TaskPromptSubmission`:

```typescript
export type TaskPromptSubmission = {
  input: string;
  workflowHint: WorkflowHint;
  workspacePath: string;
  taskSource: 'workbench';
};
```

Update `submitTaskDescription` return payload:

```typescript
return await onSubmitTaskPrompt({
  input: description,
  workflowHint: 'propose_background_task',
  workspacePath,
  taskSource: 'workbench'
});
```

- [ ] **Step 4: Remove ordinary chat instruction from empty state**

In `src/renderer/views/tasks/TasksView.tsx`, replace:

```typescript
<p className="muted">在聊天里告诉我“帮我创建一个定时任务”，或点击右上角“新建任务”。</p>
```

with:

```typescript
<p className="muted">点击右上角“新建任务”开始创建后台任务。</p>
```

- [ ] **Step 5: Forward source from AppShell**

In `src/renderer/app/AppShell.tsx`, update `startTaskRun`:

```typescript
const result = await chatFeature.startRun({
  input: payload.input,
  mode: 'task',
  threadId: selectedThreadId,
  enabledCapabilities: {
    mcpServers: currentSelectedMcpServers,
    skills: currentSelectedSkills
  },
  workflowHint: workflowHint ?? null,
  taskSource: payload.taskSource ?? null
});
```

- [ ] **Step 6: Update empty state assertion**

In `tests/renderer/tasks-view.test.ts`, replace:

```typescript
expect(html).toContain('帮我创建一个定时任务');
```

with:

```typescript
expect(html).toContain('点击右上角“新建任务”开始创建后台任务。');
```

- [ ] **Step 7: Run renderer tests**

Run:

```powershell
pnpm test -- tests/renderer/tasks-view.test.ts tests/renderer/chat-view.queued-task.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/renderer/views/tasks/TasksView.tsx src/renderer/app/AppShell.tsx tests/renderer/tasks-view.test.ts tests/renderer/chat-view.queued-task.test.ts
git commit -m "feat: mark task workbench submissions"
```

---

### Task 3: Deep Agent Tool Isolation

**Files:**
- Modify: `src/main/plugins/agent/deep-agent-executor.ts`
- Modify: `src/main/plugins/agent/runtime.ts`
- Test: `tests/main/plugins/agent/deep-agent-executor.test.ts`
- Test: `tests/main/plugins/agent/runtime.test.ts`

- [ ] **Step 1: Change existing production background task tool test to workbench**

In `tests/main/plugins/agent/deep-agent-executor.test.ts`, update `wires the production background task tools to task capabilities` so `buildExecutorOnce` passes:

```typescript
{
  workflowHint: 'propose_background_task',
  taskSource: 'workbench'
}
```

- [ ] **Step 2: Add failing normal chat isolation test**

In `tests/main/plugins/agent/deep-agent-executor.test.ts`, add:

```typescript
it('does not expose background task tools in ordinary chat runs', async () => {
  await buildExecutorOnce(createCapabilities([]), {
    mode: 'chat',
    workflowHint: null,
    taskSource: null
  });

  expect(readBuiltTools().map((tool) => tool.name)).not.toEqual(
    expect.arrayContaining([
      'resolve_background_task_time',
      'propose_background_task',
      'schedule_background_task',
      'read_background_task',
      'update_background_task',
      'cancel_background_task'
    ])
  );
});
```

- [ ] **Step 3: Add failing forged workflow test**

In `tests/main/plugins/agent/deep-agent-executor.test.ts`, add:

```typescript
it('rejects background task workflow hints without workbench source', async () => {
  await expect(
    buildExecutorOnce(createCapabilities([]), {
      workflowHint: 'propose_background_task',
      taskSource: null
    })
  ).rejects.toThrow('background_task_workbench_source_required');
});
```

- [ ] **Step 4: Run executor test to verify failure**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/deep-agent-executor.test.ts
```

Expected: FAIL because background task tools are currently always present and forged workflow is not rejected.

- [ ] **Step 5: Add background task workflow helper**

In `src/main/plugins/agent/deep-agent-executor.ts`, add:

```typescript
function isBackgroundTaskWorkflow(request: ChatStartRunRequest): boolean {
  return request.workflowHint === 'propose_background_task' || request.workflowHint === 'background_task_change';
}

function requireWorkbenchSourceForBackgroundTaskWorkflow(request: ChatStartRunRequest): void {
  if (!isBackgroundTaskWorkflow(request)) {
    return;
  }
  if (request.taskSource !== 'workbench') {
    throw new Error('background_task_workbench_source_required');
  }
}
```

Import `ChatStartRunRequest` from shared types if it is not already imported.

- [ ] **Step 6: Guard executor before building prompt and tools**

In `createAgentDeepAgentExecutor(...).execute`, before `createExecutorTools`, add:

```typescript
requireWorkbenchSourceForBackgroundTaskWorkflow(input.request);
```

Change `createExecutorTools` call:

```typescript
const tools = await createExecutorTools({
  capabilities: options.capabilities,
  enabledCapabilities: input.request.enabledCapabilities,
  includeBackgroundTaskTools: input.request.taskSource === 'workbench' && isBackgroundTaskWorkflow(input.request)
});
```

- [ ] **Step 7: Make tool factory conditional**

Change `createExecutorTools` input type and implementation:

```typescript
async function createExecutorTools(input: {
  capabilities: RocCapabilityRegistry;
  enabledCapabilities: TaskRun['enabledCapabilities'];
  includeBackgroundTaskTools: boolean;
}): Promise<{
  runTools: ClientTool[];
  webReadTool: DynamicStructuredTool<any, any, any, string>;
}> {
  const webReadTool = createWebReadTool(input.capabilities);
  const mcpTools = await loadSelectedMcpTools(input.capabilities, input.enabledCapabilities);
  const backgroundTaskTools = input.includeBackgroundTaskTools
    ? [
        createResolveBackgroundTaskTimeTool(),
        ...createBackgroundTaskTools({
          enabledCapabilities: input.enabledCapabilities,
          previewStore: new PreviewStore(),
          taskAdapter: {
            createBackgroundTaskPreview: async (request) =>
              await input.capabilities.invoke<BackgroundTaskPreviewRequest, BackgroundTaskPreview>('task.background.preview', request),
            createBackgroundTask: async (preview) =>
              await input.capabilities.invoke<BackgroundTaskPreview, BackgroundTask>('task.background.create', preview),
            readBackgroundTask: async (taskId) =>
              await input.capabilities.invoke<{ taskId: string }, TaskDetail>('task.detail.get', { taskId }),
            updateBackgroundTask: async (request) =>
              await input.capabilities.invoke<UpdateBackgroundTaskRequest, BackgroundTask>('task.background.update', request),
            cancelBackgroundTask: async (taskId) =>
              await input.capabilities.invoke<{ id: string }, BackgroundTask>('task.background.cancel', { id: taskId })
          },
          schedulerAdapter: {
            refreshTask: () => {},
            registerTask: () => {},
            unregisterTask: () => {}
          }
        })
      ]
    : [];
  const runTools: ClientTool[] = [
    webReadTool,
    createDeleteFileTool(input.capabilities),
    ...backgroundTaskTools,
    ...mcpTools
  ];
  return {
    runTools,
    webReadTool
  };
}
```

- [ ] **Step 8: Preserve taskSource across approval resume**

In `src/main/plugins/agent/runtime.ts`, update `PendingInterrupt`:

```typescript
type PendingInterrupt = {
  interruptId: string;
  payload: ChatApprovalRequest;
  workflowHint: ChatStartRunRequest['workflowHint'] | null;
  taskSource: ChatStartRunRequest['taskSource'] | null;
};
```

Update `handleRunInterrupted` input and stored object:

```typescript
taskSource: ChatStartRunRequest['taskSource'] | null;
```

```typescript
this.pendingInterrupts.set(input.runId, {
  interruptId: input.interruptId,
  payload: input.payload,
  workflowHint: input.workflowHint,
  taskSource: input.taskSource
});
```

When calling `handleRunInterrupted`, pass:

```typescript
taskSource: input.request.taskSource === undefined ? null : input.request.taskSource
```

When resuming, include:

```typescript
taskSource: pendingInterrupt.taskSource
```

- [ ] **Step 9: Add runtime resume test for taskSource**

In `tests/main/plugins/agent/runtime.test.ts`, extend the existing resume test with:

```typescript
let resumedTaskSource: unknown = null;
```

Inside resumed executor branch:

```typescript
resumedTaskSource = input.request.taskSource;
```

Start request:

```typescript
taskSource: 'workbench'
```

Assertion:

```typescript
expect(resumedTaskSource).toBe('workbench');
```

- [ ] **Step 10: Run agent tests**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/deep-agent-executor.test.ts tests/main/plugins/agent/runtime.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit**

```powershell
git add src/main/plugins/agent/deep-agent-executor.ts src/main/plugins/agent/runtime.ts tests/main/plugins/agent/deep-agent-executor.test.ts tests/main/plugins/agent/runtime.test.ts
git commit -m "feat: isolate background task tools to workbench"
```

---

### Task 4: Capability Preview Without Background Tasks

**Files:**
- Modify: `src/main/plugins/agent/capability-preview.ts`
- Test: `tests/main/plugins/agent/capability-preview.test.ts`
- Test: `tests/main/plugins/agent/deep-agent-executor.test.ts`

- [ ] **Step 1: Add failing preview test**

In `tests/main/plugins/agent/capability-preview.test.ts`, add or update a test that reuses the file's existing `readyRuntimeStatus()` helper:

```typescript
it('does not show background task tools in ordinary agent capability preview', () => {
  const preview = buildAgentCapabilityPreview({
    approvalMode: 'default',
    mcpServers: [],
    requestedCapabilities: {
      mcpServers: [],
      skills: []
    },
    runtimeStatus: readyRuntimeStatus(),
    skills: []
  });

  expect(preview.toolCards.map((card) => card.name)).not.toEqual(
    expect.arrayContaining([
      'resolve_background_task_time',
      'propose_background_task',
      'schedule_background_task',
      'read_background_task',
      'update_background_task',
      'cancel_background_task'
    ])
  );
  expect(preview.interruptOn.update_background_task).toBeUndefined();
  expect(preview.interruptOn.cancel_background_task).toBeUndefined();
});
```


- [ ] **Step 2: Run preview test to verify failure**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/capability-preview.test.ts
```

Expected: FAIL because background task cards and interrupt policies are currently always included.

- [ ] **Step 3: Remove background task cards from ordinary preview**

In `src/main/plugins/agent/capability-preview.ts`, change `toolCards` to:

```typescript
const toolCards = [
  createExecuteCard(),
  createWebReadCard(),
  createDeleteFileCard(input.approvalMode),
  ...selectedMcpCards
];
```

- [ ] **Step 4: Remove default background task interrupt policy**

In `src/main/plugins/agent/capability-preview.ts`, change `createInterruptPolicy` initial policy:

```typescript
const policy: AgentInterruptPolicy = {};
```

Leave delete-file and MCP policy behavior unchanged.

- [ ] **Step 5: Update obsolete test that expected background task approvals**

In `tests/main/plugins/agent/deep-agent-executor.test.ts`, update `keeps approval interrupts for background task changes during creation workflow runs` to expect ordinary preview no longer injects background task interrupts, or remove that test if it duplicates Task 3 coverage. Preferred replacement:

```typescript
it('does not rely on ordinary capability preview for background task interrupts', async () => {
  await buildExecutorOnce(createCapabilities([], { capabilityPreview: true }), {
    workflowHint: 'propose_background_task',
    taskSource: 'workbench'
  });

  expect(readBuildInput().interruptOn).toEqual({});
});
```

- [ ] **Step 6: Run related tests**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/capability-preview.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/main/plugins/agent/capability-preview.ts tests/main/plugins/agent/capability-preview.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts
git commit -m "feat: hide background tasks from ordinary capability preview"
```

---

### Task 5: Scheduler And Manual Run Preserve Workbench Source

**Files:**
- Modify: `src/main/plugins/task/scheduler.ts`
- Modify: `src/main/plugins/task/index.ts`
- Test: `tests/main/plugins/task/scheduler.test.ts`
- Test: `tests/main/plugins/task/plugin.test.ts`

- [ ] **Step 1: Update scheduler test expectation**

In `tests/main/plugins/task/scheduler.test.ts`, update the `startRequests` assertion:

```typescript
expect(startRequests).toEqual([
  expect.objectContaining({
    input: task.goal,
    mode: 'task',
    threadId: task.threadId,
    taskSource: 'workbench'
  })
]);
```

- [ ] **Step 2: Add runNow plugin test expectation**

In `tests/main/plugins/task/plugin.test.ts`, update the existing `startRequests` expectation around the `runBackgroundNow` test at the lines where `runNow` is asserted so it includes `taskSource: 'workbench'`:

```typescript
expect(startRequests).toContainEqual(expect.objectContaining({
  threadId: task.threadId,
  taskSource: 'workbench'
}));
```

- [ ] **Step 3: Run task tests to verify failure**

Run:

```powershell
pnpm test -- tests/main/plugins/task/scheduler.test.ts tests/main/plugins/task/plugin.test.ts
```

Expected: FAIL because scheduler and run-now currently do not pass `taskSource`.

- [ ] **Step 4: Pass source from scheduler**

In `src/main/plugins/task/scheduler.ts`, update `this.options.startRun` request in `fire`:

```typescript
const result = await this.options.startRun({
  input: task.goal,
  mode: 'task',
  threadId: task.threadId,
  enabledCapabilities: task.enabledCapabilities ?? emptyCapabilities,
  taskSource: 'workbench'
});
```

- [ ] **Step 5: Pass source from manual run-now**

In `src/main/plugins/task/index.ts`, update `task.background.runNow` capability:

```typescript
const startResult = await context.capabilities.invoke<ChatStartRunRequest, ChatStartRunResult>('agent.run.start', {
  input: task.goal,
  mode: 'task',
  threadId: task.threadId,
  enabledCapabilities: task.enabledCapabilities === null ? { mcpServers: [], skills: [] } : task.enabledCapabilities,
  taskSource: 'workbench'
});
```

- [ ] **Step 6: Run task tests**

Run:

```powershell
pnpm test -- tests/main/plugins/task/scheduler.test.ts tests/main/plugins/task/plugin.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/main/plugins/task/scheduler.ts src/main/plugins/task/index.ts tests/main/plugins/task/scheduler.test.ts tests/main/plugins/task/plugin.test.ts
git commit -m "feat: preserve workbench source for task runs"
```

---

### Task 6: Failed Background Runs Pause Tasks

**Files:**
- Modify: `src/main/plugins/task/task-repository.ts`
- Modify: `src/shared/types/task.ts`
- Test: `tests/main/plugins/task/plugin.test.ts`

- [ ] **Step 1: Add failing repository/plugin test for failure pause**

In `tests/main/plugins/task/plugin.test.ts`, add a test that creates a scheduled background task, fires or records a run failure for its current `runId`, then asserts:

```typescript
expect(taskAfterFailure.status).toBe('paused');
expect(taskAfterFailure.lastRunStatus).toBe('failed');
expect(snapshot.recentEvents).toContainEqual(
  expect.objectContaining({
    type: 'background_task_paused',
    payload: expect.objectContaining({
      taskId: task.id,
      status: 'paused',
      reason: 'agent_run_failed',
      error: 'provider_unavailable'
    })
  })
);
```

- [ ] **Step 2: Run plugin test to verify failure**

Run:

```powershell
pnpm test -- tests/main/plugins/task/plugin.test.ts
```

Expected: FAIL because `recordAgentRunFailed` currently updates `lastRunStatus` but does not pause the background task.

- [ ] **Step 3: Add event type if needed**

`background_task_paused` already exists in `TaskEvent['type']`; do not change `src/shared/types/task.ts` for this task.

- [ ] **Step 4: Pause task on failed run**

In `src/main/plugins/task/task-repository.ts`, update `recordAgentRunFailed` after finding `task`:

```typescript
if (task !== null) {
  this.db.transaction(() => {
    this.updateBackgroundTaskLastRunStatus(task.id, 'failed');
    this.db.prepare('UPDATE background_tasks SET status = ?, updated_at = ? WHERE id = ?').run('paused', now, task.id);
    this.db.prepare('UPDATE task_threads SET status = ?, updated_at = ? WHERE id = ?').run('paused', now, task.threadId);
    this.insertTaskEvent({
      threadId: task.threadId,
      runId: input.runId,
      type: 'background_task_paused',
      payload: {
        taskId: task.id,
        status: 'paused',
        reason: input.code,
        error: input.error
      },
      createdAt: now
    });
  })();
}
```

Refactor the whole `run !== null` + `task !== null` write path into one outer transaction so the run status update, task pause, and event write are atomic:

```typescript
this.db.transaction(() => {
  // existing run failed updates
  // background task last run status
  // background task paused status
  // paused event
})();
```

- [ ] **Step 5: Avoid duplicate last-run updates**

Remove the old standalone block:

```typescript
if (task !== null) {
  this.updateBackgroundTaskLastRunStatus(task.id, 'failed');
}
```

The single transaction from Step 4 becomes the source of truth.

- [ ] **Step 6: Run plugin test**

Run:

```powershell
pnpm test -- tests/main/plugins/task/plugin.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/main/plugins/task/task-repository.ts src/shared/types/task.ts tests/main/plugins/task/plugin.test.ts
git commit -m "feat: pause background tasks after failed runs"
```

---

### Task 7: Workbench Status Visibility

**Files:**
- Modify: `src/renderer/views/tasks/TasksView.tsx`
- Modify: `src/renderer/views/tasks/TaskDetailDrawer.tsx`
- Test: `tests/renderer/tasks-view.test.ts`
- Test: `tests/renderer/task-detail-drawer.test.ts`

- [ ] **Step 1: Add failing TasksView status assertions**

In `tests/renderer/tasks-view.test.ts`, update the main workbench render fixture so:

```typescript
schedulerStatus: {
  running: false,
  registeredTaskCount: 1,
  nextFireAt: '2026-05-16T08:00:00.000Z',
  recentSkippedCount: 2,
  lastError: 'provider_unavailable'
}
```

Add assertions:

```typescript
expect(html).toContain('调度器未运行');
expect(html).toContain('跳过 2');
expect(html).toContain('provider_unavailable');
```

- [ ] **Step 2: Add failing TaskDetailDrawer failure assertion**

In `tests/renderer/task-detail-drawer.test.ts`, add a recent `agent_update` failed event to the detail fixture:

```typescript
recentEvents: [
  {
    id: 'event-failed',
    threadId: 'thread-1',
    runId: 'run-1',
    type: 'agent_update',
    payload: {
      status: 'failed',
      error: 'provider_unavailable'
    },
    createdAt: '2026-05-16T08:01:00.000Z'
  }
]
```

Assert overview contains:

```typescript
expect(html).toContain('最近失败');
expect(html).toContain('provider_unavailable');
```

- [ ] **Step 3: Run renderer tests to verify failure**

Run:

```powershell
pnpm test -- tests/renderer/tasks-view.test.ts tests/renderer/task-detail-drawer.test.ts
```

Expected: FAIL because skipped count, lastError, and failure summary are not shown.

- [ ] **Step 4: Add scheduler status summary in TasksView**

In `src/renderer/views/tasks/TasksView.tsx`, update `.task-table-status` block to include:

```typescript
<span className={`pill ${state.schedulerStatus.recentSkippedCount === 0 ? 'ok' : 'warn'}`}>
  跳过 {state.schedulerStatus.recentSkippedCount}
</span>
{state.schedulerStatus.lastError === null ? null : (
  <small className="inline-warning">{state.schedulerStatus.lastError}</small>
)}
```

Keep existing running pill and `formatSchedulerMeta`.

- [ ] **Step 5: Add failure extraction helper in TaskDetailDrawer**

In `src/renderer/views/tasks/TaskDetailDrawer.tsx`, add a small helper near `formatEventTag`:

```typescript
function readRecentFailure(detail: TaskDetail | null): string | null {
  if (detail === null) {
    return null;
  }
  for (const event of detail.recentEvents) {
    if (event.type !== 'agent_update' || typeof event.payload !== 'object' || event.payload === null) {
      continue;
    }
    const status = Reflect.get(event.payload, 'status');
    const error = Reflect.get(event.payload, 'error');
    if (status === 'failed' && typeof error === 'string' && error.length > 0) {
      return error;
    }
  }
  return null;
}
```

Inside component after `runOutput`:

```typescript
const recentFailure = readRecentFailure(detail);
```

In overview list after "最近调度":

```typescript
{recentFailure === null ? null : (
  <Row title="最近失败" sub={recentFailure} tag="paused" tone="warn" />
)}
```

- [ ] **Step 6: Run renderer tests**

Run:

```powershell
pnpm test -- tests/renderer/tasks-view.test.ts tests/renderer/task-detail-drawer.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/renderer/views/tasks/TasksView.tsx src/renderer/views/tasks/TaskDetailDrawer.tsx tests/renderer/tasks-view.test.ts tests/renderer/task-detail-drawer.test.ts
git commit -m "feat: surface background task runtime status"
```

---

### Task 8: Final Verification

**Files:**
- Verify only.

- [ ] **Step 1: Run focused tests**

```powershell
pnpm test -- tests/main/plugins/agent/deep-agent-executor.test.ts tests/main/plugins/agent/runtime.test.ts tests/main/plugins/agent/capability-preview.test.ts tests/main/plugins/task/scheduler.test.ts tests/main/plugins/task/plugin.test.ts tests/renderer/chat-view.queued-task.test.ts tests/renderer/tasks-view.test.ts tests/renderer/task-detail-drawer.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

```powershell
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Run full tests if focused tests changed shared contracts**

```powershell
pnpm test
```

Expected: PASS. If `node-pty` prints `Error: AttachConsole failed` after Vitest exits with code `0`, treat it as non-fatal teardown noise for this repo.

- [ ] **Step 4: Inspect status**

```powershell
git status --short
```

Expected: clean working tree after task commits.

