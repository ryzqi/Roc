# OvisOCR3 8-bit adaptation evidence

Status: installation, conversion, inference smoke and the complete 8-bit worker lifecycle verified; **P3 quality acceptance has not passed**. Application parsing still uses its existing implementation until that gate passes.

The reproducible installer is [prepare-ovis-ocr.py](../scripts/research/prepare-ovis-ocr.py); [usage and limitations](../resources/ovis-ocr/README.md) describe its explicit destination and interpreter inputs. The model is downloaded separately from the application. The source manifest pins ATH-MaaS/OvisOCR3 revision `5b252386ba615bd464a5a26597560eaba87dae5c`, individual file sizes and SHA-256 digests. Dependencies are 67 hash-locked wheels under CPython 3.14.10, MLX 0.32.5 and MLX-VLM 0.8.1.

The actual installation at `~/.roc/research-models/ovisocr3-mlx-8bit` contains 187 affine 8-bit/group64 language modules and 153 unquantized BF16 vision tensors. Sizes: converted model 1,020,818,020 bytes; official source 1,728,965,773 bytes; private runtime 760,230,762 bytes; uv 28,309,040 bytes. Complete installation verification passed immediately after conversion and again after inference. Its immutable receipt remains `converted-unvalidated`.

Measured on Apple M1 Pro, 32 GiB RAM, macOS 27.2.1. Three scientific pages from the P0 corpus ran serially under Seatbelt network denial, with identical input, prompt and generation-setting hashes:

| Page content | BF16 seconds | 8-bit seconds |
| --- | ---: | ---: |
| Formulas, table and prose | 52.43 | 44.98 |
| Dense scientific tables | 79.20 | 66.30 |
| Charts, captions and prose | 19.39 | 15.98 |

All six runs ended with official EOS 248046 without truncation; strict output JSON, categories and coordinates passed. Maximum MLX memory was 3.118 GB / 2.461 GB; maximum sampled RSS was 2.888 GB / 2.196 GB for BF16 / 8-bit. Text, formulas and table HTML matched. Eight of 60 boxes changed by 1/1000 in one coordinate; one chart HTML image reference reflected the corresponding coordinate change.

These are single-pass observations, not percentile estimates or an accuracy certificate. Both variants use MLX. The independent official PyTorch MPS reference subsequently passed strict parity on only one of three pages. Formula/table content and chart image-reference strings differed. A frozen pixel-only diagnostic eliminated the table difference but left formula and chart-reference differences; it is ineligible as an acceptance reference. The exact-content gate remains unchanged. See the [independent reference evidence](../evaluation/ovis-pytorch-reference/README.md).

The 347-page scientific cohort is running paired BF16/8-bit inference. The official scorer was calibrated and its empty-prediction baseline completed: 2,240 text identities, 597 formula identities and 323 tables. All formula gold renders were nonempty. A separate immutable re-audit qualified the gold denominator; use `scoring-gold-baseline-audit` for the final arm comparisons. Scorer documentation records the upstream reading-order defect and the PDF/image mismatch without excluding either. See [evaluation instructions](../evaluation/ovis-evaluator/README.md).

The production supervisor now runs actual 8-bit inference with scoped Metal compiler-cache access, filesystem/network isolation and resource admission. Model reuse, cancellation during generation, monitored memory termination and recovery all passed. Temporary jobs and compiler caches were removed. [Worker evidence](../evaluation/ovis-worker/README.md) records exact commands, native regression tests and resource-limit boundaries. This verifies lifecycle behavior without qualifying document accuracy or enabling the parser.

The user skipped supplementary scientific-scan/cross-page gold and manual review. Those remain explicit coverage gaps. Paper IR, source-region accuracy, independent parity, full-cohort quality and isolated performance acceptance remain outstanding. Only the M1 Pro / 32 GiB machine has been exercised; 8/16/24 GiB support is not claimed.

Source-only checks, run from the repository root:

```sh
python3.14 -I -B -m unittest discover -s resources/ovis-ocr -p 'test_*.py'
```

Result: 26 tests passed. Local evidence is retained in `.artifacts/research-toolchain-p3/`: `SUMMARY.md` records exact runtime commands; `install-summary.json`, `smoke-comparison.json`, `smoke-output-diff.json`, raw outputs, token IDs and per-page metrics record the observations. Owned installer staging and inference caches were removed.
