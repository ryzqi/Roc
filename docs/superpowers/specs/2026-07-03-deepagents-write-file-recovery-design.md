# DeepAgents Write File Recovery Design

## Goal

Roc should prevent and recover from the DeepAgents error:

```text
Cannot write to /frontend/index.html because it already exists. Read and then make an edit, or write to a new path.
```

The fix must keep DeepAgents' official `write_file` contract intact: `write_file` creates new files only, while existing files are changed through `read_file` followed by `edit_file`.

## Issue Frame

The observed tool call attempted to write `/frontend/index.html` with `write_file`. The target already existed, so the DeepAgents backend returned a conflict. This is expected backend behavior, not a Windows permission failure.

The path itself is also suspicious in Roc. Roc file tools are supposed to use the virtual route prefixes `/workspace/`, `/memory/`, and `/skills/`. A project file should normally be addressed as `/workspace/frontend/index.html`, not `/frontend/index.html`. If the exact path passed through the current Roc runtime without a Roc route error, the implementation must identify which execution surface bypassed or did not use Roc's path policy.

## Scope

This design covers:

- Roc DeepAgents prompt/tool contract wording for `write_file`, `read_file`, and `edit_file`.
- Roc file-tool path policy coverage for non-route absolute paths such as `/frontend/index.html`.
- Roc hard tool error classification for existing-file `write_file` conflicts.
- Tests that lock the existing-file recovery path and the Roc virtual route boundary.

This design does not cover:

- Changing DeepAgents source code or vendoring a patched backend.
- Adding overwrite/upsert behavior to `write_file`.
- Automatically rewriting `/frontend/index.html` to `/workspace/frontend/index.html`.
- Changing shell cwd rules or allowing `/workspace/...` in `run_shell_command`.
- Changing UI layout or renderer behavior.

## Authoritative Facts

DeepAgents official JavaScript docs define the built-in file tools as:

- `write_file`: create new files.
- `edit_file`: perform exact string replacements in files.

DeepAgents backend protocol defines `write(filePath, content)` as create-only. On conflict, a backend returns an error instead of overwriting.

The installed `deepagents@1.10.5` package follows that contract. `StateBackend`, `StoreBackend`, and sandbox-backed writes all return:

```text
Cannot write to <path> because it already exists. Read and then make an edit, or write to a new path.
```

Roc's current file-tool contract defines these allowed routes:

- `/workspace`
- `/memory`
- `/skills`

Roc's current shell contract is separate: file tools use virtual routes, while shell commands use the selected real Windows workspace cwd.

## Root Cause

The direct root cause is a wrong tool choice. The agent used `write_file` for a target that already existed. The correct sequence is:

1. `read_file` the existing file.
2. Use `edit_file` with an exact `old_string` and `new_string`.
3. Verify through `read_file` or `ls`.

The secondary root cause to investigate is the path surface. `/frontend/index.html` is not a Roc-approved virtual route. If it came from Roc's normal file tools, it should have been rejected before reaching the backend. If it came from a non-Roc DeepAgents backend, that surface needs an explicit boundary decision.

## Design

### 1. Keep DeepAgents Semantics

Do not make `write_file` overwrite existing files. Do not add a Roc compatibility alias such as `overwrite_file` or `upsert_file`.

Rationale: overwriting changes the upstream contract, hides model mistakes, and makes accidental destructive writes easier. The safe behavior is to force a read-before-edit workflow.

### 2. Tighten Roc File Tool Instructions

Extend the Roc file tool prompt block with a short, actionable rule:

```text
write_file only creates new files. To change an existing file, read it first, then use edit_file with an exact replacement.
```

Keep this in the Roc file tool contract, not scattered through task-specific prompts.

### 3. Treat Existing-File Write Conflicts As Hard Recoverable Tool Errors

`ForgeFilesystemToolErrorMiddleware` should continue marking `write_file` conflicts as hard tool errors. Tests should explicitly cover the exact DeepAgents conflict string.

The tool result should remain visible to the model. The desired recovery is not to retry `write_file`; it is to switch to `read_file -> edit_file`.

If a recovery hint is added, it must not mask the backend error. It may append a concise instruction, for example:

```text
Existing files must be changed with read_file followed by edit_file.
```

### 4. Lock Roc Route Boundary For `/frontend/index.html`

Add a path policy regression test for `/frontend/index.html`. It must fail with `ROC_FILE_TOOL_ROUTE_ERROR`.

Do not auto-normalize it to `/workspace/frontend/index.html`. Automatic rewriting would hide the distinction between DeepAgents virtual paths and Roc workspace routes and could target the wrong file when a future backend has a different root.

### 5. Verify Tool Exposure And Middleware Ordering

Confirm that normal chat and background task runs include:

- `createRocFilesystemPathPolicyMiddleware`
- `createFilesystemToolErrorMiddleware`
- Roc filesystem backend and permissions

If `/frontend/index.html` bypasses path policy in a specific run mode, fix that mode by using the same Roc middleware stack rather than adding a separate special case.

### 6. Tests

Add or update targeted tests:

- `tests/main/services/deep-agent/filesystem-path-policy.test.ts`
  - rejects `/frontend/index.html` for `write_file`.
- `tests/main/services/forge-guardrails/middleware/filesystem-tool-errors.test.ts`
  - marks the exact DeepAgents existing-file conflict as `status: 'error'`.
- `tests/main/services/deep-agent/context/prompt-blocks.test.ts`
  - prompt contains the create-only `write_file` rule in normal chat.
  - plan mode still does not expose mutation guidance.
- `tests/main/deep-agent-build-wiring.test.ts` or `tests/main/plugins/agent/deep-agent-executor-tools.test.ts`
  - add coverage if the path-surface investigation shows a chat, task detail, or background run path does not include Roc filesystem path policy middleware.

## Acceptance Criteria

- The cause of `/frontend/index.html` not being treated as a Roc route violation is located.
- `write_file` create-only semantics remain unchanged.
- Existing-file write conflict is classified as a hard tool error.
- Prompt/tool contract directs the model to `read_file -> edit_file` for existing files.
- `/frontend/index.html` is rejected by Roc file tools unless explicitly routed through a non-Roc DeepAgents surface.
- All new tests assert concrete behavior, not only defined/non-null results.

## Verification

Minimum targeted verification:

```powershell
pnpm test -- tests/main/services/deep-agent/filesystem-path-policy.test.ts tests/main/services/forge-guardrails/middleware/filesystem-tool-errors.test.ts tests/main/services/deep-agent/context/prompt-blocks.test.ts
```

If middleware stack or executor wiring changes, also run:

```powershell
pnpm test -- tests/main/deep-agent-build-wiring.test.ts tests/main/plugins/agent/deep-agent-executor-tools.test.ts
pnpm typecheck
git diff --check
```

## Risks

- Prompt wording alone will not prevent recurrence. The implementation must preserve backend and middleware enforcement.
- Adding an overwrite mode would reduce friction but would violate the safer upstream contract.
- Path rewriting looks convenient but can hide a wrong backend root or a missing Roc workspace binding.
- If background task runs use a different DeepAgents stack, fixing only chat will leave the bug reproducible in scheduled runs.
