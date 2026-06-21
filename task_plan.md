# Task Plan: Split Files Over 500 Lines

## Goal
Scan the repository for files over 500 lines and split applicable source/test/style files without changing behavior.

## Current Phase
Complete

## Phases

### Phase 1: Discovery
- [x] Capture user constraints
- [x] Scan current worktree for files over 500 lines
- [x] Separate generated/binary/lock files from files eligible for source split
- **Status:** complete

### Phase 2: Source Split
- [x] Split long source/style files by existing responsibility boundaries
- [x] Keep behavior, selectors, exports, and test assertions unchanged except import paths
- **Status:** complete

### Phase 3: Test Split
- [x] Split long test files by existing describe/domain groups
- [x] Keep assertions and fixtures behavior-equivalent
- **Status:** complete

### Phase 4: Verification
- [x] Re-run line-count scan
- [x] Run direct TypeScript/test/style verification
- [x] Run final diff check
- **Status:** complete

## Key Questions
1. Which files over 500 lines are generated/binary/lock artifacts and should not be hand-edited?
2. What are the smallest responsibility boundaries that can reduce each eligible file below 500 lines?
3. What commands prove no behavior changed?

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Exclude binary RTK resources and `pnpm-lock.yaml` from manual splitting | They are generated/binary/lock artifacts; splitting them would change packaging or dependency metadata, not source structure. |
| Split source and tests by existing module/describe boundaries only | User requested no functionality changes, only file splitting. |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| Generated smoke split script failed with nested template literal syntax | 1 | Switched to smaller mechanical extraction using original line ranges and fixed generated module syntax incrementally |
| First split smoke run failed `providerChatResultVisible` against stale packaged app | 1 | Rebuilt `release/win-unpacked` with `pnpm package:dir`; reran `node tests\smoke\electron-smoke.mjs` successfully |

## Notes
- User-facing replies in Simplified Chinese.
- Use PowerShell command examples.
- Do not modify functionality; every edit must be code movement, imports/exports, or file inclusion needed by the split.
