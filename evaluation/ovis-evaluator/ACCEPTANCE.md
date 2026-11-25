# OvisOCR quality acceptance v2

The user explicitly approved replacing the agent's stricter literal-content
gate with the original plan's quality margins and source-localization checks.
This decision was made after observing v1's one-of-three exact-parity failure.
The v1 contract, failed result and pixel diagnostic are preserved unchanged.
Passing v2 will not be reported as passing v1. The new contract is
[`acceptance-v2.json`](acceptance-v2.json), committed before computing its scores.

There are two complementary comparisons. The three originally frozen pages
compare official PyTorch MPS BF16 against both MLX BF16 and MLX 8-bit, using the
same upstream gold. The full 347-page cohort compares MLX BF16 against MLX
8-bit. Both retain all pages, invalid-output deletions and extra predictions.
The three-page check is a limited independent implementation sample; it does
not become a 347-page independent official reference or a training holdout.

For every comparison, CER may increase at most 0.005; official CDM and TEDS may
decrease at most 0.01. Existing scorer normalization and matching remain frozen.
CER uses the gold denominator and counts insertions; upstream normalized edit
distance is not substituted. Missing gold identities, renderer failure or
scorer timeout invalidate a run. Absolute gold scores and WER remain visible.

Location checks retain the existing maximum-IoU family assignment at IoU >= 0.5.
They compare recall and precision overall and for formula, table, visual and
caption families (maximum 0.01 decrease). Mean signed center offset must remain
within 0.01 of page width/height, with at most 0.002 change relative to reference.
Missing regions remain in denominators; no clipping or offset correction is
allowed. Families with gold and no matches fail. These statistics do not certify
every generated block as a precise quotation: P4 must keep source-region
verification explicit and refuse unsupported precision claims.

Reading order uses pairwise inversions of geometry-matched blocks with explicit
numeric gold order, including formulas and tables. Tied gold orders are not
ordered artificially. Inversion rate may increase at most 0.01 and explicit-order
coverage may decrease at most 0.01. Empty denominators cannot pass. The official
reading-order metric remains diagnostic because its perfect table fixture fails.

All three comparisons must pass before quality qualification. Worker lifecycle,
PDF/source mapping and P4 provenance are additional requirements. V2 does not
authorize automatic model adoption or claim isolated performance. The skipped
scan/cross-page/manual-review coverage and known PDF/image content mismatch
remain explicit limitations. Existing frozen inference outputs can be scored;
neither the model installation nor the running paired inference is modified.
