# Roc Hooks Design

## Current State

Roc currently builds its agent runtime through DeepAgents and LangChain middleware. `buildDeepAgent()` wires Roc guardrails such as shell path policy, filesystem path policy, RTK middleware, prompt caching, error budget, rescue parsing, tool protocol handling, and cleanup into `createDeepAgent()`. Background task changes already use DeepAgents `interruptOn` for human approval.

The new hook mechanism must extend this runtime instead of creating a second agent path. It must preserve Roc's existing workspace contract: DeepAgents file tools use virtual `/workspace/`, `/memory/`, and `/skills/` routes, while shell execution and hook commands use real Windows paths.

## Goal

Implement user-configurable global lifecycle hooks for Roc.

The configuration source is `%USERPROFILE%\.roc\hooks.json`. Hooks configured there apply globally to chat runs and background task runs across all workspaces. The settings UI exposes hook configuration, validation, and trust management.

## Non-Goals

- Do not add workspace-local hook override files in the first version.
- Do not support prompt or agent hook handlers in the first version.
- Do not replace DeepAgents middleware, Roc guardrails, or existing `interruptOn` approvals.
- Do not change DeepAgents virtual file-tool path semantics.
- Do not execute hook commands through the agent `run_shell_command` tool.

## Events

The first version supports these events:

- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `Stop`
- `SessionEnd`

Matcher behavior:

- `PreToolUse` and `PostToolUse` match the tool name.
- `SessionStart` matches `chat` or `background_task`.
- `SessionEnd` matches `completed`, `failed`, or `cancelled`.
- `UserPromptSubmit` and `Stop` ignore matcher in the first version.

## Architecture

### HookConfigService

Reads and writes `%USERPROFILE%\.roc\hooks.json`. It validates the schema and returns a normalized snapshot to the settings UI and runtime.

The settings/runtime snapshot must merge configuration with `HookTrustService` state. A handler whose current hash is trusted must be returned as `trusted`; it must not remain `review_required` merely because trust is stored outside `hooks.json`.

### HookTrustService

Stores trusted handler hashes outside `hooks.json`. Trust is tied to the current handler definition, so external edits to the config file move the handler back to `review_required`.

The hash input includes:

- event
- matcher
- handler type
- command
- commandWindows
- timeoutSeconds
- failureMode

`statusMessage` is excluded from the hash so display-only edits do not require a new review.

### HookRuntime

Selects handlers by event and matcher, filters by enabled and trust status, runs command handlers, parses outputs, and returns a normalized outcome.

### RocHookMiddleware

Connects runtime hooks to the LangChain/DeepAgents agent loop:

- `UserPromptSubmit` uses the first LangChain `beforeModel` call for the run.
- `PreToolUse` uses LangChain `wrapToolCall` before calling the tool handler.
- `PostToolUse` uses LangChain `wrapToolCall` after the tool handler returns.
- `Stop` uses LangChain `afterModel`.

`SessionStart` and `SessionEnd` are invoked from `deep-agent-executor`, because they are run-level lifecycle events rather than model/tool loop events.

### Settings UI

Adds a Hooks section near agent and permission settings. The first version uses a JSON editor for `%USERPROFILE%\.roc\hooks.json`, with save, refresh, validation display, handler list, last run state, and a trust button for the current handler hash. Creating, editing, deleting, and disabling handlers are done by editing the JSON in this first version; do not design a separate form builder yet.

## LangChain/DeepAgents Integration Mapping

DeepAgents JavaScript accepts LangChain middleware through `createDeepAgent({ middleware })`. Roc hook integration must use the actual LangChain JavaScript middleware surface: `beforeModel`, `afterModel`, `wrapModelCall`, and `wrapToolCall`. Roc event names are product-level lifecycle events, not native LangChain hook names.

| Roc event | Integration point | Blocking behavior | Context behavior |
| --- | --- | --- | --- |
| `SessionStart` | `deep-agent-executor` before agent build/stream | Can block the run before model/tool execution starts. | `add_context` is carried into the initial model context. |
| `UserPromptSubmit` | First `beforeModel` call for the run | Can block before the first model call. | `add_context` is appended to the model context before the first model call. |
| `PreToolUse` | `wrapToolCall` before `handler(request)` | Can block the tool call or replace tool input. | Does not inject model context directly. |
| `PostToolUse` | `wrapToolCall` after `handler(request)` returns | Cannot undo the completed tool call. `block` is invalid for this event. | `add_context` is queued and injected into the next `beforeModel` call. |
| `Stop` | `afterModel` after an assistant response | Can request a bounded continuation. `block` stops finalization with a hook error. | `add_context` is queued for the continuation when `request_continue` is used. |
| `SessionEnd` | runtime/executor finalization for completed, failed, and cancelled runs | Best-effort only. It cannot block or change final status. | Does not inject model context. |

`PostToolUse add_context` is a delayed model-context injection. The runtime must not merely collect it for diagnostics; it must be consumed by a later `beforeModel` call or by a bounded `Stop` continuation path.

## Configuration Schema

Example:

```json
{
  "schemaVersion": 1,
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^run_shell_command$",
        "hooks": [
          {
            "type": "command",
            "command": "powershell -NoProfile -File C:\\Users\\you\\.roc\\hooks\\check-shell.ps1",
            "commandWindows": "powershell -NoProfile -File C:\\Users\\you\\.roc\\hooks\\check-shell.ps1",
            "timeoutSeconds": 30,
            "statusMessage": "Checking shell command",
            "enabled": true,
            "failureMode": "continue"
          }
        ]
      }
    ]
  }
}
```

Supported handler fields:

- `type`: only `command` is executable in the first version.
- `command`: command string.
- `commandWindows`: optional Windows override.
- `timeoutSeconds`: default 30, maximum 600.
- `statusMessage`: optional UI text.
- `enabled`: defaults to true.
- `failureMode`: `continue` or `block`, defaults to `continue`.

## Command Input Protocol

Hook commands receive JSON on stdin.

Common shape:

```json
{
  "schemaVersion": 1,
  "event": "PreToolUse",
  "runId": "run_...",
  "threadId": "thread_...",
  "workspacePath": "F:\\Code\\Roc",
  "cwd": "F:\\Code\\Roc",
  "triggeredAt": "2026-06-24T10:00:00.000Z",
  "payload": {}
}
```

Payloads:

- `SessionStart`: `{ "source": "chat" | "background_task", "modelId": "...", "workflowHint": ... }`
- `UserPromptSubmit`: `{ "prompt": "..." }`
- `PreToolUse`: `{ "toolName": "...", "toolCallId": "...", "toolInput": {...} }`
- `PostToolUse`: `{ "toolName": "...", "toolCallId": "...", "toolInput": {...}, "toolOutput": ... }`
- `Stop`: `{ "lastAssistantMessage": "...", "visibleOutput": true }`
- `SessionEnd`: `{ "status": "completed" | "failed" | "cancelled", "error": null | "..." }`

`cwd` and `workspacePath` are real Windows paths when present. They are never DeepAgents virtual `/workspace/...` paths.

## Command Output Protocol

stdout may be empty. Non-empty stdout must be JSON:

```json
{
  "action": "continue",
  "message": "optional",
  "updatedInput": null,
  "additionalContext": null
}
```

Supported actions:

- `continue`: continue the current operation.
- `block`: blocks only events where blocking is meaningful.
- `replace_input`: replaces the tool input.
- `add_context`: adds explicit model-visible context.
- `request_continue`: asks the agent to continue another loop with `message`.

Invalid actions are treated as invalid hook output.

Action/event matrix:

| Action | Valid events | Notes |
| --- | --- | --- |
| `continue` | All events | No behavior change. |
| `block` | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `Stop` | `SessionEnd` is best-effort; `PostToolUse` cannot block an already completed tool call. |
| `replace_input` | `PreToolUse` only | The replacement becomes `request.toolCall.args` before the tool handler runs. |
| `add_context` | `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop` | Only explicit `additionalContext` is injected. stdout/stderr are never injected implicitly. |
| `request_continue` | `Stop` only | Capped to three consecutive continuations. |

## Execution Rules

- Hook commands run through a Roc-owned process runner, not through `run_shell_command`.
- Hook commands are shell command strings in `%USERPROFILE%\.roc\hooks.json`; they are trusted local automation, not model-authored commands. Untrusted or changed hashes must never execute.
- Default hook cwd is the run's real workspace path. If no workspace exists, use the Roc app cwd.
- The runtime rejects hook cwd values that use DeepAgents virtual paths such as `/workspace/...`, `/memory/...`, or `/skills/...` before invoking the process runner.
- On Windows, `commandWindows` takes precedence over `command`.
- The Windows runner must enforce `timeoutSeconds` and terminate the spawned process tree on timeout. If process-tree termination is not fully available in the first implementation, the limitation must be explicit in code comments and diagnostics.
- Matching handlers for one event run concurrently.
- Results are merged in configuration order.
- If any handler returns `block`, the event is blocked.
- Multiple `replace_input` outputs are applied in configuration order.
- Multiple `add_context` outputs are appended in configuration order.
- `SessionEnd` is best-effort and cannot change the final run status.
- `Stop` `request_continue` is capped to three consecutive continuations.
- stdout and stderr are size-limited and truncated in logs when needed.
- stderr is never injected into the model context.

## Trust States

Settings and runtime expose these states:

- `trusted`: current hash matches a trusted record and handler is enabled.
- `review_required`: handler exists but current hash is not trusted.
- `disabled`: handler is disabled in config.
- `invalid`: schema or handler validation failed.

Untrusted, disabled, and invalid handlers do not execute. They are still shown in settings and diagnostics.

## Runtime Feedback

Each hook execution emits runtime events equivalent to:

- `hook_started`
- `hook_completed`

`hook_started` is emitted before the command starts. `hook_completed` is emitted for completed, skipped, failed, and blocked outcomes. Events include event name, matcher, command display, status, duration, and message. `commandDisplay` is the human-readable configured command string selected for the current platform; it is not the stdin payload and does not include hook input/output. Full stdout and stderr are kept out of the model-visible transcript by default. Only explicit `additionalContext` enters agent context.

### Chat Transcript Display

The renderer must show hook runtime events in the assistant activity stream, using the same folded activity-card pattern as tool calls. Hook activity is a separate block kind, not a pseudo tool call, so hook UI can keep hook-specific labels while reusing the existing transcript path.

Displayed hook fields are limited to:

- hook event name
- handler id
- status
- duration
- message
- command summary from `commandDisplay`

The default chat display must not show stdout, stderr, raw payload, hook stdin, trust hash, or model-visible context. Hook activity blocks must not append text to `assistantMessage`, must not enter persisted assistant text, and must not change the model-visible transcript. The first version displays live run hook events; persisted historical display is only required if task history already stores these runtime events.

Status mapping:

- `hook_started` renders as running.
- `hook_completed` renders as `completed`, `failed`, `blocked`, or `skipped` from the runtime summary.
- Missing duration renders as an in-progress or unknown duration label, not as `0ms`.
- Missing message renders no message row.

## Error Handling

Default failure behavior is continue:

- timeout
- exit code non-zero
- invalid JSON output
- unsupported output action

If `failureMode` is `block`, those failures block the current event, except for `SessionEnd`, which remains best-effort. Command failures must honor `failureMode: "block"`; they cannot silently continue unless the handler is for `SessionEnd`.

`cancelRun()` must emit `SessionEnd` best-effort. Missing active-run metadata or a rejected `SessionEnd` promise must be logged/ignored, not thrown back to cancellation callers.

## Testing Plan

Focused tests:

- Hook config schema: valid config, invalid event, invalid timeout, empty command, Windows override.
- Trust hashing: stable hash, command changes require review, `statusMessage` does not affect hash.
- Runtime selection: event matching, matcher behavior, disabled/untrusted/invalid skip.
- Command runner: stdin payload, timeout, process-tree cleanup, non-zero exit, stdout JSON parse, output truncation, virtual cwd rejection.
- Runtime output validation: valid/invalid action per event, `failureMode: "block"` on command failure, `SessionEnd` best-effort exception.
- Middleware: first `beforeModel` `UserPromptSubmit`, `PreToolUse` block, `PreToolUse` replace input, `PostToolUse` add context injected on later `beforeModel`, `afterModel` `Stop` request continuation cap, no recursion through `run_shell_command`.
- Executor lifecycle: `SessionStart` and `SessionEnd` for chat and background task runs.
- IPC/settings: load config, save config, trust handler, return merged config/trust validation state.
- Renderer chat state: display `hook_started` and `hook_completed` as folded hook activity blocks without crashes, assistant text pollution, stdout/stderr exposure, or loss of ordinary tool-call events.

Verification sequence:

1. Run the smallest affected Vitest files.
2. Run `pnpm typecheck`.
3. Run `pnpm check:ipc` after shared type or IPC changes.
4. Run `git diff --check`.

## Acceptance Criteria

- A user can configure command hooks in `%USERPROFILE%\.roc\hooks.json`.
- Settings can show, edit, disable, and trust hook handlers.
- Changed command definitions require re-trust before execution.
- Trusted hooks fire for chat and background task runs.
- `PreToolUse` can block or replace a tool input.
- `PostToolUse` can add explicit context without exposing raw stderr.
- `Stop` can request at most three continuations.
- `SessionStart` and `SessionEnd` run at run lifecycle boundaries.
- Hook commands use real Windows cwd and do not receive `/workspace/...` as cwd.
- Settings can save JSON config, refresh, display validation errors, and trust the current handler hash.
- Chat UI shows hook runtime events in the assistant activity stream with tool-call-like folded rows and command summary only.
- Existing Roc DeepAgents tools, memory, skills, workspace binding, and `interruptOn` behavior remain intact.
