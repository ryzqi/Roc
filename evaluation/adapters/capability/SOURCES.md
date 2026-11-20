# Capability datasets and original sources

The three suites use Task schema v2 and the existing sealed dataset API. Task Specs and all supplied engineering definitions remain **Draft**. Upstream byte verification, production runtime support, independent human review, and scientific qualification are separate gates.

## Preparation and readiness

```js
import { loadDataset } from '../../lib/data.mjs';
import {
  prepareCapabilityDataset, validateCapabilityDataset, capabilityReadiness,
  capabilitySuites, capabilityMetrics, capabilityFamilies,
  capabilityFamilyQuotas, e2eFamilyQuotas, capabilityProductionTools,
  capabilityReviewContentHash
} from './data.mjs';
import { capabilityEngineeringDataset } from './fixture.mjs';

const suite = 'roc-capability';
const corpus = capabilityEngineeringDataset(suite);
const sealedPath = await prepareCapabilityDataset(corpus, { suite });
const dataset = validateCapabilityDataset(loadDataset(sealedPath));
const readiness = capabilityReadiness(dataset);
```

`prepareCapabilityDataset(pathOrObject, {suite, cacheRoot?})` returns a sealed directory. JSON path inputs resolve source roots relative to their JSON file; object inputs resolve relative roots from the current working directory. Both accept:

```text
{
  schemaVersion: 2,
  suite?: "roc-capability" | "roc-e2e-research" | "roc-security",
  provenance?: {kind: "engineering_fixture" | "local_source_import" | "human_reviewed"},
  tasks?: Task[],
  imports?: SourceSpec[]
}
```

`validateCapabilityDataset(dataset)` returns the supplied `loadDataset` object and attaches identical `capabilityQualification` and `datasetQualification` records. It rereads the seal and replays original mappings. `capabilityReadiness(dataset)` performs the same validation and returns a separate copy of that qualification.

Readiness exposes `status`, `supported`, `tasks`, `familyCounts`, `holdoutDatasetReady`, and `releaseDatasetReady`. `holdoutReady` and `fullDatasetReady` are aliases of `holdoutDatasetReady`. A small reviewed subset can have `status: "verified"` while the complete dataset gates remain false; callers must check the gate for their selected split.

`fixture`, `development`, `holdout`, and `release` are isolated splits. Source-connected components cannot overlap across any two splits. Capability holdout and release each use the registry's 200-task family quotas; security uses its independent 15-task quota. Each E2E split needs four workflows × six qualified tasks, with **at least six actual source-connected roots per workflow**. `familyCounts[family].qualifiedHoldoutClusters` and `.qualifiedReleaseClusters` count those roots. Task labels cannot establish source independence.

Use `readiness.tasks[].sourceConnectedRoot` as the sampling/comparison cluster key. It is an opaque deterministic `source-connected-<sha256>` identity derived from sorted original source references and corpus identities. Original tasks and `task.clusterId` remain intact. Fixtures without upstream references use their declared cluster label only as an engineering fallback.

## Acquisition

The control-plane pins live in [`sources.lock.json`](../../datasets/sources.lock.json); the P0/P1/P2 selection and qualification policy live in [`registry.json`](../../datasets/registry.json).

```sh
node evaluation/adapters/capability/acquire.mjs --all-p0 --plan
node evaluation/adapters/capability/acquire.mjs --all-p0
node evaluation/adapters/capability/acquire.mjs --all-p0 --offline
node evaluation/adapters/capability/acquire.mjs --source bfcl
```

`--root DIR` selects an acquisition root. The default is ignored `evaluation/local/sources`. Snapshots are stored at `<root>/<source-id>/<revision>/<original-path>`.

The acquisition API exports `capabilitySourceAcquisitionPlan(sourceIds?)` and `acquireCapabilitySources({sourceIds?, root?, offline?, maxBytes?, fetcher?})`. Only exact trusted locked artifacts are fetched, with a default 64 MiB total byte budget and bounded individual reads. Existing snapshots are verified without refetching or repairing them. `offline: true` requires an existing complete snapshot. Archive members are read to stdout from their pinned archive and rehashed. Acquisition does not execute upstream Python, install packages, or create reviews.

The source lock is authoritative for exact revisions, URLs and byte hashes. The P0 license and adaptation boundaries are summarized below; offline verification requires the corresponding local files:

| Source | Original data license | Adaptation |
|---|---|---|
| BFCL | Apache-2.0 | First-turn file-read development slice |
| ToolSandbox | LicenseRef-Apple-ToolSandbox | Native Python scenario/milestone mapping pending |
| LongMemEval V2 | Apache-2.0 | Complete trajectory observations missing |
| LoCoMo | CC-BY-NC-4.0 | Text conversation and real cross-session memory slice |
| SciFact | CC-BY-4.0 claims; ODC-By-1.0 corpus | Original claim/evidence and offline BM25 slice |
| QASPER | CC-BY-4.0 | Reuses the existing official sealed adapter |
| ScienceAgentBench verified | CC-BY-4.0 data; MIT grader code | Scientific assets/environment/grader qualification pending |
| AgentDojo | MIT | Native business APIs and effect mapping pending |
| InjecAgent | MIT | Original untrusted response on a local file surface |

The lock records exact artifact SHA256, byte counts, original URLs, available Git blob or LFS evidence, original paths, licenses, and attribution. P1/P2 unresolved records retain `status: "pending"`, null revision/license, and no invented artifact hashes. Local content pins alone do not authenticate upstream origin.

## Explicit imports and examples

```sh
node evaluation/adapters/capability/import-examples.mjs \
  --output-root evaluation/local/source-imports/new-source-specs
pnpm evaluate source-import roc-capability \
  --spec evaluation/local/source-imports/new-source-specs/bfcl.development.json
pnpm evaluate source-import roc-security \
  --spec evaluation/local/source-imports/new-source-specs/injecagent.development.json
pnpm evaluate check --suite roc-capability --dataset /absolute/sealed-dataset
```

The example writer creates four importable development corpora (`bfcl`, `scifact`, `locomo`, `injecagent`) and five pending adaptation manifests with reasons and no fabricated tasks. It refuses to overwrite an existing file. `--sources-root DIR` selects the acquisition root. The `*.pending.json` files describe missing adaptation work; they are not preparation corpora.

```js
import {
  capabilityDevelopmentSources, capabilitySourceImportExample,
  capabilitySourceAdaptationManifest, writeCapabilitySourceImportExamples
} from './import-examples.mjs';
import {
  capabilitySourceIds, capabilityLockedSourceSpec, importCapabilitySources,
  verifyCapabilitySourceSnapshot, verifyCapabilitySources, localSourceRevision
} from './sources.mjs';

const corpus = capabilitySourceImportExample('scifact');
const sealedPath = await prepareCapabilityDataset(corpus, { suite: corpus.suite });
```

A normal source spec contains `dataset`, `root`, a fixed `revision`, `license: {id, file, sha256}`, `attribution`, `files: [{path, sha256, format, role, license?}]`, and explicit `mappings`. `capabilityLockedSourceSpec(dataset, {root, mappings})` fills the pinned descriptors from the trusted lock after verifying the original snapshot.

Each mapping names `originalTaskId`, `record: {file, path}`, `groundTruth: [{file, path}]`, source-specific native references, cluster references, and a Task template. BFCL requires an explicit original-function → production-tool map; memory imports require complete histories; SciFact requires original corpus/evidence coordinates; attack imports require original benign task, attacker objective, and payload references. Imported function-call strings and Python dict payloads are data and are never evaluated.

Templates can bind exact raw values with `{$source: {file, path}}`. Optional `encoding: "text"` converts a scalar; `"json"` produces a pretty JSON string with a final newline; `"text-lines"` joins an original nonempty string array in order and trims outer whitespace for the existing text-native research corpus. SciFact uses the latter for abstract sentences and derives citation spans/hashes from that exact declared conversion.

`importCapabilitySources(imports, {baseDir?})` returns `{tasks, sourceEvidence, controlFiles}`. Preparation retains original files, native annotations, mappings, reviews, and expected checks in the sealed controller dataset. Only `visible` inputs and declared public environment assets go to the production runtime. Source bindings that overlap hidden ground truth are rejected in public files, prompts, sessions, or research assets.

QASPER requires an explicitly supplied official seal and actual question IDs:

```js
const corpus = capabilitySourceImportExample('qasper', {
  qasperDatasetPath: '/absolute/official-qasper-seal',
  originalTaskIds
});
```

The equivalent direct import is `{dataset: "qasper", datasetPath, mappings: [{originalTaskId, task?}]}`. It preserves original paper/question IDs and native answer/evidence references. Regenerate the official seal with `pnpm evaluate prepare qasper`, optionally supplying `--archive /absolute/source.tgz`. No old QASPER or RAG cache is required.

## Engineering runtime and qualification boundaries

The [fixture factory](fixture.mjs) supplies engineering definitions. The prepared dataset's readiness report is authoritative for supported tasks and reasons. `capabilityEngineeringDataset(suite, {pythonEnvironment: absoluteLockPath})` enables the fixed `python solution.py` engineering slice when its environment qualifies. A missing or changed lock never triggers installation; definition counts are not dispatched or independently passed counts.

Session inputs are public `environment.session = {schemaVersion: 1, turns: [{id, prompt, thread: "new"|"continue", responseContract?}]}`. The first turn must start a new session and exactly match `visible.prompt`. Checks may select `inputFor`, defaulting to the last turn. Memory checks require actual `remember`/`memory_search` evidence across a new-session boundary and use production `global` or `workspace` scope. Stateful checks require genuine continued-thread history.

Local MCP tasks declare `environment.mcp = {schemaVersion: 1, mode: "local-records-v1", sourceFile: "mcp-records.json"}` and an actual `lookup_record` check. The source must be a visible, bounded JSON object containing pure data.

Context schema accepts `environment.context = {schemaVersion: 1, contextWindowTokens}` with an integer minimum of 8192; the host also validates the model limit. Context checks select `stage: "summary"|"tool-offload"`, with optional phase references and content predicates. Summary needs a real session; offload needs `filePath` and `read_context_artifact`. A supplied `filePath` must identify an existing public `visible.files` source. Both stages have supported production evidence contracts. Each trial needs its actual summary RPC or offload, usage ledger, wire/artifact/checkpoint bindings, and recovery evidence. Correct final JSON alone cannot establish compaction, memory, MCP, subagent, or lifecycle behavior.

The controlled model's fixed counters test transport and accounting; they are not measured inference usage or model-quality evidence. Legacy seals retain their stored pending annotations and supported count. Prepare a new corpus to acquire newly supported contracts; existing seals never receive an automatic qualification upgrade.

The systematic-review, writing/publication, subagent orchestration, and cancellation/crash capability workflows remain unsupported where their real evidence contracts are missing. ScienceAgentBench verified metadata is separate from original assets, a frozen execution environment, independent grader execution/calibration, and expert review. A real Python lock permits local engineering execution while scientific quality remains false.

Actual review annotations must bind `capabilityReviewContentHash(task)`, which hashes `{visible, expected, environment, source}`. At least two reviewers must be independent of the producer and each other. Disagreement requires a third independent arbiter. Preparation never supplies these identities or decisions. All shipped source examples have empty reviewer lists and `split: "development"`; they cannot grant formal holdout/release qualification.

## Scope verification

Run the relevant data/source checks from the repository root:

```sh
node --test evaluation/tests/capability-data.test.mjs
node --test evaluation/tests/capability-sources.test.mjs
```

For original-source validation, acquire the locked snapshots, create examples in a new output directory, import each supported corpus through the formal CLI, then run `check` and `inspect` on the resulting sealed dataset/run. Acquisition and development imports grant no reviews or scientific qualification. Production execution and independent grading follow the shared [validation methods](../../README.md#验证方法).
