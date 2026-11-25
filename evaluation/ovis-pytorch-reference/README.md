# Independent OvisOCR3 implementation check

This directory checks three frozen original scientific pages with Transformers' official `Qwen3_5ForConditionalGeneration` PyTorch implementation. The installed source checkpoint is `ATH-MaaS/OvisOCR3@5b252386ba615bd464a5a26597560eaba87dae5c`. This is independent of MLX's model and preprocessing ports. The model README's direct recipe uses vLLM 0.22.1 on supported GPUs; this CPU implementation check does not claim to reproduce that environment or provide a second full 347-page baseline.

`parity.json` freezes the inputs and acceptance contract before generation: identical ordered block counts/categories/content, literal LaTeX/HTML bytes and at most one integer coordinate unit of difference. Official EOS is required; no cleanup, fence removal, JSON repair or threshold widening is allowed. Three successful JSON parses are insufficient to pass.

The private environment uses CPython 3.14.10, Torch 2.15.0, Torchvision 0.29.2 and Transformers 5.24.1. Tokenizers 0.23.3, NumPy 2.5.5 and Pillow 13.0.0 match the MLX installation. The inference installation is never modified. `requirements.lock` freezes the separate dependency closure. The private venv reuses the hash-verified existing Python binary and shared library; it does not install global packages.

The image path uses Transformers' own PIL image processor with the official configuration. This matches the MLX port's Pillow bicubic resize while independently executing official normalization, patching and token expansion. AutoProcessor also loads a video component; Torchvision is required by that installed Transformers version even though these inputs are static images. Two attempted processor constructions without it failed during setup; no model result came from those attempts.

All commands run from `/Users/Apple_501/Desktop/Roc/Roc`. Each output must be new:

```sh
/opt/homebrew/bin/uv venv --python /Users/Apple_501/.roc/research-models/ovisocr3-mlx-8bit/runtime/bin/python .runtime/ovis-pytorch-reference/venv
/opt/homebrew/bin/uv pip sync --python .runtime/ovis-pytorch-reference/venv/bin/python --cache-dir .runtime/ovis-pytorch-reference/uv-cache --require-hashes evaluation/ovis-pytorch-reference/requirements.lock

/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)' \
  /Users/Apple_501/.roc/research-models/ovisocr3-mlx-8bit/runtime/bin/python -B \
  evaluation/ovis-pytorch-reference/export_inputs.py --backend mlx \
  --installation /Users/Apple_501/.roc/research-models/ovisocr3-mlx-8bit \
  --output .artifacts/research-toolchain-p3/mlx-inputs-recheck

/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)' \
  .runtime/ovis-pytorch-reference/venv/bin/python -B evaluation/ovis-pytorch-reference/export_inputs.py \
  --backend pytorch --installation /Users/Apple_501/.roc/research-models/ovisocr3-mlx-8bit \
  --output .artifacts/research-toolchain-p3/pytorch-inputs-recheck

/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)' \
  .runtime/ovis-pytorch-reference/venv/bin/python -B evaluation/ovis-pytorch-reference/run_reference.py \
  --installation /Users/Apple_501/.roc/research-models/ovisocr3-mlx-8bit \
  --inputs .artifacts/research-toolchain-p3/pytorch-inputs-recheck \
  --output .artifacts/research-toolchain-p3/pytorch-reference-recheck

.runtime/ovis-pytorch-reference/venv/bin/python -B evaluation/ovis-pytorch-reference/compare.py \
  --reference .artifacts/research-toolchain-p3/pytorch-reference-recheck \
  --candidate .artifacts/research-toolchain-p3/smoke-original-bf16 \
  --output .artifacts/research-toolchain-p3/pytorch-parity-recheck.json

.runtime/ovis-pytorch-reference/venv/bin/python -B -m unittest discover \
  -s evaluation/ovis-pytorch-reference -p test_reference.py -v

.runtime/ovis-pytorch-reference/venv/bin/python -B evaluation/ovis-pytorch-reference/verify_environment.py \
  --runtime .runtime/ovis-pytorch-reference/venv \
  --receipt .artifacts/research-toolchain-p3/pytorch-runtime-receipt.json \
  --output .artifacts/research-toolchain-p3/pytorch-runtime-verification-recheck.json
```

`run_reference.py` requires the configuration to equal committed HEAD. It uses CPU only and one intra/inter-op thread, verifies all official source bytes and actual input tensors, records every generated token as it arrives, and retains partial output on failure. The EOS-inclusive decode is saved separately; only the terminal EOS control token is removed from the content decode, matching MLX's stopping boundary. A one-second macOS memory-pressure monitor stops this reference on a non-normal pressure level. Memory evidence is a process RSS observation under mixed host load, not an exclusive-host performance result.

On 2026-11-25, input preflight found exact prompt/token/mask/grid equality on all three pages. Float32 image tensors differ by at most `1.1920928955078125e-7`. The official processor rescales in float64 before downcasting, whereas the MLX port multiplies in float32. After BF16 conversion, 6,384 / 6,568 / 6,162 components differ on formulas/table, dense tables and charts/captions respectively, with maximum difference `3.0517578125e-5`. Those are observed differences, not an accepted tolerance waiver. The independent generation keeps each implementation's actual processor input. Any follow-up shared-tensor diagnosis must be labeled separately.

Local evidence: `.artifacts/research-toolchain-p3/{mlx-inputs,pytorch-inputs,pytorch-input-comparison.json,pytorch-pixel-differences.json,pytorch-runtime-receipt.json,pytorch-reference-source}`. The model README receipt binds its pinned source URL and bytes. The private runtime receipt records 23,399 venv file/link/directory entries. Four strict-comparison regression tests passed. Generation and acceptance results remain separate from this setup evidence.

The CPU BF16 reference was interrupted after 2,044.39 seconds without emitting a generated token from its first high-resolution prompt. A process sample showed active CPU BF16 SDPA/flash-attention and scalar GEMM, with one CPU core busy and normal memory pressure. This is an unqualified backend, not a measured output accuracy failure. The partial report and samples remain intact.

## Independent MPS result

`parity-mps.json` was committed before a separate MPS run. It keeps the source, inputs, BF16 precision and exact comparison contract, changes the device to MPS and disables CPU fallback. It does not alter the interrupted CPU experiment. All 23,399 runtime entries verified before generation.

```sh
/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)' \
  .runtime/ovis-pytorch-reference/venv/bin/python -B evaluation/ovis-pytorch-reference/run_reference_mps.py \
  --installation /Users/Apple_501/.roc/research-models/ovisocr3-mlx-8bit \
  --inputs .artifacts/research-toolchain-p3/pytorch-inputs \
  --output .artifacts/research-toolchain-p3/pytorch-reference-mps-recheck

.runtime/ovis-pytorch-reference/venv/bin/python -B evaluation/ovis-pytorch-reference/compare.py \
  --backend mps --reference .artifacts/research-toolchain-p3/pytorch-reference-mps-recheck \
  --candidate .artifacts/research-toolchain-p3/smoke-original-bf16 \
  --output .artifacts/research-toolchain-p3/pytorch-mps-parity-recheck.json
```

The initial MPS run completed all three pages with official EOS 248046 and no truncation: 3,792 / 6,230 / 1,418 generated tokens in 210.33 / 344.65 / 73.17 seconds. Driver allocation was about 3.52 GB. These timings share the host with other work and do not qualify performance.

**Strict parity failed (one of three pages passed).** The formulas/table page differed in one formula and one table content block. Dense tables matched. The charts/captions page differed in two embedded image-path coordinate strings; the frozen literal content rule rejects those differences even though the separate bbox tolerance is one unit. No text normalization or tolerance change was applied. Evidence is under `.artifacts/research-toolchain-p3/{pytorch-reference-mps,pytorch-mps-parity.json,pytorch-runtime-verification-mps.json}`. P3 adoption remains closed pending diagnosis and qualification; successfully generating valid JSON is insufficient.
