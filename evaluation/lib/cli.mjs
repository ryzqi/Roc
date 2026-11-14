import { parseArgs } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { directory, readJson, EVAL_ROOT } from './common.mjs';
import { prepareQasper, prepareScience } from './data.mjs';
import { prepareRag } from '../adapters/rag/data.mjs';
import { ragEngineeringCorpus } from '../adapters/rag/fixture.mjs';
import { checkSuite } from './checks.mjs';
import { openRocModel } from './roc-model.mjs';
import { preparePython } from './local-python.mjs';
import { runBenchmark } from './runner.mjs';
import { compareRuns, inspectRun, writeComparisonReport } from './report.mjs';
import { captureIncident, createExperiment, assessExperiment, recordExperimentDecision, inspectExperiment } from './experiment.mjs';

const help = `Manual local Roc evaluation (four tracks, no automatic triggers)
  pnpm evaluate list
  pnpm evaluate doctor [--roc-root PATH] [--provider-id ID --model-id ID] [--app-name roc]
  pnpm evaluate environment NAME [--python python3] [--requirements hashed-requirements.txt]
  pnpm evaluate prepare qasper [--archive local.tgz]
  pnpm evaluate prepare rag-retrieval|rag-paper-qa --corpus reviewed-corpus.json
  pnpm evaluate prepare rag-retrieval|rag-paper-qa --fixture
  pnpm evaluate prepare scienceagentbench --metadata verified.json --recipe recipe.json --bundle benchmark_verified.zip
  pnpm evaluate run [--suite roc-harness] [--profile smoke|fast|full] [--task CASE_ID]
  pnpm evaluate run --suite roc-native
  pnpm evaluate run --suite qasper|rag-retrieval|rag-paper-qa --dataset PATH --profile smoke|fast|full|release [--fixture]
  pnpm evaluate run --suite scienceagentbench --dataset PATH [--provider-options FILE]
  pnpm evaluate run ... [--concurrency 2] [--budget-options FILE] [--retrieval-options FILE]
  pnpm evaluate run --resume UNSEALED_RUN
  pnpm evaluate check --suite frozen-retrieval --corpus frozen-corpus.json
  pnpm evaluate check --suite roc-s01 [--dataset manifest.json --dataset-sha256 HASH]
  pnpm evaluate inspect RUN
  pnpm evaluate compare BASELINE_RUN CANDIDATE_RUN [--protocol EXPERIMENT_DIRECTORY]
  pnpm evaluate incident RUN --analysis analysis.json [--task TASK_ID --repeat 0]
  pnpm evaluate experiment create SEED_RUN --spec experiment.json
  pnpm evaluate run ... --experiment EXPERIMENT_DIRECTORY [--experiment-arm baseline|candidate]
  pnpm evaluate experiment assess|inspect EXPERIMENT_DIRECTORY
  pnpm evaluate experiment decide EXPERIMENT_DIRECTORY --review review.json
roc-harness is the default: controlled local model, real production runtime, no inference.
rag-retrieval uses production retrieval without a generation model; hybrid/rerank may call configured models.
QASPER and RAG E2E use Roc's configured default model. doctor checks configuration/keychain without inference.
Optional --roc-root, --provider-id/--model-id select an existing Roc configuration.
The model host uses package.json's productName/name for safe storage; --app-name explicitly overrides it.
Provider defaults: 120s/request, 300s/task, 4096 output tokens.
Trials default to 2 isolated workers (1-8); safe resume verifies existing evidence and never replays uncertain dispatch.
Exit: 0 complete/passing/inspect/eligible or review recorded; 2 incomplete/incompatible/insufficient/blocked; 3 failure/regression/rejected.
Ordinary compare: 0 non-inferior/superior, 3 regression/inconclusive; with --protocol: 0 eligible, 2 blocked, 3 rejected.
Experiment adoption is a local development review record, not deployment or holdout approval.
--output-root PATH places new run/compare/incident/experiment records under a chosen parent.
Fixture completion and offline checks establish engineering behavior; model quality requires independently reviewed data and matched runs.
pnpm harness:bench remains an alias of this CLI.`;
try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    suite: { type: 'string' }, profile: { type: 'string' },
    dataset: { type: 'string' }, 'provider-options': { type: 'string' }, 'roc-root': { type: 'string' }, 'provider-id': { type: 'string' }, 'model-id': { type: 'string' }, 'app-name': { type: 'string' },
    python: { type: 'string' }, requirements: { type: 'string' }, fixture: { type: 'boolean', default: false },
    archive: { type: 'string' }, metadata: { type: 'string' }, recipe: { type: 'string' }, bundle: { type: 'string' }, help: { type: 'boolean' },
    experiment: { type: 'string' }, spec: { type: 'string' }, analysis: { type: 'string' }, review: { type: 'string' }, task: { type: 'string' }, repeat: { type: 'string' },
    'output-root': { type: 'string' }, corpus: { type: 'string' }, 'dataset-sha256': { type: 'string' },
    concurrency: { type: 'string' }, resume: { type: 'string' }, 'budget-options': { type: 'string' },
    'retrieval-options': { type: 'string' }, 'experiment-arm': { type: 'string' }, protocol: { type: 'string' }
  } });
  Object.assign(values, { providerOptions: values['provider-options'], rocRoot: values['roc-root'], providerId: values['provider-id'],
    modelId: values['model-id'], appName: values['app-name'], outputRoot: values['output-root'],
    datasetSha256: values['dataset-sha256'], budgetOptions: values['budget-options'],
    retrievalOptions: values['retrieval-options'], experimentArm: values['experiment-arm'] });
  const [action, ...args] = positionals;
  if (values.help || !action) console.log(help);
  else if (action === 'list' && !args.length) console.log(JSON.stringify(readJson(new URL('./registry.json', import.meta.url)), null, 2));
  else if (action === 'doctor' && !args.length) {
    const model = await openRocModel(values);
    try { console.log(JSON.stringify({ status: 'ready', inferenceRequests: 0, ...model.identity }, null, 2)); } finally { await model.close(); }
  } else if (action === 'environment' && args.length === 1) console.log(await preparePython(args[0], values.python, values.requirements));
  else if (action === 'prepare' && args.length === 1) {
    if (args[0] === 'qasper') console.log(await prepareQasper(values.archive));
    else if (['rag-retrieval', 'rag-paper-qa'].includes(args[0])) {
      if (Boolean(values.corpus) === Boolean(values.fixture)) throw new Error('rag_prepare_requires_corpus_or_fixture');
      console.log(await prepareRag(values.fixture ? ragEngineeringCorpus() : values.corpus, { suite: args[0] }));
    }
    else if (args[0] === 'scienceagentbench' && values.metadata && values.recipe && values.bundle) console.log(prepareScience(values.metadata, values.recipe, values.bundle));
    else throw new Error('prepare_requires_supported_suite_and_inputs');
  } else if (action === 'run' && !args.length) {
    const result = await runBenchmark(values); console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'complete') process.exitCode = 2;
    else if (result.assessment === 'fail') process.exitCode = 3;
  } else if (action === 'check' && !args.length) {
    const result = await checkSuite(values); console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'complete') process.exitCode = 2;
  } else if (action === 'inspect' && args.length === 1) {
    const run = inspectRun(args[0]); console.log(JSON.stringify({ directory: run.path, sealHash: run.sealHash, ...run.summary }, null, 2));
    if (run.summary.status !== 'complete') process.exitCode = 2;
    else if (run.summary.assessment === 'fail') process.exitCode = 3;
  } else if (action === 'compare' && args.length === 2) {
    const baseline = inspectRun(args[0]), candidate = inspectRun(args[1]);
    const report = { ...compareRuns(baseline, candidate, values.protocol ? { protocol: values.protocol } : {}),
      baseline: { path: baseline.path, sealHash: baseline.sealHash }, candidate: { path: candidate.path, sealHash: candidate.sealHash } };
    const dir = directory(values.outputRoot ?? join(EVAL_ROOT, 'comparisons'), 'comparison'); writeComparisonReport(dir, report);
    console.log(JSON.stringify({ directory: dir, ...report }, null, 2));
    if (report.acceptance) {
      if (report.acceptance.status !== 'eligible') process.exitCode = report.acceptance.status === 'rejected' ? 3 : 2;
    } else if (!['non-inferior', 'superior'].includes(report.conclusion)) {
      process.exitCode = ['regression', 'inconclusive'].includes(report.conclusion) ? 3 : 2;
    }
  } else if (action === 'incident' && args.length === 1 && values.analysis) {
    if (Boolean(values.task) !== (values.repeat !== undefined) || (values.repeat !== undefined && !/^\d+$/.test(values.repeat))) throw new Error('incident_requires_task_and_integer_repeat_together');
    console.log(JSON.stringify(captureIncident({ runPath: args[0], analysis: readJson(values.analysis),
      trial: values.task ? { taskId: values.task, repeat: Number(values.repeat) } : null, outputRoot: values.outputRoot }), null, 2));
  } else if (action === 'experiment' && args.length === 2) {
    const [operation, path] = args;
    let result;
    if (operation === 'create' && values.spec) result = createExperiment({ baselinePath: path, spec: readJson(values.spec), specDirectory: dirname(resolve(values.spec)), outputRoot: values.outputRoot });
    else if (operation === 'assess') {
      result = assessExperiment(path);
      if (result.status !== 'eligible') process.exitCode = result.status === 'rejected' ? 3 : 2;
    } else if (operation === 'decide' && values.review) result = recordExperimentDecision(path, readJson(values.review));
    else if (operation === 'inspect') {
      result = inspectExperiment(path);
      if (['awaiting-sealed-candidate', 'awaiting-sealed-arms'].includes(result.state)) process.exitCode = 2;
    } else throw new Error('experiment_requires_create_spec_assess_inspect_or_decide_review');
    console.log(JSON.stringify(result, null, 2));
  } else throw new Error('unknown_command_or_unexpected_arguments');
} catch (error) { console.error(JSON.stringify({ status: 'incomplete', error: error.message })); process.exitCode = 2; }
