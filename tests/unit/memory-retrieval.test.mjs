import assert from 'node:assert/strict';
import test from 'node:test';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const { searchMemoryDocuments } = await importTypeScriptModule('src/main/services/memory/memory-entry-search.ts');
const { buildAutoMemoryCandidate, formatAutoMemoryEntry } = await importTypeScriptModule('src/main/services/memory/auto-memory-candidates.ts');
const A = 'a'.repeat(64), B = 'b'.repeat(64);

function doc(content, { scope = 'global', kind = 'agents', path = `/memory/${scope}/${kind.toUpperCase()}.md` } = {}) {
  return { path, scope, kind, content };
}
function search(documents, query, limit = 10, applicability = A) {
  return searchMemoryDocuments(documents, query, limit, applicability);
}
function entry(overrides = {}) {
  return formatAutoMemoryEntry(buildAutoMemoryCandidate({ applicability: A, status: 'active', counterexamples: [],
    type: 'workspace_fact', confidence: 'high', key: 'source-policy', summary: 'source evidence', evidence: ['fixture'],
    sourceRunId: 'run', sourceThreadId: null, workspacePath: '/fixture', ttlDays: null, revalidate: null, ...overrides },
  { lowConfidenceTtlDays: 30 }, overrides.createdAt ?? '2020-01-01T00:00:00.000Z'));
}

test('USER plain Markdown bullets and prose are searchable without generated key comments', () => {
  const document = doc('# Preferences\n- Prefer Python for scripts.\n\n## 工作习惯\n回答使用中文，保留来源。', { kind: 'user' });
  assert.match(search([document], 'python').hits[0].text, /Prefer Python/);
  assert.match(search([document], '中文').hits[0].text, /使用中文/);
  assert.equal(search([document], '中文').hits[0].kind, 'user');
  assert.equal(search([document], '   ').hits.length, 0);
});

test('mixed keyed preferences and manual USER content yield distinct results without key-comment leakage', () => {
  const document = doc('# Preferences\n<!-- key: language -->\n- Prefer Python.\n- Prefer concise answers.\n\nManual note about reproducibility.', { kind: 'user' });
  const keyed = search([document], 'python');
  assert.equal(keyed.hits.length, 1);
  assert.equal(keyed.hits[0].entryType, 'user_preference');
  assert.equal(keyed.hits[0].key, 'language');
  const manual = search([document], 'concise');
  assert.equal(manual.hits.length, 1);
  assert.doesNotMatch(manual.hits[0].text, /<!--|Python/);
  assert.equal(search([document], 'reproducibility').hits.length, 1);
});

test('complete query coverage outranks a repeated partial match even in a weighted heading', () => {
  const partial = doc(`# Alpha\n${'alpha '.repeat(200)}`);
  const complete = doc('# Rules\nalpha beta', { scope: 'workspace' });
  const found = search([partial, complete], 'alpha beta');
  assert.equal(found.hits[0].scope, 'workspace');
  assert.ok(found.hits[0].score > found.hits[1].score);
  assert.equal(search([partial], 'alpha beta').hits[0].score,
    search([doc('# Alpha\nalpha')], 'alpha beta').hits[0].score);
  assert.equal(search([partial, complete], 'alpha beta', 1).hits.length, 1);
});

test('weighted fields still rank equally covered results and repeated queries cannot inflate rank', () => {
  const heading = doc('# Alpha beta\nDetails');
  const body = doc('# Rules\nalpha beta', { scope: 'workspace' });
  const found = search([body, heading], 'alpha beta');
  assert.equal(found.hits[0].path, heading.path);
  assert.deepEqual(search([body, heading], 'alpha alpha beta').hits, found.hits);
});

test('NFKC and mixed CJK queries retain coverage ranking', () => {
  const full = doc('# Notes\nＰＹＴＨＯＮ 偏好', { kind: 'user' });
  const partial = doc(`# Python\n${'python '.repeat(100)}`);
  assert.equal(search([partial, full], 'python偏好').hits[0].kind, 'user');
  assert.equal(search([full], '偏').hits.length, 1);
});

test('retrieval isolates malformed entries while suppressing their obsolete archive facts', () => {
  const old = doc(entry(), { kind: 'topic', path: '/memory/global/topics/old.md' });
  const bad = doc(entry({ applicability: B, summary: 'corrupt source evidence', createdAt: '2020-01-03T00:00:00.000Z' })
    .replace('counterexamples: []', 'counterexamples: not-json'), { kind: 'memory' });
  const healthy = doc('healthy-marker independent note');
  assert.equal(search([old, bad, healthy], 'source').hits.length, 0);
  assert.match(search([old, bad, healthy], 'healthy-marker').hits[0].text, /independent note/);
});

test('retrieval projects stable facts across hashes and never merges global/workspace lifecycle', () => {
  const global = doc(entry(), { kind: 'memory' });
  const local = doc(entry({ status: 'revoked', applicability: B, counterexamples: ['local override'],
    createdAt: '2020-01-03T00:00:00.000Z' }), { scope: 'workspace', kind: 'memory' });
  const hits = search([global, local], 'source evidence', 5, B).hits;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].scope, 'global');
});
