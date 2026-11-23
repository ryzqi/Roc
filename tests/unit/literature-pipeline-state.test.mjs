import {test} from 'node:test';
import assert from 'node:assert/strict';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

const {acquisitionPipelineStage, literaturePipeline} = await importTypeScriptModule('src/renderer/literature/pipeline-state.ts');
const states = (document, job) => Object.fromEntries(literaturePipeline(document, job).map(stage => [stage.id, stage.state]));
const job = {stage: 'resolve', status: 'queued', receipt: null, documentId: null};

test('metadata-only never implies a stored PDF, parse, or searchable index', () => {
  assert.deepEqual(states(null, null), {metadata: '已收录', pdf: '未获取', parse: '未解析', index: '未建立', wiki: '未确认生成'});
});
test('a parsed local document is not proof of an index', () => {
  const result = states({status: 'ready', currentParseId: 'parse-1'}, null);
  assert.equal(result.pdf, '已保存');
  assert.equal(result.parse, '已完成');
  assert.equal(result.index, '待核验');
});
test('parse failures retain the acquired full text and leave downstream stages incomplete', () => {
  const result = states(null, {...job, stage: 'parse', status: 'failed', documentId: 'document-1'});
  assert.equal(result.pdf, '已保存');
  assert.equal(result.parse, '失败');
  assert.equal(result.index, '未建立');
});
test('wiki failure does not erase the verified index or mark knowledge generation complete', () => {
  const result = states(null, {...job, stage: 'wiki', status: 'failed', documentId: 'document-1'});
  assert.equal(result.parse, '已完成');
  assert.equal(result.index, '可检索');
  assert.equal(result.wiki, '失败');
  assert.equal(states(null, {...job, stage: 'wiki', status: 'ready'}).wiki, '可查看');
});
test('cancelled acquisition never claims a saved full text', () => {
  assert.equal(states(null, {...job, status: 'cancelled'}).pdf, '已取消');
});
test('the retry detail targets the actual durable acquisition stage', () => {
  for (const [stage, expected] of [['resolve', 'pdf'], ['download', 'pdf'], ['import', 'pdf'],
    ['parse', 'parse'], ['index', 'index'], ['wiki', 'wiki']]) {
    assert.equal(acquisitionPipelineStage({...job, stage}), expected);
  }
});
