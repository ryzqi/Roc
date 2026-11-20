import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { AIMessage, HumanMessage } from '@langchain/core/messages';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';
import { withQasperResponseContract } from '../../evaluation/lib/response-contract.mjs';
import { testArtifacts } from '../../evaluation/tests/test-artifacts.mjs';

const root = testArtifacts('response-contract-unit');
const packages = JSON.parse(readFileSync('package.json', 'utf8'));
const options = {
  platform: 'node', tempDir: root,
  external: [...Object.keys(packages.dependencies), ...Object.keys(packages.devDependencies)]
};
const { responseContractSchema, createResponseValidator } = await importTypeScriptModule('src/shared/schemas/response-contract.ts', options);
const { createResponseContractMiddleware } = await importTypeScriptModule('src/main/services/deep-agent/response-contract-middleware.ts', options);
const { TaskContractStore } = await importTypeScriptModule('src/main/services/deep-agent/task-contract-store.ts', options);
const input = {
  kind: 'qasper', prompt: 'Return the answer and inspected evidence.',
  files: { 'paper.json': JSON.stringify({ paragraphs: [{ id: 'p0' }, { id: 'p1' }] }) }
};
const contract = withQasperResponseContract(input).responseContract;
const valid = '{"answer":"Two datasets.","evidence":["p0","p1"]}';

test('strict response validation rejects malformed whole outputs, fields, types and citation IDs without repair', () => {
  const validate = createResponseValidator(contract);
  for (const value of [valid, ` \n${valid}\n `]) assert.equal(validate(value).passed, true);
  for (const value of [
    null, '', '   ', `Here is the answer:\n${valid}`, `\`\`\`json\n${valid}\n\`\`\``,
    `${valid}\nDone.`, '{}', '{"answer":"ok"}', '{"evidence":[]}',
    '{"answer":null,"evidence":[]}', '{"answer":1,"evidence":[]}',
    '{"answer":"","evidence":[]}', '{"answer":"ok","evidence":"p0"}',
    '{"answer":"ok","evidence":[0]}', '{"answer":"ok","evidence":["p9"]}',
    '{"answer":"ok","evidence":["p0","p0"]}', '{"answer":"ok","evidence":[],"extra":true}'
  ]) {
    const before = value;
    assert.equal(validate(value).passed, false, value);
    assert.equal(value, before);
    assert.ok(validate(value).detail.length <= 600);
  }
});

test('visible QASPER requirements depend only on public paragraph IDs, including an empty paper', () => {
  assert.deepEqual(contract.schema.properties.evidence.items.enum, ['p0', 'p1']);
  assert.equal(Object.hasOwn(input, 'responseContract'), false);
  const empty = withQasperResponseContract({ ...input, files: { 'paper.json': '{"paragraphs":[]}' } });
  const validate = createResponseValidator(empty.responseContract);
  assert.equal(validate('{"answer":"Unanswerable","evidence":[]}').passed, true);
  assert.equal(validate('{"answer":"ok","evidence":["p0"]}').passed, false);
  for (const paragraphs of [[{ id: 'p0' }, { id: 'p0' }], [{ id: 1 }]]) {
    assert.throws(() => withQasperResponseContract({ ...input, files: { 'paper.json': JSON.stringify({ paragraphs }) } }),
      /qasper_visible_paragraph_ids_invalid/);
  }
});

test('schema input rejects unsupported keywords, defaults, conflicting bounds and excessive recursion', () => {
  const parse = schema => responseContractSchema.safeParse({ format: 'json', schema }).success;
  for (const schema of [
    { type: 'string', default: 'silently repaired' }, { type: 'string', pattern: '.*' },
    { anyOf: [{ type: 'string' }, { type: 'null' }] },
    { type: 'string', minLength: 2, maxLength: 1 },
    { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 1 },
    { type: 'number', minimum: 2, maximum: 1 },
    { type: 'integer', enum: [1.5] }, { type: 'string', enum: [] },
    { type: 'object', properties: { x: { type: 'string' } }, required: ['x', 'x'], additionalProperties: false },
    { type: 'object', properties: {}, required: ['missing'], additionalProperties: false },
    { type: 'object', properties: {}, required: [], additionalProperties: true }
  ]) assert.equal(parse(schema), false, JSON.stringify(schema));
  const cycle = { type: 'array' }; cycle.items = cycle;
  assert.equal(parse(cycle), false);
  let nested = { type: 'null' };
  for (let index = 0; index < 14; index++) nested = { type: 'array', items: nested };
  assert.equal(parse(nested), false);
  assert.equal(parse({ type: 'object', required: [], additionalProperties: false,
    properties: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`p${index}`, { type: 'null' }])) }), false);
  assert.equal(parse({ type: 'string', enum: Array.from({ length: 40 }, (_, index) => `${index}${'x'.repeat(1900)}`) }), false);
});

test('recursive JSON schemas enforce optional properties, scalar bounds and structural array uniqueness', () => {
  const validate = createResponseValidator({ format: 'json', schema: {
    type: 'array', uniqueItems: true, minItems: 1, maxItems: 2,
    items: { type: 'object', additionalProperties: false, required: ['count', 'enabled', 'empty'], properties: {
      count: { type: 'integer', minimum: 1, maximum: 3, enum: [1, 3] },
      enabled: { type: 'boolean', enum: [true] }, empty: { type: 'null' },
      label: { type: 'string', minLength: 1, maxLength: 4, enum: ['ok'] }
    } }
  } });
  assert.equal(validate('[{"count":1,"enabled":true,"empty":null}]').passed, true);
  for (const value of [
    '[]', '[{"count":2,"enabled":true,"empty":null}]',
    '[{"count":1.5,"enabled":true,"empty":null}]', '[{"count":1,"enabled":false,"empty":null}]',
    '[{"count":1,"enabled":true,"empty":0}]', '[{"count":1,"enabled":true,"empty":null,"label":"longer"}]',
    '[{"count":1,"enabled":true,"empty":null},{"empty":null,"enabled":true,"count":1}]'
  ]) assert.equal(validate(value).passed, false, value);
});

test('response correction skips tool turns and valid finals, respects cancellation and permits one correction per run', () => {
  const middleware = createResponseContractMiddleware('run-one', contract);
  const hook = middleware.afterModel.hook;
  const runtime = { signal: new AbortController().signal };
  for (const message of [new HumanMessage('input'), new AIMessage(valid),
    new AIMessage({ content: 'Reading.', tool_calls: [{ id: 'read', name: 'read_file', args: {} }] })]) {
    assert.equal(hook({ messages: [message] }, runtime), undefined);
  }
  const state = { messages: [new AIMessage('Bad final')] };
  const correction = hook(state, runtime);
  assert.equal(correction.jumpTo, 'model');
  assert.equal(correction.messages.length, 1);
  assert.equal(correction.messages[0].id, 'roc-response-correction:run-one');
  assert.equal(hook({ ...state, rocResponseCorrection: correction.rocResponseCorrection }, runtime), undefined);
  assert.ok(createResponseContractMiddleware('run-two', contract).afterModel.hook({
    ...state, rocResponseCorrection: correction.rocResponseCorrection
  }, runtime));
  const controller = new AbortController(); controller.abort(new Error('stop-correction'));
  assert.throws(() => hook(state, { signal: controller.signal }), /stop-correction/);
});

test('artifact acceptance cannot bypass the response contract and replay preserves raw terminal verdicts', async () => {
  const workspacePath = join(root, 'workspace'); mkdirSync(workspacePath);
  const bytes = 'checked artifact'; writeFileSync(join(workspacePath, 'result.txt'), bytes);
  const sha256 = value => createHash('sha256').update(value).digest('hex');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE agent_task_contracts (run_id TEXT PRIMARY KEY, contract_json TEXT, report_json TEXT)');
  try {
    const store = new TaskContractStore(db);
    const task = { contractVersion: 1, objective: 'Artifact plus JSON.', constraints: [], kind: 'task', responseContract: contract,
      criteria: [{ id: 'response-json', description: 'Checked artifact.', check: { kind: 'artifact_sha256', path: 'result.txt', sha256: sha256(bytes) } }] };
    store.initialize('run', task);
    const invalid = `Narration.\n${valid}`;
    const failed = await store.verify('run', { workspacePath, response: invalid });
    assert.equal(failed.status, 'partial');
    assert.deepEqual(failed.criteria.map(criterion => [criterion.id, criterion.verdict]),
      [['response-json', 'passed'], ['response-json-1', 'failed']]);
    assert.equal(failed.criteria[1].verifier, 'response_json_schema');
    assert.equal(failed.criteria[1].artifactRefs[0].sha256, sha256(invalid));
    assert.deepEqual(store.readContract('run'), task);
    assert.deepEqual(await store.refreshReport('run', { workspacePath, response: valid }), failed);
    const missing = await store.evaluate('run', { workspacePath, response: null });
    assert.equal(missing.criteria[1].verdict, 'failed');
    const passed = await store.verify('run', { workspacePath, response: ` \n${valid}\n` });
    assert.equal(passed.status, 'satisfied');
    assert.equal(passed.criteria[1].artifactRefs[0].sha256, sha256(` \n${valid}\n`));
    assert.deepEqual(await store.refreshReport('run', { workspacePath, response: invalid }), passed);
    const stopped = store.createUnverifiedReport('run', 'cancelled');
    assert.equal(stopped.criteria[1].verdict, 'unverified');
    const refreshed = await store.refreshReport('run', { workspacePath, response: valid });
    assert.deepEqual(refreshed.criteria[1], stopped.criteria[1]);
    assert.equal(refreshed.criteria[0].verdict, 'passed');
    assert.deepEqual(refreshed.blockedBy, ['cancelled']);
  } finally { db.close(); }
});
