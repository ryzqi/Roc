import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
const {ResearchProseLintService}=await importTypeScriptModule('src/main/plugins/research/prose-lint-service.ts',{platform:'node'});
const {projectTexProse}=await importTypeScriptModule('src/main/plugins/research/tex-prose-projection.ts');

test('TeX projection preserves offsets while excluding comments, citations, math and unknown macro arguments',()=>{
  const source=String.raw`\section{Title}
Visible \emph{word} \cite{secret} % comment
$equation$ \unknown{hidden}
\begin{verbatim}hidden\end{verbatim}
Last.`;
  const {projection,limitations}=projectTexProse(source);
  const text=projection.units[0].content;
  assert.equal(text.length,source.length);assert.equal(text.split('\n').length,source.split('\n').length);
  for(const word of ['Visible','word','Last.']) assert.equal(text.indexOf(word),source.indexOf(word));
  for(const word of ['secret','comment','equation','hidden']) assert.ok(!text.includes(word));
  assert.ok(limitations.includes('macro_not_expanded:unknown'));
  assert.ok(limitations.includes('environment_omitted:verbatim'));
});

test('cache remaps current claim IDs and invalidates text/rules; workspace checks lock saved bytes and reject symlinks',async()=>{
  const root=await mkdtemp(join(tmpdir(),'roc-prose-test-'));
  let claimId='a',content='Some text.',identity='a'.repeat(64),calls=0;
  const repository={getProject:()=>({language:'en',workspacePath:root}),getArtifact:()=>({id:'artifact',projectId:'project',kind:'manuscript',title:'Title'}),
    manuscripts:{inspectBundle:()=>({manuscript:{sections:[{title:'Section',claimIds:[claimId]}]},claims:[{id:claimId,content}]})}};
  const tools={status:async()=>({available:true,versions:{vale:'3.24.0'}}),utilityIdentity:async()=>identity,
    lintProse:async()=>{calls++;return {'sections/000.md':[{Line:3,Span:[1,4],Severity:'warning',Check:'Roc.Test',Message:'Check',Match:'Some'}]};}};
  const service=new ResearchProseLintService(repository,tools,root);
  try{
    const first=await service.lint({projectId:'project',artifactId:'artifact'});
    claimId='b';const second=await service.lint({projectId:'project',artifactId:'artifact'});
    assert.equal(second.cache,'hit');assert.equal(calls,1);assert.equal(second.findings[0].claimId,'b');
    assert.notEqual(first.target.contentHash,second.target.contentHash);
    content='Changed text.';await service.lint({projectId:'project',artifactId:'artifact'});assert.equal(calls,2);
    identity='b'.repeat(64);await service.lint({projectId:'project',artifactId:'artifact'});assert.equal(calls,3);
    await writeFile(join(root,'paper.tex'),'Some text.');
    const tex=await service.lintTex({projectId:'project',path:'paper.tex'});
    assert.equal(tex.target.kind,'workspace_tex');assert.equal(tex.artifactId,null);
    await writeFile(join(root,'paper.tex'),'Changed text.');
    await assert.rejects(service.lintTex({projectId:'project',path:'paper.tex',expectedHash:tex.target.contentHash}),/target_changed/);
    await symlink(join(root,'paper.tex'),join(root,'link.tex'));
    await assert.rejects(service.lintTex({projectId:'project',path:'link.tex'}),/symlink/);
    await assert.rejects(service.lintTex({projectId:'project',path:'../paper.tex'}),/relative_path_invalid/);
  }finally{await service.shutdown();await rm(root,{recursive:true,force:true});}
});
