import { parseArgs } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { directory, readJson, EVAL_ROOT, writeJson } from './common.mjs';
import { prepareQasper, prepareScience } from './data.mjs';
import { openRocModel } from './roc-model.mjs';
import { preparePython } from './local-python.mjs';
import { runBenchmark } from './runner.mjs';
import { compareRuns, inspectRun } from './report.mjs';
import { captureIncident, createExperiment, assessExperiment, recordExperimentDecision, inspectExperiment } from './experiment.mjs';

const help = `Manual local Roc evaluation (no automatic triggers, no Docker)
  pnpm harness:bench list
  pnpm harness:bench doctor [--roc-root PATH] [--provider-id ID --model-id ID]
  pnpm harness:bench environment NAME [--python python3] [--requirements hashed-requirements.txt]
  pnpm harness:bench prepare qasper [--archive local.tgz]
  pnpm harness:bench prepare scienceagentbench --metadata verified.json --recipe recipe.json --bundle benchmark_verified.zip
  pnpm harness:bench run --suite roc-native
  pnpm harness:bench run --suite qasper --dataset PATH --profile smoke|fast|full|release [--fixture]
  pnpm harness:bench run --suite scienceagentbench --dataset PATH [--provider-options evaluation/provider-options.example.json]
  pnpm harness:bench inspect RUN
  pnpm harness:bench compare BASELINE_RUN CANDIDATE_RUN
  pnpm harness:bench incident RUN --analysis analysis.json [--task TASK_ID --repeat 0]
  pnpm harness:bench experiment create BASELINE_RUN --spec experiment.json
  pnpm harness:bench run ... --experiment EXPERIMENT_DIRECTORY
  pnpm harness:bench experiment assess|inspect EXPERIMENT_DIRECTORY
  pnpm harness:bench experiment decide EXPERIMENT_DIRECTORY --review review.json
Run uses Roc's configured default model. doctor checks configuration/keychain without inference.
Optional --roc-root, --provider-id/--model-id select an existing Roc configuration.
Provider defaults: 120s/request, 300s/task, 4096 output tokens.
Exit: 0 complete/inspect/non-inferior/eligible or review recorded, 2 incomplete/incompatible/insufficient, 3 regression/inconclusive/rejected assessment.
Experiment adoption is a local development review record, not deployment or holdout approval.
Fixture completion is a wiring check, never a model-quality pass.`;
try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    suite: { type: 'string', default: 'roc-native' }, profile: { type: 'string', default: 'fast' },
    dataset: { type: 'string' }, 'provider-options': { type: 'string' }, 'roc-root': { type: 'string' }, 'provider-id': { type: 'string' }, 'model-id': { type: 'string' },
    python: { type: 'string' }, requirements: { type: 'string' }, fixture: { type: 'boolean', default: false },
    archive: { type: 'string' }, metadata: { type: 'string' }, recipe: { type: 'string' }, bundle: { type: 'string' }, help: { type: 'boolean' },
    experiment: { type: 'string' }, spec: { type: 'string' }, analysis: { type: 'string' }, review: { type: 'string' }, task: { type: 'string' }, repeat: { type: 'string' }
  } });
  Object.assign(values, { providerOptions: values['provider-options'], rocRoot: values['roc-root'], providerId: values['provider-id'], modelId: values['model-id'] });
  const [action, ...args] = positionals;
  if (values.help || !action) console.log(help);
  else if (action === 'list' && !args.length) console.log(JSON.stringify(readJson(new URL('./registry.json', import.meta.url)), null, 2));
  else if (action === 'doctor' && !args.length) {
    const model = await openRocModel(values);
    try { console.log(JSON.stringify({ status: 'ready', inferenceRequests: 0, ...model.identity }, null, 2)); } finally { await model.close(); }
  } else if (action === 'environment' && args.length === 1) console.log(await preparePython(args[0], values.python, values.requirements));
  else if (action === 'prepare' && args.length === 1) {
    if (args[0] === 'qasper') console.log(await prepareQasper(values.archive));
    else if (args[0] === 'scienceagentbench' && values.metadata && values.recipe && values.bundle) console.log(prepareScience(values.metadata, values.recipe, values.bundle));
    else throw new Error('prepare_requires_supported_suite_and_inputs');
  } else if (action === 'run' && !args.length) {
    const result = await runBenchmark(values); console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'complete') process.exitCode = 2;
  } else if (action === 'inspect' && args.length === 1) {
    const run = inspectRun(args[0]); console.log(JSON.stringify({ directory: run.path, sealHash: run.sealHash, ...run.summary }, null, 2));
    if (run.summary.status !== 'complete') process.exitCode = 2;
  } else if (action === 'compare' && args.length === 2) {
    const baseline = inspectRun(args[0]), candidate = inspectRun(args[1]);
    const report = { ...compareRuns(baseline, candidate), baseline: { path: baseline.path, sealHash: baseline.sealHash }, candidate: { path: candidate.path, sealHash: candidate.sealHash } };
    const dir = directory(join(EVAL_ROOT, 'comparisons'), 'comparison'); writeJson(join(dir, 'comparison.json'), report);
    console.log(JSON.stringify({ directory: dir, ...report }, null, 2));
    if (report.conclusion !== 'non-inferior') process.exitCode = ['regression', 'inconclusive'].includes(report.conclusion) ? 3 : 2;
  } else if (action === 'incident' && args.length === 1 && values.analysis) {
    if (Boolean(values.task) !== (values.repeat !== undefined) || (values.repeat !== undefined && !/^\d+$/.test(values.repeat))) throw new Error('incident_requires_task_and_integer_repeat_together');
    console.log(JSON.stringify(captureIncident({ runPath: args[0], analysis: readJson(values.analysis),
      trial: values.task ? { taskId: values.task, repeat: Number(values.repeat) } : null }), null, 2));
  } else if (action === 'experiment' && args.length === 2) {
    const [operation, path] = args;
    let result;
    if (operation === 'create' && values.spec) result = createExperiment({ baselinePath: path, spec: readJson(values.spec), specDirectory: dirname(resolve(values.spec)) });
    else if (operation === 'assess') {
      result = assessExperiment(path);
      if (result.status !== 'eligible') process.exitCode = result.status === 'rejected' ? 3 : 2;
    } else if (operation === 'decide' && values.review) result = recordExperimentDecision(path, readJson(values.review));
    else if (operation === 'inspect') {
      result = inspectExperiment(path);
      if (result.state === 'awaiting-sealed-candidate') process.exitCode = 2;
    } else throw new Error('experiment_requires_create_spec_assess_inspect_or_decide_review');
    console.log(JSON.stringify(result, null, 2));
  } else throw new Error('unknown_command_or_unexpected_arguments');
} catch (error) { console.error(JSON.stringify({ status: 'incomplete', error: error.message })); process.exitCode = 2; }
