# Agent Harness Audit Findings

## Requirements
- 依次检查 Roc 代码，从 agent harness 角度评估生产环境要求。
- 优先使用 DeepAgents/LangChain/LangGraph 原生能力；不要重新实现已有能力。
- 不确定点先查询权威资料；不能猜测。
- 所有代码审计过程必须用文件追踪。
- 修复必须遵守最小改动、真实验证、Windows 路径语义、DeepAgents `/workspace/` 虚拟路径边界。

## Authoritative Sources
- `AGENTS.md` user-provided operating rules in current prompt.
- Local project files under `F:\Code\Roc`.
- Local `agent-development` references mapped to official `langchain-ai/langchain-skills`.
- Official DeepAgents/LangChain/LangGraph docs when local references or package signatures are insufficient.

## Research Findings
- `task_plan.md`、`progress.md`、`findings.md` initially missing in repository root; created for this long-running audit.
- Memory quick pass found prior Roc guidance: DeepAgents native-first, no custom prompt cache middleware, recovery/idempotency and context compaction are high-risk audit areas.
- `planning-with-files` requires persistent tracking files and updates after discoveries/actions.
- `agent-development` routes this task to Deep Agents first because Roc agent harness involves long-running planning, files, subagents, memory, and skills.
- `deep-agents-core` says TodoListMiddleware, FilesystemMiddleware, and SubAgentMiddleware are built-in and should be configured rather than reimplemented.
- `session-catchup.py` detected unsynced context for this same Codex session; unsynced content was this turn's skill/planning reads, not business-code changes.
- `coverage-map.md` says local `agent-development` references are mapped one-to-one to the official `langchain-ai/langchain-skills` set and official docs remain API authority.
- `framework-selection.md` routes Roc's harness shape to Deep Agents when planning, files, subagents, skills, and memory are first-class.
- `deep-agents-memory.md` says `StoreBackend` requires a store, `FilesystemBackend` local access needs `virtualMode`, and production store/checkpointing should not be in-memory only.
- `deep-agents-orchestration.md` says custom subagents do not inherit skills, subagents are stateless per task call, and HITL requires checkpointer plus stable `thread_id` for resume.
- `langchain-middleware.md` confirms custom middleware should use explicit hooks like `wrapToolCall`, and HITL resume uses LangGraph `Command`.
- `langgraph-persistence.md` confirms `MemorySaver`/`InMemorySaver` is not production persistence and stable `thread_id` is required for durable state.
- `package.json` uses `deepagents@1.10.5`, `langchain@1.5.2`, `@langchain/core@1.2.1`, `@langchain/langgraph@1.4.7`, `@langchain/mcp-adapters@1.1.3`, and provider packages.
- Primary agent harness source inventory is under `src/main/services/deep-agent` and `src/main/plugins/agent`, with focused tests under `tests/main/services/deep-agent` and `tests/main/plugins/agent`.
- Additional in-scope support areas found: `src/main/services/forge-guardrails`, `src/rtk-integration`, `src/main/plugins/task`, `src/main/plugins/memory`, `src/main/plugins/skills`, `src/main/plugins/mcp`, provider runtime services, shell execution services, shared IPC/types, renderer task/chat surfaces, and smoke tests for capabilities/task flow/workspace memory.
- Continuation catchup for the active Codex session surfaced only handoff/current-turn context; `git diff --stat` still shows no tracked business-code changes, and `git status --short --branch` shows only audit tracking files untracked.
- Current-round reference re-read confirmed the same native-first constraints: Deep Agents is the right top-level harness for planning/files/subagents/skills/memory; HITL and continuity require a checkpointer plus stable `thread_id`; `StoreBackend`/`CompositeBackend` route persistence by path prefix and require a store; custom middleware should use explicit LangChain hooks such as `wrapToolCall`.
- DeepAgents `getModelProvider()` in installed `deepagents@1.10.5` maps `model.getName()` values `ChatAnthropic` -> `anthropic`, `ChatOpenAI` -> `openai`, and `ChatGoogleGenerativeAI` -> `google`; `createDeepAgent()` uses that provider hint for `resolveHarnessProfile`.
- Runtime probe confirmed a `ChatOpenAI` subclass instance returns `getName() === 'ChatOpenAI'`, so Roc OpenAI-compatible subclasses remain covered by the registered `openai` harness profile.
- Installed DeepAgents creates `SummarizationMiddleware` by default and its default `historyPathPrefix` is `/conversation_history`; excluding `SummarizationMiddleware` through Roc harness profiles is justified while Roc `CompositeBackend` does not route that prefix and Roc has its own context compaction pipeline.
- Continuation re-read loaded current rules and skills for this session: `planning-with-files`, `agent-development` HITL/persistence/orchestration references, `systematic-debugging`, `test-driven-development`, `typescript`, and `maintaining-agents-md`.
- LangGraph/DeepAgents HITL references reaffirm the continuity contract for Roc audit: interrupted workflows require a durable checkpointer, stable `thread_id`, and resume through `Command({ resume })`; user approval state cannot rely only on transient renderer or runtime memory.
- `git status --short --branch`, `git diff --stat`, and `git diff --check` currently show no tracked business-code diff; only the audit tracking markdown files are untracked.
- Current AHA-001 review found two persistence boundary gaps introduced by making pending interrupts durable: `resumeRun()` needed to reject stale persisted interrupts when the run is no longer `waiting_user`, and the transition to `waiting_user` needed to persist pending interrupt metadata in the same repository transaction.

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| Treat Deep Agents as top-level expected layer for Roc agent harness audit | The harness needs planning, files, subagents, memory, skills, and long session behavior. |
| Create `agent_harness_audit.md` for file-level status | The objective requires all code analysis to be tracked, not just summarized. |
| Use local official-mapped references first, then official docs/package inspection for uncertain current APIs | Avoid stale assumptions while keeping evidence local when possible. |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| Wide `rg` search for DeepAgents symbols used an invalid regex around quotes/backslashes | Logged as attempt 1; next search will split literals or use simpler escaped patterns. |

## Risk Review Notes
- Current AHA-001 diff is limited to durable pending interrupt persistence, runtime lifecycle cleanup, and one runtime rebuild regression test.
- Review follow-up fixed stale pending interrupt resume: a persisted row no longer permits resuming a terminal run; `resumeRun()` now throws `chat_resume_run_not_waiting_user` and clears stale pending state.
- Review follow-up fixed the `waiting_user` persistence boundary: `AgentSessionRepository.markRunInterrupted()` writes run/thread status and `agent_pending_interrupts` in one transaction.
- Direct follow-up verification: `pnpm test -- tests/main/plugins/agent/session-repository.test.ts tests/main/plugins/agent/runtime-approval.test.ts` passed with 2 files and 15 tests.
- Broader AHA-001 verification after review fix: `pnpm test -- tests/main/plugins/agent` passed with 18 files and 102 tests; `pnpm typecheck` passed; strict unused scan passed; `git diff --check` passed with only CRLF normalization warning for `runtime-approval.test.ts`.
- Residual test gap: runtime rebuild resume is covered for approval interrupts; question interrupts use the same persisted `PendingInterrupt` path and have same-runtime coverage, but do not yet have a separate rebuild regression.
- Runtime/orchestration audit started after AHA-001 commit. Read `agent-builder.ts`, `deep-agent-executor.ts`, `sqlite-checkpointer.ts`, `stream-consumers.ts`, and `stream-usage-accumulator.ts`.
- `agent-builder.ts` uses native `createDeepAgent()` and passes native `backend`, `store`, `memory`, `skills`, `subagents`, `permissions`, `interruptOn`, and `checkpointer`; Roc custom code is expressed as middleware around native DeepAgents rather than replacing the harness.
- `deep-agent-executor.ts` resumes interrupted graphs with LangGraph `new Command({ resume: input.resumePayload })` and streams with stable `configurable.run_id` and `configurable.thread_id`.
- `RocSqliteCheckpointer` extends LangGraph `BaseCheckpointSaver` and persists checkpoints plus pending writes in SQLite; this is a production-directed durable replacement for in-memory checkpointing, so the next audit step is matching it against existing checkpointer tests and current LangGraph saver contract.
- Local `@langchain/langgraph-checkpoint@1.1.3` official `WRITES_IDX_MAP` maps `__error__`, `__scheduled__`, `__interrupt__`, and `__resume__` to negative indexes; its `MemorySaver.putWrites()` overwrites repeated special writes and preserves repeated regular writes.
- AHA-002 found Roc `RocSqliteCheckpointer.putWrites()` used `ON CONFLICT DO NOTHING` for all writes, so repeated `__interrupt__` or `__resume__` writes for the same task/checkpoint could keep stale values instead of the latest LangGraph special write.
- AHA-002 fix: Roc now upserts special pending writes while leaving regular pending writes first-write-wins; direct checkpointer test and runtime/orchestration test group passed.
- Phase 3 boundary audit re-read Deep Agents core/memory references: official expectations remain that filesystem tools are DeepAgents built-ins backed by configured backends/routes, while shell execution is not a DeepAgents filesystem route and must stay under Roc-owned execution guards.
- Memory quick pass reaffirmed Roc-specific path contract: file tools may use `/workspace/`, `/memory/`, and `/skills/` virtual routes; shell commands must use real Windows cwd/workspace paths and reject `/workspace` leakage in command text or `cwd`.
- `backend.ts` uses native DeepAgents `CompositeBackend` with a rejecting default backend plus explicit `/skills/`, `/memory/global/`, `/memory/workspaces/current/`, and selected `/workspace/` routes; the wrapper validates Roc virtual paths before delegating.
- `filesystem-tool-contract.ts` centralizes allowed virtual routes, permission rules, path-field mapping, prompt contract lines, traversal rejection, Windows absolute path rejection, and delete-file workspace-only conversion.
- `command-tool.ts` exposes `run_shell_command` as a Roc-owned LangChain tool; `shell-path-guard.ts` rejects `/workspace` route leakage and selected Linux local paths in both command text and explicit `cwd`.
- `tool-effect-idempotency.ts` treats write/edit/delete/shell/background-task/MCP tools as side-effecting unless tool metadata marks them read-only, and persists successful `ToolMessage` results by `runId` plus `tool_call_id` plus stable input hash.
- Focused Phase 3 tests exist at `tests/main/services/deep-agent/backend.test.ts`, `filesystem-tool-contract.test.ts`, `filesystem-path-policy.test.ts`, `command-tool.test.ts`, `shell-path-policy.test.ts`, `tool-effect-store.test.ts`, and `tool-effect-idempotency.test.ts`.
- Main Phase 3 callers found so far: `agent-builder.ts` wires filesystem path policy/idempotency middleware; `deep-agent-executor.ts` creates `run_shell_command`, `delete_file`, and routed backend; `plugins/agent/index.ts` initializes `AgentToolEffectStore`.
- Existing tests lock important Phase 3 regressions: invalid file-tool routes (`/frontend/index.html`, `/home/user/...`, `/agents/...`), Windows/UNC file paths, traversal, missing path fields, delete_file `/workspace` conversion, shell `/workspace` in command/cwd/option values, selected Linux local shell paths, and idempotent replay for repeated side-effecting tool calls.
- `agent-builder.ts` middleware order is boundary-relevant: shell path policy runs before RTK middleware; filesystem path policy runs before `ForgeFilesystemToolErrorMiddleware`; tool-effect idempotency runs after tool protocol normalization and before runtime error mapping.
- `deep-agent-executor.ts` wires `run_shell_command` to `shell.execute` with `source: 'agent'` and default cwd from the run workspace; it wires `delete_file` to `files.delete` only after `toWorkspaceRelativePath()` converts `/workspace/...` to a workspace-relative path.
- Installed `deepagents@1.10.5` `CompositeBackend` sorts routes by descending prefix length, exposes `routePrefixes` from configured routes, routes `read/write/edit` with prefix stripping, and handles `ls/glob/grep` route-prefix listing/search explicitly.
- AHA-003 found a skill route leak: runtime passes `enabledCapabilities.skills` into `createBackend()`, but `backend.ts` treated an explicit empty `selectedSkillIds` array as unfiltered read-only `/skills/`; RED showed a no-skill run could list `/skills/typescript/`.
- AHA-003 fix: `selectedSkillIds === undefined` remains the only unfiltered read-only path; any provided array, including `[]`, now uses `SelectedSkillsFilesystemBackend`, so empty enabled skills exposes no skill directories and rejects direct skill reads.
- Phase 3 memory/skills inventory spans DeepAgents backend adaptation (`store-memory-backend.ts`), memory service policy (`store-slots.ts`, `sqlite-store.ts`, `security-scan.ts`, `capacity.ts`), user-facing plugins (`plugins/memory`, `plugins/skills`, `skill-service.ts`), and DeepAgent context/prompt assembly (`context/*`, `prompt.ts`, `prompt-builder.ts`).
- `RocStoreMemoryBackend` keeps `/memory/...` writes on slot-derived `allowedKeys`, blocks upload/download APIs, filters ls/glob/grep outputs to allowed files, and validates final edit content with the same security/capacity checks used for writes.
- `store-slots.ts` maps global memory to namespace `['roc','memory','global']`, workspace memory to `['roc','memory','workspaces', workspaceHash]`, excludes workspace `USER.md`, and reports `workspace_required` when workspace memory is requested without a workspace.
- `RocSqliteStore` implements the LangGraph `BaseStore` surface over SQLite with namespace/key validation, `put/get/delete/search/listNamespaces`, and rejects reserved `langgraph` namespaces.
- Memory tests cover the important behavior branches found so far: memory whitelist rejection, workspace `USER.md` rejection, credential scan before store write, capacity overflow, edit final-content validation, slot resolution by path/scope, SQLite Store CRUD/search/list, scan redaction, and code-point capacity counting.
- AHA-004 found a SkillService path boundary bug: `normalizeSkillId()` rejected path separators but allowed `.` and `..`; because `basename('..') === '..'`, `listFiles({ id: '..' })` could resolve outside the skill root and `deleteSkill('..')` could target the Roc data root.
- AHA-004 fix: `normalizeSkillId()` now rejects `.` and `..` using the existing `skill_id_invalid` error path; focused RED/GREEN test passed.
- Prompt/context assembly uses shared `ROC_FILE_TOOL_PROMPT_LINES`, emits stable prompt block markers, keeps explicit skills as path-only indexes, and directs agents to read selected `SKILL.md` files through `/skills/` rather than embedding full skill contents.
- Memory plugin capabilities (`memory.status.get`, `memory.file.read`, `memory.file.write`, `memory.snapshot.preview`) run through `MemoryStoreRepository`, which reuses the same slot resolution, security scan, capacity checks, workspace hash, and `RocSqliteStore` as the DeepAgents memory backend path.
- Prompt/context tests lock SKILL.md non-echo guidance, Roc virtual route prompt lines, `run_shell_command` `/workspace` warning, capability summary sorting, plan-mode no-mutation guidance, explicit skill path index without full contents, and background-task workflow constraints.
- Memory plugin tests lock the user-facing memory capability contract: five virtual slots, workspace hash namespaces, current workspace provider resolution, workspace-required behavior, workspace `USER.md` rejection, security/capacity failures, snapshot preview, and automatic memory audit/write paths.
- Phase 4 reference re-read confirms the contracts to audit: LangGraph persistence requires stable `thread_id` plus durable checkpointer/store; HITL resume must use `Command({ resume })`; interrupt payloads must be JSON-serializable; side effects before interrupts must be idempotent; DeepAgents filesystem/memory persistence depends on routed backend prefixes rather than ad hoc path handling.
- Phase 4 shared contract read: `ChatStartRunRequest` carries `enabledCapabilities`, optional `workspacePath`, `workflowHint`, `taskSource`, and explicit skill IDs; `BackgroundTask` carries persisted `workspacePath` and nullable `enabledCapabilities`; generated IPC channels include `chat.resumeRun` and background task lifecycle channels matching `src/shared/ipc.ts`; `pnpm check:ipc` passed with generated files current.
- Initial task repository read found `background_tasks.enabled_capabilities_json` is persisted and mapped, while the synthetic run inserted by `createBackgroundTaskRecord()` currently stores empty capabilities; this needs scheduler/run-chain evidence before classifying as a bug because later fired agent runs may create separate `task_runs` with real capabilities.
- AHA-005 found scheduler start-boundary persistence gap: if automatic `TaskScheduler.fire()` reaches `agent.run.start` and that capability throws before an `agent.run.started` event exists, the previous code only set in-memory `lastError`; RED test showed no `scheduled_task_runs` failed row and no `pause_and_report` task pause.
- AHA-005 fix: scheduler now records `scheduled_task_runs.status = 'failed'` with `skipReason: 'agent_start_failed'`, reuses background-task failure pause behavior, and refreshes scheduler registration for the paused task.
- Agent persistence contract read: `agent_pending_interrupts` stores `run_id`, `thread_id`, interrupt payload, mode, task source, workflow hint, explicit skill IDs, and workspace path using an explicit `undefined`/`null`/`value` state; `AgentSessionRepository.markRunInterrupted()` writes run/thread `waiting_user` state and pending metadata in one transaction.
- Agent capability/IPC contract read: `agent.run.start`, `agent.run.resume`, event replay, active run, sessions list/search, and capability preview descriptors live in `src/main/plugins/agent/index.ts`; preload chat methods route through `src/main/ipc/plugin-capability-adapter.ts` to those capability names.
- Continuation quick pass found only `findings.md` modified with the two agent persistence/IPC notes above; no business-code diff exists before continuing the next Phase 4 candidate.
- Memory quick pass for `workspacePath` found prior accepted contract: background-task creation and run execution are separate contract surfaces; saved `workspacePath`/`enabledCapabilities` snapshots should feed run-level `ChatStartRunRequest`, and runtime workspace binding is the drift-prone area.
- Phase 4 workspacePath candidate evidence: `use-app-task-runs.ts` still hardcodes ordinary chat `workspacePath: null`, while `deep-agent-executor.ts` treats null/undefined as current workspace and `plugins/agent/index.ts` SessionEnd hook treats null as no workspace/root cwd.
- Existing renderer tests already expect workbench task creation to pass `workspacePath: 'F:\\Code\\Roc'`; the stale contract is the plan-execute/ordinary-chat assertion expecting `workspacePath: null`.
- RED renderer test confirmed the workspacePath split: ordinary chat, plan execution, and task detail follow-up all sent `workspacePath: null` before the fix, even when current or saved task workspace paths were available.
- AHA-006 GREEN path: renderer request construction now passes current workspace for ordinary chat/plan execution and saved background-task workspace for task detail follow-up; focused AppShell and TaskDetailView renderer tests passed after the change.
- Phase 4 task repository read: `TaskThreadRow.kind` is typed as `ActiveTaskItem['kind']` even though `task_threads.kind` stores `TaskKind`; current evidence makes this a type-level audit note, not a runtime behavior bug.
- Background task creation persistence path uses `createBackgroundTaskRecord()` to insert a synthetic initial `task_runs` row with empty capabilities while `background_tasks.enabled_capabilities_json` stores the preview snapshot; this needs run-history/UI evidence before classifying as a bug.
- Background task detail read shows `getTaskDetail()` lists all runs for the task thread, so the synthetic creation run can appear in `runHistory`; current renderer only uses background-task `runCount`/metadata for task summaries, so empty synthetic-run capabilities are not yet proven user-visible behavior.
- Residual `workspacePath: null` search after AHA-006 found no production renderer `chat.startRun` request construction still hardcoding null; remaining matches are main/runtime type surfaces and explicit null test fixtures.
- `TaskRepository.createBackgroundTaskProposalRequest()` builds a workflow-hinted task request without workspacePath but current search found no production callers; it is only covered by `task-repository.test.ts`, so this is a suspected stale helper, not a fix target without further evidence.
- AHA-007 found a scheduled-run pagination boundary gap: `task.scheduledRuns.list` accepted any integer `limit`, and `TaskRepository.listScheduledRuns()` passed non-positive values directly into SQLite `LIMIT`; RED showed `limit: 0` did not throw.
- AHA-007 fix: `task.scheduledRuns.list` schema now requires a positive integer limit, and repository rejects non-positive limits with `scheduled_runs_limit_invalid` before querying SQLite.

## Resources
- `C:\Users\任彦舟\.codex\skills\agent-development\references\coverage-map.md`
- `C:\Users\任彦舟\.codex\skills\agent-development\references\framework-selection.md`
- `C:\Users\任彦舟\.codex\skills\agent-development\references\deep-agents-core.md`
- `C:\Users\任彦舟\.codex\skills\agent-development\references\deep-agents-memory.md`
- `C:\Users\任彦舟\.codex\skills\agent-development\references\deep-agents-orchestration.md`
- `C:\Users\任彦舟\.codex\skills\agent-development\references\langchain-middleware.md`
- `C:\Users\任彦舟\.codex\skills\agent-development\references\langgraph-persistence.md`
- `package.json`
- `src/main/services/deep-agent/`
- `src/main/plugins/agent/`
- `tests/main/services/deep-agent/`
- `tests/main/plugins/agent/`

## Audit Findings
| ID | Status | Severity | Area | Evidence | Finding | Next Step |
|----|--------|----------|------|----------|---------|-----------|
| AHA-001 | verified passing | high | Agent runtime HITL continuity | RED test reproduced `chat_resume_no_pending_interrupt`; review RED test reproduced stale persisted interrupt resume; repository RED test reproduced missing atomic interrupted-run persistence API; verification passed after fixes | After process restart or runtime reconstruction, a DB-persisted `waiting_user` run can resume using persisted interrupt metadata; stale persisted rows on terminal runs are rejected; `waiting_user` and pending metadata are written in one repository transaction | Committed as `e7302d1`; continue runtime/orchestration inventory |
| AHA-002 | verified passing | medium | LangGraph SQLite checkpointer pending writes | Official `MemorySaver.putWrites()` overwrites special negative-index writes; RED test showed Roc preserved stale `__interrupt__` value | `RocSqliteCheckpointer.putWrites()` now upserts special writes (`__error__`, `__scheduled__`, `__interrupt__`, `__resume__`) and preserves regular writes | Committed as `c1158e3`; continue tools/filesystem/shell boundary inventory |
| AHA-003 | verified passing | high | DeepAgents skills backend authorization | RED test showed `selectedSkillIds: []` still listed `/skills/typescript/`; direct backend source showed empty array selected unfiltered read-only backend; verification passed after fix | `/skills/` now filters whenever `selectedSkillIds` is provided; no-skills runs expose no skill directories through file tools | Committed as `7c178c1`; continue Phase 3 memory/skills/backend inventory |
| AHA-004 | verified passing | high | Skill service path boundary | RED test showed `listFiles({ id: '..' })` did not throw before resolving filesystem paths; verification passed after fix | `SkillService.normalizeSkillId()` now rejects `.` and `..` IDs before any filesystem operation | Committed as `de532da`; continue Phase 3 remaining prompt/context/memory plugin inventory |
| AHA-005 | verified passing | medium | Background task scheduler persistence | RED test in `tests/main/plugins/task/scheduler.test.ts` failed with `scheduled_task_runs` empty after `agent.run.start` threw; focused and task tests passed after fix | Scheduler startup failures are now durable: failed scheduled run row is recorded, `lastRunStatus` becomes `failed`, and the task pauses per `pause_and_report` | Committed as `34799cc`; continue Phase 4 contract/persistence audit |
| AHA-006 | verified passing | medium | Renderer chat workspace contract | RED renderer test showed ordinary chat, plan execution, and task detail follow-up sent `workspacePath: null`; focused GREEN tests passed after request construction fix | Renderer now sends selected/current workspace for ordinary chat and saved background-task workspace for task detail follow-up so executor and lifecycle hooks receive the same run workspace | Committed as `142a080`; continue Phase 4 audit |
| AHA-007 | verified passing | low | Scheduled run list pagination contract | RED repository test showed `limit: 0` did not throw before querying SQLite; task plugin tests passed after fix | Scheduled-run list limits must be positive at both capability schema and repository boundaries, avoiding unbounded/invalid SQLite `LIMIT` behavior | Commit verified fix and continue Phase 4 audit |
| Phase 3 | verified passing | n/a | Tools, filesystem, shell, memory, skills | Focused tests passed for backend/path policy/shell/tool-effect, memory/skills, prompt/context, and plugin boundaries | Phase 3 audit complete; audit records committed as `85e0d01` and `86c18eb` | Continue Phase 4 contracts/IPC/persistence/tests audit |

## Visual/Browser Findings
- None.
