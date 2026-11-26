# Ovis installation lifecycle

`OvisInstallationManager` owns the selected model generation in one Electron main
process. Its root and specification paths must be absolute and canonical. Every
instance for the same root shares mutation reservations, acquisition counts and
progress. A durable operation marker also excludes other main processes and
preserves an unresolved reservation after the owning host exits.

Installation delegates to the verified preparation transaction: fixed official
sources and wheels, offline private environment, controlled 8-bit downloaded weight verification,
and complete inventory verification. It publishes `active.json` exclusively only
after the generation is complete. The selection pins parent and generation
filesystem identities, the managed interpreter path and complete model identity.
Existing selections are never replaced. A pre-publication cancellation removes
only the generation created by that attempt; a published selection remains
installed if cancellation arrives after the publication point. Unproven worker
exit failures retain their files and reservation for explicit diagnosis, including
failures wrapped in causes or aggregate errors.

Both library document parsing and project-directory indexing preserve the job's
input/output directory when process termination is unproven. Ordinary parse
failure and confirmed cancellation remove only the new job, preserving earlier
published artifacts and indexes. The project-index regression covers all three
unproven-exit codes through nested causes/aggregate errors, cancellation and
service shutdown. It reproduces the former unconditional deletion before the
fix; the combined lifecycle, release, incremental-index and publication batch
passes 25 tests:

```sh
node --test tests/unit/research-index-process-lifecycle.test.mjs \
  tests/unit/research-document-process-lifecycle.test.mjs \
  tests/unit/research-index-release.test.mjs \
  tests/unit/research-incremental-index.test.mjs \
  tests/unit/research-scientific-project-publication.test.mjs
```

Evidence: `.artifacts/research-toolchain-p3/index-lifecycle-red.log` and
`index-lifecycle-final.log`. The fixture does not launch an unresolved process;
its simulated errors verify the consumers' retention decisions.

`installed()` indicates a selection exists. It does not claim the payload is
healthy or quality-qualified. `acquire()` reserves the generation before checking
all recorded bytes, interpreter and inference identities, then returns an
idempotent release function. Installation and removal refuse while any acquisition
or mutation is active. Parsing callers must retain the lease until the supervised
Worker exits. No Python or MLX process starts merely to inspect model state.

Explicit removal can delete a damaged generation, but refuses changed directory
identities, aliases and symlinks. It removes only the selected generation and its
selection, leaving the shared interpreter and other files intact. Interrupted
removal can be retried; an absent generation clears only its matching selection.
The lifecycle module is not yet registered in the application model catalog and
does not adopt the separate qualification installation.

The marker is an exclusively created empty file named with macOS's kernel boot
session UUID. Concurrent holders in the owning main process share it, and the
last confirmed release removes it after checking file and directory identities.
An unresolved marker from the current boot refuses inspection, acquisition,
installation and removal with `research_ovis_previous_operation_unresolved`.
Restarting Roc alone cannot clear it: a supervised Worker may outlive its host.
Restarting macOS changes the boot identity and proves those processes are gone;
the next operation removes only intact markers from earlier boots. Corrupt or
replaced markers are preserved and reported. Diagnostic directories are not
automatically deleted by this recovery step.

This is conservative crash recovery: even a host exit after the Worker ended but
before marker removal requires an OS restart. The marker does not depend on PID
reuse checks, and no recovery action kills a process found by an old PID. Normal
cancellation, verified process exit and ordinary failures release it immediately.
The read-only `OvisModelStore` used by qualification scripts does not own model
mutation; application lifecycle callers must use `OvisInstallationManager`.

Validation from the repository root:

```sh
node --test tests/unit/research-ovis-installation-manager.test.mjs \
  tests/unit/research-ovis-installation.test.mjs \
  tests/unit/research-ovis-model-store.test.mjs
node scripts/research/verify-ovis-installation.mjs \
  --output /absolute/new-verification-directory \
  --installation /absolute/qualification-installation \
  --reference-inference .artifacts/research-toolchain-p3/smoke-8bit
pnpm build
```

All 14 filesystem/integrity regressions passed, including a separate Node process
reopening the selection. Six actual installation checks passed: a fresh generation
contained 16,625 verified entries (3,466,774,118 bytes), and its 8-bit Worker output
matched the frozen reference. Selection persistence, lease exclusion, cancellation,
damaged download isolation, corrupted-installation refusal and explicit removal
passed. All verification-owned directories were removed. Evidence is retained in
`.artifacts/research-toolchain-p3/installation-manager/report.json`. These checks
qualify lifecycle behavior; the full-cohort quality gate remains separate.

Durable reservation verification adds real host `SIGKILL` and cross-process
exclusion, shared-holder release, nested failure retention, marker replacement and
simulated boot-change recovery. The focused lifecycle/download/parser/admission
batch passed37 tests. Boot-change recovery uses a controlled boot-identity fixture;
the host-kill case uses actual separate Node processes and the actual macOS boot
UUID. Evidence: `.artifacts/research-toolchain-p3/reservation-expanded-unit.log`.
`node --test tests/integration/research-process-resources.test.mjs` passed24 native
process checks, and final `pnpm build` passed. Their logs are
`reservation-native-process.log` and `reservation-build-final.log` in the same
evidence directory. All test-created temporary directories were removed.
