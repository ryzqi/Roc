# Roc Agent Harness PR-01 Execution Boundary

Status: PR-01 implementation and target-host validation complete. This report records the boundary implemented for agent shell execution; it is not a claim that every application process path is sandboxed.

## Scope

PR-01 closes the path from renderer-authored run/shell fields to agent host execution. Renderer shell IPC is terminal-only, and run/task/workspace identity for agent execution is derived in the main process. Agent commands use distinct profile tools and a private `shell.executeAgent` capability. That capability requires a broker-issued, one-use grant bound to the frozen run, thread, `ToolRuntime.toolCallId`, tool, profile, canonical workspace identity, cwd, command hash, manifest/resource-scope hashes, and fixed limits. Grant issue and consumption validate active run state and a durable run fence in immediate SQLite transactions. Grants expire after 30 seconds; run cancellation, completion, and failure revoke outstanding authorization.

The `trusted_host` profile is deliberately separate from isolated execution. It requires a positive main-process native confirmation for the exact tool call and is rejected under `ROC_SMOKE=1`; it runs with the user's host permissions and inherited network access, with a 120-second deadline and 64 KiB output cap. It is unavailable to background/plan execution. It does not receive an isolation claim.

## Isolated profiles

`MacOsIsolatedEnvironment` fails closed unless running on Darwin with `/usr/bin/sandbox-exec`. Both isolated profiles use a private mode-0700 temporary directory, a minimal environment and a workspace bound by canonical path plus device/inode identity. The identity is checked before spawn and rechecked in the execution environment; cwd and file paths must remain inside the workspace. `isolated_read` denies workspace writes; `isolated_write` permits them. Both deny network access, limit command duration to 120 seconds, combined output to 1 MiB and input to 1 MiB, and kill the detached process group on cancellation, deadline or output overflow.

The Seatbelt policy now allows process-fork and process-exec only for `/bin`, `/sbin`, `/usr/bin` and `/usr/libexec`; it no longer grants the broad `process*` wildcard. Read/map-executable access is limited to the workspace and OS runtime directories (`/bin`, `/sbin`, `/usr/bin`, `/usr/lib`, `/usr/libexec`, `/usr/share`), plus the private temporary directory. `/usr/local` is explicitly denied, so user-installed tools and data do not inherit the OS runtime allowance. `system.sb` supplies OS-specific loader/syscall rules. The agent's ordinary host terminal remains a separate user-facing capability; this report covers agent tool execution.

## Evidence

Measured on macOS 27.0.1 (Build 26A434), Darwin 27.0.0 arm64, Node v26.12.1 and pnpm 12.5.1. This is the only macOS build validated here; no broader OS-version or hardware support range is established. On other platforms, or if `sandbox-exec` is unavailable, isolated execution refuses to start rather than falling back to host execution.

| Check | Result |
| --- | --- |
| Focused grant, migration, manifest and IPC-boundary tests | Pass, 29/29 |
| Full unit suite (`pnpm test:unit`) | Pass, 490/490 |
| TypeScript (`pnpm typecheck`) | Pass |
| IPC generated-file check (`pnpm check:ipc`) | Pass |
| Production build (`pnpm build`) | Pass |
| Renderer chunk check (`pnpm check:renderer-chunks`) | Pass, 1,130,127 eager JS bytes across 6 files |
| Harness (`pnpm harness:eval`) | Pass, 93/93 fixture cases |
| Diff whitespace check (`git diff --check`) | Pass |
| Serial renderer suite | 30/31; one intermittent Settings dialog detach timeout, detailed below |

Harness report: `.artifacts/harness-eval/2026-10-29T13-47-55.636Z-46591/report.json` (local generated artifact, not committed). Its `execution-isolation` evidence reports outside read/write, symlink, `/usr/local` read, and workspace path-swap denial; zero localhost requests; bounded output; enforced deadline; and zero background effects. `execution-cancel` finished with `finalCounter: 0`; `execution-child` finished with `finalCounter: 0`. The isolated Settings dialog test passed on an individual rerun after the full serial renderer suite timed out waiting for `settings-discard-panel` to detach at `tests/renderer/radix-settings-dialog.test.mjs:137:52`. Earlier baseline runs also showed intermittent renderer timeouts; the full-suite failure remains unresolved and is not reported as a pass.

The harness uses deterministic fixtures. It does not measure real-model quality or provider cost and does not prove resistance to arbitrary kernel attacks, every process invocation, MCP execution, research process policies, or untested macOS versions. `sandbox-exec` policy behavior remains OS-version-specific. `/usr/local` denial is verified only when that directory exists on the test host.

## Review boundary

The broker and grant enforcement cover agent shell tools. Interactive terminal, Git, hooks, research `process-runner`, and MCP stdio/network clients remain separate application process/network boundaries with their own policies. The isolated policy allows `sysctl-read` and file metadata reads needed by the runtime; it is not a VM or a CPU/memory quota. Trusted-host execution intentionally inherits host permissions after explicit confirmation.
