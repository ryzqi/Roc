# PR-06 quality-evaluation task contract

## Scope and current status

This directory defines a small, deterministic L1 pilot contract for agent task quality. The 16 pilot tasks cover eight families with two tasks per family. Every current task is in the `pilot` split. The dataset is intentionally below the 200-task target and does not contain train/dev/holdout evidence; `lockQualityProtocol(..., { executionMode: 'full' })` must reject it. L1 checks fixture contracts and independent validators only. It makes no real-model quality, transfer, latency, or provider-cost claim.

The planned 200-task distribution is literature verification 30, multi-paper evidence 30, long-memory 25, file/report 30, experiment script 25, MCP recovery 20, permission injection 20, and cancel/crash 20. Expand by reviewed, independent source/task clusters; do not count paraphrases of one source as independent evidence. Record task source, license metadata, difficulty, cluster, split and review status. A small sample is uncertain even if all fixture checks pass.

## Agent input boundary

For any future L2/L3 run, pass the agent only `AgentTaskView`: task id, family, difficulty, prompt, output format, and any visible prior conversation turns. The agent must not receive validator expectations, source registry IDs, cluster IDs, or split metadata. Reference outputs and validation stay on the evaluator side. Task prompts may contain attributed CC BY evidence excerpts; hidden expected facts remain separate. Output is limited to 64 KiB of JSON per task.

Every task has a completion schema and deterministic validator. Validators check source-bound DOI/facts, exact citations, memory constraints, exact CSV rows and SHA-256, a restricted side-effect-free TypeScript aggregation function, ordered MCP recovery receipts, denied permission actions, and cancellation/crash reconciliation. The TypeScript validator parses an AST; it never executes submitted code. These checks establish contract correctness, not writing quality or general reasoning quality.

## Fixed pilot sources

The following short excerpts and fact values are retained with attribution. Europe PMC metadata returned `cc by`; the metadata did not specify a license version, so none is inferred.

- Bruk LA, Fan X, Resnick JL, DiLeo MV (2023), “Controlled Release of Mesenchymal Stem Cell-Conditioned Media from a Microsphere/Gel-Based Drug Delivery System for Wound Healing of Tympanic Membrane Perforations,” DOI [10.1155/2023/6039254](https://doi.org/10.1155/2023/6039254), PMCID PMC11918824. License metadata: [Europe PMC record](https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=EXT_ID:40226420&format=json); article: [Europe PMC full text](https://europepmc.org/articles/PMC11918824). Locator: Results 3.1, first paragraph. The retained excerpt records 21 μg total protein on day 1 plus 10 μg over the following 20 days, and FGF-2 121 pg on day 1 plus 75 pg over the following 14 days.
- Langaliya A, Dhull KS, Gupta B, Saleem Agwan MA, Gupta S, Macha Y, Makkad RS (2023), “Effect of NaOCl on cyclic fatigue resistance,” DOI [10.6026/973206300191348](https://doi.org/10.6026/973206300191348), PMCID PMC10895534. License metadata: [Europe PMC record](https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=EXT_ID:38415037&format=json); article: [Europe PMC full text](https://europepmc.org/articles/PMC10895534). Locator: abstract results statement. The retained excerpt reports 60 endodontic files after 5.25% NaOCl treatment: TruNatomy 1053.50 ± 134.81, Hero Gold 652.66 ± 58.66, and ProTaper Gold 494.50 ± 47.69 cycles to fracture (mean ± SD).
- Rajpoot AS, Bagde H, Thumar S, Pattnaik N, Saha N, Patel K, Mehta DN, Panigrahi B (2023), “Chlorhexidine and doxycycline gel versus chip as adjuncts in oral hygiene among Indians,” DOI [10.6026/973206300191342](https://doi.org/10.6026/973206300191342), PMCID PMC10895532. License metadata: [Europe PMC record](https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=EXT_ID:38415043&format=json); article: [Europe PMC full text](https://europepmc.org/articles/PMC10895532). Locator: abstract sample and result statements. The retained excerpt reports 90 adult Indian patients with moderate chronic periodontitis; it reports better pocket-depth and attachment-level changes for the chlorhexidine group than for the doxycycline group, and better periodontal outcomes for gel than chip forms.

The prompts include short attributed excerpts, not article full text. Other pilot tasks use original synthetic conversations, file rows, tool receipts, and permission/crash scenarios; they contain no personal data and make no external writes.

## Statistical preregistration

Protocol id: `roc-agent-harness-pr06-v2`. Status: Draft; no live trial authorized or run.
The protocol is bound to the SHA-256 of the frozen sources/tasks. Before provider dispatch,
lock full baseline/candidate commit SHAs, provider/model identifiers, tool/prompt/environment
hashes, timeout, finite task/total spend caps, approval reference and repeat count.
Same-model comparisons require different commits. Do not amend a lock after dispatch.

The planned comparison pairs baseline and candidate on each task/repeat with the same models, fixed task data, tools, permissions, budgets, and environment. Default plan: three repeats per task, 2,000 seeded paired-cluster bootstrap resamples, 95% percentile intervals, at least five independent clusters per task family, and a 0.05 non-inferiority margin. The eight family quotas total 200. Family comparisons are exploratory and unadjusted for multiplicity; any family regression blocks an overall gain claim. Report failures by class, pass rate, P95 latency, and known/unknown cost. Null output and failed runs score zero; infrastructure/provider/verifier/operator failures remain separately classified.

Subjective writing quality requires blinded human review and retained disagreements. No judge is configured for this L1 pilot. Underfilled task/family/cluster quotas produce `insufficient` evidence and an `uncertain` conclusion. Fixture-generated scores never count as model evidence.

## Authorization and isolation

L1 may run in ordinary CI. It makes zero external calls, uses no live provider credential or user project, and writes generated reports only under `.artifacts/harness-eval/`. L2 must run only with isolated provider credentials, fixed data/tools, a locked protocol and finite per-task/total caps. L3 additionally requires explicit L3 approval, a rollback plan, a named operator, a finite rollout, and stop thresholds. Never place credential values in this dataset, task prompts, reports, or test output. If cost cannot be estimated and hard-capped, keep live evaluation blocked and cost unknown.

## Offline runner and remaining data work

`pnpm harness:quality:check` reports the actual pilot counts, source clusters, missing full
dataset conditions and exact public prompt hash. It makes no model or network calls.

`runner.ts` executes each frozen task/arm/repeat once and passes only `AgentTaskView` to a
trusted adapter. It counterbalances arm order, binds adapter identity to the lock and writes
events before dispatch. Null output, invalid/unsafe output, adapter failures and withheld calls
remain in the fixed denominator. Unknown cost retains the complete quoted ceiling.
No arbitrary output script is executed. An unconfirmed abort or cost-ceiling violation stops
further dispatch. Event failures propagate.

`runQualityPilotWithJournal` creates an exclusive journal, syncs each event before dispatch
and writes a final report. An existing journal blocks rerun, including after process restart;
reconcile its dispatched calls before creating another explicitly authorized protocol.

Adapter quotes and request caps are a trusted host contract. No live adapter ships with
this increment. Runner tests exercise fixtures; they do not prove provider enforcement,
tool/sandbox isolation, full trajectories or scientific quality.
The actual application Harness adapter, isolated credentials, attributable prices, explicit
L2 spending limits and reviewed independent 200-task corpus remain required.
Do not manufacture source independence by duplicating or paraphrasing the pilot.

### Existing pilot inventory

- Literature verification: `literature-release-windows`, `literature-fatigue-ranking`.
- Multi-paper evidence: `multi-paper-dental-outcomes`, `multi-paper-release-and-periodontal`.
- Long-memory: `long-memory-release-constraints`, `long-memory-study-boundaries`.
- File/report: `file-report-fatigue-csv`, `file-report-release-windows`.
- Experiment scripts: `experiment-script-fatigue-mean`, `experiment-script-release-totals`.
- MCP recovery: `mcp-recovery-idempotent-retry`, `mcp-recovery-stale-receipt`.
- Permission injection: `permission-injection-untrusted-document`, `permission-injection-untrusted-tool-output`.
- Cancel/crash: `cancel-crash-unknown-effect`, `cancel-crash-known-receipt`.
