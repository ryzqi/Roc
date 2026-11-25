import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('candidate backend maps original reference order and retains invalid candidate pages', () => {
  const run = spawnSync('python3', ['-B', '-c', `
import copy,importlib.util
spec=importlib.util.spec_from_file_location('backend','scripts/research/score-ovis-candidate-backend.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
c={'pages':[{'id':'one','sha256':'a'},{'id':'two','sha256':'b'},{'id':'three','sha256':'c'}]}
r={'pages':[{**p,'valid':p['id']!='two'} for p in c['pages']]}
associations=[{'id':'ref-two','pairedPageId':'two','sourceImage':{'sha256':'b'}},
              {'id':'ref-one','pairedPageId':'one','sourceImage':{'sha256':'a'}}]
selected=m.select_pages(c,associations,r)
assert [p['id'] for _,p in selected]==['two','one']
assert selected[0][1]['valid'] is False
assert r['pages'][1]['valid'] is False
def reject(candidate,refs,report):
 try:m.select_pages(candidate,refs,report)
 except ValueError:return
 raise AssertionError('changed source association accepted')
reject(c,associations,{'pages':r['pages'][:2]})
reject(c,associations,{'pages':list(reversed(r['pages']))})
reject(c,[],r)
reject(c,[associations[0],associations[0]],r)
reject(c,[{**a,'id':'same'} for a in associations],r)
reject(c,[{**associations[0],'pairedPageId':'absent'}],r)
reject(c,[{**associations[0],'sourceImage':{'sha256':'changed'}}],r)
changed=copy.deepcopy(r);changed['pages'][1]['sha256']='changed';reject(c,associations,changed)
reject({'pages':[c['pages'][0],c['pages'][0]]},associations,{'pages':[r['pages'][0],r['pages'][0]]})
assert len(c['pages'])==3 and len(r['pages'])==3
`], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stderr);
});
