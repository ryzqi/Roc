# Task: scientific-e2e

**Status:** Draft — agent-reviewed; not a registered `pnpm evaluate` suite. This spec
defines required evidence and does not itself accept a real user project.

## Outcome and environment

Measure final answers from the real Agent Runtime and research tools, retaining the
actual search, context, scientific knowledge and Wiki reads. Reuse the existing
`rag-paper-qa` runtime/isolation and host verifiers where their contracts apply; do not
substitute a scripted answer generator or tool double for a scientific quality trial.
Create one disposable project/database per trial. Keep hidden reference answers,
source regions, supported propositions and unanswerable labels out of model input.

Lock original PDF/source identities, question IDs/text, project/document scope,
parser/IR/generation/model/prompt/tool versions, context budget, permissions and
repeats before running. Include text, tables, formulas, figures, numeric comparisons,
multiple papers and unanswerable cases; retain every preselected case and failed trial.
Published reference answers retain their exact upstream provenance. Mechanically
aligned regions remain distinct from reviewed source correspondence.

## Independent scoring

| Metric | Evidence and denominator |
| --- | --- |
| Answer Correctness | Fraction of applicable answerable questions whose final answer meets every required reference proposition, numeric value, unit and condition under a frozen adjudication rubric; report partial proposition coverage separately. |
| Faithfulness | Supported factual answer propositions divided by all factual answer propositions, resolving each citation to the exact original source and checking entailment. No factual propositions is NA, not 100%. |
| Evidence Recall | Complete recovered gold support sets divided by applicable reference support sets, using actual context reads and exact source intervals/regions. Ranked-but-unread results are a separate retrieval metric. |
| Correct Refusal | Explicitly unsupported/unanswerable questions answered with an honest evidence limitation divided by all labelled unanswerable questions; invented answers fail. Also report false refusal on answerable cases. |

Token overlap can be a labelled auxiliary QA metric, never a replacement for semantic
correctness or faithfulness. Source-resolvable citations alone do not prove entailment.
Preserve model-produced claims, independently authored/approved reference propositions,
matching decisions and rubric/reviewer provenance. Agent adjudication may be reported
as such, without inventing human review. Missing judgments remain null with reasons.

The host checks actual source bytes, immutable Evidence and Wiki revisions, tool call
effects, context observations, answer citations and project isolation. A model's claim
that it read or verified evidence is not an observation. Empty/cancelled/failed answers
keep the answerable denominator and their explicit failure status. Report context
budget exclusions, stale sources and provider failures rather than silently rerunning
only poor cases. For repeated model trials, retain all samples and paired paper clusters.

## Acceptance and rollout

Freeze minimum quality, per-category non-inferiority, wrong-source ceiling zero and
resource ceilings before comparing Baseline/A–I. Require actual positive benefit on a
declared primary metric with no failed safety/source gate. Parser fixtures, public text
BM25 and source-copy Wiki trials cannot satisfy this final-answer acceptance.

Record each rollout stage separately: locked 45-paper cohort, isolated project,
authorized real project, multi-paper project and wider enablement. At each stage read
original PDFs, old Evidence and immutable Wiki revisions; exercise retrieval failure,
legacy fallback and generation rollback without reparse. Never report an isolated
fixture as acceptance of a real user project. Preserve trial manifests, transcripts,
independent scoring decisions, before/after persistence snapshots, resource samples
and the exact code/config hashes. Unavailable model/judgment/project inputs leave the
corresponding stage pending rather than making the full release gate pass.
