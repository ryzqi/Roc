# Task: scientific-objects baseline

**Status:** Draft — agent-reviewed. This full original-PDF object contract is not a registered `pnpm evaluate` suite. The [full-PDF adapter](../../../scripts/score-scientific-pdf.mjs) retains table/formula/asset observations and supports gold scoring after corpus qualification. Public raster annotations and custom normalization have a separate component scope, described in the [Scientific RAG guide](../../../docs/scientific-rag/README.md); they do not substitute for the reviewed PDF locator contract below.

## Outcome and production evidence

Measure objects produced by the current parser/structured artifact, including objects retained only in regions and absent from current retrieval chunks. Use the [independent structure annotations](../../corpora/scientific-rag/annotations/README.md), immutable source/parse identities and actual coordinate snapshots. Do not create new production scientific-object schemas or improve extraction as part of the baseline.

Freeze parser/model/settings and region matching from [scientific-parser](../scientific-parser/Task.md). Evaluate in isolated repository-native trials; raw PDFs, hidden gold and observed objects remain separate. A missing table/formula is a measured miss, not a reason to remove its gold from the denominator.

## Scoring contracts

| Metric | Required independent evidence |
| --- | --- |
| Table Cell Exact Match | Match source tables by reviewed locator; compare cell row/column/rowSpan/columnSpan and NFC text against gold. Report matched/total gold cells and extra predicted cells separately. |
| TEDS | Verified reference/prediction HTML tree and a frozen tree-edit implementation/version; preserve merged-cell structure. HTML/cell equivalence must be checked before running. |
| Normalized LaTeX Exact Match | Per gold equation, exact equality under one reviewed normalizationVersion; missing equations score 0. Preserve symbols/operators/units and the original LaTeX. |
| Figure/caption provenance | Report whether figure asset and caption independently resolve to the correct original page/region; no invented diagram-understanding score. |

Before implementing/running TEDS and formula normalization, independently review their algorithms against the actual annotated cases. An empty category, missing gold, malformed reference or unsupported scorer is an incomplete baseline with explicit reason. Existing table HTML, `structure/matched` and formula region payloads must not be silently recast as independently indexed scientific objects.

Implemented agent-reviewed Draft scoring preserves cell whitespace and merged spans, checks
gold HTML/cell equivalence, and freezes custom `public-ordered-tree-v1` TEDS and conservative
`latex-nfc-v1`. It is not official leaderboard TEDS or symbolic LaTeX equivalence; human
review against genuine annotations remains pending. Full-PDF table rows retain
normalized reference/prediction trees, node counts, final distance and normalization
denominator under the frozen custom tree contract. Missing or rejected predictions have
no invented distance and retain their gold denominator; unsupported TEDS size retains both
trees and an explicit null score with a reason. Figure scoring checks declared asset path/page/hash linkage after
source-region matching, not crop-image content correspondence. Independent caption locators
are absent, so caption quality remains null. Rich-only objects are retained without invented order.

## Artifacts and completion

`objects.json` retains source/model/input identities, per-object matching and exact-match results, TEDS intermediate trees/distances, normalization version and category counts. Every failure/missing object remains visible. A measured 0 is a real score; unrun or inapplicable metrics are null with reasons.

Synthetic table/formula fixtures and manual schema construction are engineering evidence only.
Public raster reports must preserve their measured subset and scorer identity; they do not establish figure/caption PDF provenance or full scientific readiness.
