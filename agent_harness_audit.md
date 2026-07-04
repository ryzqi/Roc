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
| `src/main/plugins/agent/run-event-log.ts` | located | Persists chat run events that include `run_interrupted` | Source read | Events remain replayable UI/history data; runtime resume continuity now uses explicit pending-interrupt persistence rather than event replay because run events do not carry all resume metadata | Not changed |
| `src/main/plugins/agent/session-repository.ts` | verified | Persists task run status, task events, session messages, and now pending HITL interrupt metadata | Source read; implementation changed | Added `markRunInterrupted()` transaction plus get/clear pending interrupt methods with exact workspacePath undefined/null/value encoding | `pnpm test -- tests/main/plugins/agent`; `pnpm typecheck`; strict unused scan; `git diff --check` |
| `src/main/plugins/agent/schema.ts` | verified | Agent plugin persistence schema | Source read; implementation changed | Added `agent_pending_interrupts` table and thread index for durable HITL resume state | `pnpm test -- tests/main/plugins/agent`; `pnpm typecheck`; strict unused scan |
| `src/main/services/deep-agent/sqlite-checkpointer.ts` | verified | Durable LangGraph checkpoint/pending-write saver for Roc DeepAgents runtime | Source read; compared with local `@langchain/langgraph-checkpoint@1.1.3` `BaseCheckpointSaver` and `MemorySaver`; RED/GREEN test run | Persists checkpoints and pending writes in SQLite; special pending writes now follow official MemorySaver overwrite semantics while regular writes remain first-write-wins | Runtime/orchestration test group passed |
| `src/main/services/deep-agent/stream-consumers.ts` | verified | Projects DeepAgents message/tool/subagent streams into Roc `ChatRunEvent`s | Source read with stream consumer and executor streaming tests | Streams visible assistant text, reasoning, tool blocks, subagent events, usage metadata, and suppresses internal guardrail nudges | Runtime/orchestration test group passed |
| `src/main/services/deep-agent/stream-usage-accumulator.ts` | verified | Extracts provider usage metadata for prompt cache metrics | Source read with executor prompt-cache metric test | Reads `usage_metadata.input_tokens`, `input_token_details.cache_read`, and `cache_creation` without provider-specific cache middleware | Runtime/orchestration test group passed |
| `src/main/services/deep-agent/backend.ts` | verified | DeepAgents backend routing for workspace, memory, and skills file tools | Source read with Deep Agents memory/backend reference; `backend.test.ts` read and changed | AHA-003: explicit empty selected skills previously exposed all `/skills/`; now provided arrays are filtered and `undefined` is the only unfiltered read-only mode | Focused tests, boundary wiring tests, `pnpm typecheck`, strict unused scan, and `git diff --check` passed |
| `src/main/services/deep-agent/filesystem-tool-contract.ts` | located | Shared file-tool route, permission, prompt, and path-normalization contract | Source read; `filesystem-tool-contract.test.ts` read | Centralizes `/workspace`, `/skills`, `/memory` routes, path field mapping, traversal/Windows path rejection, permissions, and delete-file workspace conversion | Focused tests read; not run this phase yet |
| `src/main/services/deep-agent/filesystem-path-policy.ts` | located | LangChain middleware enforcing file-tool virtual path contract before DeepAgents tools run | Source read; `filesystem-path-policy.test.ts` read | Uses `wrapToolCall` to return `ToolMessage` errors for missing or invalid file-tool path args | Focused tests read; not run this phase yet |
| `src/main/services/deep-agent/command-tool.ts` | located | Roc-owned shell command tool exposed to DeepAgents | Source read; `command-tool.test.ts` read | Defines `run_shell_command` with PowerShell command/cwd schema and execution-layer validation via `shell-path-guard.ts` | Focused tests read; not run this phase yet |
| `src/main/services/deep-agent/shell-path-guard.ts` | located | Shared guard for `/workspace` and Linux local path leakage in Windows shell execution | Source read; shell path tests read | Rejects virtual workspace route tokens and selected Linux local paths while allowing Windows drive paths like `C:/workspace/...` | Focused tests read; not run this phase yet |
| `src/main/services/deep-agent/tool-effect-store.ts` | located | SQLite persistence for side-effecting tool-call idempotency | Source read; `tool-effect-store.test.ts` read | Stores tool-call input hash and success/error state by run and tool call; reuses only matching successful effects | Focused tests read; not run this phase yet |
| `src/main/services/deep-agent/tool-effect-idempotency.ts` | located | LangChain middleware preventing duplicate side-effect execution on retry/resume | Source read; `tool-effect-idempotency.test.ts` read | Wraps side-effecting tools, replays stored `ToolMessage` results, and treats MCP tools as side-effecting unless read-only hints are present | Focused tests read; not run this phase yet |
| `src/main/services/deep-agent/shell-path-policy.ts` | located | LangChain middleware preventing shell virtual-path leakage before concrete tool execution | Source read; `shell-path-policy.test.ts` read; build wiring test read | Returns error `ToolMessage` for `/workspace` and Linux local paths in `run_shell_command` args before handler/RTK middleware | Focused tests read; not run this phase yet |
| `tests/main/deep-agent-build-wiring.test.ts` | located | Focused regression for `buildDeepAgent()` wiring | Source read | Covers profile registration call, middleware ordering, plan mode tool exposure, hook/subagent middleware, prompt cache native handoff, and context compaction wiring | Not run yet |
| `tests/main/services/deep-agent/deep-agent-official-contracts.test.ts` | located | Locks selected DeepAgents contract assumptions | Source read | Covers async subagents, built-in tools excluding `execute`, DeepAgents filesystem tool behavior, empty permissions permissiveness, memory/skills passthrough, and explicit subagent skills | Not run yet |
| `src/main/services/langchain-model-factory.ts` | located | Determines concrete LangChain model classes passed to DeepAgents | Source read | `anthropic_compatible` creates `ChatAnthropic`; OpenAI-compatible/OpenRouter/NVIDIA/llama.cpp paths create `ChatOpenAI` or subclasses; supports current harness profile coverage claim | Runtime probe for subclass `getName()`; focused tests not run yet |
| `src/main/services/langchain-openai-compatible-models.ts` | located | Defines Roc `ChatOpenAI` subclasses used by non-OpenAI provider types | Source read | Subclasses do not override static `lc_name`/`getName`, so they inherit `ChatOpenAI` profile identity | Runtime probe with a local `ChatOpenAI` subclass |

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
