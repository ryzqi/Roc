import assert from 'node:assert/strict';
import {before,test} from 'node:test';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {ZipFile} from 'yazl';
import {createHash} from 'node:crypto';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
let api;
before(async()=>{api=await importTypeScriptModule('src/main/plugins/research/submission-preflight.ts',{platform:'node',
  external:['@napi-rs/canvas','pdfjs-dist/legacy/build/pdf.mjs','pdf-lib','yauzl','fast-xml-parser'],tempDir:'.runtime/test-bundles'});});
const hash=value=>createHash('sha256').update(value).digest('hex');
function profile(overrides={}){
  const snapshot={schemaVersion:1,id:'profile-version',profileId:'profile',version:1,request:{projectId:'project',requestId:'policy',profileId:null,parent:null,profile:{journal:'Fixture',articleType:'Article',submissionStage:'initial',version:'1',revisionDate:'2026-11-22',
      dateAuthority:'human_transcription',retrievedAt:'2026-11-22T00:00:00.000Z',rules:[{id:'refs',label:'References',sourceUrl:'https://example.org/guide',excerpt:'Synthetic fixture.',
        authority:'required',kind:'reference_count',maximum:100}]},requirements:{maximumPages:2,anonymous:false,requiredDeclarations:['Data availability'],minimumEditableTables:0,supplementPaths:[],...overrides}},requestHash:'a'.repeat(64),actor:{kind:'user',id:'window:73'},recordedAt:'2026-11-22T00:00:00.000Z'};
  return {snapshot,snapshotHash:hash(JSON.stringify(snapshot))};
}
const journalChecks=[{ruleId:'refs',status:'pass',subjectIds:[],detail:'Exact saved source count'}];
async function pdf(text='Data availability: retained.',count=1,author){
  const doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.Helvetica);
  if(author)doc.setAuthor(author);
  for(let i=0;i<count;i++){const page=doc.addPage([500,600]);if(text)page.drawText(text,{font,size:12,x:20,y:550});}
  return await doc.save();
}
async function docx(xml){
  const zip=new ZipFile(),chunks=[];
  zip.addBuffer(Buffer.from(xml),'word/document.xml');zip.addBuffer(Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),'[Content_Types].xml');
  zip.end();for await(const chunk of zip.outputStream)chunks.push(chunk);return Buffer.concat(chunks);
}

test('real PDF metadata and private filename matches are masked while page/declaration/supplement failures remain precise',async()=>{
  const original=await pdf('Data availability: retained.',2,'Private Researcher'),before=hash(original);
  const report=await api.inspectSubmissionPreflight({profile:profile({maximumPages:1,anonymous:true,requiredDeclarations:['Ethics approval'],supplementPaths:['supplement.csv']}),
    pdf:original,files:[{path:'Private Researcher.csv',bytes:Buffer.from('value\n3\n')}],privateIdentityTokens:['Private Researcher'],journalChecks});
  assert.equal(report.status,'fail');
  assert.equal(report.pdf.pages,2);
  for(const kind of ['pages','declarations','supplements','anonymity'])assert.equal(report.checks.find(check=>check.kind===kind).status,'fail');
  assert.ok(report.checks.find(check=>check.kind==='anonymity').subjectIds.includes('pdf:metadata'));
  assert.ok(!JSON.stringify(report).includes('Private Researcher'));
  assert.equal(hash(original),before);
  assert.equal(report.files[0].sha256,hash(Buffer.from('value\n3\n')));
});

test('only actual WordprocessingML tables count and image-only/unselected identity checks stay manual',async()=>{
  const native=await docx('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&lt;w:tbl&gt; is text</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl></w:body></w:document>');
  assert.equal((await api.inspectSubmissionDocx(native)).tables,1);
  const result=await api.inspectSubmissionPreflight({profile:profile({minimumEditableTables:1,supplementPaths:['table.docx']}),pdf:await pdf(),files:[{path:'table.docx',bytes:native}],journalChecks});
  assert.equal(result.status,'pass');
  const image=await api.inspectSubmissionPreflight({profile:profile({anonymous:true}),pdf:await pdf(''),files:[],privateIdentityTokens:['Unlisted Person'],journalChecks});
  assert.equal(image.pdf.readableText,false);
  assert.equal(image.checks.find(check=>check.kind==='anonymity').status,'manual');
  assert.equal(image.checks.find(check=>check.kind==='declarations').status,'manual');
  const inspectedPdf=await pdf();
  const duplicate=await api.inspectSubmissionPreflight({profile:profile({anonymous:true}),pdf:inspectedPdf,
    files:[{path:'paper.pdf',bytes:inspectedPdf}],privateIdentityTokens:['Unlisted Person'],journalChecks});
  assert.equal(duplicate.checks.find(check=>check.kind==='anonymity').status,'pass');
  await assert.rejects(api.inspectSubmissionPreflight({profile:profile(),pdf:inspectedPdf,
    files:[{path:'paper.pdf',bytes:await pdf('Other contents')}],journalChecks}),/pdf_mismatch/u);
  const noTokens=await api.inspectSubmissionPreflight({profile:profile({anonymous:true}),pdf:await pdf(),files:[],journalChecks});
  assert.equal(noTokens.checks.find(check=>check.kind==='anonymity').status,'manual');
  const absent=await api.inspectSubmissionPreflight({profile:profile({minimumEditableTables:1}),pdf:await pdf(),files:[],journalChecks});
  assert.equal(absent.checks.find(check=>check.kind==='editable_tables').status,'fail');
});

test('missing journal checks stay unchecked; malformed payloads and cancellation never become successful compliance',async()=>{
  const input={profile:profile(),pdf:await pdf(),files:[]};
  assert.equal((await api.inspectSubmissionPreflight(input)).checks.find(check=>check.kind==='journal_rules').status,'manual');
  await assert.rejects(api.inspectSubmissionPreflight({...input,journalChecks:[]}),/journal_checks_incomplete/u);
  await assert.rejects(api.inspectSubmissionPreflight({...input,pdf:Buffer.from('not a pdf')}),/pdf_invalid/u);
  await assert.rejects(api.inspectSubmissionDocx(await docx('<!DOCTYPE x [<!ENTITY y "untrusted">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>')),/docx_invalid/u);
  const controller=new AbortController();controller.abort();
  await assert.rejects(api.inspectSubmissionPreflight({...input,signal:controller.signal}),{name:'AbortError'});
});
