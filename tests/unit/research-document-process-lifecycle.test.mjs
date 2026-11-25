import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm, access} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api?.dispose());
async function fixture(operation) {
  const root = await mkdtemp('/private/tmp/roc-document-lifecycle-'), f = createResearchFixture(api, 'reading', root);
  let service;
  try {
    const source = Buffer.from('<html><body><h1>Retained source</h1><p>Original published text.</p></body></html>');
    await writeFile(join(root, 'source.html'), source);
    const hash = createHash('sha256').update(source).digest('hex');
    const {document} = f.repository.documents.import({id: 'lifecycle-doc', libraryItemId: null, projectId: f.project.id,
      filename: 'source.html', mediaType: 'text/html', sourcePath: 'source.html', sourceHash: hash, size: source.length,
      entry: {metadata: {id: 'lifecycle-literature', source: 'local', externalId: 'lifecycle-fixture', doi: null,
        title: 'Lifecycle fixture', authors: [], abstract: null, publishedYear: null, citationCount: null,
        url: null, openAccessUrl: null, importedAt: '2026-11-25T00:00:00Z', updatedAt: '2026-11-25T00:00:00Z'},
        bibliography: {citationKey: 'lifecycleFixture', entryType: 'article', fields: {title: 'Lifecycle fixture'}, preambles: [],
          csl: null, title: 'Lifecycle fixture', authors: [], doi: null, publishedYear: null, abstract: null, url: null}}
    }, false);
    let invoke = input => api.parseResearchDocument({...input, modelFiles: null, modelManifest: ''});
    service = new api.ResearchDocumentService(f.repository, {
      defaultParseOptions: () => ({tier: 'compact', device: 'cpu', pageRange: ''}), parseDocument: input => invoke(input)
    }, root);
    const ready = await service.parse(document.id); assert.equal(ready.status, 'ready');
    const original = service.parsed(document.id, ready.currentParseId);
    await operation({...f, service, document: ready, original, replace: work => {invoke = work;}});
    assert.equal(f.repository.documents.get(document.id).currentParseId, ready.currentParseId);
    assert.deepEqual(service.parsed(document.id, ready.currentParseId), original);
  } finally {
    await service?.shutdown(); await f.repository.knowledgeJobs.shutdown(); await f.repository.paperCards.shutdown();
    await f.repository.wiki.shutdown(); f.close(); await rm(root, {recursive: true, force: true});
  }
}
const unproven = () => new AggregateError([
  new Error('wrapped', {cause: Object.assign(new Error('research_process_kill_failed'), {code: 'research_process_kill_failed'})})
], 'research_ovis_parse_failed');

test('document service retains diagnostic input on nested unproven exit and leaves the earlier publication current', async () => {
  await fixture(async ({service, document, replace, repository}) => {
    let output;
    replace(async input => {
      output = input.outputDir; await mkdir(output); await writeFile(join(output, 'worker-input'), 'diagnostic'); throw unproven();
    });
    await service.parse(document.id);
    assert.equal(await readFile(join(output, 'worker-input'), 'utf8'), 'diagnostic');
    assert.equal(repository.documents.runs(document.id)[0].status, 'failed');
    await service.shutdown();
    await access(join(output, 'worker-input'));
  });
});

test('ordinary parser failure cleans its new job while the earlier successful result stays readable', async () => {
  await fixture(async ({service, document, replace, repository}) => {
    let job;
    replace(async input => {
      job = input.jobDir; await mkdir(input.outputDir); await writeFile(join(input.outputDir, 'partial'), 'partial');
      throw new Error('research_ovis_worker_failed');
    });
    await service.parse(document.id);
    await assert.rejects(access(job), {code: 'ENOENT'});
    assert.equal(repository.documents.runs(document.id)[0].status, 'failed');
  });
});

test('user cancellation retains diagnostics only when Worker termination remains unproven', async () => {
  for (const uncertain of [false, true]) await fixture(async ({service, document, replace, repository}) => {
    const entered = Promise.withResolvers(); let output;
    replace(async input => {
      output = input.outputDir; await mkdir(output); await writeFile(join(output, 'worker-input'), 'diagnostic');
      return await new Promise((resolve, reject) => {
        input.signal.addEventListener('abort', () => reject(uncertain ? unproven() : new Error('research_process_cancelled')), {once: true});
        entered.resolve();
      });
    });
    const pending = service.parse(document.id); await entered.promise;
    const parseId = repository.documents.get(document.id).activeParseId;
    service.cancel(document.id, parseId); await pending;
    assert.equal(repository.documents.runs(document.id)[0].status, 'cancelled');
    if (uncertain) await access(join(output, 'worker-input'));
    else await assert.rejects(access(output), {code: 'ENOENT'});
  });
});
