# Deep Agents Plan Progress

## Completed

- Task 2.4
  - Removed the obsolete `AGENTS.md` capability-boundary fragment from the runtime assembly path.
  - Verification: `pnpm vitest run tests/main/app-services.test.ts tests/main/deep-agent-runtime-service.test.ts`
- Task 3.1
  - Switched deep-agent store file values to read-only memory projections built from `MemoryCandidate`.
  - Added projection helpers and updated tests to assert `source`, `sourceRef`, `updatedAt`, `acceptedAt`, `reasoning`, and `validationStatus`.
- Task 3.2
  - Derived memory namespaces from the selected workspace key and added legacy migration on first access.
  - Verification: `pnpm vitest run tests/main/sqlite-store.test.ts tests/main/app-services.test.ts`
- Task 3.3
  - Aligned `RuntimeSubagent` with `deepagents` `SubAgent` and exposed per-subagent `skills` in runtime and preview shapes.
- Task 3.4
  - Moved built-in tool names to `DEEP_AGENT_BUILT_IN_TOOLS` and reused that constant in preview generation.
  - Updated preview copy to describe preview behavior without the old W2 wording.
- Task 4.1
  - Reduced `src/main/services/deep-agent/record-utils.ts` from 373 lines to 301 lines by dropping uncovered legacy fallback branches.
  - Kept the branches exercised by `tests/main/deep-agent-runtime-service.test.ts`.
- Task 4.3
  - Rechecked `deepagents` docs references and updated `docs/技术栈.md` package versions to match `package.json`.

## Skipped

- Task 4.2
  - Skipped because Task 2.3 is not complete in the current branch. `src/main/services/langchain-model-factory.ts` still injects Anthropic `cache_control`, so the "assert no residual cache_control" follow-up would be premature.

## Verification

- `pnpm vitest run tests/main/app-services.test.ts tests/main/deep-agent-runtime-service.test.ts`
- `pnpm vitest run tests/main/sqlite-store.test.ts tests/main/app-services.test.ts`
- `pnpm vitest run tests/main/app-services.test.ts tests/main/deep-agent-tools.test.ts tests/main/deep-agent-runtime-service.test.ts`
- `pnpm vitest run tests/main/deep-agent-runtime-service.test.ts`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`

## Notes

- `pnpm vitest run --coverage tests/main/deep-agent-runtime-service.test.ts` could not run because `@vitest/coverage-v8` is not installed in this workspace. Task 4.1 was completed by trimming branches not exercised by the runtime suite, then re-running the targeted runtime tests and the full test suite.
- `pnpm test` prints a Windows `node-pty` `AttachConsole failed` message from `conpty_console_list_agent.js`, but the full suite still passes (`45` files, `310` tests).
