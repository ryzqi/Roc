# Task: roc-native-reliability

**Status:** Draft — agent-reviewed; exact spec not yet user-approved.

## Purpose and evidence

Preserve the 94-case deterministic reliability contract implemented by [the native adapter](../../adapters/native/run.mjs) as a supplementary track and bring its raw evidence into the manual benchmark audit workflow. Cases cover effect/checkpoint/tool-loop/state/permissions and recovery behavior; many pilot tasks use synthetic `pilot_action` tools. They are not independent research-quality examples or a substitute for the [production lifecycle cases](../roc-harness/Task.md).

## Agent input and conditions

Inputs are exactly [the source scenarios](../../adapters/native/scenarios.mjs) and scripted transports of the native runner, backed by [its runtime](../../adapters/native/runtime.ts). The wrapper does not change case instructions or inject model providers. The native runner exercises installed Deep Agents and Roc infrastructure with deterministic fixtures. No live credential or paid API call is used; no browser or Electron UI claim.

## Environment

Use the repository dependency lock and current supported macOS runtime. Run `pnpm evaluate run --suite roc-native` from the repository root. The wrapper invokes `evaluation/adapters/native/run.mjs` in a child process, captures stdout/stderr/exit/duration, and copies its whole artifact directory after completion. Freeze source files, scenarios hash and environment. All triggers are manual. Source mutation during the run invalidates the wrapper result.

For direct adapter checks, use `pnpm evaluation:native:check`; its default output is `evaluation/.runtime/native/`. The suite wrapper retains the native evidence in its sealed run directory.

## Verification

| ID | Result | Independent evidence | Pass condition |
|---|---|---|---|
| N1 | Native reliability contracts | Original machine-readable per-case report and evidence | 94 cases present, all passed, process exit 0 |
| N2 | Retained diagnostics | Full native output, copied files and wrapper seal | Ordinary files copied in full; intentional fixture symlinks recorded as metadata without following targets; inspect verifies the snapshot |

contractPassRate is number of passed cases divided by 94. A missing/failed case is a harness failure and makes the wrapper incomplete. The wrapper has one suite-level observation; it is not 94 independent quality samples. No synthetic price is treated as actual billing; cost is unknown, as in the original report. A successful run proves deterministic reliability only; compare never returns a real-model quality pass for fixture evidence.

## Fairness and leakage

Preserve upstream internal fixtures as authored. No answers are supplied to a live model. The wrapper cannot turn the fixture's known output into research-quality evidence. The [S01 task contract](../../adapters/s01/Task.md) remains independent.

## Open decisions

The count 94 is a deliberate current contract. If the native suite changes, review the expected count, source spec and wrapper together rather than silently accepting partial coverage. No model/price decision is needed. Use the public-dataset tasks for model quality and keep native reliability status separate.
