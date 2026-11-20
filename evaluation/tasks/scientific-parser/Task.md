# Task: scientific-parser baseline

**Status:** Draft — agent-reviewed. This full scientific-PDF contract is not a registered `pnpm evaluate` suite. The [full-PDF adapter](../../../scripts/score-scientific-pdf.mjs) implements gold scoring and observation mode; qualification requires the complete corpus and readable raw evidence. Public raster components use different annotation/scoring boundaries; see the [Scientific RAG guide](../../../docs/scientific-rag/README.md) for public component scope.

Public raster scoring uses published assisted/human annotations, NFC/space-collapse CER, whitespace WER and greedy category-collapsed layout matching. Those metrics cannot replace the full Draft contracts below.

## Outcome and frozen inputs

Measure the current production PDF parser before changing Native/OCR fusion, reading order or extraction. Use [scientific corpus](../../corpora/scientific-rag/README.md) with all 45 unique PDFs, human transcripts/regions/order and source hashes. Keep annotation gold separate from parser output. Corpus readiness verifies declared input records; independent human authenticity, completeness and scientific correctness remain necessary.

Freeze corpus inputDigest, raw PDF/annotation bytes, repository source identity, Node/platform, parser version/fingerprint/parse contract, model file hashes, DPI and OCR settings. Direct-PDF gold has no parseRef; any parse-based gold must resolve to the exact captured parse, not a later one.

## Runtime and reset

Invoke the real document parser/toolchain in repository-native isolated evaluation directories, never a production database. Preserve immutable parsed/structured artifacts, native text, blocks/assets, sourceHash/parseHash/fingerprint and coordinate snapshots. Missing required OCR models, unreadable sources, cancellation or parser failure are environment/input failures and retain explicit results.

The adapter must convert actual CropBox/rotation/raster coordinates to the gold `TOPLEFT_NORMALIZED` frame using the production coordinate contract. Do not infer PDF coordinates from character offsets. Retain the conversion and one-to-one matching artifacts for independent verification.

## Independent metrics

| Metric | Required scoring contract |
| --- | --- |
| CER | Levenshtein distance over NFC Unicode code points divided by human reference characters; preserve whitespace and punctuation. Empty reference is NA with reason. |
| WER | Levenshtein distance over frozen language-specific word segmentation divided by reference words; segmentation version and Chinese/mixed-language treatment require review before running. |
| Layout F1 | Same-class regions with IoU ≥0.5, maximum one-to-one matching; retain TP/FP/FN and per-class results. |
| Reading Order | Correctly ordered gold block pairs divided by all comparable gold pairs on a page; pairs with an unmatched endpoint receive no credit. A page with fewer than two gold blocks is NA. |

Score native, scanned, mixed and all eight categories separately. Do not omit failed pages to improve means; distinguish invalid trials from measured extraction errors. Gold is independent of current block IDs; matching preserves both identities.

Implemented Draft tooling freezes `whitespace-v1` WER, which is not linguistic Chinese
segmentation and still needs human review for acceptance. It scores NFC CER without whitespace
collapse, maximum same-class matches and all gold order pairs; retains float CropBox conversions,
per-category/parse-mode aggregates, failures and NA denominators. Published-block transcripts
use two LF between actual output blocks; native sidecars and rich-only regions do not replace them.
Gold mode requires full corpus qualification and exact source-cohort identity; observation mode
verifies actual receipts/geometry without gold or scores. Isolated receipts have no parseId and
cannot satisfy captured-parse gold. See the [corpus guide](../../corpora/scientific-rag/README.md#独立观测与评分入口) for the CLI and the adapter for unsupported cases.

## Artifacts and gate

Retain frozen inputs, production artifacts, human-gold digest, coordinate conversions, region matching and per-page metric samples. A qualified `evaluation/results/baseline/parser.json` must contain status, source/runtime/model identities, each metric's value/applicable count/NA reasons and all failures. Missing metrics stay null and make the required baseline incomplete.

Repeat identical frozen inputs to check deterministic outputs and scores; retain actual performance samples separately. Fixture PDF tests validate parser contracts, not scientific CER/WER/Layout quality. Any retained public raster report must keep its original subset and scorer identity; its scores do not qualify the full PDF contract.
