# Phase 6 Verification

Status: complete

Date: 2026-05-28 Asia/Shanghai

## Scope

Phase 6 adds the proactive pre-compaction flush path:

- `memory_flush_marks` stores one idempotency mark per thread.
- `PrecompactionService` gates flushes by enabled flag, token ratio, configured context window, and 24h per-thread idempotency.
- `DeepAgentRuntimeService` runs a hidden follow-up turn after the visible run completes when usage crosses the configured threshold.
- Hidden flush turns are archived as `phase='pre_compaction_flush'` and suppressed from visible runtime events/task event persistence.
- Flush prompt targets `/memory/global/USER.md`, `/memory/workspaces/current/MEMORY.md`, and `/memory/workspaces/current/AGENTS.md`, then requires `FLUSH_DONE`.

## Official Docs Alignment

Fresh official-doc checks were performed through Context7 before this verification document was written:

- Deep Agents JS `/langchain-ai/deepagentsjs`: current examples still use `createDeepAgent({ model, tools, systemPrompt })`, and sandbox/filesystem examples show backend or filesystem middleware customization.
- LangGraph JS `/websites/langchain_oss_javascript_langgraph`: current event-streaming docs show `streamEvents(input, { version: "v3" })`, consuming `stream.messages`, and awaiting `stream.output`.
- LangChain JS `/websites/langchain_oss_javascript`: current tool examples use `tool` from `@langchain/core/tools` with Zod schemas and chat model/tool invocation through `invoke`.

Roc keeps the existing local package contract from `package.json`: `deepagents@1.10.2`, `@langchain/langgraph@1.3.2`, `langchain@1.4.1`, `@langchain/core@1.1.47`.

## Command Verification

Fresh commands run from `F:\Code\Roc` after the checklist 6.5 security fix:

| Check | Command | Status | Evidence |
|---|---|---|---|
| Typecheck | `pnpm typecheck` | Verified passing | Exit 0; `tsc --noEmit -p tsconfig.json`. |
| Unit / renderer tests | `pnpm test` | Verified passing | Exit 0; `Test Files 113 passed (113)`, `Tests 720 passed (720)`. Existing `node-pty` `AttachConsole failed` stderr appeared, but Vitest completed with exit 0. |
| Production build | `pnpm build` | Verified passing | Exit 0; build ran `pnpm typecheck` and `electron-vite build`. |
| Electron smoke | `pnpm smoke:electron` | Verified passing | Exit 0; `better-sqlite3` rebuild completed; latest `.artifacts/wave1/electron-smoke.json` has `passed=true`, `smokeTarget.kind=dist-main-fallback`, `packagedExeExists=true`. |

Targeted Phase 6 evidence collected during implementation:

| Target | Command | Evidence |
|---|---|---|
| DDL | `pnpm test -- tests/main/memory/flush-marks-ddl.test.ts` | `memory_flush_marks` table exists and upsert behavior works. |
| Service gate | `pnpm test -- tests/main/memory/precompaction.test.ts` | Threshold, disabled flag, 24h idempotency, context window, and prompt content covered. |
| Runtime hidden turn | `pnpm test -- tests/main/deep-agent-runtime-service.test.ts -t "pre-compaction flush"` | Hidden flush run is triggered, visible UI stream excludes `FLUSH_DONE`, and archive rows use `pre_compaction_flush`. |
| Runtime/app integration | `pnpm test -- tests/main/deep-agent-runtime-service.test.ts tests/main/app-services.test.ts tests/main/memory/precompaction.test.ts` | Exit 0; `3 passed`, `82 tests passed`. |
| Integration coverage | `pnpm test -- tests/main/memory-integration/pre-compaction-flush.test.ts` | Exit 0; `1 passed`, `3 tests passed`. |
| Credential redaction | `pnpm test -- tests/main/memory/security-scan.test.ts tests/main/memory/memory-service-write.test.ts tests/main/memory-integration/writable-memory-backend.test.ts` | Exit 0; `3 passed`, `29 tests passed`; AWS key excerpt no longer exposes the full key. |

## Checklist

| Item | Status | Evidence |
|---|---|---|
| 7. Context reaches 85%, silent flush turn triggers, UI does not show it, archive has `pre_compaction_flush` | Verified by automated runtime proxy | `tests/main/deep-agent-runtime-service.test.ts` mocks a visible run at `180000/200000` tokens, asserts a second hidden `streamEvents` call, asserts visible deltas only contain the user-visible answer, and asserts `session_messages` rows include `phase='pre_compaction_flush'` with `FLUSH_DONE`. |
| 24h idempotency | Verified passing | `tests/main/memory/precompaction.test.ts` and `tests/main/memory-integration/pre-compaction-flush.test.ts` cover same-thread suppression and different-thread independence. |
| Flush prompt target paths | Verified passing | `tests/main/memory-integration/pre-compaction-flush.test.ts` asserts `/memory/global/USER.md`, `/memory/workspaces/current/MEMORY.md`, `/memory/workspaces/current/AGENTS.md`, `FLUSH_DONE`, and the invisible-turn warning. |
| Checklist 6.5 credential excerpt boundary | Verified passing | A red/green fix now asserts `AKIAIOSFODNN7EXAMPLE` is not present in `matchExcerpt` or formatted security scan output. |

Boundary:

- No live long-conversation + external-model manual run was performed for the 85% trigger. The runtime test covers the exact Roc trigger/visibility/archive contract without provider latency or token-cost dependency.

## Commits

- `5cbd312 feat(db): memory_flush_marks table for Pre-Compaction idempotency`
- `9fbf43b feat(memory): PrecompactionService with threshold + 24h idempotency`
- `aff085b feat(deep-agent): trigger silent pre-compaction flush turn at 85% context usage`
- `e5f7218 test(memory): pre-compaction flush idempotency and prompt content`
- `affd203 fix(memory): redact credential excerpts in security scan`
