# Background Task DeepAgents Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make workbench background-task creation run through DeepAgents only, with model-parsed trigger times, background-task creation tools, and normal shell/file workspace tools available.

**Architecture:** Remove the deterministic `agent.run.started -> createTaskProposalWorkflow` creation branch from the task plugin. Re-enable background-task creation tools in `AgentDeepAgentExecutor` for `workflowHint='propose_background_task'`, keep normal DeepAgents backend/tools available, and update workflow prompts so the model creates a scheduled task instead of immediately executing the task goal.

**Tech Stack:** TypeScript, Electron main process, DeepAgents, LangChain tools, Vitest, better-sqlite3 test repositories.

---

## File Structure

- Modify `src/main/plugins/agent/deep-agent-executor.ts`: change background task tool mode resolution so workbench proposal runs receive creation tools, while change runs still receive only change tools.
- Modify `src/main/plugins/task/index.ts`: remove deterministic creation from `agent.run.started`; keep run/event recording.
- Modify `src/main/services/deep-agent/prompt.ts`: replace harness wording with DeepAgents-owned creation rules, Chinese time mappings, and no-immediate-execution guidance.
- Modify `src/main/services/deep-agent/prompt-builder.ts`: keep the alternate prompt builder in sync with `prompt.ts`.
- Modify `tests/main/plugins/agent/deep-agent-executor.test.ts`: update tool exposure expectations and add direct tool invocation checks for proposal runs.
- Modify `tests/main/plugins/task/plugin.test.ts`: replace deterministic creation test with a test that proves `agent.run.started` only records the run.
- Modify `tests/main/deep-agent-prompt.test.ts`: update prompt assertions.
- Modify `tests/main/services/deep-agent/prompt-builder.test.ts`: add/update prompt builder assertions if existing coverage checks workflow text.
- Optional cleanup after tests pass: remove `src/main/plugins/task/task-proposal-workflow.ts` and `tests/main/plugins/task/task-proposal-workflow.test.ts` only if no production or test imports remain.

---

### Task 1: Re-enable DeepAgents creation tools for proposal runs

**Files:**
- Modify: `tests/main/plugins/agent/deep-agent-executor.test.ts:29-42`
- Modify: `src/main/plugins/agent/deep-agent-executor.ts:554-626`

- [ ] **Step 1: Replace the old proposal tool exposure test with failing expectations**

Replace the test at `tests/main/plugins/agent/deep-agent-executor.test.ts:30` with:

```typescript
  it('wires background task creation tools during workbench proposal runs', async () => {
    const capabilityCalls: Array<{ name: string; input: unknown }> = [];
    await buildExecutorOnce(createCapabilities(capabilityCalls), {
      workflowHint: 'propose_background_task',
      taskSource: 'workbench'
    });
    const tools = readBuiltTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual(expect.arrayContaining(['propose_background_task', 'schedule_background_task', 'read_background_task']));
    expect(toolNames).not.toEqual(expect.arrayContaining(['resolve_background_task_time', 'update_background_task', 'cancel_background_task']));
    expect(capabilityCalls.map((call) => call.name)).toEqual(['workspace.getCurrent']);
  });
```

- [ ] **Step 2: Add a failing proposal tool invocation test**

Add this test immediately after the previous test:

```typescript
  it('routes proposal tools to task preview and create capabilities', async () => {
    const capabilityCalls: Array<{ name: string; input: unknown }> = [];
    await buildExecutorOnce(createCapabilities(capabilityCalls), {
      workflowHint: 'propose_background_task',
      taskSource: 'workbench'
    });
    const tools = readBuiltTools();

    const previewOutput = await invokeTool(findTool(tools, 'propose_background_task'), {
      goal: '每天晚上9点创建 docx 文件，里面写你好世界',
      trigger: {
        type: 'cron',
        description: '每天 21:00',
        cronExpression: '0 21 * * *',
        nextRunAt: '2026-06-16T13:00:00.000Z'
      },
      workspacePath: 'F:\\\\Code\\\\Roc'
    });
    const previewJson = readJson(previewOutput) as { previewId: string };

    const scheduleOutput = await invokeTool(findTool(tools, 'schedule_background_task'), {
      previewId: previewJson.previewId
    });

    expect(readJson(scheduleOutput)).toMatchObject({
      ok: true,
      taskId: 'background-1',
      threadId: 'thread-background-1'
    });
    expect(capabilityCalls.map((call) => call.name)).toEqual([
      'workspace.getCurrent',
      'task.background.preview',
      'task.background.create'
    ]);
  });
```

- [ ] **Step 3: Run the failing executor tests**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/deep-agent-executor.test.ts
```

Expected: FAIL. The first test fails because proposal runs do not expose `propose_background_task`; the second fails because `findTool` cannot find `propose_background_task`.

- [ ] **Step 4: Implement proposal/change tool mode split**

In `src/main/plugins/agent/deep-agent-executor.ts`, change the tool mode type and mode resolver.

Replace:

```typescript
      backgroundTaskToolMode: readBackgroundTaskToolMode(input.request)
```

with:

```typescript
      backgroundTaskToolMode: readBackgroundTaskToolMode(input.request)
```

Keep the call site name unchanged, but update the helper types below.

Replace:

```typescript
  backgroundTaskToolMode: 'change' | null;
```

with:

```typescript
  backgroundTaskToolMode: 'all' | 'change' | null;
```

Replace:

```typescript
function readBackgroundTaskToolMode(request: ChatStartRunRequest): 'change' | null {
  return request.workflowHint === 'background_task_change' ? 'change' : null;
}
```

with:

```typescript
function readBackgroundTaskToolMode(request: ChatStartRunRequest): 'all' | 'change' | null {
  if (request.workflowHint === 'propose_background_task') {
    return 'all';
  }
  if (request.workflowHint === 'background_task_change') {
    return 'change';
  }
  return null;
}
```

- [ ] **Step 5: Restrict proposal mode to create/read tools, not update/cancel**

In `src/main/services/deep-agent/background-task-tools.ts`, adjust `createBackgroundTaskTools` so `toolMode: 'all'` for proposal returns `propose_background_task`, `schedule_background_task`, and `read_background_task`, but not `update_background_task` or `cancel_background_task`.

Use this implementation shape:

```typescript
export function createBackgroundTaskTools(input: BackgroundTaskToolDependencies): Array<DynamicStructuredTool<any, any, any, string>> {
  const readTool = new DynamicStructuredTool<typeof readInputSchema, z.infer<typeof readInputSchema>, z.infer<typeof readInputSchema>, string>({
    name: 'read_background_task',
    description: '读取已有后台任务定义、状态和最近运行信息。',
    schema: readInputSchema,
    func: async (rawInput) => JSON.stringify(await readBackgroundTask(input, rawInput), null, 2)
  });
  const changeTools = [
    readTool,
    new DynamicStructuredTool<typeof updateInputSchema, z.infer<typeof updateInputSchema>, z.infer<typeof updateInputSchema>, string>({
      name: 'update_background_task',
      description: '修改已有后台任务；本工具由 HITL 在执行前审批，审批通过或编辑后才会执行。',
      schema: updateInputSchema,
      func: async (rawInput) => JSON.stringify(await updateBackgroundTask(input, rawInput), null, 2)
    }),
    new DynamicStructuredTool<typeof cancelInputSchema, z.infer<typeof cancelInputSchema>, z.infer<typeof cancelInputSchema>, string>({
      name: 'cancel_background_task',
      description: '取消已有后台任务；本工具由 HITL 在执行前审批，审批通过或编辑后才会执行。',
      schema: cancelInputSchema,
      func: async (rawInput) => JSON.stringify(await cancelBackgroundTask(input, rawInput), null, 2)
    })
  ];
  if (input.toolMode === 'change') {
    return changeTools;
  }
  return [
    new DynamicStructuredTool<
      typeof proposeToolInputSchema,
      z.infer<typeof proposeToolInputSchema>,
      z.infer<typeof proposeToolInputSchema>,
      string
    >({
      name: PROPOSE_TOOL_NAME,
      description: PROPOSE_TOOL_DESCRIPTION,
      schema: proposeToolInputSchema,
      func: async (rawInput) => JSON.stringify(await createBackgroundTaskPreview(input, rawInput), null, 2)
    }),
    new DynamicStructuredTool<
      typeof scheduleInputSchema,
      z.infer<typeof scheduleInputSchema>,
      z.infer<typeof scheduleInputSchema>,
      string
    >({
      name: 'schedule_background_task',
      description: SCHEDULE_TOOL_DESCRIPTION,
      schema: scheduleInputSchema,
      func: async (rawInput) => JSON.stringify(await scheduleBackgroundTask(input, rawInput), null, 2)
    }),
    readTool
  ];
}
```

- [ ] **Step 6: Run executor tests again**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/deep-agent-executor.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 1**

```powershell
git add -- src/main/plugins/agent/deep-agent-executor.ts src/main/services/deep-agent/background-task-tools.ts tests/main/plugins/agent/deep-agent-executor.test.ts
git commit -m "feat: route background task creation through deepagents tools"
```

---

### Task 2: Remove deterministic task-plugin creation branch

**Files:**
- Modify: `tests/main/plugins/task/plugin.test.ts:991-1037`
- Modify: `src/main/plugins/task/index.ts:91-125`

- [ ] **Step 1: Replace deterministic creation test with a single-owner test**

Replace the test named `creates proposal background tasks deterministically from agent.run.started` in `tests/main/plugins/task/plugin.test.ts` with:

```typescript
  it('records proposal run starts without creating background tasks deterministically', async () => {
    const eventBus = createTestEventBus();
    const plugin = createTaskPlugin();
    const capabilities = new CapabilityRegistry();
    registerWorkspaceGetCurrent(capabilities);
    for (const descriptor of plugin.manifest.capabilities) {
      capabilities.declare(plugin.manifest.id, descriptor);
    }
    await plugin.initialize(createContext({ capabilities, eventBus }));

    await eventBus.publish({
      type: 'agent.run.started',
      source: '@roc/plugin-agent',
      createdAt: '2026-06-04T00:00:00.000Z',
      payload: {
        runId: 'run_task_proposal',
        threadId: 'thread_task_proposal',
        mode: 'task',
        providerId: 'smoke-provider',
        modelId: 'smoke-model',
        createdAt: '2026-06-04T00:00:00.000Z',
        userInput: '每天晚上9点创建 docx 文件，里面写你好世界。',
        workflowHint: 'propose_background_task',
        enabledCapabilities: {
          mcpServers: [],
          skills: []
        }
      }
    });

    const activeTasks = await capabilities.invoke<{}, ActiveTaskItem[]>('task.active.list', {});
    const snapshot = await capabilities.invoke<{}, TaskSnapshot>('task.snapshot.get', {});

    expect(activeTasks).toEqual([]);
    expect(snapshot.recentEvents).toContainEqual(
      expect.objectContaining({
        runId: 'run_task_proposal',
        threadId: 'thread_task_proposal',
        type: 'message',
        payload: expect.objectContaining({
          role: 'user',
          content: '每天晚上9点创建 docx 文件，里面写你好世界。'
        })
      })
    );
    expect(readToolCallStatuses(snapshot, 'resolve_background_task_time')).toEqual([]);
    expect(readToolCallStatuses(snapshot, 'propose_background_task')).toEqual([]);
    expect(readToolCallStatuses(snapshot, 'schedule_background_task')).toEqual([]);
  });
```

- [ ] **Step 2: Run failing task plugin test**

Run:

```powershell
pnpm test -- tests/main/plugins/task/plugin.test.ts
```

Expected: FAIL. It still creates an active background task from `agent.run.started`.

- [ ] **Step 3: Remove deterministic creation branch**

In `src/main/plugins/task/index.ts`, replace the `agent.run.started` subscription body:

```typescript
      unsubscribeAgentRunStarted = context.eventBus.subscribe('agent.run.started', async (event) => {
        const payload = readAgentRunStartedPayload(event.payload);
        if (payload === null) {
          return;
        }
        repository.recordAgentRunStarted(payload);
        if (payload.workflowHint === 'propose_background_task') {
          const workflow = createTaskProposalWorkflow(context);
          const result = await workflow({
            runId: payload.runId,
            threadId: payload.threadId,
            input: payload.userInput,
            enabledCapabilities: payload.enabledCapabilities,
            recordTaskEvent: async (type, eventPayload) => {
              repository.recordAgentTaskEvent({
                runId: payload.runId,
                threadId: payload.threadId,
                type,
                payload: eventPayload,
                createdAt: new Date().toISOString()
              });
            }
          });
          repository.recordAgentRunCompleted({
            runId: payload.runId,
            threadId: payload.threadId,
            assistantMessage: result.assistantMessage,
            providerId: payload.providerId,
            modelId: payload.modelId,
            durationMs: 0,
            summary: result.summary,
            finishReason: 'stop'
          });
        }
      });
```

with:

```typescript
      unsubscribeAgentRunStarted = context.eventBus.subscribe('agent.run.started', async (event) => {
        const payload = readAgentRunStartedPayload(event.payload);
        if (payload === null) {
          return;
        }
        repository.recordAgentRunStarted(payload);
      });
```

Remove the now-unused `createTaskProposalWorkflow` import from the same file.

- [ ] **Step 4: Run task plugin test again**

Run:

```powershell
pnpm test -- tests/main/plugins/task/plugin.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```powershell
git add -- src/main/plugins/task/index.ts tests/main/plugins/task/plugin.test.ts
git commit -m "fix: stop deterministic background task creation branch"
```

---

### Task 3: Update creation workflow prompt for model time parsing

**Files:**
- Modify: `tests/main/deep-agent-prompt.test.ts:170-184`
- Modify: `src/main/services/deep-agent/prompt.ts:43-50`
- Modify: `src/main/services/deep-agent/prompt-builder.ts:159-166`
- Modify: `tests/main/services/deep-agent/prompt-builder.test.ts`

- [ ] **Step 1: Update prompt test expectations**

In `tests/main/deep-agent-prompt.test.ts`, replace the test named `adds a propose-background-task workflow overview with time resolution one-shot` with:

```typescript
  it('adds a propose-background-task workflow overview for DeepAgents creation', () => {
    const prompt = buildSystemPrompt({
      enabledCapabilities: { mcpServers: [], skills: [] },
      workspacePath: 'F:\\\\Code\\\\Roc',
      frozenSnapshot: disabledSnapshot(),
      workflowHint: 'propose_background_task'
    });

    expect(prompt).toContain('本轮工作流：创建后台任务。');
    expect(prompt).toContain('你负责解析用户目标和触发时间，并通过 propose_background_task 创建 preview，再通过 schedule_background_task 落地。');
    expect(prompt).toContain('创建后台任务不是立即执行任务目标；不要把用户要求定时执行的文件、shell 或业务动作在当前回合直接完成。');
    expect(prompt).toContain('中文时段解析约定：早上7点=07:00，晚上9点=21:00，中午1点=13:00，晚上12点=00:00。');
    expect(prompt).toContain('如果触发时间仍不确定，直接请求用户补充明确时间，不要调用 propose_background_task。');
    expect(prompt).not.toContain('harness 会解析时间');
    expect(prompt).not.toContain('resolve_background_task_time');
  });
```

- [ ] **Step 2: Run failing prompt tests**

Run:

```powershell
pnpm test -- tests/main/deep-agent-prompt.test.ts
```

Expected: FAIL because prompt still says harness parses time.

- [ ] **Step 3: Update `prompt.ts` workflow overview**

In `src/main/services/deep-agent/prompt.ts`, replace the `propose_background_task` return block with:

```typescript
    return [
      '',
      '本轮工作流：创建后台任务。',
      '你负责解析用户目标和触发时间，并通过 propose_background_task 创建 preview，再通过 schedule_background_task 落地。',
      '创建后台任务不是立即执行任务目标；不要把用户要求定时执行的文件、shell 或业务动作在当前回合直接完成。',
      '中文时段解析约定：早上7点=07:00，晚上9点=21:00，中午1点=13:00，晚上12点=00:00。',
      'cron trigger 使用五段 cronExpression；nextRunAt 必须是 UTC ISO 字符串。',
      '如果触发时间仍不确定，直接请求用户补充明确时间，不要调用 propose_background_task。'
    ];
```

- [ ] **Step 4: Update `prompt-builder.ts` workflow overview**

In `src/main/services/deep-agent/prompt-builder.ts`, make the same replacement in `SystemPromptBuilder.createWorkflowOverview`.

- [ ] **Step 5: Add or update prompt-builder coverage**

Search:

```powershell
rg -n "harness 会解析时间|propose_background_task|创建后台任务" tests/main/services/deep-agent/prompt-builder.test.ts
```

If `prompt-builder.test.ts` already asserts old text, replace it with the same new assertions from Step 1. If it has no workflow test, add:

```typescript
  it('adds DeepAgents-owned background task creation guidance', () => {
    const blocks = SystemPromptBuilder.buildPromptBlocks({
      enabledCapabilities: { mcpServers: [], skills: [] },
      workspacePath: 'F:\\\\Code\\\\Roc',
      frozenSnapshot: disabledSnapshot(),
      workflowHint: 'propose_background_task',
      tools: []
    });
    const content = blocks.map((block) => block.content).join('\\n');

    expect(content).toContain('你负责解析用户目标和触发时间，并通过 propose_background_task 创建 preview，再通过 schedule_background_task 落地。');
    expect(content).toContain('中文时段解析约定：早上7点=07:00，晚上9点=21:00，中午1点=13:00，晚上12点=00:00。');
    expect(content).not.toContain('harness 会解析时间');
  });
```

Use the existing imports and helper names in `prompt-builder.test.ts`; if `disabledSnapshot` is not present there, create the same minimal helper style already used in `deep-agent-prompt.test.ts`.

- [ ] **Step 6: Run prompt tests**

Run:

```powershell
pnpm test -- tests/main/deep-agent-prompt.test.ts tests/main/services/deep-agent/prompt-builder.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```powershell
git add -- src/main/services/deep-agent/prompt.ts src/main/services/deep-agent/prompt-builder.ts tests/main/deep-agent-prompt.test.ts tests/main/services/deep-agent/prompt-builder.test.ts
git commit -m "fix: guide deepagents background task creation"
```

---

### Task 4: Cover normal DeepAgents shell/file tool availability and no immediate execution guidance

**Files:**
- Modify: `tests/main/plugins/agent/deep-agent-executor.test.ts`
- Modify: `tests/main/plugins/agent/runtime.test.ts`

- [ ] **Step 1: Add executor test for built-in shell/file tools remaining available**

Add this test after the proposal tool exposure test in `tests/main/plugins/agent/deep-agent-executor.test.ts`:

```typescript
  it('keeps the DeepAgents backend available during workbench proposal runs', async () => {
    await buildExecutorOnce(createCapabilities([]), {
      workflowHint: 'propose_background_task',
      taskSource: 'workbench'
    });

    const buildInput = readBuildInput();

    expect(buildInput.backend.routePrefixes).toEqual(expect.arrayContaining(['/workspace/', '/skills/', '/agents/', '/memory/']));
    expect(buildInput.filesystemPermissions).toBeUndefined();
  });
```

- [ ] **Step 2: Add runtime test that creation event path comes from DeepAgents tool calls**

In `tests/main/plugins/agent/runtime.test.ts`, add a test near the existing background tool event test:

```typescript
  it('runs workbench proposal requests through DeepAgents instead of completing before execution', async () => {
    const repository = new AgentSessionRepository(db);
    const seenInputs: ChatStartRunRequest[] = [];
    const runtime = new AgentPluginRuntime({
      deepAgentExecutor: {
        execute: async function* (input) {
          seenInputs.push(input.request);
          yield {
            type: 'assistant_block',
            runId: input.run.id,
            block: {
              kind: 'tool_call',
              blockId: 'tool-call-propose',
              callId: 'call-propose',
              name: 'propose_background_task',
              phase: 'start',
              input: {
                goal: '每天晚上9点创建 docx 文件，里面写你好世界',
                trigger: {
                  type: 'cron',
                  description: '每天 21:00',
                  cronExpression: '0 21 * * *',
                  nextRunAt: '2026-06-16T13:00:00.000Z'
                },
                workspacePath: 'F:\\\\Code\\\\Roc'
              }
            }
          };
          yield {
            type: 'assistant_block',
            runId: input.run.id,
            block: {
              kind: 'tool_call',
              blockId: 'tool-call-schedule',
              callId: 'call-schedule',
              name: 'schedule_background_task',
              phase: 'end',
              output: {
                ok: true,
                taskId: 'background-1'
              }
            }
          };
          yield {
            type: 'assistant_block',
            runId: input.run.id,
            block: {
              kind: 'text',
              blockId: 'text-final',
              phase: 'delta',
              text: '后台任务已创建。'
            }
          };
        }
      },
      eventBus,
      modelFactory,
      repository
    });

    const result = await runtime.startRun({
      ...startRequest,
      input: '每天晚上9点创建 docx 文件，里面写你好世界',
      mode: 'task',
      workflowHint: 'propose_background_task',
      taskSource: 'workbench'
    });

    await waitForEvent(() =>
      events.some((event) => event.type === 'agent.chat.run-event' && readChatRunEvent(event.payload)?.type === 'run_completed')
    );

    expect(seenInputs).toHaveLength(1);
    expect(seenInputs[0]).toMatchObject({
      workflowHint: 'propose_background_task',
      taskSource: 'workbench'
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent.run.task-event',
        payload: expect.objectContaining({
          runId: result.runId,
          type: 'tool_call',
          payload: expect.objectContaining({
            name: 'propose_background_task',
            status: 'start'
          })
        })
      })
    );
  });
```

- [ ] **Step 3: Run targeted tests**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/deep-agent-executor.test.ts tests/main/plugins/agent/runtime.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit Task 4**

```powershell
git add -- tests/main/plugins/agent/deep-agent-executor.test.ts tests/main/plugins/agent/runtime.test.ts
git commit -m "test: cover deepagents proposal execution path"
```

---

### Task 5: Remove stale deterministic workflow artifacts if unused

**Files:**
- Possibly delete: `src/main/plugins/task/task-proposal-workflow.ts`
- Possibly delete: `tests/main/plugins/task/task-proposal-workflow.test.ts`
- Possibly modify: imports that still reference `createTaskProposalWorkflow`

- [ ] **Step 1: Search for deterministic workflow references**

Run:

```powershell
rg -n "createTaskProposalWorkflow|TaskProposalWorkflow|normalizeBackgroundTaskProposalGoal|task-proposal-workflow" src tests
```

Expected after Tasks 1-4: only `src/main/plugins/task/task-proposal-workflow.ts` and `tests/main/plugins/task/task-proposal-workflow.test.ts` remain.

- [ ] **Step 2: Delete unused deterministic workflow files**

If Step 1 confirms no production imports, delete:

```powershell
Remove-Item -LiteralPath 'src\main\plugins\task\task-proposal-workflow.ts'
Remove-Item -LiteralPath 'tests\main\plugins\task\task-proposal-workflow.test.ts'
```

If Step 1 shows additional references, update those references first so no production path uses the deterministic workflow.

- [ ] **Step 3: Verify no stale references remain**

Run:

```powershell
rg -n "createTaskProposalWorkflow|TaskProposalWorkflow|normalizeBackgroundTaskProposalGoal|task-proposal-workflow" src tests
```

Expected: no matches.

- [ ] **Step 4: Run task tests after cleanup**

Run:

```powershell
pnpm test -- tests/main/plugins/task/plugin.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```powershell
git add -- src/main/plugins/task tests/main/plugins/task
git commit -m "refactor: remove deterministic background task proposal workflow"
```

---

### Task 6: Final verification

**Files:**
- No code changes expected.

- [ ] **Step 1: Run focused verification**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/deep-agent-executor.test.ts tests/main/plugins/agent/runtime.test.ts tests/main/plugins/task/plugin.test.ts tests/main/deep-agent-prompt.test.ts tests/main/services/deep-agent/prompt-builder.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```powershell
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Run full test suite if focused checks pass**

Run:

```powershell
pnpm test
```

Expected: PASS. If `node-pty` prints `Error: AttachConsole failed` while exit code is 0, treat it as known teardown noise.

- [ ] **Step 4: Inspect git status**

Run:

```powershell
git status --short
```

Expected: no unstaged implementation changes. Only intentional commits from this plan should be present.

---

## Self-Review

- Spec coverage: Tasks 1 and 4 cover DeepAgents creation tool and normal backend availability. Task 2 removes the deterministic branch and fixes double ownership. Task 3 moves time parsing responsibility to model prompt and includes the requested Chinese time mappings. Task 5 removes stale harness artifacts. Task 6 verifies.
- Placeholder scan: no TBD/TODO/fill-in steps. Each code-changing step includes exact code or exact replacement guidance.
- Type consistency: tool mode is consistently `'all' | 'change' | null`; workflow hints use existing `propose_background_task` and `background_task_change`; task capability names match current code.
