# DeepAgents Windows Path Architecture Design

## Goal

Roc must stop relying on prompts to keep DeepAgents file-tool paths and local Windows shell paths separate.

The target behavior is:

- DeepAgents built-in file tools use only Roc virtual routes: `/workspace/`, `/memory/`, `/skills/`, and `/agents/`.
- Local command execution uses the selected Windows workspace as cwd and does not treat `/workspace/` as a shell directory.
- Linux-style paths such as `/home/user/workarea/...` and Windows absolute paths such as `F:\Code\Roc\...` are rejected before DeepAgents file tools execute.
- The old DeepAgents built-in `execute` shell surface is removed at the filesystem backend boundary and replaced with a Roc-owned Windows command tool.

## Current Cause

Roc currently gives DeepAgents a single `CompositeBackend` whose routed file operations are virtual while its default backend also exposes command execution.

The file side is correct:

- `/workspace/` routes to a `FilesystemBackend` rooted at the selected Windows workspace with `virtualMode: true`.
- `/memory/` routes to Roc memory storage.
- `/skills/` and `/agents/` route to controlled read-only or selected-skill backends.
- Unknown file paths fall through to `RocHostShellBackend` and return `Roc 当前只允许访问 /workspace/、/skills/、/agents/、/memory/ 路径。`.

The command side is the source of confusion:

- DeepAgents injects an `execute` tool when the backend supports execution.
- DeepAgents' built-in `execute` description is sandbox/Linux-oriented and includes POSIX absolute-path examples.
- Roc then compensates in system prompts by saying file tools use `/workspace/`, while shell commands use the Windows workspace root.

That compensation is not stable. The model sees conflicting tool semantics in the same harness.

## DeepAgents Constraints

The design follows the supported DeepAgents surface instead of replacing core middleware.

- `FilesystemMiddleware` and `SubAgentMiddleware` are required scaffolding and should not be removed.
- Built-in filesystem tool names are fixed: `ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`.
- `FilesystemBackend({ virtualMode: true })` is the correct local development backend for constrained real-disk file access.
- `CompositeBackend` is the correct way to route virtual path prefixes to different backends.
- `FilesystemPermission` rules are first-match and default-allow if no rule matches.
- Filesystem permissions do not protect `execute`. If a backend supports `execute`, DeepAgents rejects permissions unless every permission path is scoped to a `CompositeBackend` route prefix.
- A final `/**` deny rule is only valid once the DeepAgents filesystem backend is no longer execution-capable.
- Harness profiles can hide tool names with `excludedTools`, including middleware-provided tools such as `execute`.

## Chosen Architecture

Use DeepAgents for file context and delegation. Use Roc for Windows command execution.

### 1. Keep DeepAgents File Tools

Roc keeps `createDeepAgent(...)` and the built-in file tools. The backend remains a routed `CompositeBackend` for the virtual filesystem contract:

- `/workspace/` maps to the selected Windows workspace.
- `/memory/` maps to Roc memory storage.
- `/skills/` maps to selected skills or a read-only skills backend.
- `/agents/` maps to read-only agent memory.

The default backend for unknown file routes should not be used as a compatibility fallback. Unknown routes remain hard errors.

### 2. Remove DeepAgents Built-In `execute` At The Backend Boundary

Roc must stop passing an execution-capable backend to DeepAgents `FilesystemMiddleware`.

The current `RocHostShellBackend` mixes two responsibilities:

- fallback file operations for unknown routes
- shell command execution through `ShellExecutionService`

The implementation should split this into two surfaces:

- A non-execution route-rejecting filesystem backend used as `CompositeBackend` default.
- A separate Roc command tool that calls `ShellExecutionService`.

The non-execution default backend keeps the current unknown-route hard error for file tools but does not implement `execute`.

Roc should also register a DeepAgents harness profile, or equivalent profile resolution path, that applies:

```ts
excludedTools: ['execute']
```

This is a belt-and-suspenders cleanup. The primary guarantee is that the backend given to `FilesystemMiddleware` is not execution-capable, so DeepAgents should not expose a working built-in `execute` in the first place. The profile filter must still apply to the main agent and the auto-created general-purpose subagent.

This is a cleanup, not an alias. The final code should not keep user-facing prompt text or docs that instruct the model to call DeepAgents `execute` for shell work.

### 3. Add a Roc-Owned Windows Command Tool

Roc exposes one command tool with Windows semantics. The exact final name should follow the existing local naming pattern, but it must not be `execute` if that would collide with DeepAgents built-ins.

Required behavior:

- Runs through `ShellExecutionService`.
- Uses the selected workspace path as cwd unless the user explicitly provides an allowed cwd.
- Rejects `/workspace`, `/workspace/...`, `/home/user/...`, `/tmp/...`, and other Linux-style workspace assumptions before invoking the shell service.
- Rejects cwd values outside the selected workspace unless Roc intentionally supports that flow.
- Returns clear tool errors, not successful ToolMessages that contain failure text.
- Keeps RTK shell-output rewriting on this Roc command path if RTK remains part of the command pipeline.

The command tool description should be Windows-specific and mention PowerShell examples only.

### 4. Add File-Tool Path Policy

Roc adds a hard path policy before file operations reach the backend.

The policy applies to:

- `ls.path`
- `read_file.file_path`
- `write_file.file_path`
- `edit_file.file_path`
- `glob.path` when present
- `grep.path` when present

Allowed file-tool paths:

- `/workspace/...`
- `/memory/...`
- `/skills/...`
- `/agents/...`

Rejected file-tool paths:

- Windows absolute paths, including drive paths and UNC paths.
- Linux home or temp paths such as `/home/user/...` and `/tmp/...`.
- Relative paths that do not explicitly target a Roc route.
- Paths containing traversal segments.
- Any absolute POSIX path outside the four Roc routes.

The rejection must produce a tool error with `status: 'error'`. This avoids the current misleading pattern where a failed file operation may be wrapped as a successful ToolMessage unless later middleware catches it.

### 5. Use Filesystem Permissions After `execute` Is Hidden

Once the DeepAgents filesystem backend is non-execution-capable, Roc can safely pass explicit filesystem permissions:

```ts
[
  { operations: ['read'], paths: ['/workspace/**', '/memory/**', '/skills/**', '/agents/**'], mode: 'allow' },
  { operations: ['write'], paths: ['/workspace/**', '/memory/**'], mode: 'allow' },
  { operations: ['write'], paths: ['/skills/**', '/agents/**'], mode: 'deny' },
  { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' }
]
```

The final deny rule is important because DeepAgents permissions default to allow when no rule matches.

The implementation must not rely on profile exclusion alone for this permission model. DeepAgents validates permissions while constructing `FilesystemMiddleware`, before model-visible tool filtering is enough to make path permissions meaningful. If the backend still implements `execute`, the final `/**` deny rule is invalid and the implementation is incomplete.

## Cleanup Scope

Implementation must remove or update old code and documentation that preserve the ambiguous model.

Required cleanup targets:

- Prompt text that says to use DeepAgents `execute` for shell commands.
- Prompt text that tries to teach the model to distinguish `/workspace/` file-tool paths from Windows shell paths as the primary safety mechanism.
- Tests expecting `filesystemPermissions` to be `undefined`.
- The `RocHostShellBackend` responsibility mix: shell execution must move out of the DeepAgents filesystem backend path.
- Capability preview or tool-list assumptions that expose DeepAgents built-in `execute`.
- Docs mentioning RTK as rewriting DeepAgents `execute` output; those references should move to the Roc-owned command tool path.
- Any mock data or fixtures that include `/home/user/workarea` as a valid Roc path.

Cleanup must not delete unrelated shell confirmation policy unless the implementation plan explicitly includes that separate behavior. Roc has separate approval concepts: DeepAgents HITL interrupts and Roc shell execution confirmation. This design only removes DeepAgents built-in `execute` from the agent-visible tool surface.

## Data Flow

File write example:

1. Model calls `write_file` with `/workspace/create_docx.py`.
2. Roc file path policy accepts the route.
3. DeepAgents permission check allows workspace write.
4. `CompositeBackend` strips `/workspace/`.
5. `FilesystemBackend({ virtualMode: true })` writes under the selected Windows workspace.
6. Roc verifies through `read_file` or `ls` before reporting success.

Invalid file path example:

1. Model calls `write_file` with `/home/user/workarea/create_docx.py`.
2. Roc file path policy rejects it before backend dispatch.
3. Tool result has `status: 'error'` and explains that Roc file tools require `/workspace/`, `/memory/`, `/skills/`, or `/agents/`.
4. No file operation occurs.

Command example:

1. Model calls Roc command tool with `python .\create_docx.py`.
2. Roc command policy resolves cwd to the selected Windows workspace.
3. Command goes through `ShellExecutionService`.
4. RTK output rewriting applies if the command output path still uses that middleware.
5. Result reports stdout, stderr, exit code, and truncation state.

Invalid command path example:

1. Model calls Roc command tool with `python /workspace/create_docx.py`.
2. Roc command policy rejects it before shell execution.
3. Error says `/workspace/` is a DeepAgents file-tool route, not a Windows shell path.

## Error Handling

Errors should be specific and non-successful:

- File-tool route violation: `Roc 文件工具只允许访问 /workspace/、/skills/、/agents/、/memory/ 路径。`
- File-tool Windows absolute path violation: `Roc 文件工具使用虚拟路径；请改用 /workspace/...。`
- Shell virtual path violation: `/workspace/ 是 DeepAgents 文件工具路由，不是 Windows shell 路径。`
- Shell Linux path violation: `Roc 在 Windows 本地执行命令；请使用当前工作区 cwd 下的相对路径或 Windows 路径。`

The exact strings can be adjusted during implementation, but tests must assert the route category and `status: 'error'`.

## Testing Plan

Add focused tests before implementation changes.

Unit tests:

- DeepAgent build wiring passes explicit filesystem permissions.
- The backend passed to DeepAgents filesystem middleware is not execution-capable.
- The final deny rule rejects non-routed file paths.
- File path policy rejects `/home/user/workarea/create_docx.py`.
- File path policy rejects `F:\Code\Roc\create_docx.py`.
- File path policy accepts `/workspace/create_docx.py`.
- DeepAgents visible tools do not include built-in `execute`.
- Roc command tool rejects `/workspace/...` in command strings before `ShellExecutionService` runs.
- Roc command tool uses selected workspace cwd for normal commands.

Integration tests:

- A simulated `write_file` to `/home/user/workarea/create_docx.py` produces `status: 'error'`.
- A simulated `write_file` to `/workspace/create_docx.py` dispatches to the workspace backend.
- General-purpose subagent does not expose DeepAgents built-in `execute`.
- RTK rewriting still applies to the Roc command tool path or is removed with matching docs/tests if no longer needed.

Regression searches:

```powershell
rg -n "Deep Agents `execute`|agent `execute`|/home/user/workarea|filesystemPermissions\\)\\.toBeUndefined|excludedTools: \\['execute'\\]" src tests docs
```

The search should show only intentional new implementation, tests, and documentation.

## Acceptance Criteria

- `write_file("/home/user/workarea/create_docx.py")` fails before backend write with a tool error.
- `write_file("F:\\Code\\Roc\\create_docx.py")` fails before backend write with a tool error.
- `write_file("/workspace/create_docx.py")` writes under the selected Windows workspace.
- Shell commands no longer use DeepAgents built-in `execute`.
- The `CompositeBackend` default used by file tools does not implement `execute`.
- The visible tool set contains the Roc-owned command tool and does not contain built-in `execute`.
- Shell command input containing `/workspace/...` is rejected before process execution.
- Prompt, docs, tests, fixtures, and capability preview no longer preserve the old mixed-path command model.
- The implementation keeps DeepAgents filesystem, task planning, skills, memory, and subagent behavior intact.

## Out of Scope

- Removing DeepAgents `FilesystemMiddleware`.
- Renaming DeepAgents built-in file tools.
- Deleting Roc shell confirmation policy.
- Supporting Linux runtime paths.
- Supporting writes outside the selected workspace through file tools.
- Adding compatibility aliases for `/home/user/workarea`.

## Rollout Notes

This should be implemented as a single behavior change with red-green tests because partial rollout can leave two command paths visible at once.

Recommended order:

1. Add tests proving current wrong-path behavior and visible built-in `execute`.
2. Add Roc path policy for file tools.
3. Hide DeepAgents built-in `execute`.
4. Add or wire the Roc-owned Windows command tool.
5. Enable explicit filesystem permissions.
6. Clean prompts, docs, fixtures, capability preview, and tests.
7. Run targeted Vitest files, then `pnpm typecheck`.
