# OvisOCR3 8-bit adaptation evidence

Status: installation, conversion, inference smoke and the complete 8-bit worker lifecycle verified; **P3 quality acceptance has not passed**. Application parsing still uses its existing implementation until that gate passes.

The reproducible installer is [prepare-ovis-ocr.py](../scripts/research/prepare-ovis-ocr.py); [usage and limitations](../resources/ovis-ocr/README.md) describe its explicit destination and interpreter inputs. The model is downloaded separately from the application. The source manifest pins ATH-MaaS/OvisOCR3 revision `5b252386ba615bd464a5a26597560eaba87dae5c`, individual file sizes and SHA-256 digests. Dependencies are 67 hash-locked wheels under CPython 3.14.10, MLX 0.32.5 and MLX-VLM 0.8.1.

The actual installation at `~/.roc/research-models/ovisocr3-mlx-8bit` contains 187 affine 8-bit/group64 language modules and 153 unquantized BF16 vision tensors. Sizes: converted model 1,020,818,020 bytes; official source 1,728,965,773 bytes; private runtime 760,230,762 bytes; uv 28,309,040 bytes. Complete installation verification passed immediately after conversion and again after inference. Its immutable receipt remains `converted-unvalidated`.

The later [immutable wheel download audit](../resources/ovis-downloads/README.md)
establishes macOS **15**, not the source manifest's historical 14, as the minimum
for these exact OpenCV/MLX Metal wheels. This is a dependency constraint, not
runtime qualification on every macOS 15+ system. No frozen specification or
running quality evaluation was changed by the audit.

Measured on Apple M1 Pro, 32 GiB RAM, macOS 27.2.1. Three scientific pages from the P0 corpus ran serially under Seatbelt network denial, with identical input, prompt and generation-setting hashes:

| Page content | BF16 seconds | 8-bit seconds |
| --- | ---: | ---: |
| Formulas, table and prose | 52.43 | 44.98 |
| Dense scientific tables | 79.20 | 66.30 |
| Charts, captions and prose | 19.39 | 15.98 |

All six runs ended with official EOS 248046 without truncation; strict output JSON, categories and coordinates passed. Maximum MLX memory was 3.118 GB / 2.461 GB; maximum sampled RSS was 2.888 GB / 2.196 GB for BF16 / 8-bit. Text, formulas and table HTML matched. Eight of 60 boxes changed by 1/1000 in one coordinate; one chart HTML image reference reflected the corresponding coordinate change.

These are single-pass observations, not percentile estimates or an accuracy certificate. Both variants use MLX. The independent official PyTorch MPS reference subsequently passed strict parity on only one of three pages. Formula/table content and chart image-reference strings differed. A frozen pixel-only diagnostic eliminated the table difference but left formula and chart-reference differences; it is ineligible as an acceptance reference. The original exact-content contract and failed result remain unchanged. The user explicitly authorized quality acceptance v2 in place of that stricter adoption gate. See the [independent reference evidence](../evaluation/ovis-pytorch-reference/README.md).

The 347-page scientific cohort completed paired BF16/8-bit inference. The official scorer was calibrated and its empty-prediction baseline completed: 2,240 text identities, 597 formula identities and 323 tables. All formula gold renders were nonempty. A separate immutable re-audit qualified the gold denominator; `scoring-gold-baseline-audit-v2-linked` retains that baseline. Scorer documentation records the upstream reading-order defect and the PDF/image mismatch without excluding either. See [evaluation instructions](../evaluation/ovis-evaluator/README.md).

The completed BF16 arm has 347 valid pages. Its initial scorer report was rejected
because two formulas had position `0` in the matched output but `""` in the
empty-prediction baseline. The upstream matcher tests order by truthiness. Both
gold files are byte-identical, and the two exact formulas each occur once in their
page's annotations with numeric order zero. The independent
`scripts/research/audit-ovis-zero-order.py` re-audits saved results without editing
the frozen evaluator or original reports. It maps an empty formula position to
zero only when the exact page/category/LaTeX identifies one nonignored annotation
with numeric order zero; multiplicities and all other audit errors remain binding.
The linked report is
`.artifacts/research-toolchain-p3/quality-v2-zero-order-audit/original-bf16/report.json`.
It preserves the original CER 0.1352443265, CDM 0.9928023451 and TEDS 0.9354555977.
This is a denominator audit, not quality adoption.

The completed 8-bit arm contains one invalid `scientific-253` page: generation
repeats table-format tokens until the 16,384-token limit, leaving truncated JSON.
BF16 completes the same page in 3,698 tokens. The 8-bit invalid-page count therefore
exceeds BF16's zero and fails that v2 gate, regardless of the remaining scores.
Original evidence stays in `paired-347/8bit/scientific-253.*`; a separately labelled
cold-process diagnostic cannot replace this page in the frozen cohort.

The complete independent metrics also fail CER delta (0.0067811254 versus maximum
0.005), formula region precision delta (-0.0129728059 versus minimum -0.01), and
formula horizontal center bias (0.0155339379 versus maximum 0.01). BF16's own
formula horizontal bias is 0.0151225660. These are recorded in
`quality-v2-original-comparison.json`; the completed official 8-bit CDM is
0.9849614740 and TEDS is 0.9381436012. Original quality failures are preserved.

A [saved-output formula geometry diagnostic](research-ovis-formula-geometry.md)
reproduces both biases and identifies a region-semantics mismatch in tagged
equations: some gold regions include the right-side number, while Ovis emits the
body and number separately. The user approved the separately frozen v3 formula
and number association rule, retaining original coordinates and all numerical
thresholds. The 1.05 candidate passes formula geometry under v3 but still loses
four caption matches out of 382. Its independent backend check passes.

The 1.03 diagnostic restores the two captions on `scientific-240`, finishes the
repetition failure on `scientific-253`, and still loses two caption matches on
`scientific-043`. The user then requested **only twenty samples**. The 347-page
1.03 run was stopped; its interruption evidence is retained. The
[new fixed sample](../evaluation/ovis-decoder/sample-20-1.03.json) includes seven
known regression/backend pages and thirteen pages selected by fixed SHA256 order.
Sample BF16 and 8-bit scores use identical gold and unchanged quality margins.
The independent backend check reuses three of those twenty pages. No full-cohort
or held-out qualification claim is made, and the application route stays pending.

`scripts/research/probe-ovis-repetition.py` creates an explicitly labelled
diagnostic copy of the frozen inference script. It changes only the repetition
penalty, records the unchanged 20-token context window, preserves model/prompt/
runtime inputs, and keeps the generated script, command, source hashes and output
in a new evidence directory. It cannot change the application's decoder. Example:

```sh
python3 -B scripts/research/probe-ovis-repetition.py \
  --installation /Users/Apple_501/.roc/research-models/ovisocr3-mlx-8bit \
  --output /absolute/new-diagnostic-directory \
  --page scientific-253 --penalty 1.05
```

The unchanged cold-process reproduction emits exactly the same raw bytes and
tokens as the original failed page. Penalty 1.01 still fails; penalty 1.05 ends
normally in 3,694 tokens with 24 blocks, but changes one paragraph classification
and raises this page's CER from BF16's 0.222627 to 0.248322. Separate controls
`scientific-006`, `scientific-005`, `scientific-001` all finish normally at 1.05;
their combined CER is 0.080074, versus 0.084662 for both original arms. Evidence is
under `diagnostic-scientific-253-cold`, `diagnostic-repetition-1.01`,
`diagnostic-repetition-1.05` and `diagnostic-repetition-1.05-controls`. These selected
probes are not full-cohort quality qualification or replacement inference pages.

The production supervisor now runs actual 8-bit inference with scoped Metal compiler-cache access, filesystem/network isolation and resource admission. Model reuse, cancellation during generation, monitored memory termination and recovery all passed. Temporary jobs and compiler caches were removed. [Worker evidence](../evaluation/ovis-worker/README.md) records exact commands, native regression tests and resource-limit boundaries. This verifies lifecycle behavior without qualifying document accuracy or enabling the parser.

The user skipped supplementary scientific-scan/cross-page gold and manual review. Those remain explicit coverage gaps. Paper IR, complete source-region verification, full-cohort quality and isolated performance acceptance remain outstanding. Only the M1 Pro / 32 GiB machine has been exercised; 8/16/24 GiB support is not claimed.

Source-only checks, run from the repository root:

```sh
python3.14 -I -B -m unittest discover -s resources/ovis-ocr -p 'test_*.py'
```

Result: 26 tests passed. Local evidence is retained in `.artifacts/research-toolchain-p3/`: `SUMMARY.md` records exact runtime commands; `install-summary.json`, `smoke-comparison.json`, `smoke-output-diff.json`, raw outputs, token IDs and per-page metrics record the observations. Owned installer staging and inference caches were removed.

## Independent backend quality v2

Both three-page comparisons passed the user-approved [v2 contract](../evaluation/ovis-evaluator/ACCEPTANCE.md).
The contract was committed as `fbd3f3d` before scores were computed. The original
v1 one-of-three exact parity failure remains a failure; these are different checks.

| Backend | Micro CER | Micro WER | Official CDM | Official TEDS |
| --- | ---: | ---: | ---: | ---: |
| Official PyTorch MPS BF16 | 0.08466244 | 0.14151576 | 1.00000000 | 0.88648155 |
| MLX BF16 | 0.08466244 | 0.14151576 | 1.00000000 | 0.88292114 |
| MLX 8-bit | 0.08466244 | 0.14151576 | 1.00000000 | 0.88292114 |

Both MLX variants have zero CER/CDM delta and -0.00356041 TEDS delta. Geometry
precision/recall and reading-order deltas meet every frozen limit. All retain
53/58 matched gold regions, 53/60 matched predictions, 50/51 explicit-order
coverage and 22/492 order inversions. These absolute errors are retained; matching
the reference does not certify every predicted region. The three pages contain
7 formula and 4 table gold items and do not establish full-cohort quality.

The P0 PNG renders have exactly identical decoded RGB pixels and dimensions to
the corresponding upstream JPEG inputs. Before scoring, all 33,536 private
runtime entries were verified against the original receipt. A missing standard
library bytecode directory and its 66 files were reconstructed from unchanged
source with the same interpreter; every restored byte matched its original hash.
The restoration receipt is `evaluator-runtime-cache-restoration.json`.

Initial denominator audits failed because upstream formula matching uses either
full-document indices or formula-only indices for the same gold. Upstream source
and scores remain unmodified. The corrected formula audit keys exact gold bytes,
page, original gold position and category, preserving multiplicity; changed gold,
missing rows and duplicates still fail. A linked read-only re-audit retains every
identity from the frozen baseline. The initial invalid reports are preserved in
`quality-v2-backend`; corrected audits are in `quality-v2-backend-audited`.
`quality-v2-backend-bf16.json` and `quality-v2-backend-8bit.json` record all passing
checks. The evaluator regression suite passed 26/26 from the repository root:

```sh
.runtime/ovis-evaluator/venv/bin/python -B -m unittest discover \
  -s evaluation/ovis-evaluator -p 'test_*.py' -v
```

P3 remains incomplete pending the user-authorized twenty-page candidate check and
remaining resource qualification. No application parser has been enabled by these
results. The latest sample scope supersedes the earlier full-cohort requirement
for the new candidate; historical full-cohort failures remain recorded.
