# Task Plan: Roc Full Production Audit

## Goal
Audit the whole Roc codebase section by section until current evidence supports: no proven redundant code remains, production standards are met, and performance, animation, and interaction risks have been reviewed and fixed where justified.

## Current Phase
Phase 5

## Acceptance Criteria
- Every source area is inspected with local evidence: `src/main`, `src/preload`, `src/renderer`, `src/shared`, `src/rtk-integration`, `tests`, `scripts`, and relevant docs/config.
- Each completed area has findings recorded in `findings.md`, progress recorded in `progress.md`, and a self-review before moving on.
- Only evidence-backed redundant code is removed. Unproven dead code is reported, not deleted.
- Fixes are surgical and trace to a recorded finding.
- Verification matches risk: focused tests for narrow fixes, `pnpm typecheck` for TypeScript changes, `pnpm check:ipc` for shared IPC/schema changes, renderer tests or responsive smoke for UI/layout risk, strict unused scan for cleanup, and broader checks before final completion.
- After each completed area: review current diff, fix required issues, verify, then commit.
- The goal remains active until the whole repo audit and final completion audit prove the requested end state.

## Phases

### Phase 1: Recovery, Rules, Baseline
- [x] Read local project rules and command sources.
- [x] Capture current git state and existing diffs.
- [x] Confirm verification commands from local files.
- [x] Record repo map and audit order.
- **Status:** complete

### Phase 2: Automated Baseline Scans
- [x] Run strict unused/dead-code scan.
- [x] Run typecheck.
- [x] Run IPC drift check if shared contracts are touched or baseline indicates drift.
- [x] Triage failures into actionable findings.
- **Status:** complete

### Phase 3: Main Process And Services Audit
- [x] Audit `src/main` for production, redundancy, contracts, persistence, paths, errors, and performance.
- [x] Fix only proven issues.
- [x] Run focused verification and diff review.
- [x] Commit verified changes.
- **Status:** complete

### Phase 4: Shared, Preload, RTK Integration Audit
- [x] Audit `src/shared`, `src/preload`, and `src/rtk-integration` for IPC/schema drift, boundaries, and path/runtime contracts.
- [x] Fix only proven issues.
- [x] Run focused verification and diff review.
- [x] Commit verified changes.
- **Status:** complete

### Phase 5: Renderer UI, Animation, Interaction Audit
- [ ] Audit `src/renderer` for layout, interaction, animation, rendering cost, global style risk, and stale UI paths.
- [ ] Fix only proven issues without adding unrelated workflow or fields.
- [ ] Run focused renderer verification and responsive smoke when needed.
- [ ] Commit verified changes.
- **Status:** in_progress

### Phase 6: Tests, Scripts, Resources, Docs Audit
- [ ] Audit tests for stale assertions, weak coverage, duplicates, and obsolete fixtures.
- [ ] Audit scripts/config/docs for stale commands, generated-code drift, and redundant maintenance paths.
- [ ] Fix only proven issues.
- [ ] Run focused verification and diff review.
- [ ] Commit verified changes.
- **Status:** pending

### Phase 7: Whole-Repo Completion Audit
- [ ] Re-run high-value verification set for broad cleanup.
- [ ] Reconcile all findings with current state.
- [ ] Confirm every acceptance criterion has direct evidence.
- [ ] Commit final verified cleanup if needed.
- **Status:** pending

## Key Questions
1. What is the current authoritative command set for verification in this checkout?
2. Does the worktree already contain unrelated changes that must be preserved?
3. Which baseline checks reveal proven redundant or non-production code?
4. What can be safely fixed now without broad refactor or unrequested feature work?

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Use evidence-first area audit | The objective is repo-wide and cleanup must not delete useful code by name alone. |
| Commit only after area review and verification | User requested review/fix/commit after each completed part. |
| Keep unproven dead-code candidates as findings | Project rules forbid deleting code unless evidence proves it unused or redundant. |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| PowerShell `rg` path used unsupported glob form `tests\main\plugins\agent\deep-agent-executor*.test.ts` and returned `os error 123` | 1 | Re-ran with explicit file paths instead of shell glob path syntax |
| Repeated the unsupported PowerShell glob path form in a broader `rg` command and hit `os error 123` again | 2 | Switched to `rg --glob` and explicit paths for subsequent searches |
| Phase 5 initially tried to read nonexistent `src/renderer/styles.css` | 1 | Confirmed the real renderer style entry is `src/renderer/styles/index.css` |
| Added JSX to `.ts` renderer test file and esbuild failed with `Expected ">" but found "client"` | 1 | Rewrote the harness with `React.createElement` to match the file extension |

## Notes
- Re-read this plan before each area transition.
- Update `findings.md` after searches and discoveries.
- Update `progress.md` after actions, verification, errors, review, and commits.
