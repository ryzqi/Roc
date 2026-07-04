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
| AHA-002 | verified passing | medium | LangGraph SQLite checkpointer pending writes | Official `MemorySaver.putWrites()` overwrites special negative-index writes; RED test showed Roc preserved stale `__interrupt__` value | `RocSqliteCheckpointer.putWrites()` now upserts special writes (`__error__`, `__scheduled__`, `__interrupt__`, `__resume__`) and preserves regular writes | Commit this audited segment, then continue runtime/orchestration inventory |

## Visual/Browser Findings
- None.
