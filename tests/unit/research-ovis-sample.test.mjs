import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('twenty-page sample retains regressions and rejects exclusions, substitutions and expansion', () => {
  const run = spawnSync('python3', ['-B', '-c', `
import copy,importlib.util,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('sample','scripts/research/score-ovis-sample.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
c=json.loads(Path('evaluation/ovis-decoder/sample-20-1.03.json').read_text())
p=json.loads(Path('evaluation/ovis-evaluator/paired-inference.json').read_text())
gold=[{'identity':page['id']} for page in p['pages']]
selected=m.selected_pages(c,p,gold)
assert len(selected)==20
assert all(page['id']==annotation['identity'] for page,annotation in selected)
assert set(c['selection']['anchors'])<={page['id'] for page,_ in selected}
def reject(changed):
 try:m.selected_pages(changed,p,gold)
 except ValueError:return
 raise AssertionError('Changed sample accepted')
for pages in [c['pages'][:-1],c['pages']+[p['pages'][1]],list(reversed(c['pages'])),p['pages']]:
 reject({**c,'pages':pages})
reject({**c,'exclusions':['scientific-253']})
changed=copy.deepcopy(c);changed['pages'][0]['sha256']='changed';reject(changed)
changed=copy.deepcopy(c);changed['pages'][0]=p['pages'][1];reject(changed)
changed=copy.deepcopy(c);changed['selection']['seed']='new-seed';reject(changed)
changed=copy.deepcopy(c);changed['selection']['anchors'][-1]='scientific-254';reject(changed)
`], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stderr);
});
