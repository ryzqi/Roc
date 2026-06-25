# Chat And Plan Human In The Loop Design

## Goal

确保 Roc 的普通 chat 和 plan mode 都支持 human in the loop。Agent 遇到需要用户判断、偏好、范围、路径或其他有帮助的澄清点时，可以暂停当前 run，向用户提问，并在用户回答后从同一 DeepAgents/LangGraph checkpoint 恢复。现有工具审批 HITL 继续保留，并与自然语言澄清分开建模。

## Sources

- DeepAgents JS `/langchain-ai/deepagentsjs`: `interruptOn` 用于工具审批，DeepAgents 通过 LangGraph interrupt 暂停敏感工具调用；`createDeepAgent` 接收 `checkpointer` 和 `store`。
- LangGraph JS docs: `interrupt(value)` 可传任意 JSON-serializable payload 给客户端；恢复使用 `new Command({ resume })`，并且需要 checkpointer 和稳定 `thread_id`。
- Roc 当前代码事实：
  - `src/main/plugins/agent/deep-agent-executor.ts` 已使用 `MemorySaver`、稳定 `thread_id`、`new Command({ resume })`。
  - `src/shared/types/chat.ts` 已有 `run_interrupted`、`run_resumed`、`ChatResumeRunRequest`。
  - `src/renderer/chat-run-state.ts` 已有 `waiting_user` 和 pending approval 状态。
  - `src/main/plugins/agent/runtime.ts` 当前 `resumeRun()` 把恢复请求硬编码成 `mode: 'task'`，会破坏 chat 和 plan 的恢复语义。

## User Decisions

- 范围包括工具审批 HITL 和 agent 主动澄清 HITL。
- Agent 觉得有帮助时可以停下问用户，不只限于硬阻塞。
- 用户回答澄清问题时，使用底部聊天输入框；不在问题卡片里做专用输入框。
- 采用通用 interrupt 协议，不用工具审批协议伪装自然语言问答。

## Interrupt Contract

将 run interrupt payload 分成两类：

```typescript
type ChatInterruptPayload =
  | {
      kind: 'approval';
      request: HITLRequest;
    }
  | {
      kind: 'question';
      question: string;
      context?: string;
      suggestedResponses?: string[];
    };
```

`ChatRunEvent.run_interrupted.payload` 使用该 union。`ChatResumeRunRequest` 也分成明确 union：

```typescript
type ChatResumeRunRequest =
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

实现必须在 request kind 与 pending interrupt kind 不匹配时明确失败。不能用 optional `decisions` 或 `answer` 默认值掩盖 malformed resume request。

## Runtime Design

`PendingInterrupt` stores the original run context:

- `mode`
- `taskSource`
- `workflowHint`
- `workspacePath`
- `explicitSkillIds`
- interrupt payload kind

`resumeRun()` reconstructs `ChatStartRunRequest` from the pending interrupt and the stored `TaskRun`, preserving the original `mode`. It must not hardcode `mode: 'task'`.

Approval resume keeps the existing DeepAgents/LangGraph shape:

```typescript
new Command({ resume: { decisions } })
```

Question resume uses the ask-user interrupt contract:

```typescript
new Command({ resume: { answer } })
```

The exact shape is owned by the new Roc ask-user tool and tested at that boundary.

## Ask User Tool

Add a Roc-owned `ask_user` tool to chat and plan runtime tools. The tool:

- accepts `question`, optional `context`, optional `suggestedResponses`;
- triggers a LangGraph interrupt with `kind: 'question'`;
- resumes with the user's answer;
- returns the answer to the agent as the tool result after resume.

The tool is available in both chat and plan. It does not mutate files, run shell commands, or change workspace state.

Prompt text should tell the agent it may ask when a user decision, preference, scope, path, or clarifying detail would improve the result. Because user chose an active asking policy, the prompt should also ask the agent to avoid fragmented repeated questions and prefer one clear question at a time.

## UI And Data Flow

When `chatRun.state.status === 'waiting_user'`:

- If pending interrupt kind is `approval`, render the existing approval card and approve/reject/edit buttons.
- If pending interrupt kind is `question`, render a question card in the assistant transcript.

For question interrupts:

- The bottom composer remains enabled.
- Submitting the composer calls `chat.resumeRun`, not `chat.startRun`.
- The submitted text becomes `answer`.
- The UI may show a pending user bubble while persisted events catch up.
- Resume success clears the pending interrupt through `run_resumed`.

For plan mode:

- Question resume keeps `mode: 'plan'`.
- After the resumed plan completes, existing `<proposed_plan>...</proposed_plan>` extraction and execute-plan actions still apply.

For chat mode:

- Question resume keeps `mode: 'chat'`.
- The same thread/checkpoint continues.

For task workbench:

- Background task runs may enter `waiting_user`.
- Task detail transcript shows approval or question interrupts.
- V1 does not add a kanban-card answer input.
- Task mode answering is not a primary acceptance criterion for this spec. If implementation finds no task detail composer capable of resume submission, it must leave task question answering out of scope and document that follow-up explicitly.

## Tool Boundaries

Plan mode keeps its read-only runtime boundary:

- no `run_shell_command`;
- no `delete_file`;
- no background task create/update/cancel tools;
- read-only filesystem permissions stay enforced.

`ask_user` is safe in plan mode because it only pauses and collects user input. It does not provide mutation capability.

## Tests And Acceptance Criteria

Runtime tests:

- Chat approval interrupt resumes with `mode: 'chat'`.
- Plan approval interrupt resumes with `mode: 'plan'`.
- Chat question interrupt resumes with `mode: 'chat'`.
- Plan question interrupt resumes with `mode: 'plan'`.
- Resume preserves `workflowHint`, `taskSource`, `workspacePath`, and `explicitSkillIds`.
- Interrupt ID mismatch and thread mismatch still fail.
- Resume kind mismatch fails clearly.

Executor tests:

- Chat and plan tool surfaces include `ask_user`.
- `ask_user` produces `kind: 'question'` interrupt payload.
- Question resume returns the supplied answer to the agent.
- Plan mode still excludes `run_shell_command`, `delete_file`, and background-task mutation tools.

Renderer tests:

- Question interrupt renders a question card.
- Waiting-user question submission calls `chat.resumeRun`, not `chat.startRun`.
- Approval interrupt still uses approval buttons.
- Plan question resume can still finish with a `<proposed_plan>` block and show execute actions.

Verification:

- Run targeted Vitest files for runtime, executor, and renderer.
- Run `pnpm typecheck`.
- Run `git diff --check`.

## Non-Goals

- No prompt-only solution.
- No natural-language question modeled as approve/reject/edit.
- No multi-question form in v1.
- No global auto-ask or never-ask setting.
- No change to plan mode read-only tool boundary.
- No change to background task scheduling policy.
- No long-term approval grants.

## Risks

- DeepAgents JS may expose approval interrupts and raw LangGraph interrupts with different payload shapes. The implementation must normalize both at `readRunInterruptedEvent()`.
- If composer submission does not branch on pending question, user answers could accidentally start a new run.
- If resume still uses hardcoded `mode: 'task'`, plan and chat guarantees fail.
- If background task detail lacks a composer, task question resume needs a scoped UI addition or a documented implementation blocker.
