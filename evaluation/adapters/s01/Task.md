# S01 quality-evaluation task contract

## Scope and current status

Status: Draft scientific task specification; engineering contract implemented. One evaluator accepts explicit frozen fixture, dev pilot and holdout full datasets. The original 16 tasks now live in `tests/fixtures/quality-evaluation/`, with two tasks per family, all in the `fixture` split. They are contract-only and do not count toward independent data. No independent corpus, human blind review or live provider run has been completed.

The required 200-task holdout distribution is literature verification 30, multi-paper evidence 30, long-memory 25, file/report 30, experiment script 25, MCP recovery 20, permission injection 20, and cancel/crash 20, with at least five independent clusters per family. Train/dev samples are additional. Register connected source clusters and concrete splits before annotation; retain license, attribution, locator, content hash, input hash, two independent reviews and any arbitration. Current independent completion is 0/200. See the [executable protocol](protocol.ts) and [dataset validation contract](dataset.ts). These implementations validate metadata; an approved annotation manual and independent reviewed corpus remain outstanding.

## Agent input and verifier boundary

Pass the agent only `AgentTaskView`: task id, family, difficulty, prompt, output format, and visible prior conversation turns. The agent must not receive validator expectations, source registry IDs, cluster IDs, split metadata or reviewer records. Reference outputs and validation stay on the evaluator side. Task prompts may contain attributed CC BY evidence excerpts; hidden expected facts remain separate. Output is limited to 64 KiB of JSON per task. S01 uses the [shared application worker](../../runtime/application-worker.ts) and [shared task view](../../runtime/agent-task-view.ts); its build graph excludes evaluator modules and fixtures. The S01 dataset preserves its original strict task fields and rejects the optional response contract used by other suites.

Every fixture task has a completion schema and deterministic validator. Validators check source-bound DOI/facts, exact citations, memory constraints, exact CSV rows and SHA-256, a restricted side-effect-free TypeScript aggregation function, ordered MCP recovery receipts, denied permission actions, and cancellation/crash reconciliation. The TypeScript validator parses an AST; it never executes submitted code. These checks establish structured contract correctness. Agent-authored receipt JSON does not prove an external effect, permission denial or crash recovery; those tasks require real environment observers before scientific evaluation.

## Retained fixture sources

The following short excerpts and fact values are retained with attribution. Europe PMC metadata returned `cc by`; the metadata did not specify a license version, so none is inferred.

- Bruk LA, Fan X, Resnick JL, DiLeo MV (2023), “Controlled Release of Mesenchymal Stem Cell-Conditioned Media from a Microsphere/Gel-Based Drug Delivery System for Wound Healing of Tympanic Membrane Perforations,” DOI [10.1155/2023/6039254](https://doi.org/10.1155/2023/6039254), PMCID PMC11918824. License metadata: [Europe PMC record](https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=EXT_ID:40226420&format=json); article: [Europe PMC full text](https://europepmc.org/articles/PMC11918824). Locator: Results 3.1, first paragraph. The retained excerpt records 21 μg total protein on day 1 plus 10 μg over the following 20 days, and FGF-2 121 pg on day 1 plus 75 pg over the following 14 days.
- Langaliya A, Dhull KS, Gupta B, Saleem Agwan MA, Gupta S, Macha Y, Makkad RS (2023), “Effect of NaOCl on cyclic fatigue resistance,” DOI [10.6026/973206300191348](https://doi.org/10.6026/973206300191348), PMCID PMC10895534. License metadata: [Europe PMC record](https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=EXT_ID:38415037&format=json); article: [Europe PMC full text](https://europepmc.org/articles/PMC10895534). Locator: abstract results statement. The retained excerpt reports 60 endodontic files after 5.25% NaOCl treatment: TruNatomy 1053.50 ± 134.81, Hero Gold 652.66 ± 58.66, and ProTaper Gold 494.50 ± 47.69 cycles to fracture (mean ± SD).
- Rajpoot AS, Bagde H, Thumar S, Pattnaik N, Saha N, Patel K, Mehta DN, Panigrahi B (2023), “Chlorhexidine and doxycycline gel versus chip as adjuncts in oral hygiene among Indians,” DOI [10.6026/973206300191342](https://doi.org/10.6026/973206300191342), PMCID PMC10895532. License metadata: [Europe PMC record](https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=EXT_ID:38415043&format=json); article: [Europe PMC full text](https://europepmc.org/articles/PMC10895532). Locator: abstract sample and result statements. The retained excerpt reports 90 adult Indian patients with moderate chronic periodontitis; it reports better pocket-depth and attachment-level changes for the chlorhexidine group than for the doxycycline group, and better periodontal outcomes for gel than chip forms.

The prompts include short attributed excerpts, not article full text. Other fixture tasks use original synthetic conversations, file rows, tool receipts, and permission/crash scenarios; they contain no personal data and make no external writes. Original source metadata is retained in `tests/fixtures/quality-evaluation/source-records.json`.

## Statistical preregistration

Protocol schema version: 3. Status: Draft scientific preregistration; no live trial authorized or run. `createQualityProtocolDraft(dataset, id)` binds the explicit dataset hash. Before provider dispatch, lock different baseline/candidate commit SHAs, the same provider/model, tool/prompt/environment/isolation hashes, temperature, timeout, price version, maximum request count, per-request/trial/total spend caps and approval reference. Statistical defaults cannot be weakened by re-signing a draft. Do not amend a lock after dispatch.

The comparison pairs baseline and candidate on each task/repeat with the same models, fixed task data, tools, permissions and environment. Three repeats per task, 2,000 seeded paired-cluster bootstrap resamples, 95% percentile intervals, at least five independent clusters per family, and a 0.05 non-inferiority margin are fixed. Task/repeat order is randomized by the registered seed. Family comparisons are exploratory and unadjusted for multiplicity; any significant family regression blocks an overall gain claim, and every family must satisfy the non-inferiority interval for an overall gain. Report failure classes, pass rate, P95 latency and token usage. Null output and failed runs score zero; infrastructure/provider/verifier/operator failures remain separately classified.

Scientific sufficiency requires the complete frozen holdout identity and quotas, live-model evidence and all registered repeats. Subjective writing quality requires separate blinded human review with retained disagreements; the statistics report always starts with `subjectiveReviewStatus=not_run`. Underfilled evidence returns `insufficient` and `uncertain`. Fixtures never count as model evidence.

## Application environment and authorization

The macOS adapter runs the real `AgentPluginRuntime → createAgentDeepAgentExecutor → buildRunHarness`, with application event log, usage ledger, checkpointer, session history, memory database and effect store. Each trial receives fresh state. `sandbox-exec` denies network, restricts process execution to Node and denies evaluator/corpus paths. Host transcript and cleanup evidence are outside the worker-readable workspace. No ambient credentials or tracing are inherited. Model requests go through stdio to a trusted host transport; request admission is journaled and synced before dispatch, SDK retries are disabled. Input-size and request-timeout settings are locked.

Application tests use fixed local responses and retain the exact assistant answer through the [isolated regression](../../../tests/unit/quality-application-adapter.test.mjs); raw output and incorrect facts remain visible to the evaluator. The adapter has no connected MCP, Skill or external workspace, and prior turns are prompt context rather than cross-session recovery. Real effect observers and long-task environments remain outstanding. Local SDK streaming is bridged from one non-streaming completion and cannot establish provider streaming latency.

L1 uses no live credential or user project. L2 requires independent reviewed data, isolated credentials, actual provider identity, checked permissions and the locked protocol. L3 additionally requires explicit L3 approval and a rollback reference. No paid L2, external writes or publishing are authorized by this spec. Shared credential/evidence handling follows the [evaluation guide](../../README.md#模型预算与隔离); the former `.artifacts/research-harness/S01/` directory is absent and supplies no inspectable evidence.

## Entry points and remaining data work

`loadQualityDatasetPackage(manifestPath, canonicalHash)` loads data and evaluator-only expectations explicitly; hidden refs are hash checked and realpath-contained. `pnpm evaluate check --suite roc-s01` selects the fixture and makes zero model/network calls; explicit manifest/hash audits another package without dispatch. Direct adapter entry remains `pnpm evaluation:s01:check`. Underlying APIs have no implicit fixture fallback.

`runQualityEvaluationWithJournal` uses the one runner, exclusive fsynced journal and final report. Existing journals block replay across restarts; reconcile calls before a new explicitly authorized protocol. Failed and withheld arms remain in the denominator. Unconfirmed abort, integrity failures or journal errors stop further dispatch.

Prepare each arm from a committed clean checkout using `node evaluation/adapters/s01/prepare-worker.mjs .artifacts/research-harness/S01/<arm>`. The artifact records actual commit, bundle hash, lockfile hash, dependencies and Node version. Arms require the same dependency lockfile. A baseline without this adapter must first receive the same evaluation contract and then be committed; never attach an old SHA to a new worker bundle.

Reviewed independent data, real effect observers, two-arm model trials, blinded scientific reports remain unrun. Do not manufacture source independence by duplicating or paraphrasing fixtures.

### Retained fixture inventory

- Literature verification: `literature-release-windows`, `literature-fatigue-ranking`.
- Multi-paper evidence: `multi-paper-dental-outcomes`, `multi-paper-release-and-periodontal`.
- Long-memory: `long-memory-release-constraints`, `long-memory-study-boundaries`.
- File/report: `file-report-fatigue-csv`, `file-report-release-windows`.
- Experiment scripts: `experiment-script-fatigue-mean`, `experiment-script-release-totals`.
- MCP recovery: `mcp-recovery-idempotent-retry`, `mcp-recovery-stale-receipt`.
- Permission injection: `permission-injection-untrusted-document`, `permission-injection-untrusted-tool-output`.
- Cancel/crash: `cancel-crash-unknown-effect`, `cancel-crash-known-receipt`.
