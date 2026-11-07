import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, realpath, readFile, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
const {pandocDocument} = await importTypeScriptModule('src/main/plugins/research/pandoc-export.ts', {platform:'node',external:['yazl','yauzl'],tempDir:'.runtime/test-bundles'});
const {validateDiagramSource} = await importTypeScriptModule('src/shared/research-diagram-policy.ts');
const {ResearchDiagramService} = await importTypeScriptModule('src/main/plugins/research/diagram-service.ts', {platform:'node',external:['electron','yazl','yauzl'],tempDir:'.runtime/test-bundles'});
const {ResearchExportFiles} = await importTypeScriptModule('src/main/plugins/research/export-files.ts', {platform:'node',external:['yazl','yauzl'],tempDir:'.runtime/test-bundles'});
const {buildArxivSubmission} = await importTypeScriptModule('src/main/plugins/research/arxiv-submission.ts', {platform:'node',external:['yazl','yauzl'],tempDir:'.runtime/test-bundles'});
const {latexReachability,prunableTexFiles} = await importTypeScriptModule('src/main/plugins/research/arxiv-preflight.ts');

test('normalized document preserves literal markup, citation identity, order and caption sources',()=>{
 const sources={manuscript:{sections:[{title:'Results',claimIds:['c']}]},claims:[{id:'c',content:'<script> x $y$ \\input{secret}',evidenceIds:['e','e']}],citationKeys:{e:'Smith'},bibliography:[{citationKey:'Smith'}],figures:[]};
 const ast=pandocDocument(sources,'Title',new Map());
 assert.equal(ast.blocks[0].t,'Header');
 const content=ast.blocks[1].c;
 assert.ok(content.some(node=>node.t==='Str'&&node.c==='<script>'));
 assert.equal(content.at(-1).c[0].length,1); assert.equal(content.at(-1).c[0][0].citationId,'Smith');
 assert.ok(!JSON.stringify(ast).includes('RawInline'));
 assert.throws(()=>pandocDocument({...sources,citationKeys:{}},'Title',new Map()),/citation_unknown/);
});

test('static diagram policy rejects configuration, resources and unsupported or oversized sources',()=>{
 for (const source of ['flowchart LR\n A-->B','sequenceDiagram\n Alice->>Bob: hello']) validateDiagramSource(source);
 for (const source of ['flowchart LR\n%%{init:{}}%%\nA-->B','flowchart LR\nclick A "https://evil.test"','flowchart LR\nA[<img src=x>]','pie\n"x": 1','flowchart LR\n'+'A'.repeat(50000)]) assert.throws(()=>validateDiagramSource(source));
});

test('diagram service freezes saved bytes and rejects stale results before writing outputs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'roc-diagram-unit-'));
 const repo={getProject:()=>({id:'p',workspacePath:root,status:'active'})};
 let change=false;
 const service=new ResearchDiagramService(repo,async()=>{
  if(change) await writeFile(join(root,'a.mmd'),'flowchart LR\nB-->C');
  return {svg:'<svg/>',png:Buffer.from('png'),pdf:Buffer.from('%PDF-')};
 });
 try {
  await writeFile(join(root,'a.mmd'),'flowchart LR\nA-->B');
  const result=await service.render({projectId:'p',path:'a.mmd'});
  assert.equal(result.files.length,5);
  const manifest=JSON.parse(await readFile(join(root,result.directory,'manifest.json'),'utf8'));
  assert.equal(manifest.sourceHash,result.sourceHash);assert.equal(manifest.files.length,4);
  await assert.rejects(service.render({projectId:'p',path:'a.mmd',expectedHash:'a'.repeat(64)}),/source_changed/);
  change=true;await assert.rejects(service.render({projectId:'p',path:'a.mmd'}),/source_changed/);
 } finally {await service.shutdown();await rm(root,{recursive:true,force:true});}
});

test('arxiv retained alternate entry keeps transitive dependencies and dynamic references disable pruning',()=>{
 const files=new Map([['main.tex','% alt.tex'],['alt.tex','\\input{child}'],['child.tex','body'],['unused.tex','unused']]);
 const reachable=latexReachability({entryPath:'main.tex',files}).texFiles;
 assert.deepEqual(prunableTexFiles({entryPath:'main.tex',files,reachable}),['unused.tex']);
 files.set('alt.tex','\\input{\\dynamic}');assert.deepEqual(prunableTexFiles({entryPath:'main.tex',files,reachable}),[]);
});

test('submission derivative preserves original bytes and emits ZIP only after successful compile',async()=>{
 for(const status of ['ready','failed','blocked']) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'roc-arxiv-unit-')));
  try {
   const writer=new ResearchExportFiles(root);
   const original=await writer.write('source/main.tex',status==='blocked'?'\\input{missing}':'\\documentclass{article}\n\\begin{document}Hi\\end{document}');
   await writer.write('source/unused.tex','unused');
   let calls=0;
   const tools={utilityIdentity:async()=> 'a'.repeat(64),compile:async request=>{
    calls++;
    if(status==='ready') await writeFile(join(request.outputDir,'main.pdf'),'%PDF-fixture');
    return {exitCode:status==='ready'?0:1,stdout:'',stderr:'',resourceUsage:{},admission:{}};
   }};
   await buildArxivSubmission({writer,entryPath:'main.tex',bbl:null,scratch:root,projectId:'p',exportId:'e',artifactId:'a',sourceHash:'b'.repeat(64),tools,signal:new AbortController().signal});
   const manifest=JSON.parse(await readFile(join(root,'submission/manifest.json'),'utf8'));
   assert.equal(manifest.changes.find(file=>file.path==='main.tex').originalSha256,original.sha256);
   assert.ok(writer.list().some(file=>file.path==='source/unused.tex'));
   assert.ok(!writer.list().some(file=>file.path==='submission/source/unused.tex'));
   assert.equal(manifest.archive!==null,status==='ready');assert.equal(calls,status==='blocked'?0:1);
  } finally {await rm(root,{recursive:true,force:true});}
 }
});
