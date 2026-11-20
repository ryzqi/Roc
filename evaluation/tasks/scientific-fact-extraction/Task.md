# Task: scientific-fact-extraction

**Status:** Draft — agent-reviewed; not a registered `pnpm evaluate` suite. Production
extraction/source validation regressions are engineering evidence. Qualified scientific
metrics require the independent gold and actual execution defined below.

## Outcome and fixed inputs

Measure entities and atomic scientific facts produced by the actual
`ScientificExtractionService` on the locked original-paper cohort. Freeze source bytes,
Paper IR and generation receipts, extractor/prompt/model/config identities, selected
paper IDs, repeat count, budgets and matching rules before either comparison arm runs.
Use a disposable project and database for each trial. Independent reference entities,
facts and support annotations stay outside model input. Preserve published provenance;
agent review must not be relabelled as human annotation.

Gold must include entity type/name/aliases and a fact's complete subject, predicate,
object/value, unit, dataset, split, metric, baseline, experimental conditions and exact
supporting source regions. A field can be explicitly inapplicable; absent annotation
does not license its inference from the candidate output. Do not derive gold from the
new extractor or treat a QASPER answer as a complete paper-level fact inventory.

## Execution and independent verifier

Run production enqueue/drain/read against real stored Paper IR. Capture actual model
requests/responses, extraction versions, candidates, validation failures and resulting
readable knowledge. Use the existing isolated provider/budget/seal infrastructure.
Report queue failure, malformed model output, source/config supersession and cancellation
for every selected paper; never omit a failed paper from an applicable denominator.

| Metric | Frozen scoring contract |
| --- | --- |
| Entity F1 | One-to-one same-type matches against independently approved names/aliases; micro TP/FP/FN plus per-type counts. Do not use candidate-generated aliases as reference equivalences. |
| Fact F1 | One-to-one exact structured semantic match over every applicable reference field, including numeric value/unit and experiment conditions. Missing conditions are a miss. Unmatched predictions count as FP and gold facts as FN. |
| Evidence Coverage | Gold facts with both a correctly matched fact and complete independently verified supporting regions divided by all applicable supported gold facts. Union exact source spans; partial overlap receives no full-support credit. |

Entity or fact equivalence requiring judgment must retain the reference, prediction,
decision, reviewer provenance and rubric version. Until those decisions exist, report
null with the missing requirement; structural source validity is a separate metric.
Report per-paper and table/formula/text breakdowns. Repeated duplicate predictions cannot
receive repeated TP credit. Empty gold categories are NA; an empty prediction set with
nonempty gold has zero recall. Record precision/recall denominators explicitly.

Resolve support independently from original source/parse/hash/page/object/span and
stored immutable artifacts. Wrong project, stale generation, altered source and
unresolved support receive no credit. Keep source-binding rejection rates separate from
scientific truth. Model failures count as failed trials and zero recovery of applicable
gold, not as invented semantic false positives.

## Artifacts and acceptance

Retain per-paper raw observations, reference identity, matching pairs, counts, rejection
reasons, cost/latency/RSS and repeat samples. Compare paired papers with the same frozen
cohort/model/budget, preserving failures and type regressions. Acceptance requires
predeclared quality/resource thresholds, no wrong-source support, and independently
reproducible arithmetic. Fixtures and public QA exports alone cannot establish
this whole-paper gold inventory; missing independent judgments leave the corresponding
quality metrics null.
