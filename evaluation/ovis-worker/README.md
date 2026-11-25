# Ovis MLX process isolation qualification

This P3 probe uses the real production `runResearchProcess` supervisor, process
resource admission and deny-default Seatbelt profile. It does not register a
parser, enable full parsing or qualify model accuracy.

```sh
node evaluation/ovis-worker/probe.mjs \
  /Users/Apple_501/.roc/research-models/ovisocr3-mlx-8bit \
  .artifacts/research-toolchain-p3/worker-sandbox-first.json
```

The installation receipt is bound to the already frozen three-page reference
configuration. The probe verifies the entire installed MLX runtime file set,
modes, hashes and link targets, the base interpreter and its shared library. It
compares the complete Python code tree before/after execution. Python starts
with `-I -S -B`; only the pinned runtime site-packages directory is added
explicitly, without executing site startup hooks.

Only the runtime, base Python, macOS system libraries and a private job directory
are readable. Only the private job directory is writable. A real readable
outside fixture and listening loopback socket establish that refusal is due to
the sandbox, rather than a missing file or unavailable server. Outside file
read/write, network, an unapproved executable, `setsid` and `setpgid` must all
fail with an access error. The same MLX computation must fail without the GPU
grant and succeed with it, using the existing three IOKit user client classes.
No ordinary Python experiment permission is changed.

On the tested M1 Pro / 32 GiB / macOS 27.2.1 machine all checks passed. MLX 0.32.5
performed an actual Metal reduction with the expected result. The receipt at
`.artifacts/research-toolchain-p3/worker-sandbox-first.json` records the runtime
code hash, resource samples and admission times. This small computation is not
evidence that a complete model invocation fits within this sandbox or memory
budget. Full model, cancellation and repeated-load qualification remain separate.

MLX 0.32.5 documents `set_memory_limit` as a **guideline**, not a hard allocation
limit. The probe records this explicitly. Process RSS and CPU are separately
monitored by Roc. Temporary jobs and denial fixtures are removed on completion;
the evidence JSON is retained and cannot be overwritten by the command.

## Complete 8-bit inference

```sh
node evaluation/ovis-worker/infer.mjs \
  /Users/Apple_501/.roc/research-models/ovisocr3-mlx-8bit \
  .artifacts/research-toolchain-p3/worker-full-scoped-cache
```

The complete model initially failed because Metal dynamically compiles kernels
through Apple's MTLCompilerService, whose module cache is outside the job.
`MTL_SHADER_CACHE_PATH` and `CLANG_MODULE_CACHE_PATH` did not redirect that cache
on the tested machine. The worker now selects a private Darwin cache suffix
before importing MLX. The supervisor permits compiler read/write extensions
only for that explicitly writable cache and only for GPU jobs. Other writable
paths and ordinary experiment jobs cannot issue extensions. The existing
file/byte limits cover the cache. Its sole permitted symlink form is Metal's
transient `com.apple.metalfe/.../*.pcm.lock` pointing to a hexadecimal lock name
in the same directory; the auditor never follows the target.

All four real model scenarios passed on this machine: two identical pages in
one model load with identical raw hashes and EOS, cancellation after generated
bytes, termination at a monitored 128 MiB RSS boundary, and successful restart
after both failures. Every worker exited. The pinned inference script, receipt
and runtime code hash were unchanged. The private job and cache were removed;
outputs and the report remain under the command's output directory.

The first successful pair took 36.29 / 25.49 seconds per page, with 1.41 seconds
for model loading and sampled peak process RSS of 1,775,419,392 bytes. These are
mixed-host-load observations, not performance qualification. The 4 GiB MLX
allocation guideline and 6 GiB monitored worker RSS limit do not bound the
system compiler service or establish support for lower-memory Macs. This
one-page repeated fixture qualifies the worker lifecycle, not corpus accuracy.

Checks from the repository root:

```sh
pnpm build
node --test tests/integration/research-metal-compiler.test.mjs
node --test tests/integration/research-process-resources.test.mjs \
  tests/integration/research-process-guard.test.mjs \
  tests/unit/research-compute-policy.test.mjs
```

Build passed; native Metal tests passed 3/3; supervisor regressions passed 29/29.
The native tests directly check extension refusal, compile and execute a real
32-element Metal kernel, and reject lock targets outside the cache and output
symlinks. A separate MLX custom-kernel probe also passed alongside filesystem,
network, executable and process-group denial checks. Evidence is retained in
`metal-compiler-tests-final.log`, `metal-cache-supervisor-regressions.log`,
`build-metal-cache.log` and `metal-cache-lock-scoped.json` under the P3 artifacts.
