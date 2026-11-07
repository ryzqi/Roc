import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp, mkdir, readFile, writeFile, realpath, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import yauzl from 'yauzl';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const bibliography='@article{Smith2024, author={Smith, Jane}, title={Synthetic scientific finding}, journal={Test Journal}, year={2024}, volume={7}, pages={1--8}, doi={10.1234/test}}';
const sources={project:{title:'Synthetic study',description:'Reproducible output fixture'},manuscript:{sections:[{title:'Results',claimIds:['c']}]},
 claims:[{id:'c',content:'Literal $x$ and <script> text.',evidenceIds:['e'],status:'supported'},
 {id:'caption',content:'Synthetic figure caption',evidenceIds:['e'],artifactId:'fa',subjectType:'figure',status:'supported'}],
 citationKeys:{e:'Smith2024'},bibliography:[{citationKey:'Smith2024'}],evidence:[{id:'e',title:'Source',locator:'p. 1'}],
 figures:[{id:'fig',artifactId:'fa',title:'Synthetic figure',manifestHash:'a'.repeat(64)}],review:{}};
let api, tools, root, bundle;
before(async()=>{
 root=await realpath(await mkdtemp('/tmp/roc-writing-runtime-'));
 bundle=resolve('.runtime/test-bundles/scientific-writing-runtime.mjs');
 await mkdir(resolve('.runtime/test-bundles'),{recursive:true});
 await build({stdin:{contents:[
  "export {ResearchToolchain} from './src/main/plugins/research/toolchain';",
  "export {ResearchProseLintService} from './src/main/plugins/research/prose-lint-service';",
  "export {ResearchExportFiles} from './src/main/plugins/research/export-files';",
  "export {buildPandocExports} from './src/main/plugins/research/pandoc-export';",
  "export {buildArxivSubmission} from './src/main/plugins/research/arxiv-submission';",
  "export {createTypstReport} from './src/main/plugins/research/typst-report';"
 ].join('\n'),resolveDir:process.cwd()},outfile:bundle,bundle:true,platform:'node',format:'esm',packages:'external',loader:{'.c':'text'},logLevel:'silent'});
 api=await import(pathToFileURL(bundle).href);
 tools=new api.ResearchToolchain(await realpath(process.env.ROC_WRITING_TEST_TOOLCHAIN ?? '.runtime/research-toolchain/darwin-arm64'));
 assert.equal((await tools.status()).available,true,JSON.stringify(await tools.status()));
 console.log(`Runtime evidence: ${root}`);
});
after(async()=>{await rm(bundle,{force:true});});
async function directory(name){const path=join(root,name);await mkdir(path);return path;}
async function pdfText(bytes){
 const loadingTask=getDocument({data:new Uint8Array(bytes),useSystemFonts:true});
 try {const doc=await loadingTask.promise;let text='';for(let i=1;i<=doc.numPages;i++) text+=(await (await doc.getPage(i)).getTextContent()).items.map(item=>item.str).join(' ');return text;} finally{await loadingTask.destroy();}
}
function zipFiles(path){return new Promise((resolve,reject)=>yauzl.open(path,{lazyEntries:true},(error,zip)=>{
 if(error)return reject(error);const files=new Map();zip.on('error',reject);zip.on('end',()=>resolve(files));
 zip.on('entry',entry=>zip.openReadStream(entry,(error,stream)=>{
  if(error)return reject(error);const chunks=[];stream.on('error',reject);stream.on('data',chunk=>chunks.push(chunk));
  stream.on('end',()=>{files.set(entry.fileName,Buffer.concat(chunks));zip.readEntry();});
 }));zip.readEntry();
}));}

test('real Vale checks saved TeX coordinates, ignores citations/math, reuses cache and rejects drift',async()=>{
 const workspace=await directory('prose-workspace'), jobs=await directory('prose-jobs');
 const prose='In order to utilize our revolutionary novel state-of-the-art algorithm, we prove that this guarantees success.';
 await writeFile(join(workspace,'paper.tex'),`\\section{Introduction}\n\\cite{revolutionary} $revolutionary$\n${prose}\n这显然是众所周知的。`);
 let invocations=0;
 const service=new api.ResearchProseLintService({getProject:()=>({language:'en',workspacePath:workspace})},{
  status:()=>tools.status(),utilityIdentity:()=>tools.utilityIdentity(),lintProse:input=>{invocations++;return tools.lintProse(input);}
 },jobs);
 try {
  const result=await service.lintTex({projectId:'p',path:'paper.tex'});
  assert.ok(result.findings.length>0);assert.equal(result.cache,'miss');
  assert.ok(result.findings.some(f=>f.line===3));assert.ok(!result.findings.some(f=>f.line===2));
  const cached=await service.lintTex({projectId:'p',path:'paper.tex',expectedHash:result.target.contentHash});
  assert.equal(cached.cache,'hit');assert.equal(invocations,1);assert.deepEqual(cached.findings,result.findings);
  await writeFile(join(workspace,'paper.tex'),'Changed saved text.');
  await assert.rejects(service.lintTex({projectId:'p',path:'paper.tex',expectedHash:result.target.contentHash}),/target_changed/);
  await writeFile(join(root,'vale-receipt.json'),JSON.stringify(result,null,2));
 } finally{await service.shutdown();}
});

test('six pinned CSL styles compile actual Typst reports containing the bibliography',async()=>{
 const provenance=JSON.parse(await readFile('resources/research-runtime/csl/provenance.json','utf8'));
 const styles=['ama','apa','chicago-author-date','gb-t-7714','ieee','nature'];
 for(let index=0;index<styles.length;index++) {
  const style=styles[index],entry=provenance.styles.find(value=>value.file === ({ama:'american-medical-association.csl',apa:'apa.csl','chicago-author-date':'chicago-author-date.csl','gb-t-7714':'china-national-standard-gb-t-7714-2015-numeric.csl',ieee:'ieee.csl',nature:'nature.csl'})[style]);
  assert.equal(hash(await tools.typstStyle(entry.file)),entry.sha256);
  const jobDir=await directory(`typst-${style}`);
  const report=await api.createTypstReport({tools:{typstStyle:name=>tools.typstStyle(name),compileTypst:async input=>{
   const result=await tools.compileTypst(input);
   assert.equal(result.exitCode,0,`${style}: ${JSON.stringify(result)}`);return result;
  }},jobDir,sources,bibliography,language:style==='gb-t-7714'?'zh':'en',style,admission:{projectId:'p',priority:'user'}});
  // CSL controls title and author casing (Chicago title case, GB/T uppercase authors).
  const text=await pdfText(report.pdf);assert.match(text,/Synthetic scientific finding/iu);assert.match(text,/Smith/iu);
  assert.equal(report.style,style);
 }
});

test('real offline Pandoc produces cited DOCX and self-contained HTML with literal text and embedded PNG',async()=>{
 const output=await directory('conversion-output'),scratch=await directory('conversion-job');
 const writer=new api.ResearchExportFiles(output);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH9sAAAAASUVORK5CYII=','base64');
 await writer.write('source/figures/fig.png',png);
 const record={id:'export',projectId:'p',sourceHash:'b'.repeat(64),request:{title:'Synthetic export',conversionFormats:['docx','html'],reportCitationStyle:'apa'}};
 await api.buildPandocExports({record,sources,writer,tools,scratch,signal:new AbortController().signal,bibliography,language:'en'});
 const html=await readFile(join(output,'paper.html'),'utf8');
 assert.match(html,/data:image\/png;base64,/u);assert.match(html,/&lt;script&gt;/u);assert.match(html,/Literal \$x\$/u);
 assert.match(html,/Smith/u);assert.match(html,/Synthetic scientific finding/u);assert.match(html,/Synthetic figure caption/u);
 assert.ok(!html.includes('<script>'));
 const docx=await zipFiles(join(output,'paper.docx'));
 const xml=docx.get('word/document.xml').toString();assert.match(xml,/Smith/u);assert.match(xml,/Literal \$x\$/u);assert.match(xml,/Synthetic scientific finding/u);
 assert.ok([...docx.keys()].some(name=>name.startsWith('word/media/')));
 const manifest=JSON.parse(await readFile(join(output,'conversion/manifest.json'),'utf8'));
 assert.equal(manifest.sourceHash,record.sourceHash);assert.equal(manifest.outputs.length,2);
 for(const file of manifest.outputs) assert.equal(hash(await readFile(join(output,file.path))),file.sha256);
 // Missing bibliography is a real converter error, never a successful empty output.
 const bad=await directory('conversion-bad');await writeFile(join(bad,'document.json'),await readFile(join(output,'conversion/document.json')));
 const failed=await tools.convertDocument({rootPath:bad,jobDir:bad,format:'docx',admission:{projectId:'p',priority:'user'}});
 assert.notEqual(failed.exitCode,0);
});

test('real Tectonic recompiles the derivative and ZIP retains dependency closure and original hashes',async()=>{
 const output=await directory('arxiv-output'),scratch=await directory('arxiv-job');
 const writer=new api.ResearchExportFiles(output);
 await writer.write('source/main.tex','\\documentclass{article}\n\\begin{document}\\input{section}\\end{document}');
 const child=await writer.write('source/section.tex','Synthetic submission text.');
 const unused=await writer.write('source/unused.tex','Alternate unused source.');
 await api.buildArxivSubmission({writer,entryPath:'main.tex',bbl:null,scratch,projectId:'p',exportId:'export',artifactId:'artifact',sourceHash:'c'.repeat(64),tools,signal:new AbortController().signal});
 const manifest=JSON.parse(await readFile(join(output,'submission/manifest.json'),'utf8'));
 assert.equal(manifest.compilation.status,'ready');assert.ok(manifest.archive);assert.equal(manifest.origin.sourceHash,'c'.repeat(64));
 const files=await zipFiles(join(output,manifest.archive.path));
 assert.deepEqual([...files.keys()].sort(),['main.tex','section.tex']);assert.equal(hash(files.get('section.tex')),child.sha256);
 assert.equal(hash(await readFile(join(output,unused.path))),unused.sha256);
});
