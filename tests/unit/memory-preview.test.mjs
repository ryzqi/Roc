import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import Database from 'better-sqlite3';

const compiled = await build({
  stdin: { contents: `
    export { MemoryStoreRepository } from './src/main/plugins/memory/memory-store-repository';
    export { RocSqliteStore } from './src/main/services/memory/sqlite-store';
    export { buildAutoMemoryCandidate, formatAutoMemoryEntry } from './src/main/services/memory/auto-memory-candidates';
    export { buildWorkspaceHash } from './src/main/services/paths';
  `, resolveDir: process.cwd() },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
  plugins: [{ name: 'absolute-dependencies', setup(builder) {
    builder.onResolve({ filter: /^@langchain\/langgraph$/ }, args => ({ path: import.meta.resolve(args.path), external: true }));
  } }]
});
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const A = 'a'.repeat(64), B = 'b'.repeat(64);
const projectA = { path: '/synthetic/preview-a', label: 'A' };
const projectB = { path: '/synthetic/preview-b', label: 'B' };

function entry(key, summary, overrides = {}) {
  const createdAt = overrides.createdAt ?? '2020-01-01T00:00:00.000Z';
  const candidate = api.buildAutoMemoryCandidate({ applicability: A, status: 'active', counterexamples: [],
    type: 'workspace_fact', confidence: 'high', key, summary, evidence: ['synthetic observation'], sourceRunId: 'fixture',
    sourceThreadId: null, workspacePath: projectA.path, ttlDays: null, revalidate: null, ...overrides },
  { lowConfidenceTtlDays: 30 }, createdAt);
  return `## ${createdAt.slice(0, 10)}\n\n${api.formatAutoMemoryEntry(candidate)}`;
}

function fixture(t, initialWorkspace = projectA) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE langgraph_store_items(namespace_key TEXT, namespace_json TEXT, key TEXT,
    value_json TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY(namespace_key,key))`);
  const store = new api.RocSqliteStore(db);
  let workspace = initialWorkspace, reads = 0;
  const repository = new api.MemoryStoreRepository({ store, getWorkspace: () => { reads++; return workspace; },
    agentFacts: { readSessionStats: () => ({ totalRows: 0, oldestAt: null }),
      readFullTextIndexHealth: () => ({ healthy: true, status: 'ready' }) } });
  return { repository, store, reads: () => reads, select: value => { workspace = value; },
    // Seed raw historical content, including malformed data written before validation existed.
    seed: (scope, key, content, project = projectA) => store.put(scope === 'global' ? ['roc', 'memory', 'global']
      : ['roc', 'memory', 'workspaces', api.buildWorkspaceHash(project.path)], key, { content }),
    snapshot: () => db.prepare('SELECT * FROM langgraph_store_items ORDER BY namespace_key, key').all() };
}

test('management preview filters invalid lifecycle states and preserves plain fixed documents without writes', async t => {
  const f = fixture(t);
  await f.seed('global', '/USER.md', '# Preferences\n- Prefer concise explanations.');
  await f.seed('global', '/AGENTS.md', 'Global rules marker');
  await f.seed('workspace', '/AGENTS.md', 'Workspace rules marker');
  await f.seed('workspace', '/MEMORY.md', [
    entry('healthy', 'VISIBLE_HEALTHY'),
    entry('revoked', 'HIDDEN_REVOKED', { status: 'revoked', counterexamples: ['withdrawn'] }),
    entry('pending', 'HIDDEN_PENDING', { status: 'needs_revalidation', revalidate: 'Recheck source' }),
    entry('expired', 'HIDDEN_EXPIRED', { ttlDays: 1 }),
    entry('corrected', 'HIDDEN_SUPERSEDED'),
    entry('corrected', 'VISIBLE_CORRECTION', { applicability: B, createdAt: '2020-01-03T00:00:00.000Z' }),
    entry('corrupt', 'HIDDEN_MALFORMED').replace('counterexamples: []', 'counterexamples: not-json')
  ].join('\n\n'));
  const before = f.snapshot();
  const { text } = await f.repository.buildSnapshotPreview();
  assert.match(text, /VISIBLE_HEALTHY/);
  assert.match(text, /VISIBLE_CORRECTION/);
  assert.doesNotMatch(text, /HIDDEN_|not-json/);
  assert.match(text, /Prefer concise explanations/);
  assert.match(text, /Global rules marker/);
  assert.match(text, /Workspace rules marker/);
  assert.match(text, /仅展示自动注入的固定记忆文档/);
  assert.match(text, /运行环境.*尚未解析.*未展示/);
  assert.match(text, /不是完整运行提示词/);
  assert.deepEqual(f.snapshot(), before);
});

test('topic history suppresses fixed-file predecessors without injecting any topic body', async t => {
  const f = fixture(t);
  const cases = [
    { key: 'revoked', status: 'revoked', counterexamples: ['withdrawn'] },
    { key: 'expired', ttlDays: 1 },
    { key: 'superseded' },
    { key: 'malformed', malformed: true }
  ];
  await f.seed('global', '/MEMORY.md', cases.map(value => entry(value.key, `OLD_${value.key}`)).join('\n\n'));
  for (const value of cases) {
    let content = entry(value.key, `TOPIC_${value.key}`, { ...value, createdAt: '2020-01-03T00:00:00.000Z' });
    if (value.malformed) content = content.replace('counterexamples: []', 'counterexamples: [1]');
    await f.seed('global', `/topics/${value.key}.md`, content);
  }
  await f.seed('global', '/topics/standalone.md', 'TOPIC_ONLY_PROSE');
  const { text } = await f.repository.buildSnapshotPreview(A);
  assert.doesNotMatch(text, /OLD_|TOPIC_|## \/memory\/global\/topics\//);
  assert.match(text, /主题文件仅参与替代和失效判定/);
});

test('unresolved environments hide experiences including legacy missing hashes; an explicit hash filters them', async t => {
  const f = fixture(t);
  await f.seed('global', '/MEMORY.md', [
    entry('stable', 'STABLE_FACT'),
    entry('experience', 'EXPERIENCE_A', { type: 'verification' }),
    entry('experience', 'EXPERIENCE_B', { type: 'verification', applicability: B }),
    entry('legacy', 'EXPERIENCE_LEGACY', { type: 'pitfall' }).replace(`  applicability: ${A}\n`, '')
  ].join('\n\n'));
  for (const unresolved of [undefined, '', 'invalid']) {
    const { text } = await f.repository.buildSnapshotPreview(unresolved);
    assert.match(text, /STABLE_FACT/);
    assert.doesNotMatch(text, /EXPERIENCE_/);
    assert.match(text, /尚未解析，未展示/);
  }
  const a = (await f.repository.buildSnapshotPreview(A)).text;
  assert.match(a, /EXPERIENCE_A/);
  assert.doesNotMatch(a, /EXPERIENCE_B|EXPERIENCE_LEGACY/);
  assert.match(a, /已按提供的运行环境过滤经验/);
  const b = (await f.repository.buildSnapshotPreview(B)).text;
  assert.match(b, /EXPERIENCE_B/);
  assert.doesNotMatch(b, /EXPERIENCE_A|EXPERIENCE_LEGACY/);
});

test('global and workspace lifecycle projection remain independent', async t => {
  const f = fixture(t);
  await f.seed('global', '/MEMORY.md', entry('shared-key', 'GLOBAL_VISIBLE'));
  await f.seed('workspace', '/MEMORY.md', entry('shared-key', 'WORKSPACE_HIDDEN'));
  await f.seed('workspace', '/topics/revocation.md', entry('shared-key', 'WORKSPACE_REVOKED', {
    status: 'revoked', counterexamples: ['local change'], createdAt: '2020-01-03T00:00:00.000Z'
  }));
  const { text } = await f.repository.buildSnapshotPreview();
  assert.match(text, /GLOBAL_VISIBLE/);
  assert.doesNotMatch(text, /WORKSPACE_HIDDEN|WORKSPACE_REVOKED/);
});

test('preview pins one workspace for fixed files and topic suppression even if the selected object mutates', async t => {
  const selected = { ...projectA };
  const f = fixture(t, selected);
  await f.seed('workspace', '/AGENTS.md', 'PROJECT_A_VISIBLE');
  await f.seed('workspace', '/MEMORY.md', entry('project-key', 'PROJECT_A_SUPPRESSED'));
  await f.seed('workspace', '/topics/revocation.md', entry('project-key', 'PROJECT_A_TOPIC', {
    status: 'revoked', counterexamples: ['withdrawn'], createdAt: '2020-01-03T00:00:00.000Z'
  }));
  await f.seed('workspace', '/AGENTS.md', 'PROJECT_B_HIDDEN', projectB);
  const get = f.store.get.bind(f.store);
  f.store.get = async (...args) => {
    const result = await get(...args);
    Object.assign(selected, projectB);
    return result;
  };
  const { text } = await f.repository.buildSnapshotPreview();
  assert.equal(f.reads(), 1);
  assert.match(text, /PROJECT_A_VISIBLE/);
  assert.doesNotMatch(text, /PROJECT_B_HIDDEN|PROJECT_A_SUPPRESSED|PROJECT_A_TOPIC/);
});

test('a no-workspace preview remains global-only if a project is selected during reads', async t => {
  const f = fixture(t, null);
  await f.seed('global', '/USER.md', 'GLOBAL_ONLY');
  await f.seed('workspace', '/AGENTS.md', 'PROJECT_HIDDEN');
  const get = f.store.get.bind(f.store);
  f.store.get = async (...args) => { const result = await get(...args); f.select(projectA); return result; };
  const { text } = await f.repository.buildSnapshotPreview();
  assert.equal(f.reads(), 1);
  assert.match(text, /GLOBAL_ONLY/);
  assert.doesNotMatch(text, /PROJECT_HIDDEN|## \/memory\/workspaces\//);
});
