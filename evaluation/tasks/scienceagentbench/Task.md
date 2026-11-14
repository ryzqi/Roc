# Task: scienceagentbench-verified-results

**Status:** Draft — agent-reviewed; exact spec not yet user-approved. Local synthetic execution and calibration are verified; official tasks have not been imported or evaluated.

Control-plane only. Native adapter: evaluation/lib/{data,science,application,local-python}.mjs. No Harbor packaging or Docker dependency.

## Purpose and evidence

Exercise the actual Roc tool loop on operator-prepared scientific instructions and public inputs, with independent checks of result files. The current importer supports local recipes for engineering diagnostics. Official quality evaluation would require an independently audited chain from official metadata and benchmark_verified.zip to each task's assets, environment and grader, plus an approved Task Spec and validated import contract. A supplied revision and SHA-256 do not establish that chain.

## Agent input and conditions

`scienceInput(task)` inserts metadata task_inst and domain_knowledge, asks the agent to read /workspace with Roc tools, write /workspace/solution.py, run exactly `python solution.py`, and produce declared outputs. Python's cwd is the actual local workspace; scripts use relative paths. No network, subprocesses or package installation. The final model text is retained but does not determine scientific correctness. No later human turn.

Real AgentPluginRuntime/DeepAgent executor in task mode with workbench source; ls/read_file/write_file/edit_file/run_shell_command. Model exposure is filtered by the scope manifest; the host requires exactly these five tools before dispatch and retains their actual schema in tool-schema.json. Schema drift within or between trials invalidates the run. The production ExecutionGrantBroker issues and consumes a command/cwd-bound grant. Python executes through the local sandbox callback. Each repeat has a fresh worker, project, thread, database and workspace. No external tools, browser, retrieval or prior memory. Roc's configured model is read through an isolated, read-only host; credentials never enter the worker or Python process.

## Environment

SchemaVersion 2 recipe imports public, hidden, verifier and calibration directories; all files are copied and hashed, links rejected, omitted metadata IDs reported. Original metadata/bundle hashes and revision are frozen. Human audit still has to establish that prepared files correspond to the original bundle; hashes alone cannot prove that correspondence.

New dataset manifests carry provenance.kind=engineering_fixture, retained in the run's manifest.datasetProvenance; sciencePreflight returns evidenceKind=engineering-fixture and new runs retain that evidence label even when using an actual configured model. Calibration, the recipe's verified split, arbitrary sourceRevision, supplied hashes or self-declared official/human review cannot grant quality eligibility. Existing datasets and sealed runs remain unchanged; reimporting with the new provenance creates a new dataset identity.

The operator prepares venvs with the environment command, under evaluation/environments. Optional dependency installation uses hash-pinned requirements. Runtime records interpreter identity, installed files, symlinks, platform and architecture, then verifies each use. External system libraries and Python stdlib are not fully frozen; this is a local environment contract, not cross-machine bitwise reproducibility.

Canonical commands are `pnpm evaluate environment`, `prepare scienceagentbench` and `run --suite scienceagentbench --dataset PATH`; `pnpm harness:bench` remains a compatibility alias. Runs default to concurrency=2 (range 1–8), keeping separate projects/workspaces/databases and grader scratch per trial. Dataset identity/inventory, selected task IDs/clusters, model/config, metricsHash/taskSchemaHash/scorerHash, actual tool/schema, application contract, permissions, environment/executionPolicy and cumulative budget are frozen before dispatch.

`--budget-options FILE` supplies host request/input-output token/cost/task/run duration policy. Request reservations and estimates are separate from measured provider receipts; cost uses only frozen applicable pricing and known usage. Unknown resource values cannot satisfy corresponding experiment gates. Python grant/process resource limits below are distinct from model accounting.

macOS sandbox-exec denies network and child processes. Python reads dependencies and public input, writes its workspace, and cannot read hidden truth. Production grant limits apply, at most 120s and 1MiB stdout/stderr; CPU time, 64MiB per-file and 128 descriptor limits also apply. There is no total memory or total disk hard cap. Tasks needing unavailable packages, subprocesses, network or incompatible resource limits must be excluded or explicitly adapted.

Only allowlisted ordinary data files are copied to verifier-input; recognized executable/module suffixes are rejected at import. Grader entry: `python grade.py OUTPUT_DIR TRUTH_DIR`, with frozen verifier code and a separate scratch directory and 120s timeout. It cannot see the agent workspace or source. Agent outputs must be parsed as data, never imported, unpickled unsafely or executed. Process groups are cleaned and cleanup failures invalidate the run.

## Verification

| ID | Result | Independent evidence | Pass condition |
|---|---|---|---|
| S1 | Required artifacts | Inventory and allowlist copies after worker termination | Missing output yields agent successRate=0 |
| S2 | Scientific correctness | Frozen grader, hidden truth and actual data outputs | Exit 0, JSON success:boolean and evidence:nonempty; score 1 or 0 |
| S3 | Grader calibration | Five actual grader executions before evaluated trials | oracle and alternative accepted; incorrect-output, corrupt-output and shortcut rejected |
| S4 | Runtime correctness | Independent read-only SQLite completed run/thread/root checkpoint, final assistant bound to terminal model response, frozen inputs/model/limits/manifest, ordered hashed transport, persisted events, session output, usage/tool ledger; grant events, environment/source/data identities, worker isolation and process cleanup | Runtime/environment/protocol/cleanup failure invalidates run before scientific scoring |

Task-specific tolerances, accepted formats and allowlist come from the upstream task and local recipe. No scoring by narrative regex or self-reported completion; no implicit paid model judge. Grader nonzero exit or malformed reward is verifier-invalid. A valid negative grade remains an agent failure in the denominator. Score is mean per-trial success, not upstream best-of-three.

Safe resume uses `pnpm evaluate run --resume UNSEALED_RUN` only under the unchanged source/manifest/plan/journal/budget/owner contract. Complete dispatched evidence, output allowlist and independent grade are reverified; uncertain model/tool/Python execution is not reissued. Sealed complete or incomplete runs cannot be continued. Experiment resume preserves its original claim/path/arm rather than registering another candidate.

## Fairness and leakage

Public directories must include all needed inputs while excluding reference code, outputs and grader. Hidden truth and task specs remain outside agent access. All five calibration examples are evaluator-only and frozen with the data. Alternative valid output must be accepted to avoid overspecific grading. The shortcut case should target a plausible false success for this specific grader. Calibration on output examples checks reward behavior; it does not itself prove a reference solution can complete the full agent task.

Public data may be in model training. Group by source repo before hash splitting; local holdout is not a contamination guarantee. Some upstream task licenses differ, including IDs 3/32/46/53/54/84; no unpacked online redistribution.

## Remaining validation

The local synthetic task exercises actual Roc file tools, consumed grants, Python, hidden-data/network/subprocess denial and five independent calibration outcomes. The shared configured-model bridge is exercised with a local scripted provider; that does not establish official scientific quality. Official prepared tasks, dependency recipes and graders remain to be imported and audited. This document does not establish an official Science environment, new live baseline or independent holdout.

Manual profiles: smoke1x1, fast up to 5x1, full up to 50x3 development and release all supported holdout x3. These are selection/repeat schedules; none authenticates the task source or provides release approval. All current and legacy Science local recipes remain unadoptable engineering diagnostics, including legacy live-model labels. With complete matched contracts and evidence, compare returns insufficient / science_quality_provenance_unverified while retaining per-task differences, resource reports and trace pointers; registered acceptance is blocked. Five repo clusters and three repeats cannot bypass this provenance boundary.

The shared comparison protocol freezes runtime/answer/tool/schema/metric/data/model/environment/permissions/budget contracts. For qualifying evidence it uses at least five applicable independent clusters, three repeats, 2000 paired cluster bootstrap samples, margin at most 0.05, and preregistered primary metrics with conservative multiplicity. Experiments enforce frozen absolute/individual floors and resource degradation/budget ceilings; unknown cost cannot pass a cost gate. Tool/schema differences require exact preregistration with two fresh ablation arms. Noninferior is not improvement or release approval; controlled or synthetic results, including ten tasks × three repeats, cannot establish scientific quality. See [EXPERIMENTS](../../EXPERIMENTS.md).
