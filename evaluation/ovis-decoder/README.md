# Ovis 8-bit decoder candidate

The original 347-page 8-bit evaluation failed. Its outputs and acceptance contract
remain frozen. `candidate-1.05.json` fixes a separate full-cohort run with a 1.05
repetition penalty and the unchanged 20-token repetition context. The selected
failure page and three exploratory controls informed this setting; no held-out
quality claim is made.

`score-ovis-candidate.py` scores every candidate page against the original BF16
reference, retaining invalid pages as empty predictions. Changing the decoder
also requires a new comparison with the independent official PyTorch MPS output.
`backend-1.05.json` pins that check to the original three-page backend cohort,
reference score, source-image associations and unchanged v2 acceptance margins.

The backend scorer consumes those pages from the **complete 347-page candidate
run**, in original backend order (`scientific-006`, `005`, `001`). It verifies the
full candidate's settings, completion accounting and hashes before selecting
pages. The original PNG reference images and candidate JPEG images must still
have identical decoded RGB pixels. Raw output changes invalidate the run; model
failures remain in the denominator. Exploratory controls cannot replace pages.

Run from the repository root under network denial, with a new output directory:

```sh
/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)' \
  .runtime/ovis-evaluator/venv/bin/python -B scripts/research/score-ovis-candidate-backend.py \
  --inference .artifacts/research-toolchain-p3/candidate-repetition-1.05 \
  --runtime .runtime/ovis-evaluator \
  --runtime-receipt .artifacts/research-toolchain-p3/evaluator-runtime-receipt.json \
  --baseline .artifacts/research-toolchain-p3/scoring-gold-baseline-audit-v2-linked \
  --output .artifacts/research-toolchain-p3/candidate-repetition-1.05-backend \
  --wait
```

The scorer and protocol must be committed before execution. It records source
hashes before waiting and rejects changes. Results include independent text,
geometry and reading-order metrics, official CDM/TEDS, the gold-denominator audit
and a separate comparison report. Exit 0 means this comparison passed; exit 2
means it did not. A scorer/runtime/input failure is recorded separately and must
not be interpreted as a model quality score.

Both candidate comparisons, source provenance and actual resource qualification
remain prerequisites for adoption. Neither scorer enables the application parser.
The old exact-content failure and original full-cohort quality failures remain
part of the evidence. Skipped scan/cross-page gold and device coverage remain
limitations of this work.

Script regression checks:

```sh
node --test tests/unit/research-ovis-candidate-contract.test.mjs \
  tests/unit/research-ovis-candidate-backend.test.mjs \
  tests/unit/research-ovis-zero-order.test.mjs
.runtime/ovis-evaluator/venv/bin/python -B -m unittest discover \
  -s evaluation/ovis-evaluator -p 'test_*.py' -v
```
