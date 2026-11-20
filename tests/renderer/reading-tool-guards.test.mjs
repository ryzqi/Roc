import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
const pageErrors = [];
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-reading-tool-guards-'));
  await buildViteRenderer({directory, script: `
    import React, {useRef, useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import PdfReadingTools from './src/renderer/literature/PdfReadingTools';
    import ReadingTranslationPanel from './src/renderer/literature/ReadingTranslationPanel';
    import {readingHighlightSaveSchema, translationSettingsSaveSchema} from './src/shared/schemas/research-reading';
    const root = createRoot(document.getElementById('root'));
    let session = 0;
    const storedSettings = {provider:'openai',target:'zh-CN',keyConfigured:true,
      baseUrl:'https://example.invalid/v1',model:'synthetic-model',region:''};
    const client = {api:{research:{
      listReadingHighlights: () => Promise.resolve({ok:true,data:[]}),
      saveReadingHighlight: raw => {
        const {expectedRevision,...record} = readingHighlightSaveSchema.parse(raw);
        window.highlightCalls++;
        return new Promise(resolve => {window.resolveHighlight = () =>
          resolve({ok:true,data:{...record,revision:expectedRevision+1,createdAt:'2026-11-12'}});});
      },
      getReadingTranslationSettings: () => {
        if(window.loadMode==='throw') throw new Error('Synthetic settings load failure');
        return Promise.resolve({ok:true,data:storedSettings});
      },
      saveReadingTranslationSettings: raw => {
        translationSettingsSaveSchema.parse(raw);
        window.settingsCalls++;
        if(window.saveMode==='throw') throw new Error('Synthetic settings save failure');
        return new Promise(resolve => {window.resolveSettings = () => resolve({ok:true,data:{...raw,keyConfigured:true}});});
      },
      translateReading: raw => {
        window.translationCalls++;
        return new Promise(resolve => {window.resolveTranslation = () =>
          resolve({ok:true,data:{text:'Synthetic translated '+raw.text,provider:'openai',target:raw.target}});});
      }
    }}};
    const pdf = {numPages:1,getOutline:()=>Promise.resolve(null),
      getPage:()=>Promise.resolve({getTextContent:()=>Promise.resolve({items:[{str:'Synthetic PDF',hasEOL:false}]})})};
    function Highlights() {
      const [rows,setRows] = useState([]);
      return <PdfReadingTools client={client} projectId="fixture" documentId="document" sourceHash={'a'.repeat(64)}
        pdf={pdf} page={1} navigate={()=>{}} selection={{text:'Selected source',rects:[[0.1,0.1,0.3,0.05]]}}
        writable={true} highlights={rows} onHighlights={setRows} onQuery={()=>{}} onNote={()=>{}} onTranslate={()=>{}}/>;
    }
    function Translation() {
      const guard = useRef(null),[source,setSource] = useState('First source');
      return <>
        <button type="button" onClick={() => {
          const replace = () => setSource('Second source');
          if(guard.current) guard.current.request(replace); else replace();
        }}>Replace translation source</button>
        <ReadingTranslationPanel key={source} transitionGuardRef={guard} client={client} projectId="fixture"
          segments={[{label:'first',text:'First segment'},{label:'second',text:'Second segment'}]}
          label={source} onNote={()=>{}} onClose={()=>{window.closeCalls++;}}/>
      </>;
    }
    window.mountTools = (kind,loadMode='ready') => {
      window.highlightCalls = window.settingsCalls = window.translationCalls = window.closeCalls = 0;
      window.loadMode = loadMode;window.saveMode = 'pending';
      flushSync(() => root.render(<div key={++session} style={{height:620,width:600}}>
        {kind==='pdf'?<Highlights/>:<Translation/>}
      </div>));
    };
  `, style:'html,body{margin:0}'});
  await writeFile(join(directory,'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory,'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:720,height:780}).loadFile(${JSON.stringify(join(directory,'index.html'))}));`);
  app = await _electron.launch({executablePath:electronPath,args:[join(directory,'main.cjs')]});
  page = await app.firstWindow();
  page.on('pageerror',error=>pageErrors.push(error.message));
  page.setDefaultTimeout(5000);
  await page.waitForFunction(()=>typeof window.mountTools==='function');
});
after(async () => {try {await app?.close();} finally {if(directory)await rm(directory,{recursive:true,force:true});}});

async function mount(kind,loadMode='ready') {
  pageErrors.length = 0;
  await page.evaluate(({kind,loadMode})=>window.mountTools(kind,loadMode),{kind,loadMode});
  if(kind==='translation'&&loadMode==='ready') {
    await expect(page.getByRole('status')).toContainText('OpenAI');
  }
}

test('highlight writes are single flight and freeze the submitted note and color',async()=>{
  await mount('pdf');
  await page.getByLabel('高亮备注',{exact:true}).fill('Submitted remark');
  await page.evaluate(()=>{
    const button=[...document.querySelectorAll('button')].find(button=>button.textContent==='保存高亮');
    button.click();button.click();
  });
  assert.equal(await page.evaluate(()=>window.highlightCalls),1);
  await expect(page.getByLabel('高亮备注',{exact:true})).toBeDisabled();
  await expect(page.getByLabel('高亮颜色',{exact:true})).toBeDisabled();
  await page.evaluate(()=>window.resolveHighlight());
  await expect(page.getByLabel('高亮备注',{exact:true})).toHaveValue('');
  await page.getByRole('button',{name:'高亮 1',exact:true}).click();
  await expect(page.getByLabel('第 1 页高亮备注',{exact:true})).toHaveValue('Submitted remark');
  assert.deepEqual(pageErrors,[]);
});

test('translation settings writes cannot be stopped, reentered or closed while pending',async()=>{
  await mount('translation');
  await page.getByRole('button',{name:'翻译设置',exact:true}).click();
  await page.getByLabel('翻译 API Key',{exact:true}).fill('synthetic-test-key');
  await page.evaluate(()=>{
    const button=[...document.querySelectorAll('button')].find(button=>button.textContent==='保存翻译设置');
    button.click();button.click();
  });
  assert.equal(await page.evaluate(()=>window.settingsCalls),1);
  await expect(page.getByRole('button',{name:'停止后续翻译',exact:true})).toHaveCount(0);
  await expect(page.getByLabel('翻译 API Key',{exact:true})).toBeDisabled();
  await expect(page.getByLabel('翻译渠道',{exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Replace translation source',exact:true}).click();
  await expect(page.getByTestId('reader-translation')).toContainText('First source');
  assert.equal(await page.evaluate(()=>window.closeCalls),0);
  await expect(page.getByRole('status')).toContainText('保存翻译设置');
  await page.evaluate(()=>window.resolveSettings());
  await expect(page.getByLabel('翻译 API Key',{exact:true})).toHaveCount(0);
  assert.deepEqual(pageErrors,[]);
});

test('translation setting drafts survive cancelled close, channel and source replacement',async()=>{
  await mount('translation');
  await page.getByRole('button',{name:'翻译设置',exact:true}).click();
  await page.getByLabel('翻译 API Key',{exact:true}).fill('synthetic-unsaved-key');
  const confirmation=page.getByTestId('translation-discard-dialog');
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button',{name:'取消',exact:true}).click();
  await expect(confirmation).toHaveCount(0);
  assert.equal(await page.evaluate(()=>window.closeCalls),0);
  await page.getByLabel('翻译渠道',{exact:true}).selectOption('deepl');
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button',{name:'取消',exact:true}).click();
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByLabel('翻译渠道',{exact:true})).toHaveValue('openai');
  await expect(page.getByLabel('翻译 API Key',{exact:true})).toHaveValue('synthetic-unsaved-key');
  await page.getByRole('button',{name:'Replace translation source',exact:true}).click();
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button',{name:'取消',exact:true}).click();
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByTestId('reader-translation')).toContainText('First source');
  assert.deepEqual(pageErrors,[]);
});

test('stopping translation waits for the current segment and prevents the next request',async()=>{
  await mount('translation');
  await page.evaluate(()=>{
    const button=[...document.querySelectorAll('button')].find(button=>button.textContent==='开始翻译');
    button.click();button.click();
  });
  assert.equal(await page.evaluate(()=>window.translationCalls),1);
  await page.getByRole('button',{name:'停止后续翻译',exact:true}).click();
  await expect(page.getByRole('button',{name:'开始翻译',exact:true})).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('当前段');
  await page.evaluate(()=>window.resolveTranslation());
  await expect(page.getByRole('button',{name:'开始翻译',exact:true})).toBeEnabled();
  assert.equal(await page.evaluate(()=>window.translationCalls),1);
  await expect(page.getByTestId('reader-translation')).toContainText('Synthetic translated First segment');
  await expect(page.getByRole('status')).toContainText('已停止');
  assert.deepEqual(pageErrors,[]);
});

test('translation settings load catches a synchronous bridge failure and offers retry',async()=>{
  await mount('translation','throw');
  await expect(page.getByRole('alert')).toContainText('Synthetic settings load failure');
  await page.evaluate(()=>{window.loadMode='ready';});
  await page.getByRole('button',{name:'重试',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('OpenAI');
  await expect(page.getByRole('button',{name:'开始翻译',exact:true})).toBeEnabled();
  assert.deepEqual(pageErrors,[]);
});
