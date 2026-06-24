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

- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `Stop`

`SessionStart` and `SessionEnd` are invoked from `deep-agent-executor`, because they are run-level lifecycle events rather than model/tool loop events.

### Settings UI

Adds a Hooks section near agent and permission settings. It shows the parsed config, handler trust state, validation errors, and last run result. It allows creating, editing, deleting, disabling, and trusting handlers.

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
- `block`: block the current event. `PreToolUse` blocks the tool call. `UserPromptSubmit` and `SessionStart` block the run.
- `replace_input`: only valid for `PreToolUse`; replaces the tool input.
- `add_context`: adds explicit context to the agent; valid for `SessionStart`, `UserPromptSubmit`, `PostToolUse`, and `Stop`.
- `request_continue`: only valid for `Stop`; asks the agent to continue another loop with `message`.

Invalid actions are treated as invalid hook output.

## Execution Rules

- Hook commands run through a Roc-owned process runner, not through `run_shell_command`.
- Default hook cwd is the run's real workspace path. If no workspace exists, use the Roc app cwd.
- The runtime does not accept `/workspace/...` as hook cwd.
- On Windows, `commandWindows` takes precedence over `command`.
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

Events include event name, matcher, command display, status, duration, and message. Full stdout and stderr are kept out of the model-visible transcript by default. Only explicit `additionalContext` enters agent context.

## Error Handling

Default failure behavior is continue:

- timeout
- exit code non-zero
- invalid JSON output
- unsupported output action

If `failureMode` is `block`, those failures block the current event, except for `SessionEnd`, which remains best-effort.

## Testing Plan

Focused tests:

- Hook config schema: valid config, invalid event, invalid timeout, empty command, Windows override.
- Trust hashing: stable hash, command changes require review, `statusMessage` does not affect hash.
- Runtime selection: event matching, matcher behavior, disabled/untrusted/invalid skip.
- Command runner: stdin payload, timeout, non-zero exit, stdout JSON parse, output truncation.
- Middleware: `PreToolUse` block, `PreToolUse` replace input, `PostToolUse` add context, no recursion through `run_shell_command`.
- Executor lifecycle: `SessionStart` and `SessionEnd` for chat and background task runs.
- IPC/settings: load config, save config, trust handler, return validation state.

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
- `SessionStart` and `SessionEnd` run at run lifecycle boundaries.
- Hook commands use real Windows cwd and do not receive `/workspace/...` as cwd.
- Existing Roc DeepAgents tools, memory, skills, workspace binding, and `interruptOn` behavior remain intact.
