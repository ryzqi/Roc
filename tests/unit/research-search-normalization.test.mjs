import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

const {searchMatchScore, searchTerms, searchTermsScore, registerSearchFunctions, searchNormalizationLimits} =
  await importTypeScriptModule('src/main/plugins/research/search-normalization.ts', {platform: 'node'});

test('read-time normalization tolerates case, Unicode dashes, script and phonetic spellings without rewriting text', () => {
  const original = 'Multi‑Agent 注意力機制与重慶重構、绿色网络';
  for (const query of ['MULTI-AGENT', 'multi agent', 'multiagent', '注意力机制', 'zhuyili', 'zhu yi li',
    'zyl', 'chongqing', 'zhònggòu', 'lvse', 'lǜ sè']) {
    assert.ok(searchMatchScore(original, query) > 0, query);
  }
  assert.equal(original, 'Multi‑Agent 注意力機制与重慶重構、绿色网络');
  assert.ok(searchMatchScore('注意力机制', '注意力机制') > searchMatchScore('注意力機制', '注意力机制'));
  assert.ok(searchMatchScore('注意力機制', '注意力机制') > searchMatchScore('注意力机制', 'zhuyili'));
  assert.equal(searchMatchScore(original, 'z'), 0);
  assert.equal(searchMatchScore(original, 'notpresent'), 0);
  assert.equal(searchMatchScore(original, ''), 0);
  assert.equal(searchMatchScore('literal 100%_\\ value', '100%_\\'), 4);
  assert.equal(searchMatchScore('literal 100000 value', '100%_\\'), 0);
  assert.equal(searchMatchScore(original, '%'), 0);
});

test('whole spaced pinyin is matched before OR tokens without expanding a short syllable into unrelated Han text', () => {
  const terms = searchTerms('zhu yi li');
  assert.ok(searchTermsScore('注意力机制', terms) > 0);
  assert.equal(searchTermsScore('唯一实验', terms), 0);
  assert.ok(searchTermsScore('多头注意力机制', searchTerms('Transformer zhuyili')) > 0);
});

test('registered functions are read-only and use content-keyed projections after edits and repeated registration', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE originals(id TEXT,content TEXT); INSERT INTO originals VALUES (\'one\',\'注意力機制\');');
    registerSearchFunctions(db);
    registerSearchFunctions(db);
    const statement = db.prepare('SELECT content,roc_search_match(content,?) AS matched FROM originals');
    assert.deepEqual(statement.get('zhuyili'), {content: '注意力機制', matched: 1});
    db.prepare('UPDATE originals SET content=?').run('图神经网络');
    assert.deepEqual(statement.get('zhuyili'), {content: '图神经网络', matched: 0});
    assert.equal(statement.get('tushenjing').matched, 1);
    const changes = () => db.prepare('SELECT total_changes()').pluck().get();
    const before = changes();
    for (let i = 0; i < 700; i++) db.prepare('SELECT roc_search_match(?,?) AS score').get(`元数据 ${i} 注意力`, 'zhuyili');
    assert.equal(changes(), before);
    assert.equal(statement.get('tushenjing').matched, 1);
  } finally {db.close();}
});

test('bounded overlapping projections retain matches across a window boundary and at the end of a large source', () => {
  const start = searchNormalizationLimits.projectionCharacters - 2;
  const original = 'x'.repeat(start) + '注意力機制' + 'y'.repeat(100_000) + 'Multi‑Agent 重慶';
  for (const query of ['注意力机制', 'zhuyili', 'multiagent', 'chongqing']) {
    assert.ok(searchMatchScore(original, query) > 0, query);
  }
  assert.equal(searchMatchScore(original, 'unmatched'.repeat(600)), 0);
});
