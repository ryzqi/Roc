# Formula region diagnostic

Status: **Verified passing** for reproducing the saved geometry measurements.
P3 quality acceptance still fails under its unchanged v2 contract. This diagnostic
does not change coordinates, merge predictions, remove pages or qualify a model.

The observed horizontal bias is concentrated in formulas whose gold LaTeX contains
an equation tag. Both BF16 and 8-bit show the same pattern:

| Matched formula regions | BF16 count | BF16 mean X bias | 8-bit count | 8-bit mean X bias |
| --- | ---: | ---: | ---: | ---: |
| All | 182 | -1.5123% | 177 | -1.5534% |
| Gold contains `\tag` | 52 | -4.6761% | 52 | -4.6780% |
| Gold has no `\tag` | 130 | -0.2467% | 125 | -0.2535% |

Bias is signed and normalized by page width. These are diagnostic groups among
IoU-matched formulas, not separate acceptance cohorts or recall denominators.
All 347 pages remain in the reports; the invalid 8-bit page is recorded explicitly.
The 8-bit median X bias is -0.1192%. Its average left edge error is +0.0920%,
while the right edge error is -3.1988%; the error is not a uniform page translation.

Visual inspection of `scientific-157` confirms one concrete mismatch in region
meaning. Gold equation `(33)` spans normalized X `[0.1809, 0.8590]`, including its
right-side number. Ovis emits the formula body as `[0.180, 0.562]` and a separate
`formula_number` block `(33)` as `[0.824, 0.858]`. The current metric compares the
gold combined region against only the formula body. This produces a -14.896%
center difference even though the number is present in its own region. Similar
tagged examples rank among the largest errors. This evidence does not prove that
every mismatch has that cause or that combining regions would pass acceptance.

`diagnose-ovis-formula-geometry.py` re-reads the complete frozen inference report,
checks every source-image/raw-output identity, and recomputes matches with the
unchanged geometry scorer. It records input hashes and refuses existing output
paths. The original scores and reports remain untouched. Grouping is for
diagnosis only; the script never produces a passing decision.

Checks from `/Users/Apple_501/Desktop/Roc/Roc`:

```sh
.runtime/ovis-evaluator/venv/bin/python -B scripts/research/diagnose-ovis-formula-geometry.py \
  --inference .artifacts/research-toolchain-p3/paired-347/8bit \
  --output .artifacts/research-toolchain-p3/formula-geometry-8bit.json
.runtime/ovis-evaluator/venv/bin/python -B scripts/research/diagnose-ovis-formula-geometry.py \
  --inference .artifacts/research-toolchain-p3/paired-347/original-bf16 \
  --output .artifacts/research-toolchain-p3/formula-geometry-bf16.json
```

Both commands exited 0. Counts and aggregate X bias reproduce the frozen
independent scores within `1e-15`. Re-running requires new output paths. No model
inference or runtime mutation was needed and no temporary directories were created.

A revised semantic region contract would require an explicit decision, a fixed
association rule, and complete-cohort evaluation. It must preserve ambiguous and
missing associations, raw coordinates and all original failures. The pending
decoder candidate continues under the existing contract until that decision.
