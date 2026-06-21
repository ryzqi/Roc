# Findings & Decisions

## Requirements
- Scan `F:\Code\Roc` sequentially for files over 500 lines.
- Split files over 500 lines when they are applicable source/test/style files.
- Do not change functionality.
- Do not hand-edit generated output, binary artifacts, release/dist output, or lock files unless explicitly required.
- Verify the current worktree, not prior assumptions.

## Research Findings
- Initial scan excluding `node_modules`, `dist`, `release`, `out`, `coverage`, and lock patterns found these eligible long files:
  - `tests/smoke/electron-smoke.mjs` 3353
  - `tests/main/langchain-model-factory.test.ts` 2211
  - `src/main/services/langchain-model-factory.ts` 1330
  - `src/renderer/styles/shared.css` 1320
  - `tests/renderer/settings-model.test.ts` 1250
  - `tests/main/config-service.test.ts` 1241
  - `src/main/plugins/task/task-repository.ts` 1234
  - `tests/main/plugins/task/plugin.test.ts` 1142
  - `tests/main/plugins/agent/runtime.test.ts` 1072
  - `tests/renderer/chat-transcript.test.ts` 1012
  - `src/renderer/app/AppShell.tsx` 1007
  - `src/renderer/styles/settings.css` 913
  - `src/renderer/settings/sections/providers-section.tsx` 910
  - `tests/main/plugins/agent/deep-agent-executor.test.ts` 893
  - `src/renderer/settings/provider-draft-model.ts` 828
  - `src/main/plugins/agent/deep-agent-executor.ts` 778
  - `src/renderer/styles/chat.css` 604
  - `tests/renderer/app-shell.test.tsx` 587
  - `src/main/services/shell-execution-service.ts` 583
  - `src/main/plugins/agent/runtime.ts` 572
  - `src/main/services/deep-agent/stream-consumers.ts` 567
  - `src/renderer/styles/app-shell.css` 556
  - `src/main/services/git-service.ts` 555
  - `src/main/index.ts` 534
  - `src/renderer/workbench/GitWorkbench.tsx` 511
  - `src/main/plugins/task/index.ts` 502
- Excluded from splitting:
  - `resources/rtk-binaries/**/rtk*` binary resources with line counts from byte interpretation.
  - `pnpm-lock.yaml` lockfile.

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| Preserve exports and IPC/schema contracts while extracting helpers/components/styles | Required for behavior-equivalent file splitting. |
| Prefer new sibling files next to original long files | Keeps ownership and import paths local. |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| Initial `apply_patch` for `src/main/index.ts` did not match current import context | Re-read current file head/tail and applied smaller patch. |

## Resources
- `task_plan.md`
- `progress.md`
