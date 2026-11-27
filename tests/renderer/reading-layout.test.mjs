import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
let artifacts;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-reading-layout-'));
  artifacts=process.env.ROC_UI_CAPTURE_DIR??join(directory,'captures');
  await mkdir(artifacts,{recursive:true});
  await buildViteRenderer({directory, script: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {PaperReader} from './src/renderer/literature/PaperReader';
    import {WorkspaceScopeProvider} from './src/renderer/app/workspace-scope';
    import {TaskSummary} from './src/renderer/research/tasks/TaskSummary';
    let setReaderFocus;
    function ReaderHarness() {
      const [focus,setFocus]=React.useState(null);setReaderFocus=setFocus;
      return <PaperReader literature={store} onClearFocus={()=>{}} openInFilesView={()=>{}} focusParseId={focus?.parseId ?? null} focusLocator={focus?.locator ?? null} focusRequestId={focus?.requestId ?? 0}/>;
    }
    window.focusReader=()=>flushSync(()=>setReaderFocus(current=>({parseId:'parse',locator:'page:1',requestId:(current?.requestId??0)+1})));
    import {readingNoteSaveSchema} from './src/shared/schemas/research-reading';
    const root=createRoot(document.getElementById('root'));
    const notes=[];
    const acquisitionListeners=new Set();
    let acquisition={ok:true,data:{jobs:[],total:0,nextOffset:null}};
    window.updateAcquisition=value=>{acquisition=value;for(const listener of acquisitionListeners)listener();};
    const client={api:{research:{
      listAcquisition:async()=>acquisition,
      onLibraryChanged:listener=>{acquisitionListeners.add(listener);return()=>acquisitionListeners.delete(listener);},
      getModelsStatus:async()=>({ok:true,data:{ready:false,error:null,models:[],downloading:false,selectedPack:'compact'}}),
      getReadingTranslationSettings:async()=>({ok:true,data:{provider:'google',target:'zh-CN',keyConfigured:false,baseUrl:'',model:'',region:''}}),
      translateReading:async()=>({ok:true,data:{text:'Explicit synthetic translation. '.repeat(500)}}),
      listReadingNotes:async()=>({ok:true,data:notes}),
      saveReadingNote:async raw=>{const {expectedRevision,...input}=readingNoteSaveSchema.parse(raw);const note={...input,revision:expectedRevision+1,links:[],createdAt:'2026-11-10',updatedAt:'2026-11-10'};const index=notes.findIndex(n=>n.id===note.id);if(index<0)notes.push(note);else notes[index]=note;window.savedNote=note;return {ok:true,data:note};}
    }}};
    const selected={id:'paper',revision:1,archived:false,
      metadata:{title:'Synthetic multi agent research paper with a long title',authors:['Fixture Author'],publishedYear:2026,citationCount:null,doi:null,url:null,openAccessUrl:null},
      bibliography:{title:'Synthetic paper',citationKey:'fixture2026',fields:{}}};
    const fixtureDocument={id:'document',libraryItemId:'paper',filename:'synthetic.pdf',mediaType:'application/pdf',status:'ready',sourceHash:'source',currentParseId:'parse',activeParseId:null};
    window.setDocumentStatus=status=>{fixtureDocument.status=status;};
    const content={sourceHash:'source',pageCount:1,parseMode:'native-text',warnings:[],assets:[],blocks:[{id:'block',kind:'paragraph',label:'Synthetic page',text:'Explicit synthetic source. '.repeat(400),locator:'page:1',locations:[],imageAssetId:null}]};
    const loadDocumentContent=async()=>({ok:true,data:{run:{id:'parse',documentId:'document'},content}});
    const store={client,projectId:'fixture',selected,items:[selected],documents:[fixtureDocument],loadDocumentContent,
      derivedStatus:'ready',derivedError:null,reloadDerived(){},wikiSnapshot:{papers:[],sources:[{
        evidence:{id:'captured-evidence',sourceId:'paper',title:'Captured source',locator:'page:1',excerpt:'Explicit synthetic source.'},
        referenceStatus:'superseded',sourceLocator:{parseId:'historical-parse',rawLocator:'page:1'}
      },{evidence:{id:'unrelated-evidence',sourceId:'another-paper',title:'Other source',locator:'page:9',excerpt:'Not this paper.'},
        referenceStatus:'recorded',sourceLocator:null}]},
      exportItem:async()=>({filename:'fixture.bib',content:'@article{fixture2026}'}),
      writeToWorkspace:async input=>{window.writtenBibtex=input;return input.relativePath;},
      action:{pending:false,error:null},assistant:{pending:false,error:null},parseInFlight:null};
    const scope={client,projectId:'fixture',workspacePath:'/tmp/synthetic-reader',writable:true,workspaceStatus:'ready',workspaceError:null,
      openFileInCanvas:()=>{},openLiterature:target=>{window.openedEvidence=target;}};
    window.mountTranslation=(width=420,height=598,metadata=null)=>{
      selected.metadata.title=metadata?.title??'Synthetic multi agent research paper with a long title';
      selected.metadata.authors=metadata?.authors??['Fixture Author'];
      flushSync(()=>root.render(
      <div style={{height,width}}><WorkspaceScopeProvider value={scope}>
        <ReaderHarness/>
      </WorkspaceScopeProvider></div>));
    };
    window.mountTask=(statusReason=null)=>flushSync(()=>root.render(<div style={{width:320}}><TaskSummary data={{
      task:{goal:'A long scientific research task with a detailed instruction. '.repeat(12),status:statusReason?'failed':'active',statusReason},
      executions:[],usage:{tokens:{settled:0,unknown:0,reserved:0},calls:{models:{total:0},tools:{total:0},children:{total:0}}}
    }}/></div>));
  `, style:'html,body{margin:0}'});
  await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:600,height:812}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app=await _electron.launch({executablePath:electronPath,args:[join(directory,'main.cjs')]});
  page=await app.firstWindow();
  page.on('pageerror',error=>console.error('fixture pageerror:',error.message));
  page.on('console',message=>{if(message.type()==='error')console.error(message.text());});
  page.setDefaultTimeout(5000);
  await page.waitForFunction(()=>typeof window.mountTranslation==='function');
});

test('reader inspector retains notes, reuses citation actions and opens the captured evidence parse',async()=>{
  await page.setViewportSize({width:1200,height:800});
  await page.evaluate(()=>window.mountTranslation(1200,740));
  await page.getByTestId('reader-block-paragraph').waitFor();
  await page.getByTestId('reader-inspector-toggle').click();
  await expect(page.getByTestId('notes-panel')).toBeVisible();
  await page.getByTestId('notes-create').click();
  await page.getByLabel('笔记标题',{exact:true}).fill('Inspector retained note');
  const notes=page.getByRole('tab',{name:'笔记',exact:true});
  await notes.focus();await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab',{name:'引用',exact:true})).toBeFocused();
  await expect(page.getByTestId('reader-copy-bibtex')).toBeVisible();
  await page.getByTestId('reader-export-bibtex').click();
  await expect.poll(()=>page.evaluate(()=>window.writtenBibtex?.relativePath)).toBe('literature/fixture.bib');
  await page.getByRole('tab',{name:'证据',exact:true}).click();
  await expect(page.getByTestId('reader-evidence')).toContainText('来源已失效，保留历史摘录');
  await expect(page.getByTestId('reader-evidence')).not.toContainText('Not this paper.');
  await page.getByTestId('reader-evidence-open-captured-evidence').click();
  assert.deepEqual(await page.evaluate(()=>window.openedEvidence),{kind:'reader',libraryItemId:'paper',
    parseId:'historical-parse',locator:'page:1',text:'Explicit synthetic source.'});
  await notes.click();
  await expect(page.getByLabel('笔记标题',{exact:true})).toHaveValue('Inspector retained note');
  await page.getByTestId('notes-save').click();
  await expect(page.getByTestId('notes-panel').getByRole('status')).toHaveText('已保存');
  await page.getByTestId('reader-inspector-toggle').click();
});
after(async () => {try {await app?.close();} finally {if(directory)await rm(directory,{recursive:true,force:true});}});

test('translation output leaves a usable sibling reader and note region in a constrained column',async()=>{
  await page.evaluate(()=>window.mountTranslation());
  await page.getByTestId('reader-block-paragraph').getByRole('button',{name:'翻译',exact:true}).click();
  await page.getByRole('button',{name:'开始翻译',exact:true}).click();
  await page.getByRole('button',{name:'译文存为笔记',exact:true}).waitFor();
  await page.getByTestId('reader-inspector-toggle').click();
  await page.getByTestId('notes-create').waitFor();
  const body=await page.getByTestId('notes-panel').boundingBox();
  assert.ok(body.height>=100,`reader notes collapsed to ${body.height}px`);
  await page.getByTestId('notes-create').click();
  await page.getByLabel('笔记标题',{exact:true}).fill('Synthetic layout regression');
  await page.getByTestId('notes-save').click();
  assert.equal(await page.evaluate(()=>window.savedNote?.title),'Synthetic layout regression');
  await expect(page.getByTestId('notes-panel').getByRole('status')).toHaveText('已保存');
  await page.getByLabel('选择笔记',{exact:true}).selectOption({label:'Synthetic layout regression'});
  await page.getByLabel('笔记标题',{exact:true}).fill('Synthetic reopened note');
  await page.getByTestId('notes-save').click();
  await expect(page.getByTestId('notes-panel').getByRole('status')).toHaveText('已保存');
  assert.equal(await page.evaluate(()=>window.savedNote?.title),'Synthetic reopened note');
  assert.equal(await page.evaluate(()=>window.savedNote?.revision),2);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
});

test('long task goals wrap inside the task column without expanding grid tracks',async()=>{
  await page.evaluate(()=>window.mountTask());
  const title=page.getByText('A long scientific research task with a detailed instruction. '.repeat(12).trim(),{exact:true});
  assert.ok((await title.boundingBox()).width<=320);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
});

test('long paper metadata leaves at least three quarters of a short column for reading and tools stay keyboard accessible',async()=>{
  const title='Synthetic long title for a scientific paper about reproducible multi agent research and document understanding. '.repeat(3);
  const authors=Array.from({length:24},(_,index)=>`Fixture Author ${index+1}`);
  const rows=[];
  const auditSource=await readFile('scripts/ui-audit/clip-audit.js','utf8');
  for(const [width,theme] of [[420,'light'],[420,'dark'],[820,'light'],[1100,'dark']]){
    await page.setViewportSize({width,height:700});
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.evaluate(({width,theme,title,authors})=>{
      document.documentElement.dataset.theme=theme;
      window.mountTranslation(width,640,{title,authors});
    },{width,theme,title,authors});
    await page.getByTestId('reader-block-paragraph').waitFor();
    const area=page.getByTestId('reader-content-area');
    await expect.poll(async()=>{const box=await area.boundingBox();return box!==null&&box.height>0&&box.height<=640;}).toBe(true);
    const geometry=await area.boundingBox();
    assert.ok(geometry.height>=640*.75,`only ${geometry.height}px of 640px available at ${width}px`);
    await expect(page.getByTestId('reader-resource-status')).toHaveJSProperty('open',false);
    await expect(page.getByTestId('pipeline-stage-metadata')).toBeHidden();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.equal(await page.getByLabel('结构化阅读分类').isVisible(),false);
    const audit=await page.evaluate(source=>(0,eval)(source)({root:'#root',viewport:true}),auditSource);
    assert.equal(audit.cut,0);
    rows.push({width,theme,readerHeight:640,contentHeight:geometry.height,clipAudit:audit});
    await page.screenshot({path:join(artifacts,`parsed-${theme}-${width}.png`)});
    const tools=page.getByTestId('reader-reading-tools');
    await tools.focus();await page.keyboard.press('Enter');
    await expect(page.getByLabel('结构化阅读分类')).toBeVisible();
    await tools.focus();await page.keyboard.press('Enter');
    const info=page.getByTestId('reader-tools-disclosure');
    await info.focus();await page.keyboard.press('Enter');
    await expect(page.locator('.reading-disclosure-body').getByText(authors.join('，'),{exact:true})).toBeVisible();
    await info.focus();await page.keyboard.press('Enter');
    assert.equal(await area.isVisible(),true);
  }
  await writeFile(join(artifacts,'parsed-geometry.json'),JSON.stringify(rows,null,2));
});

test('provider reply loops have an actionable reason within the task column',async()=>{
  await page.evaluate(()=>window.mountTask('research_provider_reply_loop'));
  await expect(page.getByTestId('task-reason')).toContainText('模型服务检测到循环回复并终止生成');
  await expect(page.getByTestId('task-reason')).toContainText('更换模型后继续');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.evaluate(()=>window.mountTask('research_stage_inputs_stale'));
  await expect(page.getByTestId('task-reason')).toContainText('阶段输入已变化');
  await expect(page.getByTestId('task-reason-code')).toBeHidden();
  const identifier=page.getByTestId('task-reason').getByText('错误标识',{exact:true});
  await identifier.focus();await page.keyboard.press('Enter');
  await expect(page.getByTestId('task-reason-code')).toBeVisible();
  await expect(page.getByTestId('task-reason-code')).toHaveText('research_stage_inputs_stale');
});

test('reading hides routine pipeline receipts while acquisition failures and retry remain visible',async()=>{
  const checkFeedback=async controls=>{
    for(const control of controls){
      await expect.poll(()=>control.evaluate(element=>{
        const rect=element.getBoundingClientRect();
        const header=element.closest('.reading-paper-header').getBoundingClientRect();
        // Check the full bounds and sample inside the controls' rounded corners.
        const insetX=Math.min(6,rect.width/4),insetY=Math.min(6,rect.height/4);
        const points=[[.5,.5],[0,0],[1,0],[0,1],[1,1]].map(([x,y])=>{
          const hit=document.elementFromPoint(rect.x+insetX+(rect.width-2*insetX)*x,rect.y+insetY+(rect.height-2*insetY)*y);
          return {x,y,visible:hit===element||element.contains(hit),hit:hit?.tagName};
        });
        return {inside:rect.left>=header.left&&rect.right<=header.right&&rect.top>=header.top&&rect.bottom<=header.bottom,
          points,rect:{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom},
          header:{left:header.left,right:header.right,top:header.top,bottom:header.bottom}};
      })).toMatchObject({inside:true,points:Array.from({length:5},()=>({visible:true}))});
    }
  };
  await page.evaluate(()=>window.mountTranslation(420,640));
  await page.getByTestId('reader-block-paragraph').waitFor();
  const resource=page.getByTestId('reader-resource-status');
  await expect(resource).toHaveJSProperty('open',false);
  await expect(page.getByTestId('pipeline-stage-metadata')).toBeHidden();
  await page.evaluate(()=>window.updateAcquisition({ok:false,error:{message:'Synthetic receipt failure'}}));
  await expect(page.getByRole('alert')).toContainText('Synthetic receipt failure');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(resource).toHaveJSProperty('open',true);
  await expect(page.getByRole('button',{name:'重试',exact:true})).toBeVisible();
  await checkFeedback([page.getByRole('alert'),page.getByRole('button',{name:'重试',exact:true})]);
  await page.evaluate(()=>window.updateAcquisition({ok:true,data:{jobs:[{documentId:'document',status:'failed',stage:'parse',errorCode:'synthetic_parse_failed'}]}}));
  await expect(page.getByRole('alert')).toHaveText('synthetic_parse_failed');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('reader-pipeline-retry')).toBeVisible();
  const auditSource=await readFile('scripts/ui-audit/clip-audit.js','utf8');
  for(const [width,theme] of [[420,'light'],[420,'dark'],[820,'light'],[1100,'dark']]){
    await page.setViewportSize({width,height:700});
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.evaluate(({width,theme})=>{
      document.documentElement.dataset.theme=theme;window.mountTranslation(width,640);
    },{width,theme});
    await page.evaluate(()=>window.updateAcquisition({ok:true,data:{jobs:[],total:0,nextOffset:null}}));
    await expect(resource.locator('[role="alert"]')).toHaveCount(0);
    await page.evaluate(()=>window.updateAcquisition({ok:false,error:{message:'Synthetic receipt failure'}}));
    await expect(page.getByRole('alert')).toContainText('Synthetic receipt failure');
    const receiptRetry=page.getByRole('button',{name:'重试',exact:true});
    await checkFeedback([page.getByRole('alert'),receiptRetry]);
    await page.screenshot({path:join(artifacts,`receipt-failed-${theme}-${width}.png`)});
    await receiptRetry.focus();await expect(receiptRetry).toBeFocused();
    const receiptAudit=await page.evaluate(source=>(0,eval)(source)({root:'#root',viewport:true}),auditSource);
    assert.equal(receiptAudit.cut,0);
    await page.evaluate(()=>window.updateAcquisition({ok:true,data:{jobs:[{documentId:'document',status:'failed',stage:'parse',errorCode:'synthetic_parse_failed'}]}}));
    await expect(page.getByRole('alert')).toHaveText('synthetic_parse_failed');
    await expect(page.getByTestId('reader-pipeline-retry')).toBeVisible();
    await checkFeedback([page.getByRole('alert'),page.getByTestId('reader-pipeline-retry')]);
    await page.screenshot({path:join(artifacts,`pipeline-failed-${theme}-${width}.png`)});
    const retry=page.getByTestId('reader-pipeline-retry');
    await retry.hover();
    const hoverAudit=await page.evaluate(source=>(0,eval)(source)({root:'#root',viewport:true}),auditSource);
    assert.equal(hoverAudit.cut,0);
    await retry.focus();await expect(retry).toBeFocused();
    const audit=await page.evaluate(source=>(0,eval)(source)({root:'#root',viewport:true}),auditSource);
    assert.equal(audit.cut,0);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
  await page.evaluate(()=>window.updateAcquisition({ok:true,data:{jobs:[{documentId:'document',status:'ready',stage:'wiki',errorCode:null}]}}));
  await expect(resource.locator('[role="alert"]')).toHaveCount(0);
  const toggle=page.getByTestId('reader-pipeline-toggle');
  await toggle.focus();await page.keyboard.press('Enter');
  await expect(resource).toHaveJSProperty('open',false);
  await expect(page.getByTestId('pipeline-stage-metadata')).toBeHidden();
});


test('reader gives content most of the viewport and notes use the full narrow column',async()=>{
  for(const width of [420,820]) {
    await page.setViewportSize({width,height:800});
    await page.evaluate(width=>window.mountTranslation(width,740),width);
    await page.getByTestId('reader-block-paragraph').waitFor();
    assert.equal(await page.getByTestId('reader-tools-disclosure').evaluate(node=>node.parentElement.open),false);
    assert.equal(await page.getByTestId('reader-parse-disclosure').evaluate(node=>node.parentElement.open),false);
    const reading=await page.getByTestId('reader-content-area').boundingBox();
    assert.ok(reading.height>=400,`reader content height ${reading.height}px at ${width}px`);
    await page.getByTestId('reader-inspector-toggle').click();
    const notes=await page.getByTestId('notes-panel').boundingBox();
    assert.ok(notes.height>=400,`notes height ${notes.height}px at ${width}px`);
    assert.ok(notes.width>=(width<=800?width-4:300),`notes width ${notes.width}px at ${width}px`);
    await page.getByTestId('reader-inspector-toggle').click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
});

test('background parsing stays compact, with controls available on demand',async()=>{
  await page.setViewportSize({width:820,height:800});
  await page.evaluate(()=>{window.setDocumentStatus('parsing');window.mountTranslation(820,740);});
  try {
    await page.getByTestId('reader-block-paragraph').waitFor();
    const disclosure=page.getByTestId('reader-parse-disclosure');
    await expect(disclosure).toContainText('解析中');
    assert.equal(await disclosure.evaluate(element=>element.parentElement.open),false);
    const content=await page.getByTestId('reader-content-area').boundingBox();
    assert.ok(content.height>=500,`background status left ${content.height}px for reading`);
    await disclosure.click();
    await expect(page.getByTestId('reader-cancel-parse')).toBeVisible();
    await disclosure.click();
    assert.equal(await disclosure.evaluate(element=>element.parentElement.open),false);
  } finally {
    await page.evaluate(()=>window.setDocumentStatus('ready'));
  }
});

test('focus reading fills the viewport and Escape restores the workspace',async()=>{
  await page.setViewportSize({width:820,height:800});
  await page.evaluate(()=>window.mountTranslation(820,740));
  await page.getByTestId('reader-block-paragraph').waitFor();
  const reader=page.getByTestId('paper-reader');
  const focus=page.getByTestId('reader-focus-toggle');
  await focus.click();
  await expect(reader).toHaveAttribute('data-focus-mode','true');
  const geometry=await reader.evaluate(element=>({width:element.getBoundingClientRect().width,
    height:element.getBoundingClientRect().height,windowWidth:innerWidth,windowHeight:innerHeight}));
  assert.equal(geometry.width,geometry.windowWidth);
  assert.equal(geometry.height,geometry.windowHeight);
  await focus.focus();await page.keyboard.press('Escape');
  await expect(reader).toHaveAttribute('data-focus-mode','false');
});


test('incoming search focus reveals reading content without discarding the mounted note draft',async()=>{
  await page.setViewportSize({width:420,height:800});
  await page.evaluate(()=>window.mountTranslation(420,740));
  await page.getByTestId('reader-block-paragraph').waitFor();
  await page.getByTestId('reader-inspector-toggle').click();
  await page.getByTestId('notes-create').click();
  await page.getByLabel('笔记标题',{exact:true}).fill('Unfinished search note');
  await page.evaluate(()=>window.focusReader());
  await expect(page.getByTestId('reader-content-area')).toBeVisible();
  await expect(page.getByTestId('notes-panel')).toBeHidden();
  await page.getByTestId('reader-inspector-toggle').click();
  await expect(page.getByLabel('笔记标题',{exact:true})).toHaveValue('Unfinished search note');
  await page.evaluate(()=>window.focusReader());
  await expect(page.getByTestId('reader-content-area')).toBeVisible();
  await page.getByTestId('reader-inspector-toggle').click();
  await expect(page.getByLabel('笔记标题',{exact:true})).toHaveValue('Unfinished search note');
  await page.getByTestId('notes-save').click();
  await expect(page.getByTestId('notes-panel').getByRole('status')).toHaveText('已保存');
});
