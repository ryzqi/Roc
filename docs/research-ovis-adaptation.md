# OvisOCR3 8-bit adaptation evidence

Status: installation, conversion and three-page inference smoke verified; **P3 quality acceptance is incomplete**. Application parsing still uses its existing implementation until that gate passes.

The reproducible installer is [prepare-ovis-ocr.py](../scripts/research/prepare-ovis-ocr.py); [usage and limitations](../resources/ovis-ocr/README.md) describe its explicit destination and interpreter inputs. The model is downloaded separately from the application. The source manifest pins ATH-MaaS/OvisOCR3 revision `5b252386ba615bd464a5a26597560eaba87dae5c`, individual file sizes and SHA-256 digests. Dependencies are 67 hash-locked wheels under CPython 3.14.10, MLX 0.32.5 and MLX-VLM 0.8.1.

The actual installation at `~/.roc/research-models/ovisocr3-mlx-8bit` contains 187 affine 8-bit/group64 language modules and 153 unquantized BF16 vision tensors. Sizes: converted model 1,020,818,020 bytes; official source 1,728,965,773 bytes; private runtime 760,230,762 bytes; uv 28,309,040 bytes. Complete installation verification passed immediately after conversion and again after inference. Its immutable receipt remains `converted-unvalidated`.

Measured on Apple M1 Pro, 32 GiB RAM, macOS 27.2.1. Three scientific pages from the P0 corpus ran serially under Seatbelt network denial, with identical input, prompt and generation-setting hashes:

| Page content | BF16 seconds | 8-bit seconds |
| --- | ---: | ---: |
| Formulas, table and prose | 52.43 | 44.98 |
| Dense scientific tables | 79.20 | 66.30 |
| Charts, captions and prose | 19.39 | 15.98 |

All six runs ended with official EOS 248046 without truncation; strict output JSON, categories and coordinates passed. Maximum MLX memory was 3.118 GB / 2.461 GB; maximum sampled RSS was 2.888 GB / 2.196 GB for BF16 / 8-bit. Text, formulas and table HTML matched. Eight of 60 boxes changed by 1/1000 in one coordinate; one chart HTML image reference reflected the corresponding coordinate change.

These are single-pass observations, not percentile estimates or an accuracy certificate. Both variants use MLX; independent official-backend parity remains unverified. The committed 347-page corpus, PDF geometry, official CDM/TEDS calibration, scanned papers, cross-page tables, cancellation, filesystem/GPU isolation and Paper IR integration still require acceptance.

Source-only checks, run from the repository root:

```sh
python3.14 -I -B -m unittest discover -s resources/ovis-ocr -p 'test_*.py'
```

Result: 26 tests passed. Local evidence is retained in `.artifacts/research-toolchain-p3/`: `SUMMARY.md` records exact runtime commands; `install-summary.json`, `smoke-comparison.json`, `smoke-output-diff.json`, raw outputs, token IDs and per-page metrics record the observations. Owned installer staging and inference caches were removed.
