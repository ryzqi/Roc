# Chat Plan Mode Design

## Goal

在普通 chat 输入框新增 Plan mode。用户用 `Shift+Tab` 在 `Chat` 和 `Plan` 间切换；Plan run 只用于读取、搜索、分析和产出计划。计划完成后，用户点击“执行计划”，Roc 启动新的 `chat` run，并且新 run 的输入上下文只包含最终计划文本。

## Sources

- Codex `openai/codex` at `c38b2e9`: Plan mode is a collaboration mode, `Shift+Tab` cycles visible modes, and final plans are emitted through `<proposed_plan>...</proposed_plan>`.
- Claude Code docs:
  - `https://code.claude.com/docs/en/permission-modes.md`: Plan mode researches and proposes changes without editing source; `Shift+Tab` switches modes.
  - `https://code.claude.com/docs/en/permissions.md`: read-only tools run without approval; write/edit/shell operations are permission-controlled.
  - `https://code.claude.com/docs/en/agent-sdk/permissions.md`: `plan` routes write operations away from auto-approval and allows clarifying questions.

## Current Roc Facts

- `ChatRunMode` is currently `chat | task`.
- Normal chat sends `ChatStartRunRequest` with `mode: 'chat'`.
- Task workbench sends `mode: 'task'` and uses `workflowHint` for background-task flows.
- `ChatComposer` handles `Enter` to submit and `Shift+Enter` for newline. It does not currently handle `Shift+Tab`.
- DeepAgents backend already separates virtual routes `/workspace`, `/memory`, and `/skills`.
- File tool permissions currently allow writes to `/workspace/**` and `/memory/**`, deny writes to `/skills/**`, and deny all other file routes.
- Runtime tools include `run_shell_command`, `delete_file`, web read, selected MCP tools, and background-task tools depending on workflow.

## User Decisions

- Scope is normal chat only. Task workbench, task detail, scheduled/background task creation, and task approval flows are out of scope for v1.
- `Shift+Tab` toggles only between `Chat` and `Plan`.
- Plan output approval uses方案 1: Plan is a run-level mode; executing a plan starts a new `chat` run.
- After Plan completes, “执行计划” uses the final plan text directly as the new chat input.
- The execution chat context must contain only the final plan. It must not reuse the Plan thread, Plan messages, or Plan tool history.
- Plan mode exposes read file tools: `ls`, `read_file`, `grep`, `glob`.
- Plan mode does not expose file mutation tools: `write_file`, `edit_file`, `delete_file`.

## UX

- The composer shows a compact mode indicator near the send controls:
  - `Chat`
  - `Plan`
- Pressing `Shift+Tab` while the chat composer textarea is focused toggles the mode and prevents focus traversal.
- `Shift+Enter` keeps the current newline behavior.
- `Enter` submits using the currently selected composer mode.
- Plan mode placeholder/copy may indicate planning, but it must not add instructional text that describes keyboard shortcuts inside the app surface beyond the mode indicator.
- During a Plan run, transcript behavior remains the same as a normal chat run.
- When a completed Plan run has a final `<proposed_plan>` block, the UI renders a plan action row with:
  - `执行计划`
  - `继续规划`
- `执行计划` starts a new `chat` run. The submitted input is exactly the extracted plan text with surrounding whitespace trimmed.
- `继续规划` keeps the user in Plan mode and leaves the composer ready for another planning message.
- If a Plan run completes without `<proposed_plan>`, Roc shows no execute action. The assistant text still appears normally.

## Protocol And Data Flow

- Extend `ChatRunMode` to `chat | task | plan`.
- Extend `ChatTaskSubmitPayload` with optional `mode?: 'chat' | 'plan'`.
- Normal chat submissions pass `mode: 'chat'`.
- Plan submissions pass `mode: 'plan'`.
- `useAppTaskRuns.startChatRun()` chooses request mode from payload:
  - `payload.mode === 'plan'` starts `ChatStartRunRequest.mode = 'plan'`.
  - otherwise starts `mode = 'chat'`.
- Executing a plan must pass:
  - `mode: 'chat'`
  - `threadId: null`
  - `input: extractedPlanText`
  - the current selected MCP servers and skills from the current UI state
  - no Plan thread id
  - no Plan history continuation
- Existing `run_started`, `run_completed`, and `run_failed` event shapes remain unchanged except for the additional `mode: 'plan'` value.

## Plan Extraction

- Extract the final plan from the completed assistant message by finding the last well-formed block:

```text
<proposed_plan>
...
</proposed_plan>
```

- The extracted executable plan is the inner text, trimmed.
- If multiple blocks exist, use the last complete block.
- If no complete block exists, no execute action is available.
- The full assistant message remains visible in the transcript. The execute action uses only extracted plan text.

## Runtime Tool Contract

- Plan mode is enforced by runtime tool construction, not by prompt text.
- Plan mode keeps read-oriented capabilities:
  - DeepAgents read file tools through backend routes
  - `web_read`
  - selected MCP tools only if they are known read/search tools or are otherwise approved as read-only by existing capability metadata
- Plan mode removes mutation-capable tools from the model context:
  - `write_file`
  - `edit_file`
  - `delete_file`
  - background task create/update/cancel tools
- Plan mode must not rely only on the model obeying instructions.
- Shell execution in Plan mode must not be exposed in v1 unless a read-only shell classifier already exists. Current Roc shell tool is command-string based and can mutate files, so v1 excludes `run_shell_command` in Plan mode.
- If future work adds a read-only shell classifier, it can be introduced behind a separate tested capability.

## Prompt Contract

- Plan mode system context tells the model to research first, ask clarification when needed, and output the final plan in exactly one `<proposed_plan>` block.
- Prompt text is secondary. Runtime tool restrictions are authoritative.
- Normal chat and task prompts must remain unchanged unless directly required for the new `plan` mode.

## Non-Goals

- No Plan mode in task workbench or task detail.
- No one-click execution inside the same Plan run.
- No migration of existing chat history.
- No global default Plan mode setting.
- No `acceptEdits`, `auto`, `dontAsk`, or bypass-permission modes.
- No shell read-only classifier in v1.
- No broad refactor of chat transcript architecture.

## Tests And Acceptance Criteria

- Composer mode:
  - `Shift+Tab` toggles `chat -> plan -> chat`.
  - `Shift+Enter` still inserts a newline.
  - `Enter` submits current mode.
- Request payload:
  - Plan submission sends `ChatStartRunRequest.mode = 'plan'`.
  - Chat submission still sends `mode = 'chat'`.
- Runtime tools:
  - Plan mode build path does not include `run_shell_command`.
  - Plan mode build path does not include `delete_file`.
  - Plan mode build path does not include background-task mutation tools.
  - Plan mode uses read-only filesystem permissions.
- Plan execution:
  - Completed Plan assistant text with `<proposed_plan>` renders an execute action.
  - Executing starts a new `chat` run with `threadId: null`.
  - The new chat input equals the extracted plan text and excludes previous Plan transcript content.
- Regression:
  - Existing chat and task tests remain passing.
  - `pnpm typecheck` passes.
  - `git diff --check` passes.

## Risks

- Adding `plan` to `ChatRunMode` touches shared types and tests that assume only `chat | task`.
- If MCP tools do not expose reliable read/write metadata, Plan mode should initially omit selected MCP tools from the Plan tool surface rather than guessing.
- If plan extraction is performed too early during streaming, UI may show premature actions. Only expose actions after `run_completed`.
- If execution reuses selected thread id by accident, previous Plan context could leak into the execution run. Tests must assert `threadId: null`.
