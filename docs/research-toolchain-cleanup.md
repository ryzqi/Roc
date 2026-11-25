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
