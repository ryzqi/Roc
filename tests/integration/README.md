# Research P0 integration

Run `pnpm test:research-p0` from the repository root on macOS arm64 after dependency
installation and preparation of the locked runtime at
`.runtime/research-toolchain/darwin-arm64`. Preparation and manifest verification are
documented in [the runtime guide](../../resources/research-runtime/README.md).
The suite requires the real runtime; it does not skip missing tools or replace compiled
PDFs with fixture bytes.

The scenarios run trusted chat dispatch, the real role SDK and budget ledger, native
TypeScript execution, native-text PDF parsing, Skia figures, manuscript/review repositories,
human approval and locked Tectonic/Typst compilation. Search responses and model decisions
are local fixtures. PDF parsing and figure/PDF rendering run their production implementations
in process; packaged worker isolation, OCR and live model quality are separate checks.

Reports, execution trees, source evidence, budgets/events, file hashes, both database backups,
compiled PDFs, first-page previews and the approved ZIP remain under
`.artifacts/research-optimization/p0-production/<taskId>/`. A report-compilation fault scenario
verifies failure persistence and refusal to publish or save incomplete exports.
