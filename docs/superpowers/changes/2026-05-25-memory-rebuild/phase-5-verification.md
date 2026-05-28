# Phase 5 verification

Status: complete

## Scope

Phase 5 adds the memory consolidator path for capacity overflow:

- `LangChainModelFactory.resolveCheapModelHandle()` returns the active model handle per S4 because no tested same-provider cheap model mapping exists.
- `ConsolidatorService` backs up the existing file, calls the current model through a non-streaming handle, rejects unsafe / over-limit / empty output, and writes back only after validation.
- `/memory/` agent writes pass the current run `context.modelHandle` into consolidator scheduling.
- Tab 1 `MemoryService.writeFile()` schedules consolidation when an existing memory file rejects an over-limit write.
- `.consolidator-backup` files older than 90 days are swept during consolidation.

## Official docs alignment

- LangChain JS official docs show chat model invocation with system / human messages and `AIMessage.content` as the response text carrier:
  https://docs.langchain.com/oss/javascript/integrations/chat/ollama
- LangChain JS official docs show standard tools from `@langchain/core/tools` with Zod schemas:
  https://docs.langchain.com/oss/javascript/integrations/chat/google
- Deep Agents JS official docs still configure agents with `createDeepAgent({ model, tools, systemPrompt, backend })` and custom backend / filesystem access:
  https://github.com/langchain-ai/deepagentsjs/blob/main/libs/deepagents/README.md
  https://github.com/langchain-ai/deepagentsjs/blob/main/libs/providers/node-vfs/README.md

## Verification

Fresh commands run from `F:\Code\Roc`:

```powershell
pnpm typecheck
```

Result: PASS, exit 0.

```powershell
pnpm test
```

Result: PASS, exit 0.

Observed summary:

```text
Test Files  110 passed (110)
Tests       706 passed (706)
```

Note: the existing `node-pty` `AttachConsole failed` stderr noise appeared during Vitest, but the Vitest process exited 0.

```powershell
pnpm build
```

Result: PASS, exit 0. The build ran `pnpm typecheck` and `electron-vite build`.

Targeted evidence collected during implementation:

```powershell
pnpm test -- tests/main/memory/consolidator.test.ts
pnpm test -- tests/main/deep-agent-backend.test.ts -t "schedules consolidator"
pnpm test -- tests/main/deep-agent-backend.test.ts tests/main/deep-agent-official-contracts.test.ts tests/main/app-services.test.ts tests/main/memory/consolidator.test.ts
pnpm test -- tests/main/deep-agent-runtime-service.test.ts
pnpm test -- tests/main/memory-integration/consolidator-end-to-end.test.ts
pnpm test -- tests/main/memory-integration/consolidator-end-to-end.test.ts tests/main/memory/consolidator.test.ts tests/main/app-services.test.ts
```

All targeted commands passed.

## Checklist 5

Status: PASS via automated service-chain equivalent.

Evidence:

- `tests/main/memory-integration/consolidator-end-to-end.test.ts` writes an initial `MEMORY.md`, attempts an over-limit Tab 1 service write, receives `capacity_exceeded`, waits for the scheduled consolidator, then verifies:
  - `memory/global/MEMORY.md` contains compressed content.
  - `memory/.consolidator-backup/` contains a backup file.
- The test injects a mock LLM through `ConsolidatorService.setTestModelHooksForTestsOnly()` to avoid depending on live provider credentials or latency.

Boundary:

- No separate live UI + real provider manual run was performed in this checkpoint. The renderer Tab 1 uses the same `MemoryService.writeFile()` IPC service path covered by the end-to-end main test.

## Commits

- `e417e82 feat(memory): resolve cheap model handle from active model`
- `d6b830f feat(memory): ConsolidatorService with debounce, quota, security/capacity re-check`
- `b45f570 feat(memory): wire ConsolidatorService into WritableMemoryFilesystemBackend capacity overflow path`
- `37e85b1 test(memory): consolidator end-to-end coverage; MemoryService.writeFile schedules consolidator`
