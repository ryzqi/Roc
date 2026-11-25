# Ovis download inputs

`wheels.lock.json` derives 67 immutable wheel URLs, lengths and SHA-256 digests
from the existing `resources/ovis-ocr/requirements.lock`. It does not resolve new
versions. The selector validates PyPI release identity, wheel tags, Python
requirements and membership in the original hash set. Recreate into a new file:

```sh
~/.roc/research-models/ovisocr3-mlx-8bit/runtime/bin/python -I -B \
  scripts/research/pin-ovis-wheels.py --output /absolute/new/wheels.lock.json
```

The effective dependency floor is **macOS 15 / Apple Silicon / CPython 3.14.10**:
both the locked OpenCV and MLX Metal wheels require macOS 15. The earlier source
manifest's macOS 14 field is insufficient to describe these dependencies. That
historical specification remains frozen for the ongoing quality comparison.
Only the actual macOS 27.2.1 / M1 Pro / 32 GiB host has been exercised.

Wheel downloads total **199,429,047 bytes**, official model sources **1,728,965,773
bytes**; these exclude the separately managed uv/Python archives. Weights and
wheels are not bundled with Roc. `ovis-downloads.ts` validates the original lock
and exposes 96 fixed assets for later application installation. Its private
download transaction reports progress, hashes completed files and removes parts
after verification. The consumer must finish before cleanup. Unproven process
termination retains the consumer's input directory for recovery.

This is an unregistered installation component. It neither publishes an installed
runtime nor enables complete parsing. The existing P3 installation is unchanged.

Validation from repository root:

```sh
node --test tests/unit/research-ovis-downloads.test.mjs tests/unit/research-download-lifecycle.test.mjs
~/.roc/research-models/ovisocr3-mlx-8bit/runtime/bin/python -I -B scripts/research/test_pin_ovis_wheels.py
pnpm typecheck
node scripts/research/verify-ovis-downloads.mjs --output .artifacts/research-toolchain-p3/verified-downloads
```

Results: 7 Node regressions and 2 wheel-selector tests pass; typecheck passes.
The real network check fetched the exact official structured prompt, one pure
Python wheel and the 45.8 MB native MLX Metal wheel, verified their independent
SHA-256 digests and removed every owned download directory. The report is retained
at the output path; the verification refuses to overwrite an existing report.
It does not certify installation of all 67 wheels.

## Supervised offline package installation

`ovis-package-installer.ts` creates a new private relocatable environment using
the verified managed CPython 3.14.10 and uv 0.13.9. It accepts only the 67 pinned
wheel files, verifies their lengths and hashes before execution, installs with
`--offline --no-index --require-hashes --only-binary :all:`, and checks the exact
installed distribution set without executing site startup hooks. The installer
has no network permission, cannot build source packages, and writes only inside
its new destination. Its caller owns publication and cleanup; an unproven child
exit quarantines the lease and requires retention of the attempt.

Actual verification from the repository root:

```sh
node scripts/research/verify-ovis-packages.mjs \
  --output .artifacts/research-toolchain-p3/offline-packages-cancel-during-write
node --test tests/unit/research-ovis-package-installer.test.mjs \
  tests/unit/research-ovis-downloads.test.mjs tests/unit/research-download-lifecycle.test.mjs
pnpm typecheck
```

All four runtime checks passed: all 67 wheels installed offline with native
NumPy/Pillow/OpenCV imports; an existing destination was refused unchanged;
cancellation after actual package writes reclaimed the supervised process;
and a damaged wheel was refused before execution. The native import probe also
confirmed that network connections and shell execution were denied. All owned
download/runtime/cancellation directories were removed. Nine targeted Node
regressions and typecheck passed. Failed development attempts remain separate
reports; the first cancellation timer fired during preflight hashing and is not
counted as process cleanup evidence. Model conversion and parser adoption remain
separate gates.

## Supervised 8-bit conversion

`ovis-conversion.ts` runs the frozen converter against the exact 29 official
source files in an isolated Metal process. It imports only the fresh private
wheel installation and verified managed Python, denies network and shell access,
checks write/resource limits, and removes its private compiler cache after
confirmed process exit. It refuses existing output, overlapping input/output
directories, foreign source files and changed source/specification bytes. The
caller retains ownership of the unpublished conversion directory.

```sh
node scripts/research/verify-ovis-conversion.mjs \
  --installation ~/.roc/research-models/ovisocr3-mlx-8bit \
  --output .artifacts/research-toolchain-p3/supervised-conversion
node --test tests/unit/research-ovis-conversion.test.mjs \
  tests/unit/research-ovis-package-installer.test.mjs
pnpm build
```

The fresh managed runtime and all 67 offline wheels reproduced all **847 tensor
values, dtypes and shapes** from the frozen reference: 187 affine 8-bit/group64
language modules and 153 BF16 vision tensors. Configuration, tokenizer and
processor settings also matched. Comparison hashes tensor payloads independently
of safetensors header ordering. Existing output refusal, cancellation after
Metal cache activity, damaged-source rejection, and removal of every owned
temporary directory all passed. Four focused regressions and the full build
passed. This verifies conversion reproducibility; full-cohort quality and final
application publication remain separate gates.
