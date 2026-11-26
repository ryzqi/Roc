# OvisOCR3 production model

Production downloads prequantized `fwgpiyawudk/OvisOCR3-mlx-8bit` at revision
`702a71f233a208be050b12779ee29fdd1eb2dab3`, using `prequantized.lock.json`.
It does not run local conversion. Roc’s model settings own installation, progress,
cancellation and removal; the installed model is separate from the application.
Only `parse.py`, `prequantized.lock.json`, `requirements.in` and `requirements.lock`
are packaged. The current pinned wheels require Apple Silicon and macOS 15+.
See the [installation contract](../../docs/research-ovis-lifecycle.md) and
[final validation record](../../docs/research-toolchain-validation.md) for current
commands, actual installation evidence and the limits of quality claims.

## Historical local-conversion experiment

The material below documents the earlier experiment. It is retained to reproduce
its historical evidence and is not the application installation procedure.
The user subsequently selected a ready-quantized HF model and stopped comparisons.
The macOS 14 floor stated in this historical section was superseded by the pinned
wheel audit; no current macOS 14 support is claimed.

This standalone preparation tool builds an isolated, reproducible MLX runtime from
the official `ATH-MaaS/OvisOCR3` revision
`5b252386ba615bd464a5a26597560eaba87dae5c`. It does not change Roc's parser or select
this model in the application. Conversion is not evidence of successful inference
or acceptable OCR quality; the receipt explicitly says `converted-unvalidated`.

`manifest.json` pins all 29 source files (including all 18 official task prompts),
their byte lengths and SHA256 hashes, the official uv 0.13.9 archive and binary,
and the conversion settings. Large source hashes come from the revision's
Hugging Face LFS metadata; small source hashes were computed from the pinned
revision's bytes. The source repository does not contain `processor_config.json`;
MLX-VLM generates processor files during conversion and the receipt hashes them.
No third-party quantized weights or upstream executable model code are used.

The runtime requires existing, standard CPython **3.14.10** on Apple Silicon
macOS 14 or newer. Python is never downloaded, upgraded, or selected through a
mutable minor-version alias. `requirements.lock` pins all 67 runtime distributions
with hashes; installation accepts wheels only, uses a private relocatable venv,
and does not execute source package build scripts. This is a host-resolved lock,
prepared on macOS 27.2.1 arm64; inference compatibility on any OS is still untested.

From the repository root, after the P0 baseline gate permits P3 installation:

```sh
/Users/Apple_501/.local/share/uv/python/cpython-3.14.10-macos-aarch64-none/bin/python3.14 \
  -I -S -B scripts/research/prepare-ovis-ocr.py \
  --python /Users/Apple_501/.local/share/uv/python/cpython-3.14.10-macos-aarch64-none/bin/python3.14 \
  --root /absolute/existing-parent/ovisocr3-mlx-8bit
```

`--root` must be absolute and its parent must already exist. A new destination is
prepared under a private sibling lock/staging directory and published with an
exclusive atomic rename. The tool never replaces a pre-existing destination.
Repeating the same command rehashes an exactly matching ready installation; any
change to the interpreter identity (version, executable and shared library), specification or recorded files
fails. Add `--verify-only` for a strictly read-only check. Verification hashes the
full runtime, source and output, so it reads several GB from disk.

The retained installation contains `tools/uv`, `runtime/`, `source/` (1.73 GB of
verified official sources, retained for the original-weight comparison),
`model-8bit/`, `spec/`, and `receipt.json`. Language weights use affine 8-bit RTN,
group size 64; vision weights remain bfloat16. The converter checks quantization
configuration and safetensors metadata. It does not run an OCR prompt. Remote
model code is disabled and Hugging Face/Transformers operate offline during
conversion. This is not the future Roc Worker sandbox or its Metal policy.

Downloads and package caches live only in owned staging and are removed before
publication. Failures and SIGINT/SIGTERM terminate the active process group and
remove owned staging. An uncatchable kill or machine crash can leave the explicit
`.DESTINATION.preparing` lock; a subsequent run refuses it without deleting it.
No previous model, environment, profile, or project data is removed.

The following source-only checks do not install packages or download weights:

```sh
/Users/Apple_501/.local/share/uv/python/cpython-3.14.10-macos-aarch64-none/bin/python3.14 \
  -I -B resources/ovis-ocr/test_prepare.py
/Users/Apple_501/.local/share/uv/python/cpython-3.14.10-macos-aarch64-none/bin/python3.14 \
  -I -S -B scripts/research/prepare-ovis-ocr.py --help
```

To intentionally regenerate the dependency lock (review its diff):

```sh
/opt/homebrew/bin/uv pip compile --no-config --no-cache --no-python-downloads \
  --python /Users/Apple_501/.local/share/uv/python/cpython-3.14.10-macos-aarch64-none/bin/python3.14 \
  --python-version 3.14.10 --only-binary :all: --generate-hashes --no-annotate --no-header \
  --default-index https://pypi.org/simple resources/ovis-ocr/requirements.in \
  --output-file resources/ovis-ocr/requirements.lock
```

Primary sources: [official model revision](https://huggingface.co/ATH-MaaS/OvisOCR3/tree/5b252386ba615bd464a5a26597560eaba87dae5c),
[uv release](https://github.com/astral-sh/uv/releases/tag/0.13.9),
[MLX-VLM 0.8.1](https://pypi.org/project/mlx-vlm/0.8.1/).

## Paired page evaluation

`infer.py` prepares the P3 comparison of original bfloat16 weights and the 8-bit
conversion. Run each variant in a separate process using the same input manifest.
Inputs are already-rasterized local page images; PDF rasterization and quality
scoring against ground truth remain separate benchmark steps.

The input JSON contains explicit identifiers, absolute image paths and hashes:

```json
{
  "schemaVersion": 1,
  "pages": [
    {"id": "paper-01-page-001", "image": "/absolute/cohort/page-001.png", "sha256": "ACTUAL_64_CHARACTER_SHA256"},
    {"id": "paper-01-page-002", "image": "/absolute/cohort/page-002.png", "sha256": "ACTUAL_64_CHARACTER_SHA256"}
  ]
}
```

After installation, from the repository root (replace the absolute paths):

```sh
/absolute/existing-parent/ovisocr3-mlx-8bit/runtime/bin/python -I -B \
  resources/ovis-ocr/infer.py \
  --installation /absolute/existing-parent/ovisocr3-mlx-8bit \
  --variant original-bf16 --pages /absolute/cohort/pages.json \
  --output /absolute/results/ovis-original-bf16
/absolute/existing-parent/ovisocr3-mlx-8bit/runtime/bin/python -I -B \
  resources/ovis-ocr/infer.py \
  --installation /absolute/existing-parent/ovisocr3-mlx-8bit \
  --variant 8bit --pages /absolute/cohort/pages.json \
  --output /absolute/results/ovis-8bit
```

Both output directories must be new and their parent must exist. The CLI re-execs
itself through `/usr/bin/sandbox-exec` with `(deny network*)`, verifies the network
deny policy before loading packages, disables Hugging Face network access and
remote code, and reads only local model paths. This narrow benchmark network policy
is not the application Worker's eventual filesystem or resource sandbox.

Both variants use the unmodified official `document_structured` task prompt,
image-first Qwen3.5 chat template, `enable_thinking=False`, temperature `0.0`,
maximum `16384` generated tokens, and image pixel bounds `448²`–`2880²`.
The original variant loads the verified official weights through MLX-VLM and
casts floating parameters to bfloat16 with the same upstream predicate as the
converter, preserving Qwen3.5 `A_log` in float32. It is a reference within MLX,
not an independent PyTorch correctness oracle.

Each page saves unmodified stream text in `.raw.txt`, token IDs in `.tokens.json`,
parseable JSON in `.parsed.json`, and `.metrics.json` with elapsed seconds,
per-page MLX peak bytes, RSS start/end and a 50 ms sampled RSS peak. The separate
`processLifetimePeakRssBytes` is the cumulative macOS process maximum, not a
per-page measurement. `report.json` records loading time, dependency identities,
image hashes, prompt hashes and settings. The model is loaded once per variant;
the first page includes any first-generation warm-up costs.

No fences, malformed JSON or boxes are repaired. Validation requires the exact
official fields/categories, integer coordinates in `[0,1000)`, positive box area,
and string content. Completion requires a final official EOS token (`248044` or
`248046`) with matching token-count evidence. Exhausting the token budget remains
an error even if the text parses. Exit `0` means every page passed these structural
checks, `2` means invalid output, `1` means execution failure and `130` cancellation.
Passing structural checks does not establish OCR accuracy, formula correctness,
table fidelity, citation localization or cross-page reconstruction.

Run source-only boundary checks without MLX or inference:

```sh
/Users/Apple_501/.local/share/uv/python/cpython-3.14.10-macos-aarch64-none/bin/python3.14 \
  -I -B resources/ovis-ocr/test_infer.py
```
