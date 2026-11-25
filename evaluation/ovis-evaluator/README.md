# OvisOCR evaluator and PDF slice audit

This directory uses the actual OmniDocBench scorer at commit `0ff4f3cfbcd45636cc6d9933a551036893f0d83c`. Its CDM renders colored LaTeX glyphs through pdfTeX, ImageMagick and Ghostscript. Its TEDS uses the official table tree implementation. No approximate formula metric is labeled CDM, and no evaluator source has been patched.

The installed environment is private to `.runtime/ovis-evaluator/`. It is separate from the Ovis Python 3.14 inference installation because the upstream evaluator requires Python `>=3.10,<3.12`. There are no global packages, shell-profile changes or host ImageMagick policy changes.

## Frozen environment

[`environment.lock.json`](environment.lock.json) identifies the upstream archive and 94 executable/configuration source files, all native package URLs/builds/SHA-256, 151 TeX package revisions/container checksums and cached BLEU/METEOR/NLTK resources. [`requirements.in`](requirements.in) states dependency intent; [`requirements.lock`](requirements.lock) freezes the Python dependency closure with hashes.

The measured environment is macOS arm64, CPython 3.11.18, TeX Live 2025/pdfTeX 1.40.28, ImageMagick 7.1.1-47 and Ghostscript 10.05.1. This is a calibrated **macOS variant**, not a claim of equivalence to the README's Linux/Python 3.10/Ghostscript 9.55.0 reference.

Installation used uv 0.13.9 with a task-private Python installation/cache, micromamba 2.0.5 with a task-private native prefix and the archived TeX Live 2025 final repository. TeX's portable profile disabled PATH adjustment and documentation/source installation; `scheme-basic` was extended with `geometry booktabs multirow amsmath amsfonts was xcolor cjk arphic`. `upgreek.sty` belongs to `was`. The TeX repository/container hashes were recorded; GPG verification was unavailable and is not claimed. Archive installers and package-manager caches are disposable; the actual environment and verification receipts remain local.

Two real preflight failures are retained in the local evidence: the unconstrained latest PyArrow required NumPy 2 while the official scorer pins NumPy 1.24, and Ghostscript 9.56.1 lacked the `png16malpha` device used by this ImageMagick build. The final lock fixes the former dependency graph and uses Ghostscript 10.05.1. `lxml`, `pylatexenc` and `func-timeout` were rebuilt with isolation disabled under pinned setuptools 80.9.0/wheel 0.45.1. No failing run was treated as a model score.

`snapshot_runtime.py` hashes every file/link/directory in the private interpreter, Python environment, native prefix, TeX tree and official checkout. The local receipt has 33,536 entries; verify it before using saved results or scoring new model predictions. Writable caches are excluded from that inventory; the offline resource files have separate hashes in the committed environment lock.

## Checks and evidence

All commands below run from the repository root. Use a new output directory for every run; commands reject overwrites.

```sh
python3 -B evaluation/ovis-evaluator/snapshot_runtime.py \
  --runtime .runtime/ovis-evaluator \
  --receipt .artifacts/research-toolchain-p3/evaluator-runtime-receipt.json --verify

.runtime/ovis-evaluator/venv/bin/python -B -m unittest discover \
  -s evaluation/ovis-evaluator -p test_evaluator.py -v

/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)' \
  .runtime/ovis-evaluator/venv/bin/python -B evaluation/ovis-evaluator/calibrate.py \
  --runtime .runtime/ovis-evaluator --output .artifacts/research-toolchain-p3/evaluator-calibration-recheck

/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)' \
  .runtime/ovis-evaluator/venv/bin/python -B evaluation/ovis-evaluator/calibrate_pipeline.py \
  --runtime .runtime/ovis-evaluator --output .artifacts/research-toolchain-p3/evaluator-pipeline-recheck

.runtime/ovis-evaluator/venv/bin/python -B evaluation/ovis-evaluator/verify_pdf_slices.py \
  --output .artifacts/research-toolchain-p3/pdf-slices-recheck
```

On 2026-11-25, six regression tests passed, including real raster markers on cropped pages rotated 0/90/180/270 degrees. The coordinate mapping uses the exact 200/72 DPI scale and outward-rounded raster canvas, then maps to upstream image pixels and `TOPLEFT_NORMALIZED`. PyMuPDF 1.26.7's rotated-page matrix omits CropBox offsets, so the verifier reads the matrix with the in-memory page unrotated, restores rotation and composes the full transform. It never changes the source PDF bytes.

The official direct APIs passed 12 cases repeated twice: identical ASCII/CJK CDM 1.0 with eight glyph tokens each; different, empty and malformed predictions CDM 0; empty gold or unavailable renderer classified as an invalid evaluator/gold run; identical TEDS 1.0; changed content or merged cells 0.8; empty/malformed tables 0. Repeated scores and the identical-pair glyph-box files matched exactly. The final run was under the OS network-deny sandbox.

The official Markdown parsing, `quick_match`, normalization and aggregate pipeline also passed controlled CDM/TEDS checks. Identical fixtures scored CDM/TEDS 1; changed formula/table content scored 0/0.8; an absent page scored 0/0 with text edit distance 1 and remained in the page denominator. These are synthetic calibration fixtures, never corpus gold. **Reading-order qualification remains open:** the perfect table-containing fixture produces gold order `[1,2,3]` and predicted order `[1,2]`, hence edit distance 1/3. The upstream scorer omits the table from predicted order; no reading-order pass is inferred.

`warm_resources.py` uses the revisions already frozen in the environment lock. `check_offline_resources.py` exercised their exact cached metrics under Seatbelt network denial. BLEU returned 1 and METEOR returned its expected 0.9976851851851852. Upstream METEOR initialization still attempts NLTK index checks; those attempts were blocked and logged, while scoring used the pinned local data. The proposed main CDM/TEDS configuration does not invoke BLEU/METEOR.

## PDF pairing findings

All 210 frozen original slices were readable, unencrypted single-page PDFs, required no parser repair, had rotation 0, matched their image/annotation dimensions at 200 DPI and had no annotation polygons outside the image. 207 had non-whitespace extractable native text; three did not. Lack of extractable text does not by itself prove that a page is a scientific scan.

All estimated translation offsets were zero. Median unshifted SSIM was about 0.99849; 209 pages were at least 0.98155. **One actual content mismatch remains:** `scihub_c2gc35284b.pdf_6.jpg` has the body of Table 1 blanked in the frozen image, while the original PDF renders the full table. The image's gold has no table-body annotation. The PDF and image are therefore not interchangeable complete-page gold. This finding was visually inspected by the implementing agent; it is not an independent human review. The 210-page denominator is preserved; no page was silently excluded.

[`pdf-pairing-findings.json`](pdf-pairing-findings.json) records the mismatch and text-layer exceptions. Full render PNGs, native text, normalized annotation polygons, transforms, source hashes and per-page diagnostics stay under `.artifacts/research-toolchain-p3/pdf-slices-audit/`. The final corrected audit replaced two task-owned intermediate renders; its cleanup receipt is retained.

No complete scientific-PDF qualification, original-paper identity count, cross-page table gold, independent reviewer attestation or verified training holdout is established by these checks. On 2026-11-25 the user elected to skip additional scientific-scan/cross-page gold and independent review work. Those categories remain unverified; this does not waive the existing-sample quality or backend parity checks.

## Frozen paired inference

[`paired-inference.json`](paired-inference.json) binds all 347 inputs, model/installation identities, generation settings and failure policy. `run_paired.py` requires the configuration to match committed HEAD, runs BF16 followed by 8-bit with one model worker, checks actual settings and exact completed page IDs/order, and preserves invalid or partial output. It does not alter the model installation receipt.

```sh
python3 -B evaluation/ovis-evaluator/run_paired.py \
  --installation /Users/Apple_501/.roc/research-models/ovisocr3-mlx-8bit \
  --output .artifacts/research-toolchain-p3/paired-347-recheck
```

The 347-page run is inference evidence, not automatic quality acceptance. Independent official PyTorch parity, reading-order/coordinate acceptance and absolute resource gates remain separate requirements. Both current arms use the MLX adapter; matching them alone cannot establish official-model implementation parity. The frozen configuration records all gaps at run creation; subsequent scoring specifications and user-approved skipped coverage are recorded separately without altering that configuration.

Other repository builds and Python tests ran on the same host during paired inference. Its latency and peak-memory observations therefore describe mixed host load and cannot qualify an exclusive-host P95 performance gate. Performance qualification requires a separate frozen-sample run after competing heavy work has finished.

## Frozen quality scoring

[`scoring.json`](scoring.json) was committed before quality scoring. It distinguishes independent CER/WER from the official scorer's normalized `Edit_dist`, whose denominator is the longer of gold and prediction. They are not interchangeable. `quality_metrics.py` retains every mapped nonempty gold text block, including captions, headers, footers, footnotes and page numbers. It matches within explicit category families using one-to-one raw-character Levenshtein cost with deletion/insertion nodes; unmatched predictions add insertion errors. CER and whitespace-token WER share that assignment. Unicode NFC and whitespace collapse are the only independent text normalization; punctuation, case, Markdown and inline LaTeX remain literal. Chinese whitespace-token WER is not a segmented-language WER.

All 347 pages remain in independent reports; invalid model output is an empty prediction with all gold deletions. Micro totals and per-page macro values are emitted. The explicit-order body/title/reference concatenation is diagnostic only: 669 included text blocks have no order, mostly page furniture, and no synthetic order is invented. Geometry reports maximum-IoU matching within declared families at IoU >= 0.5; unmatched predicted regions are evidence to inspect, not proof of hallucination.

`score_arm.py` requires OS network denial and the committed scoring configuration. It verifies complete inference page identities/order, raw bytes, model receipt, prompt and generation settings. It projects structured blocks to Markdown without content repair and invokes unchanged official parsing, matching, CDM and TEDS. Before comparing arms, an empty-prediction run establishes the exact applicable official gold-row identities. Missing or changed row identities, missing gold glyph rendering, scorer exceptions/timeouts, matcher timeout fallbacks or a changed page denominator invalidate official quality acceptance. Raw independent counts remain available for diagnosis. The runner owns the evaluator process group so cancellation also stops its renderer children.

```sh
.runtime/ovis-evaluator/venv/bin/python -B -m unittest discover \
  -s evaluation/ovis-evaluator -p 'test_*.py' -v

/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)' \
  .runtime/ovis-evaluator/venv/bin/python -B evaluation/ovis-evaluator/score_arm.py \
  --runtime .runtime/ovis-evaluator \
  --runtime-receipt .artifacts/research-toolchain-p3/evaluator-runtime-receipt.json \
  --arm gold-empty-baseline \
  --output .artifacts/research-toolchain-p3/scoring-gold-baseline-recheck

/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)' \
  .runtime/ovis-evaluator/venv/bin/python -B evaluation/ovis-evaluator/score_arm.py \
  --runtime .runtime/ovis-evaluator \
  --runtime-receipt .artifacts/research-toolchain-p3/evaluator-runtime-receipt.json \
  --arm original-bf16 \
  --inference .artifacts/research-toolchain-p3/paired-347/original-bf16 \
  --baseline .artifacts/research-toolchain-p3/scoring-gold-baseline-audit-v2-linked \
  --output .artifacts/research-toolchain-p3/scoring-original-bf16-recheck
```

Use `--arm 8bit` and its corresponding inference/output directory for the other arm. Gold coverage is audited per original index and position, expanding merged matches; upstream majority-category changes do not create a different gold identity. Pure prediction rows (`gt_idx=['']`) stay in upstream metrics and are counted separately, without becoming gold or requiring a gold render. Regression checks cover missing/duplicated gold, merged matches, extra predictions and renderer failures. The full gold baseline and model scores are separate runtime work. No score from this workflow automatically adopts the model or qualifies the skipped page classes.


## Saved-result re-audit

The initial empty-prediction baseline completed all 347 pages: 2,240 official text identities, 597 formula identities on 56 pages and 323 table identities on 227 pages. Every formula had nonempty gold glyph rendering. CDM and TEDS were both zero as expected for empty predictions. The current audit found no scorer errors, matcher timeout fallbacks or missing pages. These counts describe the upstream scorer's applicable rows; they are not a claim that every raw annotation becomes a scoring row. Independent text scoring retains its separately frozen broader text coverage.

That long-running baseline had loaded an earlier runner before denominator-audit fixes. Its original end report read the then-current on-disk source hash, so it cannot identify the actual in-memory implementation. The original evidence remains unchanged. `reaudit.py` records every input file hash, the original start/end runner hashes and the current auditor hash in a new output directory. Future runs capture source identities once at startup and retain them at completion.

```sh
.runtime/ovis-evaluator/venv/bin/python -B evaluation/ovis-evaluator/reaudit.py \
  --source .artifacts/research-toolchain-p3/scoring-gold-baseline \
  --output .artifacts/research-toolchain-p3/scoring-gold-baseline-audit
```

This actual re-audit passed with status `qualified-gold-denominator` and explicitly reports the runner-file change during the original run. Use `scoring-gold-baseline-audit` as `--baseline` for subsequent arms. The audit neither reruns nor patches the official evaluator and refuses to overwrite either output or original evidence. The complete evaluator regression suite now passes 16/16, including original-evidence preservation and source-drift reporting. Model scores, reading order and independent backend parity remain separate gates.

## User-approved quality acceptance v2

The contract and retained v1 evidence are documented in [ACCEPTANCE.md](ACCEPTANCE.md).
`score_backend_v2.py` verifies the committed input associations, exact decoded RGB
pixels, frozen inference reports/raw outputs/EOS, all runtime receipt entries and
upstream annotation identities. It scores all three existing arms without rerunning
or repairing model inference. Gold subsets preserve original identifiers. Invalid
model pages become empty predictions; evaluator failures invalidate the run.

```sh
/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)' \
  .runtime/ovis-evaluator/venv/bin/python -B evaluation/ovis-evaluator/score_backend_v2.py \
  --runtime .runtime/ovis-evaluator \
  --runtime-receipt .artifacts/research-toolchain-p3/evaluator-runtime-receipt.json \
  --baseline .artifacts/research-toolchain-p3/scoring-gold-baseline-audit-v2-linked \
  --output .artifacts/research-toolchain-p3/quality-v2-backend-recheck

.runtime/ovis-evaluator/venv/bin/python -B evaluation/ovis-evaluator/compare_v2.py \
  --scope backend \
  --reference .artifacts/research-toolchain-p3/quality-v2-backend/official-mps/report.json \
  --candidate .artifacts/research-toolchain-p3/quality-v2-backend/mlx-8bit/report.json \
  --output .artifacts/research-toolchain-p3/quality-v2-backend-8bit.json
```

Compare `mlx-bf16` against the same official report as the other backend check.
Complete-cohort `score_arm.py` now also emits v2 geometry and reading-order counts;
use `compare_v2.py --scope quantization` with its two complete 347-page reports.
All three comparisons are required. No single passing comparison enables parsing.

The unchanged upstream formula matcher switches `gt_idx` between full-document
and formula-only index spaces. Formula gold is therefore audited by exact gold
string SHA-256, page, original position and category, with multiplicities. Text
and table identities retain index/position auditing. No formula group, missing
string, changed content, missing row or duplicate is silently accepted.
`reaudit.py` creates a new baseline audit; `reaudit_backend_v2.py` creates new
reports for already-scored backend arms without changing any original evidence.
Its linked baseline check retains all original frozen index identities as well.

`finish_paired.py` can wait for each complete arm of an already-running paired
inference and score it serially under network denial. It captures scorer/config
hashes before waiting, refuses source changes, preserves failure evidence and
applies the frozen v2 comparison only after both347-page scorer audits pass.
It never changes or restarts inference, adopts a model, or claims isolated
performance. Use a new output directory; interruption retains completed work.

```sh
python3 -B evaluation/ovis-evaluator/finish_paired.py \
  --runtime .runtime/ovis-evaluator \
  --runtime-receipt .artifacts/research-toolchain-p3/evaluator-runtime-receipt.json \
  --inference .artifacts/research-toolchain-p3/paired-347 \
  --baseline .artifacts/research-toolchain-p3/scoring-gold-baseline-audit-v2-linked \
  --output .artifacts/research-toolchain-p3/quality-v2-paired
```

```sh
.runtime/ovis-evaluator/venv/bin/python -B evaluation/ovis-evaluator/reaudit.py \
  --source .artifacts/research-toolchain-p3/scoring-gold-baseline \
  --output .artifacts/research-toolchain-p3/scoring-gold-baseline-audit-v2-linked
.runtime/ovis-evaluator/venv/bin/python -B evaluation/ovis-evaluator/reaudit_backend_v2.py \
  --source .artifacts/research-toolchain-p3/quality-v2-backend \
  --baseline .artifacts/research-toolchain-p3/scoring-gold-baseline-audit-v2-linked \
  --output .artifacts/research-toolchain-p3/quality-v2-backend-audited
```
