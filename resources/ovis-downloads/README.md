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
