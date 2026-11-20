import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-reading-layout-'));
  await buildViteRenderer({directory, script: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {PaperReader} from './src/renderer/literature/PaperReader';
    import {WorkspaceScopeProvider} from './src/renderer/app/workspace-scope';
    import {TaskSummary} from './src/renderer/research/tasks/TaskSummary';
    import {readingNoteSaveSchema} from './src/shared/schemas/research-reading';
    const root=createRoot(document.getElementById('root'));
    const notes=[];
    const client={api:{research:{
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
    const content={sourceHash:'source',pageCount:1,parseMode:'native-text',warnings:[],assets:[],blocks:[{id:'block',kind:'paragraph',label:'Synthetic page',text:'Explicit synthetic source. '.repeat(400),locator:'page:1',locations:[],imageAssetId:null}]};
    const loadDocumentContent=async()=>({ok:true,data:{run:{id:'parse',documentId:'document'},content}});
    const store={client,projectId:'fixture',selected,items:[selected],documents:[fixtureDocument],loadDocumentContent,
      action:{pending:false,error:null},assistant:{pending:false,error:null},parseInFlight:null};
    const scope={client,projectId:'fixture',workspacePath:'/tmp/synthetic-reader',writable:true,workspaceStatus:'ready',workspaceError:null,openFileInCanvas:()=>{}};
    window.mountTranslation=()=>flushSync(()=>root.render(
      <div style={{height:598,width:420}}><WorkspaceScopeProvider value={scope}>
        <PaperReader literature={store} onClearFocus={()=>{}} openInFilesView={()=>{}}/>
      </WorkspaceScopeProvider></div>));
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
after(async () => {try {await app?.close();} finally {if(directory)await rm(directory,{recursive:true,force:true});}});

test('translation output leaves a usable sibling reader and note region in a constrained column',async()=>{
  await page.evaluate(()=>window.mountTranslation());
  await page.getByTestId('reader-block-paragraph').getByRole('button',{name:'翻译',exact:true}).click();
  await page.getByRole('button',{name:'开始翻译',exact:true}).click();
  await page.getByRole('button',{name:'译文存为笔记',exact:true}).waitFor();
  await page.getByRole('button',{name:'论文笔记',exact:true}).click();
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

test('long task goals truncate inside the task column without expanding grid tracks',async()=>{
  await page.evaluate(()=>window.mountTask());
  const title=page.locator('p[title]');
  assert.ok((await title.boundingBox()).width<=320);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
});

test('provider reply loops have an actionable reason within the task column',async()=>{
  await page.evaluate(()=>window.mountTask('research_provider_reply_loop'));
  await expect(page.getByTestId('task-reason')).toContainText('模型服务检测到循环回复并终止生成');
  await expect(page.getByTestId('task-reason')).toContainText('更换模型后继续');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.evaluate(()=>window.mountTask('research_stage_inputs_stale'));
  await expect(page.getByTestId('task-reason')).toContainText('research_stage_inputs_stale');
});
