# Chat And Plan Human In The Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add approval and natural-language question HITL to chat and plan runs, with same-run resume through DeepAgents/LangGraph checkpoints.

**Architecture:** Model interrupts as a shared discriminated union: `approval` for DeepAgents tool approval and `question` for Roc-owned `ask_user`. Runtime stores original run mode and context on interruption, then resumes with `Command({ resume })` without changing mode. Renderer shows approval cards or question cards from the same interrupt stream; question answers use the normal composer but call `chat.resumeRun` instead of starting a new run.

**Tech Stack:** TypeScript ESM, Electron IPC, React 19, DeepAgents, LangGraph `interrupt()` / `Command`, Vitest.

## Global Constraints

- Scope includes tool approval HITL and agent主动澄清 HITL.
- Chat and plan both support question interrupts.
- User answers question interrupts through the bottom chat composer.
- Use a real interrupt/resume contract; do not model natural-language questions as approve/reject/edit.
- Plan mode must still exclude `run_shell_command`, `delete_file`, and background-task mutation tools.
- The implementation must preserve original `mode`, `workflowHint`, `taskSource`, `workspacePath`, and `explicitSkillIds` across resume.
- Resume kind mismatch, thread mismatch, and interrupt mismatch must fail clearly.
- Use existing style: 2 spaces, semicolons, single quotes.

---

## File Structure

- Modify `src/shared/types/chat.ts`: define interrupt payload union, pending interrupt union, and resume request union.
- Modify `src/shared/types/task.ts`: add task event names for question request and answer.
- Modify `src/main/plugins/agent/index.ts`: validate approval and question resume requests.
- Modify `src/main/plugins/agent/runtime-types.ts`: store original mode and interrupt payload in `PendingInterrupt`.
- Modify `src/main/plugins/agent/deep-agent-final-output.ts`: normalize DeepAgents approval interrupts and Roc question interrupts.
- Modify `src/main/plugins/agent/runtime.ts`: preserve mode on resume, enforce kind matching, record question answers, and publish question task events.
- Create `src/main/services/deep-agent/ask-user-tool.ts`: Roc-owned `ask_user` tool that calls LangGraph `interrupt()`.
- Modify `src/main/plugins/agent/deep-agent-executor.ts`: include `ask_user` in chat and plan tool surfaces.
- Modify `src/main/services/deep-agent/context/prompt-blocks.ts`: tell agent when to use `ask_user`.
- Modify `src/renderer/chat-run-state.ts`: store pending interrupts instead of approval-only state.
- Modify `src/renderer/chat-transcript.ts`: render live and persisted question interrupts.
- Create `src/renderer/chat/QuestionInterruptCard.tsx`: display question payload.
- Modify `src/renderer/chat/chat-message-row.tsx`: render approval or question card by interrupt kind.
- Modify `src/renderer/chat/chat-view.tsx`: route composer submissions to `resumeRun` when waiting on a question.
- Modify `src/renderer/views/tasks/TaskApprovalCard.tsx`: accept approval-only interrupt shape after shared type change.
- Test files:
  - `tests/main/plugins/agent/runtime-approval.test.ts`
  - `tests/main/plugins/agent/deep-agent-executor.test.ts`
  - `tests/main/plugins/agent/deep-agent-executor-tools.test.ts`
  - `tests/main/plugins/agent/runtime-executor.test.ts`
  - `tests/renderer/chat-run-state.test.ts`
  - `tests/renderer/chat-transcript.test.ts`
  - `tests/renderer/chat-message-row.test.ts`
  - `tests/renderer/chat-view.test.ts`

---

### Task 1: Shared Interrupt Contract

**Files:**
- Modify: `src/shared/types/chat.ts`
- Modify: `src/shared/types/task.ts`
- Modify: `src/main/plugins/agent/index.ts`
- Test: `tests/main/plugins/agent/runtime-approval.test.ts`
- Test: `tests/renderer/chat-run-state.test.ts`

**Interfaces:**
- Produces: `ChatInterruptPayload`
- Produces: `ChatPendingInterrupt`
- Produces: `ChatResumeRunRequest` union with `kind: 'approval' | 'question'`
- Produces: task event types `human_question_requested` and `human_question_answered`

- [ ] **Step 1: Write failing shared contract tests**

In `tests/renderer/chat-run-state.test.ts`, add a question interrupt case:

```typescript
it('stores question interrupts as waiting user state', () => {
  let state = applyChatRunEvent(createEmptyChatRunState(), {
    type: 'run_started',
    runId: 'run-question',
    mode: 'plan',
    threadId: 'thread-question',
    providerId: 'openai',
    modelId: 'gpt-test',
    createdAt: '2026-06-25T00:00:00.000Z'
  });

  state = applyChatRunEvent(state, {
    type: 'run_interrupted',
    runId: 'run-question',
    threadId: 'thread-question',
    interruptId: 'interrupt-question',
    payload: {
      kind: 'question',
      question: 'Which workspace should I use?',
      context: 'Two workspaces are available.',
      suggestedResponses: ['F:\\Code\\Roc', 'G:\\问数']
    }
  });

  expect(state.status).toBe('waiting_user');
  expect(state.pendingInterrupts).toEqual([
    {
      kind: 'question',
      interruptId: 'interrupt-question',
      question: 'Which workspace should I use?',
      context: 'Two workspaces are available.',
      suggestedResponses: ['F:\\Code\\Roc', 'G:\\问数']
    }
  ]);
});
```

In `tests/main/plugins/agent/runtime-approval.test.ts`, update the existing resume call in the approval test to include `kind: 'approval'`:

```typescript
const resumed = await runtime.resumeRun({
  kind: 'approval',
  runId: start.runId,
  threadId: start.threadId!,
  interruptId,
  decisions: [{ type: 'approve' }]
});

expect(resumed.runId).toBe(start.runId);
```

- [ ] **Step 2: Run failing tests**

Run:

```powershell
pnpm test -- tests/renderer/chat-run-state.test.ts tests/main/plugins/agent/runtime-approval.test.ts
```

Expected: FAIL because `pendingInterrupts`, `ChatInterruptPayload.kind`, and resume `kind` do not exist.

- [ ] **Step 3: Add shared chat types**

In `src/shared/types/chat.ts`, replace approval-only aliases with:

```typescript
export type ChatApprovalInterruptPayload = {
  kind: 'approval';
  request: HITLRequest;
};

export type ChatQuestionInterruptPayload = {
  kind: 'question';
  question: string;
  context?: string;
  suggestedResponses?: string[];
};

export type ChatInterruptPayload = ChatApprovalInterruptPayload | ChatQuestionInterruptPayload;

export type ChatPendingApproval = HITLRequest & {
  kind: 'approval';
  interruptId: string;
};

export type ChatPendingQuestion = ChatQuestionInterruptPayload & {
  interruptId: string;
};

export type ChatPendingInterrupt = ChatPendingApproval | ChatPendingQuestion;

export type ChatResumeDecision = HITLResponse['decisions'][number];

export type ChatResumeRunRequest =
  | {
      kind: 'approval';
      runId: string;
      threadId: string;
      interruptId: string;
      decisions: ChatResumeDecision[];
    }
  | {
      kind: 'question';
      runId: string;
      threadId: string;
      interruptId: string;
      answer: string;
    };
```

Update `ChatRunEvent.run_interrupted.payload`:

```typescript
payload: ChatInterruptPayload;
```

- [ ] **Step 4: Add task event names**

In `src/shared/types/task.ts`, add two event type literals next to `approval_requested` and `approval_decision`:

```typescript
    | 'approval_requested'
    | 'approval_decision'
    | 'human_question_requested'
    | 'human_question_answered'
```

- [ ] **Step 5: Add IPC resume validation schema**

In `src/main/plugins/agent/index.ts`, replace the current resume schema with:

```typescript
const approvalResumeRunRequestSchema = z.object({
  kind: z.literal('approval'),
  runId: z.string().trim().min(1),
  threadId: z.string().trim().min(1),
  interruptId: z.string().trim().min(1),
  decisions: z.array(z.custom<ChatResumeDecision>())
});

const questionResumeRunRequestSchema = z.object({
  kind: z.literal('question'),
  runId: z.string().trim().min(1),
  threadId: z.string().trim().min(1),
  interruptId: z.string().trim().min(1),
  answer: z.string().trim().min(1)
});

const resumeRunRequestSchema = z.discriminatedUnion('kind', [
  approvalResumeRunRequestSchema,
  questionResumeRunRequestSchema
]) satisfies z.ZodType<ChatResumeRunRequest>;
```

Keep the existing capability registration, but ensure it parses through the schema before calling runtime:

```typescript
context.capabilities.register(pluginId, baseAgentCapabilityDescriptors[4], async (input) =>
  runtime.resumeRun(resumeRunRequestSchema.parse(input))
);
```

- [ ] **Step 6: Update renderer state type only enough for compile**

In `src/renderer/chat-run-state.ts`, change imports and state field:

```typescript
import type {
  ChatAssistantBlock,
  ChatPendingInterrupt,
  ChatRunEvent,
  ChatRunMode,
  ChatTodoItem,
  RocHookRunSummary,
  SubagentEventPayload,
  SubagentIdentity,
  SubagentStatus
} from '../shared/types';
```

Change state:

```typescript
pendingInterrupts: ChatPendingInterrupt[];
```

Initialize and reset with:

```typescript
pendingInterrupts: [],
```

For `run_interrupted`, use:

```typescript
pendingInterrupts:
  event.payload.kind === 'approval'
    ? [
        {
          kind: 'approval',
          interruptId: event.interruptId,
          ...event.payload.request
        }
      ]
    : [
        {
          interruptId: event.interruptId,
          ...event.payload
        }
      ],
```

For `run_resumed`, filter:

```typescript
pendingInterrupts: state.pendingInterrupts.filter((interrupt) => interrupt.interruptId !== event.interruptId),
```

- [ ] **Step 7: Run focused tests**

Run:

```powershell
pnpm test -- tests/renderer/chat-run-state.test.ts tests/main/plugins/agent/runtime-approval.test.ts
```

Expected: PASS after updating existing expectations from `pendingApprovals` to `pendingInterrupts`.

- [ ] **Step 8: Commit**

```powershell
git add src/shared/types/chat.ts src/shared/types/task.ts src/main/plugins/agent/index.ts src/renderer/chat-run-state.ts tests/renderer/chat-run-state.test.ts tests/main/plugins/agent/runtime-approval.test.ts
git commit -m "feat: add chat interrupt contract"
```

---

### Task 2: Runtime Interrupt Normalization And Resume Context

**Files:**
- Modify: `src/main/plugins/agent/runtime-types.ts`
- Modify: `src/main/plugins/agent/deep-agent-final-output.ts`
- Modify: `src/main/plugins/agent/runtime.ts`
- Test: `tests/main/plugins/agent/runtime-approval.test.ts`
- Test: `tests/main/plugins/agent/runtime-executor.test.ts`

**Interfaces:**
- Consumes: `ChatInterruptPayload`
- Consumes: `ChatResumeRunRequest`
- Produces: pending interrupt context with `mode`
- Produces: question resume payload `{ answer: string }`

- [ ] **Step 1: Write failing resume mode tests**

In `tests/main/plugins/agent/runtime-approval.test.ts`, add plan-mode approval resume coverage:

```typescript
it('resumes plan approval interrupts with the original plan mode', async () => {
  const executedModes: Array<ChatStartRunRequest['mode']> = [];
  const runtime = createRuntimeWithExecutor({
    async *execute(input) {
      executedModes.push(input.request.mode);
      if (input.resumePayload === undefined) {
        yield {
          type: 'run_interrupted',
          runId: input.run.id,
          threadId: input.run.threadId,
          interruptId: 'interrupt-plan-approval',
          payload: {
            kind: 'approval',
            request: approvalPayload()
          }
        };
        return;
      }
      yield completedText(input.run.id, 'done');
    }
  });

  const start = await runtime.startRun({
    input: 'Plan risky work',
    mode: 'plan',
    enabledCapabilities: { mcpServers: [], skills: [] },
    threadId: null
  });
  await flushRunQueue();
  await runtime.resumeRun({
    kind: 'approval',
    runId: start.runId,
    threadId: start.threadId!,
    interruptId: 'interrupt-plan-approval',
    decisions: [{ type: 'approve' }]
  });
  await flushRunQueue();

  expect(executedModes).toEqual(['plan', 'plan']);
});
```

In the same file, add kind mismatch coverage:

```typescript
await expect(
  runtime.resumeRun({
    kind: 'question',
    runId: start.runId,
    threadId: start.threadId!,
    interruptId: 'interrupt-plan-approval',
    answer: 'Use Roc.'
  })
).rejects.toThrow('chat_resume_interrupt_kind_mismatch');
```

- [ ] **Step 2: Write failing question resume test**

In `tests/main/plugins/agent/runtime-executor.test.ts`, add:

```typescript
it('resumes question interrupts with answer payload and preserves run context', async () => {
  const requests: ChatStartRunRequest[] = [];
  const resumePayloads: unknown[] = [];
  const runtime = createRuntimeWithExecutor({
    async *execute(input) {
      requests.push(input.request);
      resumePayloads.push(input.resumePayload);
      if (input.resumePayload === undefined) {
        yield {
          type: 'run_interrupted',
          runId: input.run.id,
          threadId: input.run.threadId,
          interruptId: 'interrupt-question',
          payload: {
            kind: 'question',
            question: 'Which path should I inspect?',
            context: 'Two paths match.'
          }
        };
        return;
      }
      yield completedText(input.run.id, 'continued');
    }
  });

  const start = await runtime.startRun({
    input: 'Investigate',
    mode: 'plan',
    enabledCapabilities: { mcpServers: [], skills: ['typescript'] },
    threadId: null,
    workflowHint: null,
    taskSource: null,
    workspacePath: 'F:\\Code\\Roc',
    explicitSkillIds: ['typescript']
  });
  await flushRunQueue();

  await runtime.resumeRun({
    kind: 'question',
    runId: start.runId,
    threadId: start.threadId!,
    interruptId: 'interrupt-question',
    answer: 'Use F:\\Code\\Roc.'
  });
  await flushRunQueue();

  expect(requests.map((request) => request.mode)).toEqual(['plan', 'plan']);
  expect(requests[1]).toMatchObject({
    workflowHint: null,
    taskSource: null,
    workspacePath: 'F:\\Code\\Roc',
    explicitSkillIds: ['typescript']
  });
  expect(resumePayloads[1]).toEqual({ answer: 'Use F:\\Code\\Roc.' });
});
```

- [ ] **Step 3: Run failing main runtime tests**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/runtime-approval.test.ts tests/main/plugins/agent/runtime-executor.test.ts
```

Expected: FAIL because `PendingInterrupt` lacks mode, `resumeRun()` hardcodes task, and question resume is unsupported.

- [ ] **Step 4: Store mode and payload on pending interrupt**

In `src/main/plugins/agent/runtime-types.ts`, change `PendingInterrupt`:

```typescript
export type PendingInterrupt = {
  interruptId: string;
  payload: ChatInterruptPayload;
  mode: ChatStartRunRequest['mode'];
  taskSource: ChatStartRunRequest['taskSource'] | null;
  workflowHint: ChatStartRunRequest['workflowHint'] | null;
  workspacePath: ChatStartRunRequest['workspacePath'];
  explicitSkillIds: ChatStartRunRequest['explicitSkillIds'];
};
```

- [ ] **Step 5: Normalize interrupt payloads**

In `src/main/plugins/agent/deep-agent-final-output.ts`, add helpers:

```typescript
function normalizeInterruptPayload(payload: unknown): ChatInterruptPayload {
  if (isQuestionInterruptPayload(payload)) {
    return payload;
  }
  if (isApprovalRequest(payload)) {
    return {
      kind: 'approval',
      request: payload
    };
  }
  throw new Error('agent_interrupt_payload_invalid');
}

function isQuestionInterruptPayload(value: unknown): value is ChatQuestionInterruptPayload {
  if (!recordUtils.isRecord(value)) {
    return false;
  }
  if (recordUtils.readRecordValue(value, 'kind') !== 'question') {
    return false;
  }
  return typeof recordUtils.readRecordValue(value, 'question') === 'string';
}

function isApprovalRequest(value: unknown): value is HITLRequest {
  if (!recordUtils.isRecord(value)) {
    return false;
  }
  return Array.isArray(recordUtils.readRecordValue(value, 'actionRequests')) && Array.isArray(recordUtils.readRecordValue(value, 'reviewConfigs'));
}
```

Update `readRunInterruptedEvent()`:

```typescript
const payload = Reflect.get(firstInterrupt, 'payload');
if (typeof interruptId !== 'string') {
  throw new Error('agent_interrupt_payload_invalid');
}
return {
  type: 'run_interrupted',
  runId,
  threadId,
  interruptId,
  payload: normalizeInterruptPayload(payload)
};
```

Import the needed types from `../../../shared/types`.

- [ ] **Step 6: Preserve mode and enforce resume kind**

In `src/main/plugins/agent/runtime.ts`, pass mode into `handleRunInterrupted()`:

```typescript
mode: input.request.mode,
```

Update `handleRunInterrupted()` input and pending set:

```typescript
payload: ChatInterruptPayload;
mode: ChatStartRunRequest['mode'];
```

```typescript
this.pendingInterrupts.set(input.runId, {
  interruptId: input.interruptId,
  payload: input.payload,
  mode: input.mode,
  taskSource: input.taskSource,
  workflowHint: input.workflowHint,
  workspacePath: input.workspacePath,
  explicitSkillIds: input.explicitSkillIds
});
```

At the start of `resumeRun()`, after interrupt ID checks:

```typescript
if (request.kind !== pendingInterrupt.payload.kind) {
  throw new Error('chat_resume_interrupt_kind_mismatch');
}
```

Build resumed request with original mode:

```typescript
const resumedRequest: ChatStartRunRequest = {
  input: run.userInput,
  mode: pendingInterrupt.mode,
  threadId: run.threadId,
  enabledCapabilities: run.enabledCapabilities,
  taskSource: pendingInterrupt.taskSource,
  workspacePath: pendingInterrupt.workspacePath,
  workflowHint: pendingInterrupt.workflowHint
};
```

Call `executeRun()` with:

```typescript
mode: pendingInterrupt.mode,
```

Build resume payload:

```typescript
const resumePayload =
  request.kind === 'approval'
    ? { decisions: request.decisions }
    : { answer: request.answer };
```

Pass:

```typescript
resumePayload,
```

- [ ] **Step 7: Publish question task events and record answer**

In `handleRunInterrupted()`, branch event publication:

```typescript
if (input.payload.kind === 'approval') {
  await this.publish('agent.run.task-event', {
    runId: input.runId,
    threadId: input.threadId,
    type: 'approval_requested',
    payload: {
      interruptId: input.interruptId,
      ...input.payload.request
    }
  });
  return;
}

await this.publish('agent.run.task-event', {
  runId: input.runId,
  threadId: input.threadId,
  type: 'human_question_requested',
  payload: {
    interruptId: input.interruptId,
    question: input.payload.question,
    context: input.payload.context ?? null,
    suggestedResponses: input.payload.suggestedResponses ?? []
  }
});
```

In `resumeRun()`, before `executeRun()`, record question answers:

```typescript
if (request.kind === 'question') {
  this.options.repository.recordEvent({
    runId: run.id,
    threadId: run.threadId,
    type: 'message',
    payload: {
      role: 'user',
      content: request.answer
    }
  });
  this.options.repository.recordSessionMessage({
    threadId: run.threadId,
    role: 'user',
    content: request.answer
  });
  await this.publish('agent.run.task-event', {
    runId: run.id,
    threadId: run.threadId,
    type: 'human_question_answered',
    payload: {
      interruptId: request.interruptId,
      answer: request.answer
    }
  });
}
```

Keep existing `approval_decision` publication only for `request.kind === 'approval'`.

- [ ] **Step 8: Run focused runtime tests**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/runtime-approval.test.ts tests/main/plugins/agent/runtime-executor.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```powershell
git add src/main/plugins/agent/runtime-types.ts src/main/plugins/agent/deep-agent-final-output.ts src/main/plugins/agent/runtime.ts tests/main/plugins/agent/runtime-approval.test.ts tests/main/plugins/agent/runtime-executor.test.ts
git commit -m "feat: preserve interrupt resume context"
```

---

### Task 3: Ask User Tool

**Files:**
- Create: `src/main/services/deep-agent/ask-user-tool.ts`
- Modify: `src/main/plugins/agent/deep-agent-executor.ts`
- Modify: `src/main/services/deep-agent/context/prompt-blocks.ts`
- Test: `tests/main/plugins/agent/deep-agent-executor-tools.test.ts`
- Test: `tests/main/plugins/agent/deep-agent-executor.test.ts`

**Interfaces:**
- Produces: `createAskUserTool(): DynamicStructuredTool`
- Produces: `ask_user` tool available in chat and plan
- Produces: tool result string equal to resumed `{ answer }`

- [ ] **Step 1: Write failing tool surface tests**

In `tests/main/plugins/agent/deep-agent-executor-tools.test.ts`, add:

```typescript
it('exposes ask_user in chat and plan tool surfaces', async () => {
  await runExecutor({ mode: 'chat' });
  expect(readBuiltTools().map((tool) => tool.name)).toContain('ask_user');

  resetBuiltAgent();
  await runExecutor({ mode: 'plan' });
  expect(readBuiltTools().map((tool) => tool.name)).toContain('ask_user');
  expect(readBuiltTools().map((tool) => tool.name)).not.toContain('run_shell_command');
  expect(readBuiltTools().map((tool) => tool.name)).not.toContain('delete_file');
});
```

In `tests/main/plugins/agent/deep-agent-executor.test.ts`, add a unit test for the tool by mocking `@langchain/langgraph` interrupt:

```typescript
vi.mock('@langchain/langgraph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@langchain/langgraph')>();
  return {
    ...actual,
    interrupt: vi.fn(() => ({ answer: 'Use the Roc workspace.' }))
  };
});

it('ask_user interrupts with a question payload and returns the resumed answer', async () => {
  const { interrupt } = await import('@langchain/langgraph');
  const tool = createAskUserTool();

  const result = await invokeTool(tool, {
    question: 'Which workspace should I use?',
    context: 'Two workspaces match.',
    suggestedResponses: ['F:\\Code\\Roc']
  });

  expect(interrupt).toHaveBeenCalledWith({
    kind: 'question',
    question: 'Which workspace should I use?',
    context: 'Two workspaces match.',
    suggestedResponses: ['F:\\Code\\Roc']
  });
  expect(result).toBe('Use the Roc workspace.');
});
```

- [ ] **Step 2: Run failing executor tests**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/deep-agent-executor-tools.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts
```

Expected: FAIL because `ask_user` does not exist.

- [ ] **Step 3: Create ask_user tool**

Create `src/main/services/deep-agent/ask-user-tool.ts`:

```typescript
import { DynamicStructuredTool } from '@langchain/core/tools';
import { interrupt } from '@langchain/langgraph';
import { z } from 'zod';

const askUserSchema = z.object({
  question: z.string().trim().min(1).describe('Question to ask the user before continuing.'),
  context: z.string().trim().min(1).optional().describe('Short context explaining why the question matters.'),
  suggestedResponses: z.array(z.string().trim().min(1)).optional().describe('Optional concise suggested answers.')
});

type AskUserInput = z.infer<typeof askUserSchema>;

type AskUserResumeValue =
  | string
  | {
      answer?: unknown;
    };

export function createAskUserTool(): DynamicStructuredTool<typeof askUserSchema, AskUserInput, AskUserInput, string> {
  return new DynamicStructuredTool<typeof askUserSchema, AskUserInput, AskUserInput, string>({
    name: 'ask_user',
    description: [
      'Pause the current run and ask the user one concise clarification question.',
      'Use when a user preference, scope decision, path choice, or other clarification would improve the result.',
      'Do not use for tool approval; approval is handled by HITL interruptOn.'
    ].join('\n'),
    schema: askUserSchema,
    func: async (request) => {
      const resume = interrupt({
        kind: 'question',
        question: request.question,
        ...(request.context === undefined ? {} : { context: request.context }),
        ...(request.suggestedResponses === undefined ? {} : { suggestedResponses: request.suggestedResponses })
      }) as AskUserResumeValue;
      if (typeof resume === 'string') {
        return resume;
      }
      if (typeof resume === 'object' && resume !== null && typeof resume.answer === 'string') {
        return resume.answer;
      }
      throw new Error('ask_user_resume_answer_invalid');
    }
  });
}
```

- [ ] **Step 4: Add tool to executor surfaces**

In `src/main/plugins/agent/deep-agent-executor.ts`, import:

```typescript
import { createAskUserTool } from '../../services/deep-agent/ask-user-tool';
```

In `createExecutorTools()`:

```typescript
const webReadTool = createWebReadTool(input.capabilities);
const askUserTool = createAskUserTool();
if (input.mode === 'plan') {
  return {
    runTools: [webReadTool, askUserTool],
    webReadTool
  };
}
const mcpTools = await loadSelectedMcpTools(input.capabilities, input.enabledCapabilities);
const runTools: ClientTool[] = [
  webReadTool,
  askUserTool,
  createDeleteFileTool(input.capabilities),
  createRocWindowsCommandTool(input.shellExecutionService),
  ...mcpTools
];
```

If background task tools are inserted by index, update `runTools.splice(2, 0, ...)` to insert before mutation tools:

```typescript
runTools.splice(2, 0, createResolveBackgroundTaskTimeTool(), ...backgroundTaskTools);
```

and for change mode:

```typescript
runTools.splice(2, 0, ...backgroundTaskTools);
```

- [ ] **Step 5: Add prompt guidance**

In `src/main/services/deep-agent/context/prompt-blocks.ts`, append to the chat/plan behavior block or tool guidance block:

```typescript
[
  'Human clarification:',
  '- You may call ask_user when a user preference, scope decision, path choice, or clarification would improve the result.',
  '- Ask one clear question at a time.',
  '- Avoid fragmented repeated questions; gather enough context first when possible.',
  '- Do not use ask_user for approval of tool calls.'
].join('\n')
```

Keep existing plan mode read-only guidance unchanged.

- [ ] **Step 6: Run executor tests**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/deep-agent-executor-tools.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/main/services/deep-agent/ask-user-tool.ts src/main/plugins/agent/deep-agent-executor.ts src/main/services/deep-agent/context/prompt-blocks.ts tests/main/plugins/agent/deep-agent-executor-tools.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts
git commit -m "feat: add ask user deep agent tool"
```

---

### Task 4: Renderer Interrupt State And Transcript

**Files:**
- Modify: `src/renderer/chat-run-state.ts`
- Modify: `src/renderer/chat-transcript.ts`
- Create: `src/renderer/chat/QuestionInterruptCard.tsx`
- Modify: `src/renderer/chat/chat-message-row.tsx`
- Modify: `src/renderer/views/tasks/TaskApprovalCard.tsx`
- Test: `tests/renderer/chat-run-state.test.ts`
- Test: `tests/renderer/chat-transcript.test.ts`
- Test: `tests/renderer/chat-message-row.test.ts`

**Interfaces:**
- Consumes: `ChatPendingInterrupt`
- Produces: `ChatTranscriptMessage.interrupt: ChatPendingInterrupt | null`
- Produces: `QuestionInterruptCard`

- [ ] **Step 1: Write failing transcript and render tests**

In `tests/renderer/chat-transcript.test.ts`, add:

```typescript
it('adds persisted human question requests to the assistant transcript', () => {
  const messages = buildPersistedTranscriptMessages(
    [
      {
        id: 'event-question',
        threadId: 'thread-1',
        runId: 'run-1',
        type: 'human_question_requested',
        payload: {
          interruptId: 'interrupt-question',
          question: 'Which branch should I use?',
          context: 'Current branch is main.',
          suggestedResponses: ['main']
        },
        createdAt: '2026-06-25T00:00:00.000Z'
      }
    ],
    'thread-1'
  );

  expect(messages).toHaveLength(1);
  expect(messages[0]?.interrupt).toEqual({
    kind: 'question',
    interruptId: 'interrupt-question',
    question: 'Which branch should I use?',
    context: 'Current branch is main.',
    suggestedResponses: ['main']
  });
});
```

In `tests/renderer/chat-message-row.test.ts`, add:

```typescript
it('renders question interrupt cards', () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatMessageRow, {
      message: {
        key: 'question',
        role: 'assistant',
        content: '',
        reasoning: null,
        blocks: [],
        interrupt: {
          kind: 'question',
          interruptId: 'interrupt-question',
          question: 'Which path should I inspect?',
          context: 'Two paths match.',
          suggestedResponses: ['F:\\Code\\Roc']
        },
        isStreaming: false
      }
    })
  );

  expect(html).toContain('data-testid=\"chat-question-card\"');
  expect(html).toContain('Which path should I inspect?');
  expect(html).toContain('F:\\Code\\Roc');
});
```

- [ ] **Step 2: Run failing renderer tests**

Run:

```powershell
pnpm test -- tests/renderer/chat-run-state.test.ts tests/renderer/chat-transcript.test.ts tests/renderer/chat-message-row.test.ts
```

Expected: FAIL because transcript and row still use approval-only shape.

- [ ] **Step 3: Update transcript message type**

In `src/renderer/chat-transcript.ts`, import `ChatPendingInterrupt` instead of `ChatPendingApproval`, then change:

```typescript
interrupt: ChatPendingInterrupt | null;
```

Replace all `approval: null` initializers with:

```typescript
interrupt: null,
```

Replace live assistant draft assignment with:

```typescript
interrupt: input.chatRunState.pendingInterrupts[0] ?? null,
```

Replace `pendingApprovals` checks with `pendingInterrupts`.

- [ ] **Step 4: Parse persisted question events**

In `src/renderer/chat-transcript.ts`, add:

```typescript
type HumanQuestionRequestedEvent = TaskEvent & {
  type: 'human_question_requested';
  payload: {
    interruptId: string;
    question: string;
    context: string | null;
    suggestedResponses: string[];
  };
};

function isHumanQuestionRequestedEvent(event: TaskEvent): event is HumanQuestionRequestedEvent {
  if (event.type !== 'human_question_requested') {
    return false;
  }
  if (typeof event.payload !== 'object' || event.payload === null) {
    return false;
  }
  return typeof Reflect.get(event.payload, 'interruptId') === 'string' && typeof Reflect.get(event.payload, 'question') === 'string';
}
```

When iterating task events in `buildPersistedTranscriptMessages()`, handle question events:

```typescript
if (isHumanQuestionRequestedEvent(event)) {
  const draft = getAssistantDraft(drafts, messages, event.runId);
  draft.message.interrupt = {
    kind: 'question',
    interruptId: event.payload.interruptId,
    question: event.payload.question,
    ...(event.payload.context === null ? {} : { context: event.payload.context }),
    suggestedResponses: event.payload.suggestedResponses
  };
  continue;
}
```

Update existing approval event parsing to set:

```typescript
draft.message.interrupt = {
  kind: 'approval',
  interruptId: payload.interruptId,
  actionRequests: payload.actionRequests,
  reviewConfigs: payload.reviewConfigs
};
```

- [ ] **Step 5: Add question card component**

Create `src/renderer/chat/QuestionInterruptCard.tsx`:

```tsx
import type { ChatPendingQuestion } from '../../shared/types';

type QuestionInterruptCardProps = {
  question: ChatPendingQuestion;
};

export function QuestionInterruptCard({ question }: QuestionInterruptCardProps): React.JSX.Element {
  return (
    <div className="chat-question-card" data-testid="chat-question-card">
      <header className="chat-question-card__head">等待回复</header>
      <p className="chat-question-card__question">{question.question}</p>
      {question.context === undefined ? null : <p className="chat-question-card__context">{question.context}</p>}
      {question.suggestedResponses === undefined || question.suggestedResponses.length === 0 ? null : (
        <ul className="chat-question-card__suggestions">
          {question.suggestedResponses.map((response) => (
            <li key={response}>{response}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

Use existing chat approval/card CSS first. Add only required class names if the component renders unstyled.

- [ ] **Step 6: Render by interrupt kind**

In `src/renderer/chat/chat-message-row.tsx`, rename local:

```typescript
const interrupt = message.interrupt;
```

Render:

```tsx
{interrupt !== null && interrupt.kind === 'approval' && isTaskApproval(interrupt) ? (
  <TaskApprovalCard approval={interrupt} onApprovalDecision={onApprovalDecision} />
) : interrupt !== null && interrupt.kind === 'approval' ? (
  <GenericApprovalCard approval={interrupt} onApprovalDecision={onApprovalDecision} />
) : interrupt !== null ? (
  <QuestionInterruptCard question={interrupt} />
) : null}
```

If no `GenericApprovalCard` exists, keep the existing inline approval JSX and feed it `interrupt`.

In `src/renderer/views/tasks/TaskApprovalCard.tsx`, keep `isTaskApproval()` compatible with `kind: 'approval'`:

```typescript
export function isTaskApproval(approval: ChatPendingApproval): boolean {
  return approval.kind === 'approval' && approval.actionRequests.some((request) => request.name === 'update_background_task' || request.name === 'cancel_background_task');
}
```

- [ ] **Step 7: Run renderer tests**

Run:

```powershell
pnpm test -- tests/renderer/chat-run-state.test.ts tests/renderer/chat-transcript.test.ts tests/renderer/chat-message-row.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/renderer/chat-run-state.ts src/renderer/chat-transcript.ts src/renderer/chat/QuestionInterruptCard.tsx src/renderer/chat/chat-message-row.tsx src/renderer/views/tasks/TaskApprovalCard.tsx tests/renderer/chat-run-state.test.ts tests/renderer/chat-transcript.test.ts tests/renderer/chat-message-row.test.ts
git commit -m "feat: render human question interrupts"
```

---

### Task 5: Composer Question Resume Flow

**Files:**
- Modify: `src/renderer/chat/chat-view.tsx`
- Modify: `src/renderer/app/AppShell.tsx`
- Modify: `src/renderer/app/task-creation-surface.ts`
- Test: `tests/renderer/chat-view.test.ts`
- Test: `tests/renderer/app-shell.test.tsx`

**Interfaces:**
- Consumes: `ChatPendingQuestion`
- Produces: question answer submission through `chat.resumeRun`
- Produces: approval resume requests with `kind: 'approval'`

- [ ] **Step 1: Write failing request builder tests**

In `tests/renderer/chat-view.test.ts`, update approval builder test:

```typescript
expect(
  buildChatApprovalResumeRunRequest({
    runId: 'run-1',
    threadId: 'thread-1',
    interruptId: 'interrupt-1',
    decisions: [{ type: 'approve' }]
  })
).toEqual({
  kind: 'approval',
  runId: 'run-1',
  threadId: 'thread-1',
  interruptId: 'interrupt-1',
  decisions: [{ type: 'approve' }]
});
```

Add question builder test:

```typescript
expect(
  buildChatQuestionResumeRunRequest({
    runId: 'run-1',
    threadId: 'thread-1',
    interruptId: 'interrupt-question',
    answer: 'Use F:\\Code\\Roc.'
  })
).toEqual({
  kind: 'question',
  runId: 'run-1',
  threadId: 'thread-1',
  interruptId: 'interrupt-question',
  answer: 'Use F:\\Code\\Roc.'
});
```

- [ ] **Step 2: Write failing composer resume test**

In `tests/renderer/chat-view.test.ts`, add a pure helper test for pending question selection:

```typescript
it('selects the first pending question interrupt', () => {
  expect(
    selectPendingQuestion([
      {
        kind: 'question',
        interruptId: 'interrupt-question',
        question: 'Which path?'
      }
    ])
  ).toEqual({
    kind: 'question',
    interruptId: 'interrupt-question',
    question: 'Which path?'
  });

  expect(
    selectPendingQuestion([
      {
        kind: 'approval',
        interruptId: 'interrupt-approval',
        actionRequests: [],
        reviewConfigs: []
      }
    ])
  ).toBeNull();
});
```

Add a submission helper test:

```typescript
it('builds question resume request for composer answers', () => {
  expect(
    buildChatQuestionResumeRunRequest({
      runId: 'run-1',
      threadId: 'thread-1',
      interruptId: 'interrupt-question',
      answer: 'Use F:\\Code\\Roc.'
    })
  ).toEqual({
    kind: 'question',
    runId: 'run-1',
    threadId: 'thread-1',
    interruptId: 'interrupt-question',
    answer: 'Use F:\\Code\\Roc.'
  });
});
```

- [ ] **Step 3: Run failing chat view tests**

Run:

```powershell
pnpm test -- tests/renderer/chat-view.test.ts tests/renderer/app-shell.test.tsx
```

Expected: FAIL because resume builders and question composer branch do not exist.

- [ ] **Step 4: Add resume request builders**

In `src/renderer/chat/chat-view.tsx`, replace `buildChatResumeRunRequest()` with:

```typescript
export function buildChatApprovalResumeRunRequest(input: {
  runId: string;
  threadId: string;
  interruptId: string;
  decisions: ChatResumeDecision[];
}): ChatResumeRunRequest {
  return {
    kind: 'approval',
    runId: input.runId,
    threadId: input.threadId,
    interruptId: input.interruptId,
    decisions: input.decisions
  };
}

export function buildChatQuestionResumeRunRequest(input: {
  runId: string;
  threadId: string;
  interruptId: string;
  answer: string;
}): ChatResumeRunRequest {
  return {
    kind: 'question',
    runId: input.runId,
    threadId: input.threadId,
    interruptId: input.interruptId,
    answer: input.answer
  };
}

export function selectPendingQuestion(interrupts: readonly ChatPendingInterrupt[]): ChatPendingQuestion | null {
  const interrupt = interrupts[0];
  return interrupt?.kind === 'question' ? interrupt : null;
}
```

- [ ] **Step 5: Branch composer submission for questions**

In `submitCurrentInput()` in `src/renderer/chat/chat-view.tsx`, after trimming input and before `onSubmitChatTask(payload)`, add:

```typescript
const pendingQuestion = selectPendingQuestion(chatRun.state.pendingInterrupts);
if (pendingQuestion !== null) {
  if (chatRun.state.runId === null || chatRun.state.threadId === null) {
    chatRun.setError('当前没有可恢复的提问运行。');
    return;
  }
  const result = await client.api.chat.resumeRun(
    buildChatQuestionResumeRunRequest({
      runId: chatRun.state.runId,
      threadId: chatRun.state.threadId,
      interruptId: pendingQuestion.interruptId,
      answer: trimmedInput
    })
  );
  if (result.ok) {
    setPendingUserInput(trimmedInput);
    setChatInput('');
    revokeAttachmentPreviewUrls(selectedAttachments);
    setSelectedAttachments([]);
  } else {
    chatRun.setError(result.error.message);
  }
  return;
}
```

Keep attachment validation for normal new runs. For question answers, do not attach images in v1.

- [ ] **Step 6: Update approval resume path**

In `handleApprovalDecision()`:

```typescript
const result = await client.api.chat.resumeRun(
  buildChatApprovalResumeRunRequest({
    runId: chatRun.state.runId,
    threadId: chatRun.state.threadId,
    interruptId: approvalId,
    decisions
  })
);
```

Update any renderer callers in `src/renderer/app/AppShell.tsx` and `src/renderer/app/task-creation-surface.ts` that construct resume requests to include `kind: 'approval'`.

- [ ] **Step 7: Run renderer flow tests**

Run:

```powershell
pnpm test -- tests/renderer/chat-view.test.ts tests/renderer/app-shell.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/renderer/chat/chat-view.tsx src/renderer/app/AppShell.tsx src/renderer/app/task-creation-surface.ts tests/renderer/chat-view.test.ts tests/renderer/app-shell.test.tsx
git commit -m "feat: resume human questions from composer"
```

---

### Task 6: End-To-End Verification And Cleanup

**Files:**
- Modify only files already touched by earlier tasks when verification exposes integration gaps.

**Interfaces:**
- Consumes all previous tasks.
- Produces verified chat and plan HITL implementation.

- [ ] **Step 1: Run focused HITL test set**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/runtime-approval.test.ts tests/main/plugins/agent/runtime-executor.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts tests/main/plugins/agent/deep-agent-executor-tools.test.ts tests/renderer/chat-run-state.test.ts tests/renderer/chat-transcript.test.ts tests/renderer/chat-message-row.test.ts tests/renderer/chat-view.test.ts tests/renderer/app-shell.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```powershell
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Run IPC check**

Run:

```powershell
pnpm check:ipc
```

Expected: PASS. If generated IPC output changes, commit the generated files with the code that changed the schema.

- [ ] **Step 4: Run full tests if shared types or runtime behavior affected broad callers**

Run:

```powershell
pnpm test
```

Expected: PASS.

- [ ] **Step 5: Check whitespace**

Run:

```powershell
git diff --check
```

Expected: no output.

- [ ] **Step 6: Search for stale approval-only names**

Run:

```powershell
rg -n "pendingApprovals|ChatApprovalRequest|buildChatResumeRunRequest\\(" src tests
```

Expected: no matches, except deliberate compatibility comments if a task explicitly kept one.

- [ ] **Step 7: Final commit**

Run:

```powershell
git status --short
git add src tests
git commit -m "feat: add chat plan human in loop"
```

Expected: working tree clean after commit.

---

## Self-Review Notes

- Spec coverage: approval HITL, question HITL, chat, plan, resume mode preservation, ask_user, question UI, composer resume, task event persistence, plan tool boundary, and verification are covered.
- Red flag scan: no incomplete implementation markers are present.
- Type consistency: `ChatInterruptPayload`, `ChatPendingInterrupt`, `ChatResumeRunRequest`, `kind: 'approval'`, `kind: 'question'`, and `ask_user` names are consistent across tasks.
