# Background Task Propose Runtime Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `propose_background_task` robust by letting runtime inject the Windows workspace path and derive low-risk trigger descriptions.

**Architecture:** Split the model-visible tool input from the full persisted `BackgroundTaskPreviewRequest`. Keep repository and scheduler contracts strict, but normalize model tool input inside `background-task-tools.ts` before calling `task.background.preview`. Preserve DeepAgents virtual `/workspace/...` paths for file tools and Windows absolute paths for background task metadata.

**Tech Stack:** TypeScript, Electron main process, LangChain `DynamicStructuredTool`, Zod, Vitest, DeepAgents `CompositeBackend` routes.

---

## File Structure

- Modify `src/main/services/deep-agent/background-task-tools.ts`
  - Add model-visible trigger schemas where `description` is optional.
  - Add `runtimeWorkspacePath` to `BackgroundTaskToolDependencies`.
  - Normalize model tool input into a full `BackgroundTaskPreviewRequest`.
  - Keep `proposeInputSchema` strict for full runtime/repository update contracts.
- Modify `src/main/plugins/agent/deep-agent-executor.ts`
  - Pass `workspace?.path ?? null` into `createExecutorTools`.
  - Pass that value into `createBackgroundTaskTools`.
- Modify `src/shared/background-task-tool-contract.ts`
  - Update model-visible example and tool description so models do not fill `workspacePath`.
  - Keep full runtime example with Windows `workspacePath`.
- Modify `src/main/services/deep-agent/prompt.ts`
  - Add explicit path ownership lines for background task creation workflow.
- Modify tests:
  - `tests/_factories/background-task.ts`
  - `tests/_matchers/contract.ts`
  - `tests/main/background-task-schema.test.ts`
  - `tests/shared/background-task-contract.test.ts`
  - `tests/main/deep-agent-prompt.test.ts`
  - `tests/main/plugins/agent/deep-agent-executor.test.ts`

---

### Task 1: Red Tests For Model-Visible Schema And Normalization

**Files:**
- Modify: `tests/_factories/background-task.ts`
- Modify: `tests/_matchers/contract.ts`
- Modify: `tests/main/background-task-schema.test.ts`

- [ ] **Step 1: Update test factory to support model input without `workspacePath` or `description`**

In `tests/_factories/background-task.ts`, change `MinimalProposeToolInput` and `minimalProposeToolInput` to allow omitted fields:

```typescript
type MinimalProposeToolInput = {
  goal: string;
  trigger:
    | {
        type: 'manual';
        description?: string;
      }
    | {
        type: 'once';
        description?: string;
        nextRunAt: string;
      }
    | {
        type: 'cron';
        description?: string;
        cronExpression: string;
        nextRunAt: string;
      };
  workspacePath?: string;
};
```

Keep the existing helper name. Use this default:

```typescript
export function minimalProposeToolInput(overrides: DeepPartial<MinimalProposeToolInput> = {}): MinimalProposeToolInput {
  return mergeMinimalProposeToolInput(
    {
      goal: '每天晚上 7:40 抓取 AI 最新新闻，并将结果写入当前工作目录下的 docx 文件',
      trigger: {
        type: 'cron',
        cronExpression: '40 19 * * *',
        nextRunAt: '2026-05-26T11:40:00.000Z'
      }
    },
    overrides
  );
}
```

- [ ] **Step 2: Update matcher helper to read model-visible schema separately**

In `tests/_matchers/contract.ts`, add a model-visible issue reader:

```typescript
function readToolIssues(input: unknown): ZodError['issues'] {
  const result = proposeToolInputSchema.safeParse(input);
  return result.success ? [] : result.error.issues;
}
```

Then update `toBeRejectedByProposeToolSchemaAtPath` to call `readToolIssues(input)` instead of duplicating `safeParse`.

- [ ] **Step 3: Write red schema tests**

In `tests/main/background-task-schema.test.ts`, import `minimalProposeToolInput`:

```typescript
import { invalidProposeInput, minimalProposeToolInput, validProposeInput } from '../_factories/background-task';
```

Add these tests after the `accepts %s` block:

```typescript
it('model-visible schema accepts cron input without workspacePath or trigger.description', () => {
  expect(
    minimalProposeToolInput({
      trigger: {
        type: 'cron',
        cronExpression: '0 13 * * *',
        nextRunAt: '2026-06-17T05:00:00.000Z'
      }
    })
  ).toBeAcceptedByProposeToolSchema();
});

it('model-visible schema accepts but ignores legacy workspacePath from the model', () => {
  expect(
    minimalProposeToolInput({
      workspacePath: '/workspace/',
      trigger: {
        type: 'cron',
        cronExpression: '0 13 * * *',
        nextRunAt: '2026-06-17T05:00:00.000Z'
      }
    })
  ).toBeAcceptedByProposeToolSchema();
});
```

Add the matcher declaration and implementation in `tests/_matchers/contract.ts`:

```typescript
toBeAcceptedByProposeToolSchema(input: unknown) {
  const result = proposeToolInputSchema.safeParse(input);
  return {
    pass: result.success,
    message: () =>
      `expected input to be accepted by model-visible propose schema, got:\n${
        result.success
          ? 'no Zod issues'
          : result.error.issues.map((issue) => `${formatPath(issue.path) || '<root>'}: ${issue.message}`).join('\n')
      }`
  };
},
```

Also add `toBeAcceptedByProposeToolSchema(): T;` to both Vitest interface sections.

- [ ] **Step 4: Run red schema tests**

Run:

```powershell
pnpm test -- tests/main/background-task-schema.test.ts
```

Expected: FAIL. The new tests should fail because current `proposeToolInputSchema` still requires `workspacePath` and `trigger.description`.

- [ ] **Step 5: Commit red tests**

```powershell
git add tests/_factories/background-task.ts tests/_matchers/contract.ts tests/main/background-task-schema.test.ts
git commit -m "test: cover background task model input normalization"
```

---

### Task 2: Implement Model-Visible Input Schema And Runtime Normalization

**Files:**
- Modify: `src/main/services/deep-agent/background-task-tools.ts`
- Test: `tests/main/background-task-schema.test.ts`

- [ ] **Step 1: Add model-visible trigger schemas**

In `src/main/services/deep-agent/background-task-tools.ts`, keep existing full schemas unchanged, then add these schemas after `triggerSchema`:

```typescript
export const modelManualTriggerSchema = z.strictObject({
  type: z.literal('manual').describe('触发类型：manual / once / cron。'),
  description: z.string().min(1).optional().describe('展示给用户的触发说明，单句中文；可省略，由 runtime 补齐。')
});

export const modelOnceTriggerSchema = z.strictObject({
  type: z.literal('once').describe('触发类型：manual / once / cron。'),
  description: z.string().min(1).optional().describe('展示给用户的触发说明，单句中文；可省略，由 runtime 补齐。'),
  nextRunAt: z.string().datetime().describe('UTC ISO 时间戳（含 T 与 Z），调度器下次触发时间。')
});

export const modelCronTriggerSchema = z.strictObject({
  type: z.literal('cron').describe('触发类型：manual / once / cron。'),
  description: z.string().min(1).optional().describe('展示给用户的触发说明，单句中文；可省略，由 runtime 补齐。'),
  cronExpression: z.string().min(1).describe('五段 cron，按本机时区执行，例如 50 21 * * *。'),
  nextRunAt: z.string().datetime().describe('UTC ISO 时间戳（含 T 与 Z），调度器下次触发时间。')
});

export const modelTriggerSchema = z
  .discriminatedUnion('type', [modelManualTriggerSchema, modelOnceTriggerSchema, modelCronTriggerSchema])
  .describe('触发类型：manual / once / cron。');
```

- [ ] **Step 2: Change `proposeToolInputSchema` to model-visible shape**

Replace current `proposeToolInputSchema` with:

```typescript
export const proposeToolInputSchema = z.strictObject({
  goal: z.string().min(1).max(500).describe('后台任务目标，单句中文描述。'),
  trigger: modelTriggerSchema,
  workspacePath: z.string().min(1).optional().describe('兼容旧模型输出；实际后台任务 workspacePath 始终由 runtime 注入。')
});
```

Do not change `proposeInputSchema` yet. It should still extend the full runtime schema. To preserve that, introduce:

```typescript
export const fullProposeInputSchema = z.strictObject({
  goal: z.string().min(1).max(500).describe('后台任务目标，单句中文描述。'),
  trigger: triggerSchema,
  workspacePath: z.string().min(1).describe('Windows 绝对工作区路径，由 runtime 注入。')
});
```

Then change:

```typescript
export const proposeInputSchema = fullProposeInputSchema.extend({
```

- [ ] **Step 3: Add runtime workspace dependency**

In `BackgroundTaskToolDependencies`, add:

```typescript
runtimeWorkspacePath: string | null;
```

- [ ] **Step 4: Normalize model input into full preview request**

Replace `normalizePreview` with:

```typescript
async function normalizePreview(input: BackgroundTaskToolDependencies, rawInput: unknown): Promise<BackgroundTaskPreview> {
  const parsed = proposeToolInputSchema.parse(rawInput);
  if (input.runtimeWorkspacePath === null) {
    throw new RocDomainError({
      code: 'background_task_workspace_required',
      message: '创建后台任务需要先选择工作区。',
      category: 'validation',
      retryable: true,
      userAction: '请先选择一个工作区，再创建后台任务。'
    });
  }
  const request: BackgroundTaskPreviewRequest = {
    goal: parsed.goal,
    trigger: normalizeTriggerForPreview(parsed.trigger),
    workspacePath: input.runtimeWorkspacePath,
    allowedActions: [],
    forbiddenActions: [],
    failurePolicy: 'pause_and_report',
    notificationPolicy: 'failures_and_confirmations',
    enabledCapabilities: input.enabledCapabilities === undefined ? null : input.enabledCapabilities
  };
  validateTrigger(request.trigger);
  validateWorkspacePath(request.workspacePath);
  return await input.taskAdapter.createBackgroundTaskPreview(request);
}
```

Add helper functions below `normalizePreview`:

```typescript
function normalizeTriggerForPreview(trigger: z.infer<typeof modelTriggerSchema>): z.infer<typeof triggerSchema> {
  if (trigger.type === 'manual') {
    return {
      type: 'manual',
      description: readTriggerDescription(trigger.description, '手动触发')
    };
  }
  if (trigger.type === 'once') {
    return {
      type: 'once',
      description: readTriggerDescription(trigger.description, `在 ${trigger.nextRunAt} 触发`),
      nextRunAt: trigger.nextRunAt
    };
  }
  return {
    type: 'cron',
    description: readTriggerDescription(trigger.description, describeCronTrigger(trigger.cronExpression)),
    cronExpression: trigger.cronExpression,
    nextRunAt: trigger.nextRunAt
  };
}

function readTriggerDescription(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : fallback;
}

function describeCronTrigger(cronExpression: string): string {
  const fields = cronExpression.trim().split(/\s+/u);
  if (fields.length !== 5) {
    return `按 cron ${cronExpression} 触发`;
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (/^\d+$/u.test(minute) && /^\d+$/u.test(hour) && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `每天 ${hour.padStart(2, '0')}:${minute.padStart(2, '0')} 触发`;
  }
  if (/^\d+$/u.test(minute) && /^\d+$/u.test(hour) && dayOfMonth === '*' && month === '*' && dayOfWeek !== '*') {
    return `每周 ${dayOfWeek} ${hour.padStart(2, '0')}:${minute.padStart(2, '0')} 触发`;
  }
  return `按 cron ${cronExpression} 触发`;
}
```

- [ ] **Step 5: Run schema tests**

Run:

```powershell
pnpm test -- tests/main/background-task-schema.test.ts
```

Expected: PASS for new model-visible schema tests and existing full schema tests.

- [ ] **Step 6: Commit normalization schema implementation**

```powershell
git add src/main/services/deep-agent/background-task-tools.ts tests/_matchers/contract.ts tests/_factories/background-task.ts tests/main/background-task-schema.test.ts
git commit -m "fix: normalize background task propose input"
```

---

### Task 3: Wire Runtime Workspace Path Through Executor And Cover Tool Behavior

**Files:**
- Modify: `src/main/plugins/agent/deep-agent-executor.ts`
- Modify: `tests/main/plugins/agent/deep-agent-executor.test.ts`

- [ ] **Step 1: Write red executor test for missing `workspacePath` and `description`**

In `tests/main/plugins/agent/deep-agent-executor.test.ts`, replace the existing `routes proposal tools to task preview and create capabilities` preview call with this shape:

```typescript
const previewOutput = await invokeTool(findTool(tools, 'propose_background_task'), {
  goal: '每天中午一点创建 docx 文件，里面写你好世界',
  trigger: {
    type: 'cron',
    cronExpression: '0 13 * * *',
    nextRunAt: '2026-06-17T05:00:00.000Z'
  }
});
```

Then add assertions after `scheduleOutput`:

```typescript
const previewCall = capabilityCalls.find((call) => call.name === 'task.background.preview');
expect(previewCall?.input).toMatchObject({
  goal: '每天中午一点创建 docx 文件，里面写你好世界',
  trigger: {
    type: 'cron',
    description: '每天 13:00 触发',
    cronExpression: '0 13 * * *',
    nextRunAt: '2026-06-17T05:00:00.000Z'
  },
  workspacePath
});
```

- [ ] **Step 2: Add test that model-supplied `/workspace/` is ignored**

Add this test after the proposal routing test:

```typescript
it('uses runtime workspace path instead of model-supplied workspacePath', async () => {
  const capabilityCalls: Array<{ name: string; input: unknown }> = [];
  await buildExecutorOnce(createCapabilities(capabilityCalls), {
    workflowHint: 'propose_background_task',
    taskSource: 'workbench'
  });

  const output = await invokeTool(findTool(readBuiltTools(), 'propose_background_task'), {
    goal: '每天中午一点创建 docx 文件，里面写你好世界',
    trigger: {
      type: 'cron',
      cronExpression: '0 13 * * *',
      nextRunAt: '2026-06-17T05:00:00.000Z'
    },
    workspacePath: '/workspace/'
  });

  const parsed = readJson(output) as { preview: BackgroundTaskPreview };
  expect(parsed.preview.workspacePath).toBe(workspacePath);
  expect(capabilityCalls.find((call) => call.name === 'task.background.preview')?.input).toMatchObject({
    workspacePath
  });
});
```

- [ ] **Step 3: Add test for missing selected workspace**

Update `createCapabilities` signature:

```typescript
function createCapabilities(
  calls: Array<{ name: string; input: unknown }>,
  options: { capabilityPreview?: boolean; workspace?: Workspace | null } = {}
): RocCapabilityRegistry {
```

Inside `workspace.getCurrent`, return `options.workspace` when present:

```typescript
if (name === 'workspace.getCurrent') {
  if ('workspace' in options) {
    return options.workspace as TOutput;
  }
  const workspace = {
    id: 'workspace-1',
    path: workspacePath,
    displayName: 'Roc',
    lastOpenedAt: '2026-06-04T00:00:00.000Z',
    trustState: 'trusted'
  } satisfies Workspace;
  return workspace as TOutput;
}
```

Add test:

```typescript
it('rejects background task propose when no workspace is selected', async () => {
  await buildExecutorOnce(createCapabilities([], { workspace: null }), {
    workflowHint: 'propose_background_task',
    taskSource: 'workbench'
  });

  await expect(
    invokeTool(findTool(readBuiltTools(), 'propose_background_task'), {
      goal: '每天中午一点创建 docx 文件，里面写你好世界',
      trigger: {
        type: 'cron',
        cronExpression: '0 13 * * *',
        nextRunAt: '2026-06-17T05:00:00.000Z'
      }
    })
  ).rejects.toThrow('创建后台任务需要先选择工作区');
});
```

- [ ] **Step 4: Run red executor test**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/deep-agent-executor.test.ts
```

Expected: FAIL before executor passes `runtimeWorkspacePath`.

- [ ] **Step 5: Pass runtime workspace into tool creation**

In `src/main/plugins/agent/deep-agent-executor.ts`, pass workspace path to `createExecutorTools`:

```typescript
const tools = await createExecutorTools({
  capabilities: options.capabilities,
  enabledCapabilities: input.request.enabledCapabilities,
  backgroundTaskToolMode: readBackgroundTaskToolMode(input.request),
  runtimeWorkspacePath: workspace === null ? null : workspace.path
});
```

Update `createExecutorTools` input type:

```typescript
async function createExecutorTools(input: {
  capabilities: RocCapabilityRegistry;
  enabledCapabilities: TaskRun['enabledCapabilities'];
  backgroundTaskToolMode: 'all' | 'change' | null;
  runtimeWorkspacePath: string | null;
}): Promise<{
```

Pass it into `createBackgroundTaskTools`:

```typescript
runTools.splice(2, 0, ...createBackgroundTaskTools({
  enabledCapabilities: input.enabledCapabilities,
  previewStore: new PreviewStore(),
  runtimeWorkspacePath: input.runtimeWorkspacePath,
  toolMode: input.backgroundTaskToolMode,
  taskAdapter: {
```

- [ ] **Step 6: Run executor tests**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/deep-agent-executor.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit executor wiring**

```powershell
git add src/main/plugins/agent/deep-agent-executor.ts tests/main/plugins/agent/deep-agent-executor.test.ts
git commit -m "fix: inject runtime workspace into task proposal tools"
```

---

### Task 4: Update Prompt And Shared Contract Documentation

**Files:**
- Modify: `src/shared/background-task-tool-contract.ts`
- Modify: `src/main/services/deep-agent/prompt.ts`
- Modify: `tests/shared/background-task-contract.test.ts`
- Modify: `tests/main/deep-agent-prompt.test.ts`

- [ ] **Step 1: Update shared contract constants**

In `src/shared/background-task-tool-contract.ts`, change model key constants:

```typescript
export const PROPOSE_MODEL_KEYS = ['goal', 'trigger'] as const;
```

Change `MINIMAL_BACKGROUND_TASK_PROPOSE_EXAMPLE`:

```typescript
export const MINIMAL_BACKGROUND_TASK_PROPOSE_EXAMPLE = {
  goal: '每天晚上 7:40 抓取 AI 最新新闻，并将结果写入当前工作目录下的 docx 文件',
  trigger: {
    type: 'cron',
    cronExpression: '40 19 * * *',
    nextRunAt: '2026-05-26T11:40:00.000Z'
  }
} as const;
```

Keep `BACKGROUND_TASK_PROPOSE_EXAMPLE` as the full runtime example by spelling it out:

```typescript
export const BACKGROUND_TASK_PROPOSE_EXAMPLE = {
  ...MINIMAL_BACKGROUND_TASK_PROPOSE_EXAMPLE,
  trigger: {
    ...MINIMAL_BACKGROUND_TASK_PROPOSE_EXAMPLE.trigger,
    description: '每天晚上 7:40 触发'
  },
  workspacePath: 'F:\\Code\\Roc',
  ...PROPOSE_RUNTIME_DEFAULTS
} as const satisfies Omit<BackgroundTaskPreviewRequest, 'failurePolicy' | 'enabledCapabilities'>;
```

Update `PROPOSE_TOOL_DESCRIPTION`:

```typescript
export const PROPOSE_TOOL_DESCRIPTION = [
  '为后台或定时任务生成 preview（草稿），但不实际创建。',
  '模型只填写 goal 和 trigger；workspacePath 由 runtime 注入。',
  '不要填写 allowedActions、forbiddenActions、notificationPolicy、enabledCapabilities 或 failurePolicy。',
  'trigger.type 只能是 manual、once 或 cron。',
  'trigger.description 可省略；runtime 会补齐展示说明。',
  'cron trigger 使用五段 cronExpression 和 UTC ISO nextRunAt。',
  '只有用户明确要求手动执行、按需执行或不设定时间时，才使用 manual。',
  '本工具返回 previewId 与 preview 内容；要实际创建任务，必须随后调用 schedule_background_task(previewId)。'
].join('\n');
```

- [ ] **Step 2: Update deprecated prompt builder without changing its compatibility role**

In `buildTaskProposalPrompt`, keep embedding `workspacePath` because the function is deprecated compatibility code, but add an explicit runtime line:

```typescript
'新 DeepAgents 创建流中 workspacePath 由 runtime 注入；本兼容 prompt 中的 workspacePath 只用于旧调用形状。',
```

Do not remove its JSON examples unless existing tests are adjusted for legacy behavior.

- [ ] **Step 3: Update workflow prompt**

In `src/main/services/deep-agent/prompt.ts`, add these lines to `BACKGROUND_TASK_CREATION_WORKFLOW_OVERVIEW` after the cron line:

```typescript
'propose_background_task 参数中不要填写 workspacePath；后台任务 workspacePath 由 runtime 注入当前 Windows 工作区路径。',
'Deep Agents 文件工具使用 /workspace/...；不要把 /workspace/ 当作后台任务 workspacePath。',
```

- [ ] **Step 4: Update shared contract tests**

In `tests/shared/background-task-contract.test.ts`, update `minimal canonical example only exposes model-authored keys`:

```typescript
expect(Object.keys(MINIMAL_BACKGROUND_TASK_PROPOSE_EXAMPLE).sort()).toEqual(['goal', 'trigger']);
expect(Object.keys(MINIMAL_BACKGROUND_TASK_PROPOSE_EXAMPLE.trigger).sort()).toEqual([
  'cronExpression',
  'nextRunAt',
  'type'
]);
```

Update `tool description uses canonical fields without forbidden aliases` expectations:

```typescript
expect(PROPOSE_TOOL_DESCRIPTION).toContain('模型只填写 goal 和 trigger；workspacePath 由 runtime 注入。');
expect(PROPOSE_TOOL_DESCRIPTION).toContain('trigger.description 可省略；runtime 会补齐展示说明。');
expect(PROPOSE_TOOL_DESCRIPTION).not.toContain('只填写 goal、trigger、workspacePath');
```

Update the inline snapshot for `MINIMAL_BACKGROUND_TASK_PROPOSE_EXAMPLE` key sets.

- [ ] **Step 5: Update prompt tests**

In `tests/main/deep-agent-prompt.test.ts`, update both background task creation workflow tests to expect:

```typescript
expect(prompt).toContain('propose_background_task 参数中不要填写 workspacePath；后台任务 workspacePath 由 runtime 注入当前 Windows 工作区路径。');
expect(prompt).toContain('Deep Agents 文件工具使用 /workspace/...；不要把 /workspace/ 当作后台任务 workspacePath。');
```

Also update `exports the canonical background task creation workflow overview` array to include the two new lines in the same order.

- [ ] **Step 6: Run contract and prompt tests**

Run:

```powershell
pnpm test -- tests/shared/background-task-contract.test.ts tests/main/deep-agent-prompt.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit prompt and contract updates**

```powershell
git add src/shared/background-task-tool-contract.ts src/main/services/deep-agent/prompt.ts tests/shared/background-task-contract.test.ts tests/main/deep-agent-prompt.test.ts
git commit -m "docs: clarify background task workspace ownership"
```

---

### Task 5: Final Verification And Type Safety

**Files:**
- Verify only unless failures identify required fixes.

- [ ] **Step 1: Run focused test suite**

Run:

```powershell
pnpm test -- tests/main/background-task-schema.test.ts tests/shared/background-task-contract.test.ts tests/main/deep-agent-prompt.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts tests/main/plugins/agent/runtime.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```powershell
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Run broader tests if focused suite touched shared contracts**

Run:

```powershell
pnpm test
```

Expected: PASS. If `node-pty` prints `Error: AttachConsole failed` after tests but process exits `0`, treat it as known non-fatal teardown noise.

- [ ] **Step 4: Inspect git diff**

Run:

```powershell
git status --short
git diff -- src/main/services/deep-agent/background-task-tools.ts src/main/plugins/agent/deep-agent-executor.ts src/shared/background-task-tool-contract.ts src/main/services/deep-agent/prompt.ts tests/_factories/background-task.ts tests/_matchers/contract.ts tests/main/background-task-schema.test.ts tests/shared/background-task-contract.test.ts tests/main/deep-agent-prompt.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts
```

Expected: only scoped changes for runtime normalization, prompt/contract updates, and tests.

- [ ] **Step 5: Commit final verification fixes if any**

If Step 1-3 required small fixes, commit them:

```powershell
git add src/main/services/deep-agent/background-task-tools.ts src/main/plugins/agent/deep-agent-executor.ts src/shared/background-task-tool-contract.ts src/main/services/deep-agent/prompt.ts tests/_factories/background-task.ts tests/_matchers/contract.ts tests/main/background-task-schema.test.ts tests/shared/background-task-contract.test.ts tests/main/deep-agent-prompt.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts
git commit -m "fix: complete background task proposal normalization"
```

If no files changed after verification, do not create an empty commit.

---

## Self-Review

- Spec coverage:
  - Runtime `workspacePath` injection: Task 2 and Task 3.
  - `trigger.description` derivation: Task 2 and Task 3.
  - Keep full business contract strict: Task 2 keeps `fullProposeInputSchema` and `proposeInputSchema`.
  - DeepAgents `/workspace/` versus Windows path boundary: Task 4 prompt/contract and Task 3 tests.
  - No deterministic workflow restoration: no task touches `task-proposal-workflow.ts`.
  - Verification: Task 5.
- Red-flag scan: no empty work items, no unexpanded error handling, no unspecified test commands.
- Type consistency:
  - `runtimeWorkspacePath` is added to `BackgroundTaskToolDependencies` and passed from executor.
  - `proposeToolInputSchema` is model-visible; `fullProposeInputSchema` preserves the full runtime shape.
  - Existing `proposeInputSchema` continues to back update/full request validation.
