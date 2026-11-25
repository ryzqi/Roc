import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {access, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api?.dispose());

async function fixture(operation) {
  const root = await mkdtemp('/private/tmp/roc-index-lifecycle-'), workspace = join(root, 'workspace');
  await mkdir(workspace);
  const f = createResearchFixture(api, 'reading', workspace), source = '<h1>Original</h1><p>Retained source text.</p>';
  let indexer, embeddings;
  try {
    await writeFile(join(workspace, 'paper.html'), source);
    const {projectId, revision, ...settings} = f.repository.indexing.settings(f.project.id);
    f.repository.indexing.saveSettings(projectId, revision, {...settings, kinds: ['html'], watch: false});
    embeddings = new api.ResearchEmbeddingService(f.repository.knowledge,
      {embed: async () => {throw new Error('unexpected embedding request');}},
      {secrets: {get: async () => null}, logger: {warn() {}}});
    let invoke = input => api.parseResearchDocument({...input, modelFiles: null, modelManifest: ''});
    indexer = new api.ResearchIndexService(f.repository, {
      identity: async () => 'lifecycle-fixture',
      defaultParseOptions: () => ({tier: 'compact', device: 'cpu', pageRange: ''}),
      parseDocument: input => invoke(input)
    }, embeddings, join(root, 'storage'), {info() {}, warn() {}, error() {}});
    const job = async () => {
      f.repository.indexing.requestScan(projectId, true);
      await indexer.scan(projectId, new AbortController().signal);
      const queued = f.repository.indexing.nextJob(); assert.ok(queued);
      return f.repository.indexing.beginJob(queued.id);
    };
    const initial = await job(); await indexer.process(initial, new AbortController().signal);
    assert.equal(f.repository.indexing.job(initial.id).status, 'ready');
    const snapshot = () => ({
      payload: f.repository.indexing.cached(initial.fileId).payload,
      documents: f.db.prepare('SELECT * FROM research_knowledge_documents ORDER BY id').all(),
      chunks: f.db.prepare('SELECT * FROM research_knowledge_chunks ORDER BY id').all(),
      active: f.db.prepare("SELECT * FROM research_scientific_index_generations WHERE status='active' ORDER BY id").all()
    });
    const original = snapshot();
    await operation({...f, indexer, job, replace: parser => {invoke = parser;}});
    assert.deepEqual(snapshot(), original);
    assert.equal(await readFile(join(workspace, 'paper.html'), 'utf8'), source);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await indexer?.shutdown(); await embeddings?.shutdown(); await f.close();
    // All simulated workers have settled; this fixture owns its entire temporary tree.
    await rm(root, {recursive: true, force: true});
  }
}

const uncertainExit = code => new AggregateError([
  new Error('parser wrapper', {cause: Object.assign(new Error(code), {code})})
], 'research_ovis_parse_failed');

test('project index retains inputs for nested unproven exits, including after shutdown', async () => {
  for (const code of ['research_process_kill_failed', 'research_process_supervision_failed', 'research_process_completion_failed']) {
    await fixture(async ({indexer, job, replace, repository}) => {
      let output;
      replace(async input => {
        output = input.outputDir; await mkdir(output); await writeFile(join(output, 'worker-input'), 'diagnostic');
        throw uncertainExit(code);
      });
      const attempt = await job(); await indexer.process(attempt, new AbortController().signal);
      assert.equal(repository.indexing.job(attempt.id).status, 'failed');
      assert.equal(await readFile(join(output, 'worker-input'), 'utf8'), 'diagnostic');
      await indexer.shutdown(); await access(join(output, 'worker-input'));
    });
  }
});

test('ordinary project parser failure removes only the new job and preserves published data', async () => {
  await fixture(async ({indexer, job, replace, repository}) => {
    let directory;
    replace(async input => {
      directory = input.jobDir; await mkdir(input.outputDir); await writeFile(join(input.outputDir, 'partial'), 'partial');
      throw new Error('research_ovis_worker_failed');
    });
    const attempt = await job(); await indexer.process(attempt, new AbortController().signal);
    assert.equal(repository.indexing.job(attempt.id).status, 'failed');
    await assert.rejects(access(directory), {code: 'ENOENT'});
  });
});

test('project cancellation retains inputs only if the worker exit is unproven', {timeout: 15000}, async () => {
  for (const uncertain of [false, true]) await fixture(async ({indexer, job, replace, repository}) => {
    const entered = Promise.withResolvers(), controller = new AbortController(); let output;
    replace(async input => {
      output = input.outputDir; await mkdir(output); await writeFile(join(output, 'worker-input'), 'diagnostic');
      return await new Promise((_resolve, reject) => {
        input.signal.addEventListener('abort', () => reject(uncertain
          ? uncertainExit('research_process_kill_failed') : new Error('research_process_cancelled')), {once: true});
        entered.resolve();
      });
    });
    const attempt = await job(), pending = indexer.process(attempt, controller.signal);
    await entered.promise; controller.abort(); await pending;
    assert.equal(repository.indexing.job(attempt.id).status, 'cancelled');
    if (uncertain) await access(join(output, 'worker-input'));
    else await assert.rejects(access(output), {code: 'ENOENT'});
  });
});
