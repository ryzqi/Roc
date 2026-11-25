# Research toolchain dependency cleanup

Status: **Verified passing** for removal of the unused `d3-dsv` direct dependency. P5 as a whole remains incomplete; removal of the old full parser and its models depends on P3/P4 qualification.

TypeScript experiments already serialize CSV through `csv-stringify`. Their runtime identity, allowed package roots, worker request and production fixtures now contain only `csv-parse`, `csv-stringify` and `simple-statistics`. CSV expectations use literal fixtures for column order, booleans, nulls, quoted delimiters/newlines and formula strings. There is no compatibility alias or fallback. `pnpm remove d3-dsv` updated the direct declaration and lockfile; visualization dependencies still require transitive `d3-dsv`, so no package-size reduction is claimed.

Checks from `/Users/Apple_501/Desktop/Roc/Roc`:

```sh
pnpm build
node --test tests/unit/research-typescript-experiment-csv.test.mjs
node scripts/run-research-p0.mjs --test-name-pattern='explicit resource association|actual TypeScript cancellation|native experiment rerun'
```

Build passed, CSV tests passed 10/10, and actual Electron TypeScript execution/SQLite reopen, cancellation, figure/manuscript regeneration and delivery passed 3/3. An initial direct Node invocation of the integration test was rejected by its Electron prerequisite; the project runner above supplies the correct runtime. Logs remain in `.artifacts/research-toolchain-p3/{build-d3-cleanup,typescript-csv-cleanup,typescript-production-electron-cleanup}.log`. Test-owned temporary projects were removed by their cleanup hooks.

## Intermediate package and writing-tool audit

The local arm64 candidate at source commit `1557605` built, passed strict code
signature verification and passed `scripts/smoke-mac.mjs` with an isolated data
root. The main bundle in ASAR matches the current built bundle byte for byte.
This is an intermediate P1/P2/worker package, not the final P4/P6 release.

| Logical bytes | P0 | Intermediate | Change |
| --- | ---: | ---: | ---: |
| Application directory | 866,350,807 | 866,230,401 | -120,406 |
| ASAR | 117,302,854 | 117,182,448 | -120,406 |
| ASAR unpacked | 86,588,988 | 86,588,988 | 0 |
| Research toolchain | 360,029,869 | 360,029,869 | 0 |

The package target distributes `.app`, so these are logical file sizes, not
compressed ZIP/DMG download sizes or unique APFS physical allocation. The small
reduction includes all changes since P0 and is not attributed to `d3-dsv` alone.
The actual archive and external resources contain no Ovis weights or MLX runtime.
Installed source/converted weights and Python runtimes remain separate downloads;
the Ovis installation sizes are recorded in [adaptation evidence](research-ovis-adaptation.md).
The basic 18,967,109-byte model pack and the old full pack remain separate and
hash-verified; old full resources await replacement qualification.

| Writing payload | Bytes | Actual production use |
| --- | ---: | --- |
| Pandoc binary | 196,947,248 | Cited DOCX and self-contained HTML export |
| Tectonic binary | 53,686,016 | Manuscript PDF and submission-source recompilation |
| Offline TeX bundle | 36,132,746 | Tectonic's network-free package/font input |
| Typst binary | 44,768,736 | Export report with six pinned citation styles |
| Vale binary and rules | 28,080,678 | Saved-manuscript prose checks with cached provenance |

All four tools are used. A feature download split would save their respective
binary/rule payloads, with shared CSL/licenses counted separately. Tectonic and
its bundle form one capability; Pandoc conversion, Typst reports and Vale lint
can each form another. The current `ResearchToolchain.verify()` validates a
single complete manifest before every capability, so deleting optional binaries
today would also disable unrelated capabilities. Keep them in this iteration;
future distribution changes need capability-specific manifests, download and
cancel handling, and clear unavailable states before changing this contract.

Checks from the repository root used the existing native packaging environment
and `assertLiveResearchToolchainForPackaging()` before invoking:

```sh
pnpm exec electron-builder --mac --dir --arm64 --publish never \
  --config electron-builder.yml \
  --config.directories.output=.artifacts/research-toolchain-p3/package-intermediate
node scripts/research-toolchain-inventory.mjs \
  .artifacts/research-toolchain-p3/package-inventory.json \
  .artifacts/research-toolchain-p3/package-intermediate/mac-arm64/Roc.app
node scripts/smoke-mac.mjs \
  .artifacts/research-toolchain-p3/package-intermediate/mac-arm64/Roc.app
ROC_WRITING_TEST_TOOLCHAIN=.artifacts/research-toolchain-p3/package-intermediate/mac-arm64/Roc.app/Contents/Resources/research-toolchain \
  node --test tests/integration/research-scientific-writing-runtime.test.mjs
```

Writing tests passed 11/11 using the actual packaged binaries through the
production sandbox. They inspect compiled PDF text, citation output, embedded
images, DOCX ZIP contents, cache behavior and failed conversion. Smoke passed
window/native IPC, database worker, search, preview and lifecycle checks with no
reported errors. Logs, copied screenshots, file hashes and inventories remain
in the P3 artifacts (`package-intermediate*.log`, `package-intermediate-smoke/`,
`package-inventory.json`, `writing-packaged-runtime.log`, `writing-tool-audit.json`).
The task-owned intermediate package was removed after measurement; installed
toolchains, model caches and user data were retained.
