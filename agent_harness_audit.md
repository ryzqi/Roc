# Agent Harness Audit

## Objective
逐文件/逐模块审计 Roc agent harness 相关代码，确认生产环境要求、DeepAgents/LangChain 原生能力优先、Windows/virtual path 边界、工具 side-effect、memory/skills/subagent/runtime 连续性。

## Status Legend
- `pending`: 尚未审计。
- `in_progress`: 正在审计。
- `located`: 已定位证据，但未完成判断。
- `issue`: 已确认问题，需要修复或记录风险。
- `verified`: 已审计且证据充分。
- `out_of_scope`: 与 agent harness 无直接关系，记录原因。

## Inventory Method
- Use `rg --files` for repository inventory.
- Prioritize files matching DeepAgents/LangChain/LangGraph/agent/tool/runtime/memory/skills/task/shell/filesystem/context/provider/IPC keywords.
- For every audited file, record source path, reason, evidence, result, and verification.

## Audit Checklist
| Path | Status | Reason In Scope | Evidence Read | Result | Verification |
|------|--------|-----------------|---------------|--------|--------------|
| `src/main/services/deep-agent/harness-profiles.ts` | verified | Controls DeepAgents harness profile registration, middleware/tool exclusion | Source read; installed `deepagents@1.10.5` profile resolution inspected; runtime probe for `ChatOpenAI` subclass `getName()` | Roc registers `anthropic` and `openai` profiles excluding `SummarizationMiddleware` and `execute`; current evidence supports coverage for Roc `ChatAnthropic` and `ChatOpenAI` subclass model paths | `node --input-type=module` probe showed `ChatOpenAI` subclass `getName()` returns `ChatOpenAI`; installed DeepAgents code maps that to `openai` |
| `src/main/services/deep-agent/agent-builder.ts` | verified | Central `createDeepAgent()` assembly, middleware order, native parameter passthrough | Source read with `tests/main/deep-agent-build-wiring.test.ts`; DeepAgents core reference read | Passes native `backend`, `store`, `memory`, `skills`, `subagents`, `permissions`, `interruptOn`, and `checkpointer` into `createDeepAgent`; Roc custom behavior is middleware around the native harness | Runtime/orchestration test group passed |
| `src/main/plugins/agent/deep-agent-executor.ts` | verified | Runtime workspace, tools, checkpointer/thread config, stream consumption, background-task workflow source | Source read with executor tests and LangGraph HITL/persistence references | Uses `buildDeepAgent()`, resumes with LangGraph `Command({ resume })`, and streams with stable `configurable.run_id`/`thread_id`; workspace binding and background-task tool tests cover key boundaries | Runtime/orchestration test group passed |
| `src/main/plugins/agent/runtime.ts` | verified | Owns run lifecycle, HITL interrupt handling, resume path, and runtime-local active/pending state | Source read; searched `pendingInterrupts`, `waiting_user`, `run_interrupted`, `resumeRun`; RED/GREEN approval test run | `resumeRun()` now restores persisted pending interrupts when memory is empty, rejects stale persisted interrupts unless the run is still `waiting_user`, and clears pending state on resume/cancel/complete/fail | `pnpm test -- tests/main/plugins/agent`; `pnpm typecheck`; strict unused scan; `git diff --check` |
| `src/main/plugins/agent/runtime-types.ts` | verified | Defines the `PendingInterrupt` metadata needed to resume a run | Source read | Pending interrupt metadata includes mode, task source, workflow hint, workspace path, and explicit skills; this shape is now persisted through `AgentSessionRepository` | Covered by runtime rebuild approval test and agent plugin test directory |
| `src/main/plugins/agent/run-event-log.ts` | verified | Persists chat run events that include `run_interrupted` | Source read; compared with durable pending-interrupt contract | Events remain replayable UI/history data; runtime resume continuity intentionally uses explicit pending-interrupt persistence rather than event replay because run events do not carry all resume metadata | Not changed |
| `src/main/plugins/agent/session-repository.ts` | verified | Persists task run status, task events, session messages, and now pending HITL interrupt metadata | Source read; implementation changed | Added `markRunInterrupted()` transaction plus get/clear pending interrupt methods with exact workspacePath undefined/null/value encoding | `pnpm test -- tests/main/plugins/agent`; `pnpm typecheck`; strict unused scan; `git diff --check` |
| `src/main/plugins/agent/schema.ts` | verified | Agent plugin persistence schema | Source read; implementation changed | Added `agent_pending_interrupts` table and thread index for durable HITL resume state | `pnpm test -- tests/main/plugins/agent`; `pnpm typecheck`; strict unused scan |
| `src/main/services/deep-agent/sqlite-checkpointer.ts` | verified | Durable LangGraph checkpoint/pending-write saver for Roc DeepAgents runtime | Source read; compared with local `@langchain/langgraph-checkpoint@1.1.3` `BaseCheckpointSaver` and `MemorySaver`; RED/GREEN test run | Persists checkpoints and pending writes in SQLite; special pending writes now follow official MemorySaver overwrite semantics while regular writes remain first-write-wins | Runtime/orchestration test group passed |
| `src/main/services/deep-agent/stream-consumers.ts` | verified | Projects DeepAgents message/tool/subagent streams into Roc `ChatRunEvent`s | Source read with stream consumer and executor streaming tests | Streams visible assistant text, reasoning, tool blocks, subagent events, usage metadata, and suppresses internal guardrail nudges | Runtime/orchestration test group passed |
| `src/main/services/deep-agent/stream-usage-accumulator.ts` | verified | Extracts provider usage metadata for prompt cache metrics | Source read with executor prompt-cache metric test | Reads `usage_metadata.input_tokens`, `input_token_details.cache_read`, and `cache_creation` without provider-specific cache middleware | Runtime/orchestration test group passed |
| `src/main/services/deep-agent/backend.ts` | verified | DeepAgents backend routing for workspace, memory, and skills file tools | Source read with Deep Agents memory/backend reference; `backend.test.ts` read and changed | AHA-003: explicit empty selected skills previously exposed all `/skills/`; now provided arrays are filtered and `undefined` is the only unfiltered read-only mode | Focused tests, boundary wiring tests, `pnpm typecheck`, strict unused scan, and `git diff --check` passed |
| `src/main/services/deep-agent/filesystem-tool-contract.ts` | verified | Shared file-tool route, permission, prompt, and path-normalization contract | Source read; `filesystem-tool-contract.test.ts` read | Centralizes `/workspace`, `/skills`, `/memory` routes, path field mapping, traversal/Windows path rejection, permissions, and delete-file workspace conversion | Phase 3 focused tests passed |
| `src/main/services/deep-agent/filesystem-path-policy.ts` | verified | LangChain middleware enforcing file-tool virtual path contract before DeepAgents tools run | Source read; `filesystem-path-policy.test.ts` read | Uses `wrapToolCall` to return `ToolMessage` errors for missing or invalid file-tool path args | Phase 3 focused tests passed |
| `src/main/services/deep-agent/command-tool.ts` | verified | Roc-owned shell command tool exposed to DeepAgents | Source read; `command-tool.test.ts` read | Defines `run_shell_command` with PowerShell command/cwd schema and execution-layer validation via `shell-path-guard.ts` | Phase 3 focused tests passed |
| `src/main/services/deep-agent/shell-path-guard.ts` | verified | Shared guard for `/workspace` and Linux local path leakage in Windows shell execution | Source read; shell path tests read | Rejects virtual workspace route tokens and selected Linux local paths while allowing Windows drive paths like `C:/workspace/...` | Phase 3 focused tests passed |
| `src/main/services/deep-agent/tool-effect-store.ts` | verified | SQLite persistence for side-effecting tool-call idempotency | Source read; `tool-effect-store.test.ts` read | Stores tool-call input hash and success/error state by run and tool call; reuses only matching successful effects | Phase 3 focused tests passed |
| `src/main/services/deep-agent/tool-effect-idempotency.ts` | verified | LangChain middleware preventing duplicate side-effect execution on retry/resume | Source read; `tool-effect-idempotency.test.ts` read | Wraps side-effecting tools, replays stored `ToolMessage` results, and treats MCP tools as side-effecting unless read-only hints are present | Phase 3 focused tests passed |
| `src/main/services/deep-agent/shell-path-policy.ts` | verified | LangChain middleware preventing shell virtual-path leakage before concrete tool execution | Source read; `shell-path-policy.test.ts` read; build wiring test read | Returns error `ToolMessage` for `/workspace` and Linux local paths in `run_shell_command` args before handler/RTK middleware | Phase 3 focused tests passed |
| `src/main/services/deep-agent/store-memory-backend.ts` | verified | Adapts DeepAgents StoreBackend to Roc memory file whitelist/security/capacity policy | Source read; `store-memory-backend.test.ts` read | Validates memory keys, filters read/search/list results, blocks upload/download, and validates write/edit final content | Phase 3 focused tests passed |
| `src/main/services/memory/store-slots.ts` | verified | Defines memory virtual paths, namespaces, and workspace-required behavior | Source read; `store-slots.test.ts` read | Maps global/workspace slots and rejects workspace `USER.md` plus workspace memory without workspace | Phase 3 focused tests passed |
| `src/main/services/memory/sqlite-store.ts` | verified | Durable LangGraph Store implementation used by DeepAgents StoreBackend | Source read; `sqlite-store.test.ts` read | Implements `BaseStore` over SQLite with namespace/key/value validation and basic search/list APIs | Phase 3 focused tests passed |
| `src/main/services/memory/security-scan.ts` | verified | Blocks dangerous memory writes before persistence | Source read; `security-scan.test.ts` read | Scans prompt injection, credentials, SSH backdoors, and invisible Unicode; formats bounded issue summaries | Phase 3 focused tests passed |
| `src/main/services/memory/capacity.ts` | verified | Enforces configured character limits per memory kind | Source read; `capacity.test.ts` read | Counts Unicode code points and returns formatted overflow guidance | Phase 3 focused tests passed |
| `src/main/services/skill-service.ts` | verified | Manages skill import/list/enable/delete/file tree and preview paths consumed by DeepAgents `/skills/` route | Source read; `skill-service.test.ts` read and changed | AHA-004: dot-segment skill IDs were accepted; now `.` and `..` are rejected by `normalizeSkillId()` | Skills/memory focused tests, `pnpm typecheck`, strict unused scan, and `git diff --check` passed |
| `src/main/plugins/skills/index.ts` | verified | Exposes skill capabilities used by UI and explicit skill context loading | Source read; `plugins/skills/plugin.test.ts` read | Registers list/import/setEnabled/delete/files.list/file.read capabilities over `SkillService` | Skills/memory focused tests passed |
| `src/main/services/deep-agent/prompt.ts` | verified | Builds workflow/capability prompt text consumed by agent harness | Source read; `deep-agent-prompt.test.ts` read | Uses block builder and capability summary; background-task prompt reinforces `/workspace/` virtual route versus Windows workspacePath | Prompt/context/memory plugin focused tests passed |
| `src/main/services/deep-agent/context/prompt-blocks.ts` | verified | Central prompt block assembly for memory, workspace, tools, skills, plan mode, and workflow | Source read; prompt-block/context tests read | Uses shared file-tool prompt lines, path-only explicit skill indexes, stable block hashes, and workflow-specific guidance | Prompt/context/memory plugin focused tests passed |
| `src/main/services/deep-agent/context/prompt-serialization.ts` | verified | Serializes prompt blocks with stability/hash markers | Source read; prompt-builder/prompt-block tests read | Joins block marker plus content for each prompt block | Prompt/context/memory plugin focused tests passed |
| `src/main/plugins/memory/index.ts` | verified | Exposes memory capabilities and auto-memory event subscription | Source read; `plugins/memory/plugin.test.ts` read | Registers status/read/write/snapshot capabilities and wires auto-memory writer on completed agent runs | Prompt/context/memory plugin focused tests passed |
| `src/main/plugins/memory/memory-store-repository.ts` | verified | User-facing memory read/write/status/snapshot repository | Source read; `plugins/memory/plugin.test.ts` read | Reuses memory slot resolution, security scan, capacity checks, workspace hash, and `RocSqliteStore` | Prompt/context/memory plugin focused tests passed |
| `src/main/plugins/memory/schema.ts` | verified | Memory plugin audit/events schema | Source read; `plugins/memory/plugin.test.ts` read | Creates `memory_events` and `memory_auto_audit` tables/indexes | Prompt/context/memory plugin focused tests passed |
| `src/shared/ipc.ts` | verified | Preload IPC contract for task/chat/agent surfaces | Source read; generated channel search; IPC check run | Task, lifecycle, agent, and chat methods expose background-task lifecycle and `chat.resumeRun` contracts | `pnpm check:ipc` passed |
| `src/shared/ipc-generated.ts` | verified | Generated IPC channel source of truth consumed by preload/main | Channel search read for task/chat lifecycle keys | Generated channels include background-task lifecycle and chat resume keys matching `ipc.ts` | `pnpm check:ipc` passed |
| `src/shared/ipc-schema.json` | verified | Serialized IPC schema checked for drift | Channel search read for task/chat lifecycle keys | Serialized schema matches generated IPC output | `pnpm check:ipc` passed |
| `src/shared/types/chat.ts` | verified | Shared chat run, HITL, resume, workspace, and capability request contracts | Source read | `ChatStartRunRequest` carries `enabledCapabilities`, optional `workspacePath`, `workflowHint`, `taskSource`, attachments, and explicit skill IDs; resume requests are discriminated by approval/question | AHA-001 tests and Phase 4 IPC check passed |
| `src/shared/types/task.ts` | verified | Shared task/background task state contract crossing main/preload/renderer | Source read | `BackgroundTask` persists `workspacePath` and nullable `enabledCapabilities`; `TaskRun` persists per-run `enabledCapabilities`; task status includes waiting/recovery-relevant states | AHA-005 task/shared focused tests passed |
| `src/shared/types/agent.ts` | verified | Shared enabled capability and manifest contracts used by agent/task integration | Source read | `EnabledCapabilities` is an explicit `mcpServers`/`skills` snapshot and capability manifests preserve requested/resolved/skipped capabilities | AHA-005 task/shared focused tests passed |
| `src/shared/background-task-tool-contract.ts` | verified | Shared contract for background-task proposal tool and prompt examples | Source read; shared contract test read | Keeps model-authored keys separate from runtime-injected `workspacePath` and capabilities; rejects forbidden trigger aliases through paired schema tests | `pnpm test -- tests/shared/background-task-contract.test.ts` included in AHA-005 focused run |
| `src/main/plugins/task/schema.ts` | verified | SQLite schema for task threads, runs, events, background tasks, and scheduled runs | Source read | Tables persist thread kind/status, run capabilities, background task workspace/capabilities, and scheduled-run status/skip reason | AHA-005 task/shared focused tests passed |
| `src/main/plugins/task/task-repository.ts` | verified | Task repository facade used by plugin and scheduler | Source read and changed; caller search re-run | Added `recordBackgroundTaskStartFailure()` for AHA-005; AHA-007 now rejects non-positive scheduled-run limits before SQLite query; `createBackgroundTaskProposalRequest()` has no production caller in current search and remains recorded as suspected stale helper rather than deleted | AHA-005/AHA-007 focused tests, `pnpm typecheck`, strict unused scan, `git diff --check` passed |
| `src/main/plugins/task/task-repository-mutations.ts` | verified | Task/background mutation helpers and run-start persistence | Source read | Persists background task workspace/capabilities and records real agent run starts with enabled capability snapshots; existing failure pause helper reused by AHA-005 | AHA-005 task/shared focused tests passed |
| `src/main/plugins/task/task-repository-queries.ts` | verified | Task/background query helpers and task detail/run history assembly | Source read | Reads background task workspace/capabilities and scheduled runs; detail view merges recent thread events with latest run events | AHA-005 task/shared focused tests passed |
| `src/main/plugins/task/task-repository-mappers.ts` | verified | Row-to-shared-type mapper for task/background persistence | Source read; `TaskKind` shared type compared | Maps background task capability JSON and task run capability JSON; `TaskThreadRow.kind` is typed narrowly as `ActiveTaskItem['kind']` despite DB supporting `TaskKind`; current evidence classifies this as type-level accuracy debt without reproduced runtime behavior bug | Not changed |
| `src/main/plugins/task/index.ts` | verified | Task plugin capability registration, scheduler wiring, and agent run event subscriptions | Source read and changed | `runBackgroundNow` starts agent runs in existing task thread with persisted `workspacePath` and enabled capabilities; `task.scheduledRuns.list` now requires positive integer limit | AHA-005/AHA-007 task tests passed |
| `src/main/plugins/task/scheduler.ts` | verified | Scheduled background task runtime and `agent.run.start` boundary | Source read and changed | AHA-005: automatic startup failures now create durable failed scheduled-run rows, pause the task, and refresh scheduler registration instead of only setting in-memory `lastError` | Focused scheduler test, task/shared focused tests, `pnpm typecheck`, strict unused scan, `git diff --check` passed |
| `src/main/services/deep-agent/background-task-tools.ts` | verified | DeepAgent tools for proposing, scheduling, reading, updating, and canceling background tasks | Source read; shared contract test read | Proposal tool injects runtime `workspacePath` and enabled capabilities, validates real workspace path, and keeps model-visible proposal shape minimal | AHA-005 task/shared focused tests passed |
| `src/main/plugins/task/agent-run-payloads.ts` | verified | Runtime event payload parser connecting agent events to task persistence | Source read | Validates run started/completed/failed/task-event payloads before task repository writes and resolves new workflow-hinted task threads as background threads | AHA-005 task/shared focused tests passed |
| `src/main/plugins/task/task-repository-events.ts` | verified | Mirrors agent run events into task events and status transitions | Source read | Completion/failure updates run/thread status; failure path pauses linked background task; approval events move run/thread to and from `waiting_user` | AHA-005 task/shared focused tests passed |
| `src/renderer/app/AppShell.tsx` | verified | Renderer source of current workspace context passed into chat/task run request construction | Source read and changed | Added explicit current workspace path resolution from loaded workspace or app status selected workspace before passing into `useAppTaskRuns` | AHA-006 renderer tests, `pnpm typecheck`, strict unused scan, `git diff --check` passed |
| `src/renderer/app/use-app-task-runs.ts` | verified | Renderer builds `ChatStartRunRequest` for ordinary chat, task creation, and task detail follow-up | Source read and changed | Ordinary chat/plan execution now send current workspace; task detail follow-up forwards saved detail workspace through task run payload | AHA-006 renderer tests, `pnpm typecheck`, strict unused scan, `git diff --check` passed |
| `src/renderer/views/tasks/TaskDetailView.tsx` | verified | Task detail follow-up source for background task thread continuation | Source read and changed | Follow-up payload now includes `backgroundTask.workspacePath` when present and explicit `null` for non-background-task fixtures | AHA-006 renderer tests, `pnpm typecheck`, strict unused scan, `git diff --check` passed |
| `tests/main/plugins/task/scheduler.test.ts` | verified | Scheduler regression coverage for scheduled fire, status, and start failure | Source read and changed | Added RED/GREEN regression for startup failure persistence and pause behavior | `pnpm test -- tests/main/plugins/task/scheduler.test.ts` passed |
| `tests/main/plugins/task/task-repository.test.ts` | verified | Repository contract tests for task persistence and scheduled-run limits | Source read and changed | Added RED/GREEN regression for rejecting non-positive scheduled-run limits before SQLite query | `pnpm test -- tests/main/plugins/task`; `pnpm typecheck`; strict unused scan; `git diff --check` passed |
| `tests/shared/background-task-contract.test.ts` | verified | Shared proposal-tool contract regression | Source read | Locks model-visible key set, runtime-injected workspace guidance, and forbidden trigger aliases | Included in AHA-005 task/shared focused test run |
| `tests/renderer/app-shell.test.tsx` | verified | Renderer integration coverage for chat/task request payloads crossing preload boundary | Source read and changed | Added RED/GREEN assertions for ordinary chat, plan execution, and task detail follow-up workspace propagation | `pnpm test -- tests/renderer/app-shell.test.tsx tests/renderer/task-detail-view.test.tsx` passed |
| `tests/renderer/task-detail-view.test.tsx` | verified | Direct TaskDetailView coverage for follow-up payload shape | Source read and changed | Updated direct expectation to include explicit `workspacePath: null` when fixture has no persisted background task | `pnpm test -- tests/renderer/app-shell.test.tsx tests/renderer/task-detail-view.test.tsx` passed |
| `tests/main/deep-agent-build-wiring.test.ts` | verified | Focused regression for `buildDeepAgent()` wiring | Source read; focused test run | Covers profile registration call, middleware ordering, plan mode tool exposure, hook/subagent middleware, prompt cache native handoff, and context compaction wiring | `pnpm test -- tests/main/deep-agent-build-wiring.test.ts tests/main/services/deep-agent/deep-agent-official-contracts.test.ts` passed |
| `tests/main/services/deep-agent/deep-agent-official-contracts.test.ts` | verified | Locks selected DeepAgents contract assumptions | Source read; focused test run | Covers async subagents, built-in tools excluding `execute`, DeepAgents filesystem tool behavior, empty permissions permissiveness, memory/skills passthrough, and explicit subagent skills | `pnpm test -- tests/main/deep-agent-build-wiring.test.ts tests/main/services/deep-agent/deep-agent-official-contracts.test.ts` passed |
| `src/main/services/langchain-model-factory.ts` | verified | Determines concrete LangChain model classes passed to DeepAgents | Source read; focused provider/model tests run | `anthropic_compatible` creates `ChatAnthropic`; OpenAI-compatible/OpenRouter/NVIDIA/llama.cpp paths create `ChatOpenAI` or subclasses; supports current harness profile coverage claim | Runtime probe for subclass `getName()` plus focused model factory tests passed |
| `src/main/services/langchain-openai-compatible-models.ts` | verified | Defines Roc `ChatOpenAI` subclasses used by non-OpenAI provider types | Source read; focused provider/model tests run | Subclasses do not override static `lc_name`/`getName`, so they inherit `ChatOpenAI` profile identity while adding provider-specific request/stream normalization | Runtime probe with a local `ChatOpenAI` subclass plus focused OpenAI-compatible tests passed |

## Module Notes

### Runtime And Orchestration
- Primary source paths located:
  - `src/main/plugins/agent/runtime.ts`
  - `src/main/plugins/agent/deep-agent-executor.ts`
  - `src/main/plugins/agent/session-repository.ts`
  - `src/main/plugins/agent/run-event-log.ts`
  - `src/main/services/deep-agent/agent-builder.ts`
  - `src/main/services/deep-agent/sqlite-checkpointer.ts`
  - `src/main/services/deep-agent/stream-consumers.ts`
  - `src/main/services/deep-agent/stream-usage-accumulator.ts`
  - `tests/main/plugins/agent/`
  - `tests/main/services/deep-agent/`
- Status: inventory located, detailed audit pending.

### Tools And Boundaries
- Primary source paths located:
  - `src/main/services/deep-agent/backend.ts`
  - `src/main/services/deep-agent/store-memory-backend.ts`
  - `src/main/services/deep-agent/filesystem-tool-contract.ts`
  - `src/main/services/deep-agent/filesystem-path-policy.ts`
  - `src/main/services/deep-agent/command-tool.ts`
  - `src/main/services/deep-agent/shell-path-guard.ts`
  - `src/main/services/deep-agent/tool-effect-store.ts`
  - `src/main/services/deep-agent/tool-effect-idempotency.ts`
  - `src/main/services/forge-guardrails/middleware/`
  - `src/rtk-integration/`
- Status: inventory located, detailed audit pending.

### Memory, Skills, Backend
- Primary source paths located:
  - `src/main/plugins/memory/`
  - `src/main/plugins/skills/`
  - `src/main/services/memory/`
  - `src/main/services/skill-service.ts`
  - `src/main/services/deep-agent/context/`
  - `src/main/services/deep-agent/context/explicit-skills.ts`
- Status: inventory located, detailed audit pending.

### IPC, Persistence, Contracts
- Primary source paths located:
  - `src/shared/ipc.ts`
  - `src/shared/ipc-generated.ts`
  - `src/shared/ipc-schema.json`
  - `src/shared/types/agent.ts`
  - `src/shared/types/chat.ts`
  - `src/shared/types/task.ts`
  - `src/shared/background-task-tool-contract.ts`
  - `src/main/plugins/task/`
- Status: inventory located, detailed audit pending.

### Tests And Verification
- Focused test paths located:
  - `tests/main/deep-agent-build-wiring.test.ts`
  - `tests/main/deep-agent-prompt.test.ts`
  - `tests/main/deep-agent-error-mapping.test.ts`
  - `tests/main/services/deep-agent/`
  - `tests/main/plugins/agent/`
  - `tests/main/plugins/task/`
  - `tests/shared/background-task-contract.test.ts`
  - `tests/smoke/lib/electron-smoke-capabilities.mjs`
  - `tests/smoke/lib/electron-smoke-boundary-capabilities.mjs`
  - `tests/smoke/lib/electron-smoke-task-flow.mjs`
  - `tests/smoke/lib/electron-smoke-workspace-memory.mjs`
- Status: inventory located, detailed audit pending.
