import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('candidate scorer rejects setting drift, changed cohorts and false completion without discarding invalid pages', () => {
  const run = spawnSync('python3', ['-B', '-c', `
import copy,importlib.util
spec=importlib.util.spec_from_file_location('candidate','scripts/research/score-ovis-candidate.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
settings={k:0 for k in ['temperature','maxTokens','enableThinking','minPixels','maxPixels','seed']}
settings.update(repetitionPenalty=1.05,repetitionContextSize=20,promptSha256='prompt',formattedPromptSha256='formatted',eosTokenIds=[248046],network='denied-by-seatbelt')
c={'identities':{'generatedInference':{'sha256':'probe'},'launcher':{'sha256':'launcher'}},
 'modelRevision':'revision','installationReceiptSha256':'receipt','settings':settings,'pages':[{'id':'one','sha256':'image'},{'id':'two','sha256':'image2'}]}
r={'status':'invalid-output','scope':'diagnostic-repetition-probe','variant':'8bit','evaluatorSha256':'probe',
 'revision':'revision','receiptSha256':'receipt','settings':settings,
 **{k:settings[k] for k in ['promptSha256','formattedPromptSha256','eosTokenIds','network']},
 'pages':[{'id':'one','sha256':'image','valid':False},{'id':'two','sha256':'image2','valid':True}]}
d={'status':'finished','exitCode':2,'probeSha256':'probe','launcherSha256':'launcher','inferenceStatus':'invalid-output','validPages':1}
m.validate_candidate(c,d,r)
def reject(diagnostic,report):
 try:m.validate_candidate(c,diagnostic,report)
 except ValueError:return
 raise AssertionError('changed evidence accepted')
for key in settings:
 changed=copy.deepcopy(r)
 if key in ['promptSha256','formattedPromptSha256','eosTokenIds','network']:changed[key]='changed'
 else:changed['settings'][key]='changed'
 reject(d,changed)
for key,value in [('status','completed'),('variant','original-bf16'),('scope','qualification'),('evaluatorSha256','changed'),('receiptSha256','changed')]:
 reject(d,{**r,key:value})
for key,value in [('status','running'),('exitCode',0),('validPages',2),('launcherSha256','changed')]:reject({**d,key:value},r)
reject(d,{**r,'pages':r['pages'][1:]})
reject(d,{**r,'pages':list(reversed(r['pages']))})
reject(d,{**r,'pages':[{**r['pages'][0],'sha256':'changed'},r['pages'][1]]})
good={**r,'status':'completed','pages':[{**p,'valid':True} for p in r['pages']]}
m.validate_candidate(c,{**d,'exitCode':0,'inferenceStatus':'completed','validPages':2},good)
`], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stderr);
});
