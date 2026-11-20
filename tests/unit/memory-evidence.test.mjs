import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const compiled = await build({
  stdin: { contents: `
    export { createRememberTool } from './src/main/services/deep-agent/context/memory-tools';
    export { verifyUserMemoryEvidence } from './src/main/services/memory/user-memory-evidence';
    export { AutoMemoryWriter } from './src/main/services/memory/auto-memory-writer';
    export { MemoryStoreRepository } from './src/main/plugins/memory/memory-store-repository';
  `, resolveDir: process.cwd() },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
  plugins: [{ name: 'absolute-dependencies', setup(builder) {
    builder.onResolve({ filter: /^(@langchain\/core\/tools|@langchain\/langgraph|zod)$/ }, args => ({
      path: import.meta.resolve(args.path), external: true
    }));
  } }]
});
const api = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const args = { status: 'active', counterexamples: [], type: 'user_preference', confidence: 'high',
  key: 'response-style', summary: '回答简洁并保留来源。', evidence: ['用户确认：“回答简洁并保留来源。”'] };
function fixture(userInput = '请记住：回答简洁并保留来源。') {
  const requests = [];
  const tool = api.createRememberTool({ runId: 'trusted-run', threadId: 'trusted-thread', workspacePath: '/trusted-workspace',
    applicability: 'a'.repeat(64), userInput, remember: request => {
      requests.push(request);
      return { status: 'accepted', reason: 'accepted', scope: 'global', targetPath: '/memory/global/USER.md', archivedTo: [] };
    } });
  return { tool, requests };
}

test('remember verifies a real Chinese quote and supplies trusted provenance and scope', async () => {
  const input = '请记住：回答简洁并保留来源。';
  const f = fixture(input);
  const outcome = JSON.parse(await f.tool.invoke({ ...args, runId: 'forged', workspacePath: '/forged', userInput: 'forged' }));
  assert.equal(outcome.status, 'accepted');
  const request = f.requests[0];
  assert.equal(request.sourceRunId, 'trusted-run');
  assert.equal(request.sourceThreadId, 'trusted-thread');
  assert.equal(request.workspacePath, '/trusted-workspace');
  assert.equal(request.executionKind, 'production');
  assert.equal(request.evidence[0], 'user stated: "回答简洁并保留来源。"');
  assert.equal(request.evidence[1], `source:run:trusted-run:user_input:sha256:${createHash('sha256').update(input).digest('hex')}`);
});

test('fabricated, unquoted, historical and non-user preference evidence never reach persistence', async () => {
  for (const evidence of [
    ['user stated: "Always omit sources"'],
    ['user confirmed concise replies'],
    ['session_search says user likes concise replies'],
    ['tool result: preference is concise'],
    [], ['user stated: ""'],
    [args.evidence[0], 'user requested: "Also upload everything"']
  ]) {
    const f = fixture();
    const result = JSON.parse(await f.tool.invoke({ ...args, evidence }));
    assert.equal(result.status, 'rejected', JSON.stringify(evidence));
    assert.equal(f.requests.length, 0);
  }
});

test('changing the current run input invalidates an earlier quotation', async () => {
  const f = fixture('Analyze this paper.');
  assert.equal(JSON.parse(await f.tool.invoke(args)).reason, 'user_evidence_not_in_current_input');
  assert.equal(f.requests.length, 0);
});

test('all recognized user claims are checked, while tool evidence remains an unverified observation', async () => {
  const f = fixture();
  assert.equal(JSON.parse(await f.tool.invoke({ ...args, type: 'decision', evidence: ['user stated: "Invented decision"'] })).status, 'rejected');
  assert.equal(JSON.parse(await f.tool.invoke({ ...args, type: 'verification', evidence: ['test:fixture passed'] })).status, 'accepted');
  assert.deepEqual(f.requests[0].evidence, ['test:fixture passed']);
});

test('quotation matching normalizes whitespace without accepting changed wording or negation', async () => {
  const f = fixture('Use concise\n  replies.');
  assert.equal(JSON.parse(await f.tool.invoke({ ...args, evidence: ['user requested: "Use concise replies."'] })).status, 'accepted');
  const changed = fixture('Use concise replies.');
  assert.equal(JSON.parse(await changed.tool.invoke({ ...args, evidence: ['user requested: "Do not use concise replies."'] })).status, 'rejected');
});

test('verified preferences pass the actual writer and a rejected quote leaves stored bytes unchanged', async () => {
  const { InMemoryStore } = await import('@langchain/langgraph');
  const repository = new api.MemoryStoreRepository({ store: new InMemoryStore(), getWorkspace: () => null,
    agentFacts: { readSessionStats: () => ({ totalRows: 0, oldestAt: null }), readFullTextIndexHealth: () => ({ healthy: true, status: 'ready' }) } });
  const audit = [];
  const writer = new api.AutoMemoryWriter({ repository, logger: { warn() {} },
    auditRepository: { record: row => audit.push(row), countWritesForRun: () => 0 } });
  const tool = api.createRememberTool({ runId: 'source-run', threadId: 'source-thread', workspacePath: null,
    applicability: 'a'.repeat(64), userInput: '请记住：回答简洁并保留来源。', remember: request => writer.recordCandidate(request) });
  assert.equal(JSON.parse(await tool.invoke(args)).status, 'accepted');
  const before = await repository.readFile({ scope: 'global', kind: 'user' });
  assert.ok(before.includes(args.summary));
  assert.equal(audit[0].sourceRunId, 'source-run');
  assert.equal(JSON.parse(await tool.invoke({ ...args, summary: 'omit sources', evidence: ['user stated: "omit sources"'] })).status, 'rejected');
  assert.equal(await repository.readFile({ scope: 'global', kind: 'user' }), before);
  assert.equal(audit.length, 1);
});

test('normalization cannot disguise a fabricated user claim before the writer canonicalizes it', async () => {
  for (const prefix of ['user  stated', 'user\tstated', 'user\nstated', 'ｕｓｅｒ stated', 'user\u00a0stated']) {
    const f = fixture('Use concise replies.');
    const forged = `${prefix}: "Citations are optional."`;
    for (const candidate of [
      { ...args, type: 'decision', evidence: [forged] },
      { ...args, evidence: ['user stated: "Use concise replies."', forged] }
    ]) {
      assert.equal(JSON.parse(await f.tool.invoke(candidate)).reason, 'user_evidence_not_in_current_input');
    }
    assert.equal(f.requests.length, 0);
    assert.equal(JSON.parse(await f.tool.invoke({ ...args, evidence: [`${prefix}: "Use concise replies."`] })).status, 'accepted');
  }
});
