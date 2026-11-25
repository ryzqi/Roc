import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('formula audit corrects only exact unique zero-order annotations and retains denominator differences', () => {
  const run = spawnSync('python3', ['-B', '-c', `
import hashlib, importlib.util, json
spec = importlib.util.spec_from_file_location('audit', 'scripts/research/audit-ovis-zero-order.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
a = {'category_type':'equation_isolated','latex':'$$x$$','order':0,'anno_id':'a'}
gold = [{'page_info':{'image_path':'page.png'},'layout_dets':[a]}]
identity = {'img_id':'page.png','gt_category_type':'equation_isolated','gt_position':'',
 'exactGoldSha256':hashlib.sha256(a['latex'].encode()).hexdigest()}
def ids(position='', count=1, **changes):
 return {json.dumps({**identity,'gt_position':position,**changes},sort_keys=True,separators=(',',':')):count}
expected = m.canonical_formulas(ids(0),gold)[0]
actual, corrections = m.canonical_formulas(ids(),gold)
assert actual == expected and len(corrections)==1
for annotations in [[{**a,'order':1}], [{**a,'order':None}], [{**a,'order':False}],
                    [{**a,'ignore':True}], [{**a,'latex':'$$y$$'}], [a,a]]:
 changed=[{**gold[0],'layout_dets':annotations}]
 assert m.canonical_formulas(ids(),changed)[1] == []
for altered in [ids(1), ids('',2), ids('',exactGoldSha256='0'*64), {}]:
 assert m.canonical_formulas(altered,gold)[0] != expected
assert m.canonical_formulas(ids(0,2),gold)[0] != expected
try: m.canonical_formulas(ids(), gold+gold)
except ValueError: pass
else: raise AssertionError('duplicate gold image accepted')
`], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stderr);
});
