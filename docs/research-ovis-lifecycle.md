# Ovis installation lifecycle

`OvisInstallationManager` owns the selected model generation in one Electron main
process. Its root and specification paths must be absolute and canonical. Every
instance for the same root shares mutation reservations, acquisition counts and
progress. This is an in-process lifecycle manager, not a cross-process installer
lock; the application must retain its single-main-process ownership.

Installation delegates to the verified preparation transaction: fixed official
sources and wheels, offline private environment, controlled 8-bit conversion,
and complete inventory verification. It publishes `active.json` exclusively only
after the generation is complete. The selection pins parent and generation
filesystem identities, the managed interpreter path and complete model identity.
Existing selections are never replaced. A pre-publication cancellation removes
only the generation created by that attempt; a published selection remains
installed if cancellation arrives after the publication point. Unproven worker
exit failures retain their files for explicit diagnosis.

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
