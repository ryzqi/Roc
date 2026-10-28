# Phase 8 Execa Prototype

This isolated package pins Execa 10.2.1 to evaluate the one ordinary read-only application command, `readSystemProxyText()` (`/usr/sbin/scutil --proxy`). It is not a root application dependency.

Run `npm install` once from this directory, then `npm test`. The macOS-only scutil probe compares output digests and reports only byte count and newline presence; it never prints proxy configuration. The process behavior tests use short-lived Node child processes and temporary marker files.

## Observed contract

- The initial Darwin arm64 run logged 408 bytes; this session's rerun logged 436 bytes. The count is not stable across runs, so each trial compares Node `execFile` and Execa against the same live `scutil` output; both runs matched byte-for-byte with a trailing newline. The probe logs only byte count, newline presence and equality, never proxy configuration. Execa strips final newlines by default, so `stripFinalNewline: false` is required to match.
- Node `execFile` defaults to a 1 MiB `maxBuffer`; Execa defaults to 100 MiB. The equivalent Execa adapter must set `maxBuffer: 1024 * 1024` and `timeout: 1000`.
- Execa's `forceKillAfterDelay` defaults to 5000 ms. The probe waits until a child has installed its SIGTERM handler, then verifies timeout sends TERM and escalates to KILL. AbortSignal cancellation also terminates a running child.
- `cleanup` defaults to true and kills the direct subprocess on parent exit. `killDescendants` defaults to false; setting it to true uses a Unix process group, but is best-effort and changes terminal SIGINT forwarding. The marker probe demonstrates that without the option a grandchild survives, while enabling it stops the process group.
- Execa 10.2.1 requires Node >=22, compatible with Electron 45's Node 24. Its package has 12 runtime dependencies; the isolated install added 18 packages. Roc already uses Execa 5.1.1 transitively through `shell-env@4.0.3`.
- `npm test` passes 7/7 isolated behavior tests, covering output equality, nonzero-exit fallback, final newline, maxBuffer, TERM→KILL, AbortSignal cancellation, descendant handling and parent-exit cleanup.

## Decision

Do not add Execa. The current `readSystemProxyText()` wrapper is 11 lines. A contract-preserving async adapter is 12 lines plus the import, and must retain its catch-to-empty behavior while adding the timeout, output-cap, and newline options. That gives no deletion and introduces a second Execa major version. `scutil` does not spawn descendants, so Execa's process-tree options add no value at this call site.

The trial does not replace Git's asynchronous `execFile` behavior or the research runner's sandbox, process-group, cancellation, and output-limit policies. No application source, root package manifest, or root lockfile was changed.
