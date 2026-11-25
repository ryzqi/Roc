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
