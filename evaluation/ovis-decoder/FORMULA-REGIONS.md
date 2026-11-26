# Formula measurement regions v3

The user approved measuring formulas together with their numbers after observing
the v2 mismatch documented in `docs/research-ovis-formula-geometry.md`. This is a
new contract after seeing those results. The original v1/v2 contracts, scores,
failures, raw coordinates and inference remain unchanged. The decoder candidate
still fails the independent caption recall gate under v2.

`acceptance-regions-v3.json` pins the prior contract, matcher, implementation,
seven saved score/inference arms and their qualified gold-denominator audits.
Freeze the contract and scorer in Git **before** computing v3 scores.

Association uses only each side's own coordinates and categories, independently
for gold and predictions. A number's center must lie within a display formula's
vertical span, with at least half its height overlapping. Their horizontal spans
must be disjoint. Prefer formulas to the number's left; if none qualify, consider
formulas to its right. Choose the smallest horizontal gap. Equal-distance ties
stay unbound. If several numbers choose the same formula, all stay unbound; there
is no reassignment. Inline formulas are never extended.

For an unambiguous pair, a measurement-only copy uses the bounding union as the
formula region. The separate number region stays present. Already combined gold
regions remain unchanged. No region, category, order, text or prediction is
deleted. Missing and ambiguous associations remain visible with reasons. There
is no coordinate shift, clipping, text repair or gold-guided association of model
predictions. This rule cannot certify every individual region for citation.

The unchanged v2 matcher measures these copies. All numeric geometry limits,
including IoU >= 0.5, remain binding. Every family retains its gold and prediction
counts. Only the formula and aggregate geometry statistics may change. Caption
and other families keep their original measurements. Text, official CDM/TEDS and
reading-order measurements are reused from the qualified, hash-bound v2 reports;
the scorer first reproduces the original geometry/order measurements exactly.

```sh
node --test tests/unit/research-ovis-formula-regions.test.mjs
.runtime/ovis-evaluator/venv/bin/python -B scripts/research/score-ovis-formula-regions.py \
  --output .artifacts/research-toolchain-p3/formula-regions-v3
```

Use a new output path. The scorer retains per-page associations, scores,
comparisons and input hashes. Input drift or inability to reproduce the original
measurements invalidates the run. A successful scorer exit means evaluation ran;
read each comparison's `passed` field for quality acceptance. No application
enablement or resource qualification follows automatically from these results.
