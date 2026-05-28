# Phase 3 Verification

## Command verification

| Check | Command | Status | Evidence |
|---|---|---|---|
| Smoke syntax | `node --check tests/smoke/electron-smoke.mjs` | Verified passing | Exit 0. |
| Typecheck | `pnpm typecheck` | Verified passing | Exit 0; `tsc --noEmit -p tsconfig.json`. |
| Unit / renderer tests | `pnpm test` | Verified passing | Exit 0; `Test Files 105 passed (105)`, `Tests 680 passed (680)`. `node-pty` printed `AttachConsole failed` stderr during the run, but Vitest completed with exit 0. |
| Production build | `pnpm build` | Verified passing | Exit 0; build ran `pnpm typecheck` then `electron-vite build`; main, preload, and renderer bundles were emitted. |
| Electron smoke | `pnpm smoke:electron` | Verified passing | Exit 0; `.artifacts/wave1/electron-smoke.json` has `passed=true`, `failedChecks=[]`, and `schemaFailureCount=0`. |

## Phase 3 checklist

| Item | Status | Evidence |
|---|---|---|
| 3. Frozen snapshot appears in next-session system prompt | Verified passing | `tests/main/deep-agent-runtime-service.test.ts` asserts `createDeepAgent` receives `memory=[]`, system prompt contains `<FROZEN_SNAPSHOT>`, and the saved rule content from memory appears in the prompt. |
| 3. Memory center Tab 3 previews next-session snapshot | Verified passing | `tests/renderer/memory-view.test.tsx` loads `memory.snapshotPreview()` and renders `memory-snapshot-preview`. Final smoke writes `# smoke user\n- phase 3 snapshot`, opens Tab 3, and artifact records `memorySnapshotPreviewShowsSavedContent=true`. |

## Smoke memory evidence

- Memory API: `readFile,snapshotPreview,status,writeFile`
- Memory file editor visible: `rendererBoundary.memoryFileEditorVisible=true`
- Memory API contract: `rendererBoundary.memoryApiFileEditor=true`
- Capacity inline error: `buttonInteractionEvidence.memoryCapacityErrorVisible=true`
- Security inline error: `buttonInteractionEvidence.memorySecurityErrorVisible=true`
- Snapshot preview includes saved content: `buttonInteractionEvidence.memorySnapshotPreviewShowsSavedContent=true`

## Notes

- Phase 3 disables Deep Agents `memorySources` and injects Roc's frozen snapshot directly into the system prompt at session construction.
- The conversational "ask who I am" behavior was verified at the runtime contract level rather than with a live external model: the test inspects the exact `systemPrompt` passed to `createDeepAgent`, and smoke verifies the same saved memory appears in Tab 3.
