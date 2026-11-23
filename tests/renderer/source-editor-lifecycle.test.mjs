import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
const errors = [];
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-source-lifecycle-'));
  await buildViteRenderer({directory, style: 'html,body,#root{height:100%;margin:0}', script: `
    import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {EditorView} from '@codemirror/view';
    import {SourceEditor} from './src/renderer/latex/SourceEditor';
    import {ViewActivity} from './src/renderer/shared/view-activity';
    const original=Array.from({length:300},(_,i)=>'Line '+(i+1)+' retained text').join('\\n');
    window.editor=()=>EditorView.findFromDOM(document.querySelector('.cm-content'));
    function Harness(){
      const [active,setActive]=useState(true),[value,setValue]=useState(original),[readOnly,setReadOnly]=useState(false);
      const [replacement,setReplacement]=useState(null);
      window.setActive=setActive;window.setValue=setValue;window.setReadOnly=setReadOnly;window.value=value;window.setReplacement=setReplacement;
      return <ViewActivity active={active}><div style={{display:active?'flex':'none',height:360}}>
        <SourceEditor value={value} readOnly={readOnly} onChange={setValue} replacement={replacement}
          onSelectionChange={selection=>window.selection=selection}/>
      </div></ViewActivity>;
    }
    createRoot(document.getElementById('root')).render(<Harness/>);
  `});
  await writeFile(join(directory,'main.cjs'),`const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory,'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:900,height:600}).loadFile(${JSON.stringify(join(directory,'index.html'))}));`);
  app=await _electron.launch({executablePath:electronPath,args:[join(directory,'main.cjs')]});
  page=await app.firstWindow();page.setDefaultTimeout(6000);page.on('pageerror',error=>errors.push(error.message));
});

test('hidden CodeMirror releases DOM and restores draft, undo, exact selection and reading position', async () => {
  await page.getByTestId('production-latex-content').waitFor();
  await page.evaluate(()=>{
    const editor=window.editor();
    editor.dispatch({changes:{from:0,to:4,insert:'Edited'},selection:{anchor:100,head:110}});
    editor.scrollDOM.scrollTop=1400;
  });
  await expect.poll(()=>page.locator('.cm-scroller').evaluate(node=>node.scrollTop)).toBeGreaterThan(1000);
  const before=await page.evaluate(()=>({text:window.value,selection:window.editor().state.selection.toJSON(),scroll:window.editor().scrollDOM.scrollTop}));
  await page.evaluate(()=>window.setActive(false));
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  assert.equal(await page.evaluate(()=>window.value),before.text);
  await page.evaluate(()=>window.setActive(true));
  await page.getByTestId('production-latex-content').waitFor();
  assert.deepEqual(await page.evaluate(()=>window.editor().state.selection.toJSON()),before.selection);
  await expect.poll(()=>page.locator('.cm-scroller').evaluate(node=>node.scrollTop)).toBe(before.scroll);
  assert.equal(await page.evaluate(()=>window.editor().state.doc.toString()),before.text);
  await page.getByTestId('production-latex-content').focus();
  await page.keyboard.press('Meta+z');
  await expect.poll(()=>page.evaluate(()=>window.value.startsWith('Line 1'))).toBe(true);
});

test('updates and readonly changes while hidden reach the restored editor without recreating hidden DOM', async () => {
  await page.evaluate(()=>window.setActive(false));
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await page.evaluate(()=>{window.setValue('External document');window.setReadOnly(true);});
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await page.evaluate(()=>window.setActive(true));
  await expect(page.getByTestId('production-latex-content')).toHaveText('External document');
  assert.equal(await page.evaluate(()=>window.editor().state.readOnly),true);
  await page.getByTestId('production-latex-content').focus();
  await page.keyboard.press('End');await page.keyboard.type('blocked');
  assert.equal(await page.evaluate(()=>window.value),'External document');
});

test('composition keeps its editor until composition ends even when the containing view changes', async () => {
  await page.evaluate(()=>window.setReadOnly(false));
  const editor=page.getByTestId('production-latex-content');
  await editor.dispatchEvent('compositionstart',{data:''});
  await page.evaluate(()=>window.setActive(false));
  await expect(page.locator('.cm-editor')).toHaveCount(1);
  await editor.evaluate(node=>{
    const line=node.querySelector('.cm-line');
    line.textContent='External document文';
    const range=document.createRange();range.selectNodeContents(line);range.collapse(false);
    const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
    node.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'文',isComposing:true}));
    node.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'文'}));
  });
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await page.evaluate(()=>window.setActive(true));
  await expect(editor).toHaveText('External document文');
});

test('a rejected replacement cannot revive after permission and visibility changes',async()=>{
  await page.evaluate(()=>{
    window.editor().dispatch({selection:{anchor:0,head:8}});
    window.setReadOnly(true);
    window.setReplacement({from:0,to:8,text:'Rejected',expectedDocument:window.value,nonce:1});
  });
  await expect.poll(()=>page.evaluate(()=>window.editor().state.readOnly)).toBe(true);
  await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  await page.evaluate(()=>window.setActive(false));await expect(page.locator('.cm-editor')).toHaveCount(0);
  await page.evaluate(()=>{window.setReadOnly(false);window.setActive(true);});
  await expect(page.getByTestId('production-latex-content')).toHaveText('External document文');
});

after(async()=>{try{await app?.close();}finally{if(directory)await rm(directory,{recursive:true,force:true});}assert.deepEqual(errors,[]);});
