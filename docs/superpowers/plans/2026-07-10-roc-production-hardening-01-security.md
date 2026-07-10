# Roc Security Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 阻止远端页面进入 Roc 主窗口，并让 BackgroundTask 与 HITL resume 输入在 main capability 边界经过真实、严格的 Zod 校验。

**Architecture:** main 使用一个 top-level navigation policy 同时处理 `window-open` 与 `will-navigate`，renderer 的 completed/streaming Markdown 复用同一受控 link component。BackgroundTask create 只接收 raw request 并在 main 重新推导 preview；DeepAgent preview store 同时保存 raw request 和展示 preview。HITL decisions 使用与 LangChain `HITLResponse` 一致的判别联合。

**Tech Stack:** Electron `webContents`、React Markdown、Streamdown、TypeScript、Zod、LangChain HITL、Vitest、jsdom、IPC schema generator。

## Global Constraints

- 所有 top-level navigation 都先阻止；仅绝对 `http:`/`https:` URL 可交给 `shell.openExternal()`。
- `file:`、`javascript:`、`data:`、`roc-preview:`、相对 URL 和无效 URL不得进入主窗口或 OS shell。
- renderer 只提交 `BackgroundTaskPreviewRequest`；`scheduled`、`nextRunAt`、`cronExpression`、`riskLevel`、`requiresConfirmation` 只在 main 产生。
- create/update 请求出现派生字段时 strict schema 必须拒绝，不静默 strip。
- 不引入 preview token、第二条外链 IPC、旧 create payload 兼容或双协议。
- 每项行为先写失败测试；本批只在最终 review 和验证后提交一次。

---

### Task 1: Unify top-level navigation policy and Markdown links

**Files:**
- Modify: `src/main/external-link-policy.ts:1-45`
- Modify: `src/main/index.ts:364-370`
- Create: `src/renderer/chat/markdown-link.tsx`
- Modify: `src/renderer/chat/markdown-view.tsx:1-20`
- Modify: `src/renderer/chat/streaming-markdown-view.tsx:1-28`
- Modify: `tests/main/external-link-policy.test.ts`
- Modify: `tests/main/kernel-main-integration.test.ts`
- Create: `tests/renderer/markdown-link.test.tsx`

**Interfaces:**
- Consumes: Electron `shell.openExternal(url)`, `WebContents.setWindowOpenHandler`, `WebContents.on('will-navigate')`, React Markdown/Streamdown component overrides.
- Produces: `handleExternalNavigation(url: string, input: ExternalNavigationPolicyInput): { action: 'deny' }` and `MarkdownLink(props: ComponentPropsWithoutRef<'a'>): React.JSX.Element`.

- [ ] **Step 1: Write failing main-policy tests**

Add cases that call one policy function for both event sources and assert the concrete side effect:

```ts
it.each(['https://example.com/docs', 'http://example.com/docs'])('opens allowlisted URL outside Roc: %s', (url) => {
  const shell = { openExternal: vi.fn() };
  const logService = { warn: vi.fn() };

  expect(handleExternalNavigation(url, { shell, logService })).toEqual({ action: 'deny' });
  expect(shell.openExternal).toHaveBeenCalledWith(url);
  expect(logService.warn).not.toHaveBeenCalled();
});

it.each(['file:///C:/secret.txt', 'javascript:alert(1)', 'data:text/html,owned', 'roc-preview://asset']) (
  'blocks unsupported top-level URL without exposing the query: %s',
  (url) => {
    const shell = { openExternal: vi.fn() };
    const logService = { warn: vi.fn() };

    expect(handleExternalNavigation(url, { shell, logService })).toEqual({ action: 'deny' });
    expect(shell.openExternal).not.toHaveBeenCalled();
    expect(logService.warn).toHaveBeenCalledWith(
      'Blocked top-level navigation with unsupported scheme.',
      expect.objectContaining({ metadata: { scheme: new URL(url).protocol } })
    );
  }
);
```

Add a source assertion to `tests/main/kernel-main-integration.test.ts` or the existing entrypoint source test:

```ts
expect(source).toContain("mainWindow.webContents.on('will-navigate'");
expect(source).toContain('event.preventDefault();');
expect(source).toContain('handleExternalNavigation(url');
```

- [ ] **Step 2: Run the main-policy tests and verify RED**

```powershell
pnpm test -- tests/main/external-link-policy.test.ts tests/main/kernel-main-integration.test.ts
```

Expected: FAIL because `handleExternalNavigation` and the `will-navigate` binding do not exist.

- [ ] **Step 3: Implement the single main policy and bind both Electron paths**

Replace the specialized function with:

```ts
export type ExternalNavigationPolicyInput = {
  shell: ShellLike;
  logService: Pick<LogService, 'warn'>;
};

const allowedExternalSchemes = new Set(['http:', 'https:']);

export function handleExternalNavigation(
  url: string,
  input: ExternalNavigationPolicyInput
): { action: 'deny' } {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    input.logService.warn('Blocked invalid top-level navigation.', {
      service: 'external-link-policy',
      component: 'handleExternalNavigation'
    });
    return { action: 'deny' };
  }
  if (!allowedExternalSchemes.has(parsedUrl.protocol)) {
    input.logService.warn('Blocked top-level navigation with unsupported scheme.', {
      service: 'external-link-policy',
      component: 'handleExternalNavigation',
      metadata: { scheme: parsedUrl.protocol }
    });
    return { action: 'deny' };
  }
  void input.shell.openExternal(parsedUrl.toString());
  return { action: 'deny' };
}
```

Bind it in `src/main/index.ts`:

```ts
const externalNavigationInput = {
  shell,
  logService: kernel.logService
};
mainWindow.webContents.setWindowOpenHandler(({ url }) =>
  handleExternalNavigation(url, externalNavigationInput)
);
mainWindow.webContents.on('will-navigate', (event, url) => {
  event.preventDefault();
  handleExternalNavigation(url, externalNavigationInput);
});
```

- [ ] **Step 4: Write failing renderer link tests**

Create jsdom tests that assert completed and streaming renderers share the same component and that only allowlisted absolute links call `window.open`:

```tsx
it('opens an HTTPS Markdown link through the Electron window-open boundary', async () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  await renderMarkdown(<MarkdownView text="[Docs](https://example.com/docs)" />);

  queryAnchor('Docs').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

  expect(open).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener,noreferrer');
});

it.each(['./relative', 'file:///C:/secret.txt', 'javascript:alert(1)'])(
  'keeps a blocked Markdown target readable but non-interactive: %s',
  async (href) => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await renderMarkdown(<MarkdownView text={`[Blocked](${href})`} />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('Blocked');
    expect(open).not.toHaveBeenCalled();
  }
);
```

Also assert source reuse:

```ts
expect(readFileSync('src/renderer/chat/markdown-view.tsx', 'utf8')).toContain('a: MarkdownLink');
expect(readFileSync('src/renderer/chat/streaming-markdown-view.tsx', 'utf8')).toContain('a: MarkdownLink');
```

- [ ] **Step 5: Run renderer tests and verify RED**

```powershell
pnpm test -- tests/renderer/markdown-link.test.tsx
```

Expected: FAIL because `MarkdownLink` is absent and anchors still use browser default navigation.

- [ ] **Step 6: Implement the shared controlled link**

Create `src/renderer/chat/markdown-link.tsx`:

```tsx
import type { ComponentPropsWithoutRef } from 'react';

export function MarkdownLink({ children, href }: ComponentPropsWithoutRef<'a'>): React.JSX.Element {
  if (href === undefined || !isAllowedExternalHref(href)) {
    return <span>{children}</span>;
  }
  return (
    <a
      href={href}
      rel="noreferrer noopener"
      onClick={(event) => {
        event.preventDefault();
        window.open(href, '_blank', 'noopener,noreferrer');
      }}
    >
      {children}
    </a>
  );
}

function isAllowedExternalHref(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
```

Use one component map in both renderers:

```tsx
const markdownComponents = { a: MarkdownLink, pre: CodeBlock };
```

- [ ] **Step 7: Run Task 1 tests and verify GREEN**

```powershell
pnpm test -- tests/main/external-link-policy.test.ts tests/main/kernel-main-integration.test.ts tests/renderer/markdown-link.test.tsx
```

Expected: PASS; invalid and unsupported URLs never call `openExternal` or `window.open`.

### Task 2: Replace BackgroundTask placeholder schemas and raw-create contract

**Files:**
- Create: `src/main/plugins/task/contracts.ts`
- Modify: `src/main/plugins/task/index.ts:1-170`
- Modify: `src/main/plugins/task/task-repository.ts:69-114`
- Modify: `src/shared/ipc.ts:135-151`
- Modify: `src/preload/index.ts:25-40`
- Modify: `src/main/services/forge-guardrails/preview-store.ts`
- Modify: `src/main/services/deep-agent/background-task-tools.ts:121-281`
- Modify: `src/main/plugins/agent/deep-agent-executor.ts:451-466`
- Modify: `tests/main/background-task-schema.test.ts`
- Modify: `tests/main/plugins/task/task-repository.test.ts`
- Modify: `tests/main/services/forge-guardrails/preview-store.test.ts`
- Modify: `tests/main/services/deep-agent/tool-protocol.test.ts`
- Verify: `tests/main/plugins/agent/deep-agent-executor.test.ts`
- Modify: `tests/main/plugins/agent/deep-agent-executor-test-helpers.ts`
- Modify: `tests/main/plugins/task/plugin.test.ts`
- Modify: `tests/main/plugins/task/plugin-background-management.test.ts`
- Modify: `tests/main/plugins/task/plugin-background-runs.test.ts`
- Modify: `tests/main/plugins/task/scheduler.test.ts`
- Modify: `tests/main/microkernel-regression.test.ts`
- Modify: `tests/smoke/lib/ipc.mjs`
- Modify: `tests/smoke/lib/electron-smoke-task-flow.mjs`

**Interfaces:**
- Consumes: types from `src/shared/types/task.ts` and `src/shared/types/agent.ts`.
- Produces: strict schemas `backgroundTaskPreviewRequestSchema`, `backgroundTaskPreviewSchema`, `backgroundTaskSchema`, `updateBackgroundTaskRequestSchema`; `TaskRepository.createBackgroundTask(request: BackgroundTaskPreviewRequest): BackgroundTask`; `StoredBackgroundTaskPreview = { request; preview }`.

- [ ] **Step 1: Write failing strict-schema and re-derivation tests**

In `tests/main/background-task-schema.test.ts`, invoke declared capabilities with invalid unknown payloads:

```ts
await expect(
  capabilities.invoke('task.background.create', {
    ...previewRequest,
    riskLevel: 'low',
    requiresConfirmation: false
  })
).rejects.toThrow(/task\.background\.create.*input/u);

await expect(
  capabilities.invoke('task.background.preview', {
    ...previewRequest,
    trigger: { type: 'cron', description: 'nightly', cronExpression: '* * * * *' }
  })
).rejects.toThrow(/task\.background\.preview.*input/u);
```

In the repository test, prove create ignores renderer-derived values because it accepts only raw request:

```ts
const task = repository.createBackgroundTask({
  ...manualPreviewRequest,
  allowedActions: [],
  forbiddenActions: ['delete files']
});

expect(task.riskLevel).toBe('high');
expect(task.requiresConfirmation).toBe(true);
```

In the preview-store test, assert both values survive one-time take:

```ts
store.put('preview_1', { request, preview });
expect(store.take('preview_1')).toEqual({ request, preview });
expect(store.take('preview_1')).toBeNull();
```

- [ ] **Step 2: Run Task 2 focused tests and verify RED**

```powershell
pnpm test -- tests/main/background-task-schema.test.ts tests/main/plugins/task/task-repository.test.ts tests/main/services/forge-guardrails/preview-store.test.ts
```

Expected: FAIL because `z.custom()` accepts forged payloads, repository create accepts a preview, and the store only retains the preview.

- [ ] **Step 3: Implement strict task schemas**

Create `src/main/plugins/task/contracts.ts` with strict objects and exact unions:

```ts
import { z } from 'zod';
import type {
  BackgroundTask,
  BackgroundTaskPreview,
  BackgroundTaskPreviewRequest,
  BackgroundTaskTrigger,
  EnabledCapabilities,
  UpdateBackgroundTaskRequest
} from '../../../shared/types';

export const enabledCapabilitiesSchema = z.object({
  mcpServers: z.array(z.string().trim().min(1)),
  skills: z.array(z.string().trim().min(1))
}).strict() satisfies z.ZodType<EnabledCapabilities>;

export const backgroundTaskTriggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual'), description: z.string().trim().min(1) }).strict(),
  z.object({
    type: z.literal('once'),
    description: z.string().trim().min(1),
    nextRunAt: z.string().datetime({ offset: true })
  }).strict(),
  z.object({
    type: z.literal('cron'),
    description: z.string().trim().min(1),
    cronExpression: z.string().trim().min(1),
    nextRunAt: z.string().datetime({ offset: true })
  }).strict()
]) satisfies z.ZodType<BackgroundTaskTrigger>;

export const backgroundTaskPreviewRequestSchema = z.object({
  goal: z.string().trim().min(1),
  trigger: backgroundTaskTriggerSchema,
  workspacePath: z.string().trim().min(1),
  allowedActions: z.array(z.string().trim().min(1)),
  forbiddenActions: z.array(z.string().trim().min(1)),
  failurePolicy: z.literal('pause_and_report'),
  notificationPolicy: z.literal('failures_and_confirmations'),
  enabledCapabilities: enabledCapabilitiesSchema.nullable().optional()
}).strict() satisfies z.ZodType<BackgroundTaskPreviewRequest>;

export const backgroundTaskPreviewSchema = backgroundTaskPreviewRequestSchema.extend({
  scheduled: z.boolean(),
  nextRunAt: z.string().datetime({ offset: true }).nullable(),
  cronExpression: z.string().nullable(),
  riskLevel: z.enum(['low', 'medium', 'high']),
  requiresConfirmation: z.boolean(),
  enabledCapabilities: enabledCapabilitiesSchema.nullable()
}).strict() satisfies z.ZodType<BackgroundTaskPreview>;

export const updateBackgroundTaskRequestSchema = z.object({
  taskId: z.string().trim().min(1),
  patch: backgroundTaskPreviewRequestSchema.partial().strict(),
  reason: z.string().trim().min(1)
}).strict() satisfies z.ZodType<UpdateBackgroundTaskRequest>;

export const backgroundTaskSchema = z.object({
  id: z.string().trim().min(1),
  threadId: z.string().trim().min(1),
  runId: z.string().trim().min(1),
  goal: z.string().trim().min(1),
  status: z.enum([
    'draft', 'pending_confirmation', 'running', 'paused', 'waiting_user',
    'waiting_next_turn', 'failed', 'cancelled', 'completed', 'archived'
  ]),
  scheduled: z.boolean(),
  triggerType: z.enum(['manual', 'once', 'cron']),
  triggerDescription: z.string().trim().min(1),
  nextRunAt: z.string().datetime({ offset: true }).nullable(),
  cronExpression: z.string().nullable(),
  workspacePath: z.string().trim().min(1),
  allowedActions: z.array(z.string().trim().min(1)),
  forbiddenActions: z.array(z.string().trim().min(1)),
  failurePolicy: z.literal('pause_and_report'),
  notificationPolicy: z.literal('failures_and_confirmations'),
  riskLevel: z.enum(['low', 'medium', 'high']),
  requiresConfirmation: z.boolean(),
  lastRunAt: z.string().datetime({ offset: true }).nullable(),
  lastRunStatus: z.enum(['success', 'failed', 'cancelled']).nullable(),
  runCount: z.number().int().min(0),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  enabledCapabilities: enabledCapabilitiesSchema.nullable()
}).strict() satisfies z.ZodType<BackgroundTask>;
```

Export all schemas and replace the matching `z.custom()` entries in `taskCapabilityDescriptors`.

- [ ] **Step 4: Change create to raw request and re-derive inside main**

Change the repository method:

```ts
createBackgroundTask(request: BackgroundTaskPreviewRequest): BackgroundTask {
  const preview = this.createBackgroundTaskPreview(request);
  const task = createBackgroundTaskRecord(this.db, preview);
  this.agentHistory.ensureBackgroundTaskThread(task);
  this.agentHistory.recordBackgroundTaskEvent(task, 'background_task_created', {
    taskId: task.id,
    status: task.status
  });
  return task;
}
```

Register the capability with raw input:

```ts
descriptor('task.background.create', backgroundTaskPreviewRequestSchema, backgroundTaskSchema)
```

And call it without an unsafe cast:

```ts
context.capabilities.register(pluginId, taskCapabilityDescriptors[2], async (input) => {
  const task = repository.createBackgroundTask(input);
  scheduler.registerTask(task);
  return task;
});
```

Change `RocPreloadApi.tasks.createBackgroundTask` to:

```ts
createBackgroundTask: (request: BackgroundTaskPreviewRequest) => Promise<IpcResult<BackgroundTask>>;
```

- [ ] **Step 5: Preserve raw DeepAgent requests through preview/schedule**

Change the store contract:

```ts
export type StoredBackgroundTaskPreview = {
  request: BackgroundTaskPreviewRequest;
  preview: BackgroundTaskPreview;
};

export class PreviewStore {
  private readonly entries = new Map<string, StoredBackgroundTaskPreview>();
  put(previewId: string, entry: StoredBackgroundTaskPreview): void {
    this.entries.set(previewId, entry);
  }
  take(previewId: string): StoredBackgroundTaskPreview | null {
    const value = this.entries.get(previewId);
    if (value === undefined) {
      return null;
    }
    this.entries.delete(previewId);
    return value;
  }
}
```

Change the tool adapter and flow:

```ts
type BackgroundTaskToolTaskAdapter = {
  createBackgroundTask(request: BackgroundTaskPreviewRequest): Awaitable<{
    id: string;
    threadId: string;
    nextRunAt: string | null;
    status?: string;
  }>;
  createBackgroundTaskPreview(request: BackgroundTaskPreviewRequest): Awaitable<BackgroundTaskPreview>;
};

const request = normalizePreviewRequest(input, rawInput);
const preview = await input.taskAdapter.createBackgroundTaskPreview(request);
const previewId = input.previewStore.generatePreviewId();
input.previewStore.put(previewId, { request, preview });

const stored = input.previewStore.take(previewId);
if (stored === null) {
  throw new RocToolResolutionError(`Unknown previewId ${previewId}. 请先调用 propose_background_task 生成新的 preview。`, {
    toolName: 'schedule_background_task'
  });
}
const task = await input.taskAdapter.createBackgroundTask(stored.request);
```

Update `deep-agent-executor.ts` to invoke:

```ts
await input.capabilities.invoke<BackgroundTaskPreviewRequest, BackgroundTask>(
  'task.background.create',
  request
);
```

- [ ] **Step 6: Update all direct callers and smoke fixtures atomically**

For tests and smoke flows that currently call create with a preview, retain the preview assertion but call create with the original request:

```ts
const request = createBackgroundTaskPreviewRequest();
const preview = await unwrap(await window.roc.tasks.createBackgroundTaskPreview(request), 'background task preview');
assertDerivedPreview(preview);
const task = await unwrap(await window.roc.tasks.createBackgroundTask(request), 'background task create');
```

Update microkernel, task plugin, DeepAgent executor helper, tool protocol, preload mocks and type tests to the same signature. Do not accept both preview and request.

- [ ] **Step 7: Run Task 2 focused tests and verify GREEN**

```powershell
pnpm test -- tests/main/background-task-schema.test.ts tests/main/plugins/task/task-repository.test.ts tests/main/plugins/task/plugin.test.ts tests/main/plugins/task/plugin-background-management.test.ts tests/main/plugins/task/plugin-background-runs.test.ts tests/main/services/forge-guardrails/preview-store.test.ts tests/main/services/deep-agent/tool-protocol.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts tests/main/microkernel-regression.test.ts
```

Expected: PASS; forged derived fields are rejected before handler execution and create re-derives risk from raw input.

### Task 3: Validate HITL decisions as a discriminated union

**Files:**
- Modify: `src/main/plugins/agent/index.ts:44-105`
- Modify: `tests/main/plugins/agent/plugin.test.ts`
- Verify: `tests/main/ipc-plugin-adapter.test.ts`

**Interfaces:**
- Consumes: LangChain `ChatResumeDecision = HITLResponse['decisions'][number]`.
- Produces: `chatResumeDecisionSchema` for approve, reject and edit decisions.

- [ ] **Step 1: Write failing invalid-decision tests**

```ts
await expect(
  capabilities.invoke('agent.run.resume', {
    kind: 'approval',
    runId: 'run-1',
    threadId: 'thread-1',
    interruptId: 'interrupt-1',
    decisions: [{ type: 'edit' }]
  })
).rejects.toThrow(/agent\.run\.resume.*input/u);

await expect(
  capabilities.invoke('agent.run.resume', {
    kind: 'approval',
    runId: 'run-1',
    threadId: 'thread-1',
    interruptId: 'interrupt-1',
    decisions: [{ type: 'approve', message: 'forged' }]
  })
).rejects.toThrow(/agent\.run\.resume.*input/u);
```

Add valid approve/reject/edit cases and assert the runtime receives the exact decisions unchanged.

- [ ] **Step 2: Run agent plugin tests and verify RED**

```powershell
pnpm test -- tests/main/plugins/agent/plugin.test.ts tests/main/ipc-plugin-adapter.test.ts
```

Expected: FAIL because `z.custom<ChatResumeDecision>()` accepts malformed decisions.

- [ ] **Step 3: Implement the decision schema**

```ts
const hitlActionSchema = z.object({
  name: z.string().trim().min(1),
  args: z.record(z.string(), z.unknown())
}).strict();

const chatResumeDecisionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('approve') }).strict(),
  z.object({
    type: z.literal('reject'),
    message: z.string().trim().min(1).optional()
  }).strict(),
  z.object({
    type: z.literal('edit'),
    editedAction: hitlActionSchema
  }).strict()
]) satisfies z.ZodType<ChatResumeDecision>;

const approvalResumeRunRequestSchema = z.object({
  kind: z.literal('approval'),
  runId: z.string().trim().min(1),
  threadId: z.string().trim().min(1),
  interruptId: z.string().trim().min(1),
  decisions: z.array(chatResumeDecisionSchema).min(1)
}).strict();
```

Make the question variant and outer request strict as well; keep the existing runtime contract and do not add decision aliases.

- [ ] **Step 4: Run Task 3 tests and verify GREEN**

```powershell
pnpm test -- tests/main/plugins/agent/plugin.test.ts tests/main/ipc-plugin-adapter.test.ts tests/renderer/task-approval-card.test.tsx
```

Expected: PASS; edit requires `editedAction`, approve rejects extra fields, reject accepts only optional non-empty `message`.

### Task 4: Generate IPC, review, verify, and commit the security batch

**Files:**
- Verify generated: `src/shared/ipc-schema.json`
- Verify generated: `src/shared/ipc-generated.ts`
- Review: every file changed by Tasks 1-3

**Interfaces:**
- Consumes: final Task create and HITL schemas.
- Produces: synchronized preload/main/renderer IPC schema and one reviewed commit.

- [ ] **Step 1: Regenerate and check IPC artifacts**

```powershell
pnpm generate:ipc
pnpm check:ipc
```

Expected: both exit code `0`; channel artifacts remain current. The typed create request is enforced by `src/shared/ipc.ts`, preload compilation, and main capability tests because the generator does not encode method payload types.

- [ ] **Step 2: Run the complete security focused suite**

```powershell
pnpm test -- tests/main/external-link-policy.test.ts tests/main/background-task-schema.test.ts tests/main/plugins/agent/plugin.test.ts tests/main/plugins/task/plugin.test.ts tests/main/plugins/task/plugin-background-management.test.ts tests/main/plugins/task/plugin-background-runs.test.ts tests/main/plugins/task/task-repository.test.ts tests/main/services/forge-guardrails/preview-store.test.ts tests/main/services/deep-agent/tool-protocol.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts tests/main/microkernel-regression.test.ts tests/main/ipc-plugin-adapter.test.ts tests/main/ipc-schema-generation.test.ts tests/renderer/markdown-link.test.tsx tests/renderer/task-approval-card.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Review the current diff before committing**

```powershell
git diff -- src/main src/preload src/renderer src/shared tests scripts
```

Review in this order:

1. Critical: any top-level URL can still navigate the main window or leak query data into logs.
2. High: any create path still accepts `BackgroundTaskPreview`, any derived field can reach persistence, or any HITL element remains `z.custom()`.
3. High: DeepAgent schedule loses the raw request, preview becomes reusable, or scheduler registers before create succeeds.
4. Medium: generated IPC, smoke fixtures, preload mocks or type tests still use the old signature.

Record findings with file and line. Fix every finding and rerun the directly affected test before continuing. If none exist, record `未发现问题` and note that external OS handling remains platform-owned after `shell.openExternal()`.

- [ ] **Step 4: Run final batch verification**

```powershell
pnpm typecheck
pnpm check:ipc
pnpm test -- tests/main/external-link-policy.test.ts tests/main/background-task-schema.test.ts tests/main/plugins/agent/plugin.test.ts tests/main/plugins/task/plugin.test.ts tests/main/plugins/task/plugin-background-management.test.ts tests/main/plugins/task/plugin-background-runs.test.ts tests/main/plugins/task/task-repository.test.ts tests/main/services/forge-guardrails/preview-store.test.ts tests/main/services/deep-agent/tool-protocol.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts tests/main/microkernel-regression.test.ts tests/main/ipc-plugin-adapter.test.ts tests/main/ipc-schema-generation.test.ts tests/renderer/markdown-link.test.tsx tests/renderer/task-approval-card.test.tsx
git diff --check
```

Expected: every command exit code `0`.

- [ ] **Step 5: Commit only the reviewed security batch**

```powershell
$batchFiles = @(
  'docs/superpowers/plans/2026-07-10-roc-production-hardening-01-security.md'
  'src/main/external-link-policy.ts'
  'src/main/index.ts'
  'src/main/plugins/task/contracts.ts'
  'src/main/plugins/task/index.ts'
  'src/main/plugins/task/task-repository.ts'
  'src/main/plugins/agent/index.ts'
  'src/main/plugins/agent/deep-agent-executor.ts'
  'src/main/services/forge-guardrails/preview-store.ts'
  'src/main/services/deep-agent/background-task-tools.ts'
  'src/preload/index.ts'
  'src/renderer/chat/markdown-link.tsx'
  'src/renderer/chat/markdown-view.tsx'
  'src/renderer/chat/streaming-markdown-view.tsx'
  'src/shared/ipc.ts'
  'tests/main/background-task-schema.test.ts'
  'tests/main/external-link-policy.test.ts'
  'tests/main/kernel-main-integration.test.ts'
  'tests/main/microkernel-regression.test.ts'
  'tests/main/plugins/agent/deep-agent-executor-test-helpers.ts'
  'tests/main/plugins/agent/plugin.test.ts'
  'tests/main/plugins/task/plugin.test.ts'
  'tests/main/plugins/task/plugin-background-management.test.ts'
  'tests/main/plugins/task/plugin-background-runs.test.ts'
  'tests/main/plugins/task/scheduler.test.ts'
  'tests/main/plugins/task/task-repository.test.ts'
  'tests/main/services/deep-agent/tool-protocol.test.ts'
  'tests/main/services/forge-guardrails/preview-store.test.ts'
  'tests/renderer/markdown-link.test.tsx'
  'tests/smoke/lib/ipc.mjs'
  'tests/smoke/lib/electron-smoke-task-flow.mjs'
)
git add -- $batchFiles
git diff --cached --check
git commit -m "fix: harden renderer security boundaries"
```

Expected: commit succeeds and `git status --short` contains no security-batch leftovers.
