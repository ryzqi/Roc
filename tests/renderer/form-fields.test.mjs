import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import tailwindcss from '@tailwindcss/vite';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
const errors=[];
const clipSource=await readFile('scripts/ui-audit/clip-audit.js','utf8');
before(async()=>{
  directory=await mkdtemp(join(tmpdir(),'roc-form-fields-'));
  await buildViteRenderer({directory,plugins:[tailwindcss()],script:`
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {TextField,NumberField,SelectField,CheckboxField} from './src/renderer/shared/form-ui';
    import {FormFieldsGallery} from ${JSON.stringify(join(process.cwd(),'tests/renderer/fixtures/form-fields-gallery.tsx'))};
    import './src/renderer/styles/index.css';
    const root=createRoot(document.getElementById('root'));
    window.commits=[];
    window.copyRequests=[];
    document.addEventListener('copy',event=>{
      const input=document.activeElement;
      window.copyRequests.push(input.value.slice(input.selectionStart,input.selectionEnd));
      event.preventDefault();
    });
    function Fields({state}) {
      const [text,setText]=useState('research-service');
      const [count,setCount]=useState(7);
      const [selection,setSelection]=useState('first');
      const [checked,setChecked]=useState(false);
      const issue=state.issue?'请修正当前字段。':undefined;
      return <main className="p-6">
        <button data-testid="fields-before">上一项</button>
        <fieldset disabled={state.fieldsetDisabled??false} className="flex flex-col gap-4">
          <TextField label="供应商标识" value={text} onChange={value=>{window.commits.push(value);setText(value);}}
            readOnly={state.readOnly??false} disabled={state.disabled??false} issue={issue}
            description="创建后可复制此标识。" testId="field-text"/>
          <NumberField label="最大 token" value={count} onChange={value=>{window.commits.push(value===undefined?'unset':value);setCount(value);}}
            readOnly={state.readOnly??false} disabled={state.disabled??false} issue={issue}
            allowEmpty={state.allowEmpty??false} emptyValue={state.emptyNull?null:undefined}
            description="留空使用默认值。" testId="field-number"/>
          <SelectField label="连接协议" value={selection} onChange={value=>{window.commits.push(value);setSelection(value);}}
            disabled={state.disabled??false} issue={issue} description="选择服务支持的协议。" testId="field-select"
            options={[{value:'first',label:'第一种协议'},{value:'second',label:'第二种协议'}]}/>
          <CheckboxField label="启用供应商" checked={checked} onChange={value=>{window.commits.push(value);setChecked(value);}}
            disabled={state.disabled??false} description="停用后保留配置。" testId="field-checkbox"/>
        </fieldset>
        <button data-testid="fields-after">下一项</button>
      </main>;
    }
    let generation=0;
    window.renderFixture=(mode='fields',state={},fresh=false)=>{
      if(fresh)generation++;
      flushSync(()=>root.render(mode==='gallery'?<FormFieldsGallery/>:<Fields key={generation} state={state}/>));
    };
    window.renderFixture();
  `,style:'body{overflow:auto}'});
  await writeFile(join(directory,'main.cjs'),`const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory,'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1440,height:900}).loadFile(${JSON.stringify(join(directory,'index.html'))}));`);
  app=await _electron.launch({executablePath:electronPath,args:[join(directory,'main.cjs')]});
  page=await app.firstWindow();
  page.setDefaultTimeout(5000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.getByTestId('field-text').waitFor();
});
after(async()=>{
  try {await app?.close();} finally {if(directory)await rm(directory,{recursive:true,force:true});}
  assert.deepEqual(errors,[]);
});

test('fields keep names separate from descriptions and connect current errors',async()=>{
  await page.evaluate(()=>window.renderFixture('fields',{issue:true},true));
  const fields=[['text','供应商标识','创建后可复制此标识。'],['number','最大 token','留空使用默认值。'],['select','连接协议','选择服务支持的协议。']];
  const ids=[];
  for(const [kind,label,description] of fields) {
    const field=page.getByTestId('field-'+kind);
    await expect(field).toHaveAccessibleName(label);
    await expect(field).toHaveAccessibleDescription(description+' 请修正当前字段。');
    await expect(field).toHaveAttribute('aria-invalid','true');
    const references=await field.evaluate(element=>element.getAttribute('aria-describedby').split(' ').map(id=>({id,text:document.getElementById(id)?.textContent})));
    assert.equal(references.length,2);
    assert.ok(references.every(reference=>reference.text));
    ids.push(...references.map(reference=>reference.id));
  }
  assert.equal(new Set(ids).size,ids.length);
  await expect(page.getByTestId('field-checkbox')).toHaveAccessibleName('启用供应商');
  await expect(page.getByTestId('field-checkbox')).toHaveAccessibleDescription('停用后保留配置。');
  await page.getByTestId('field-select').selectOption('second');
  await expect(page.getByTestId('field-select')).toHaveValue('second');
  await page.evaluate(()=>window.renderFixture('fields'));
  for(const [kind,,description] of fields) {
    const field=page.getByTestId('field-'+kind);
    await expect(field).not.toHaveAttribute('aria-invalid','true');
    await expect(field).toHaveAccessibleDescription(description);
  }
  assert.equal(await page.getByRole('alert').count(),0);
});

test('readonly fields remain keyboard selectable while disabled fields and fieldsets cannot write',async()=>{
  await page.evaluate(()=>{window.commits=[];window.copyRequests=[];window.renderFixture('fields',{readOnly:true},true);});
  const text=page.getByTestId('field-text');
  const number=page.getByTestId('field-number');
  await expect(text).toHaveAttribute('readonly','');
  await expect(number).toHaveAttribute('readonly','');
  await expect(text).toHaveAccessibleName('供应商标识');
  await expect(page.getByTestId('field-text-field').getByText('只读',{exact:true})).toBeVisible();
  await page.getByTestId('fields-before').focus();
  await page.keyboard.press('Tab');
  await expect(text).toBeFocused();
  await page.keyboard.press('Meta+A');
  await page.keyboard.press('Meta+C');
  assert.deepEqual(await page.evaluate(()=>window.copyRequests),['research-service']);
  await page.keyboard.insertText('changed');
  await expect(text).toHaveValue('research-service');
  await page.keyboard.press('Tab');
  await expect(number).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await page.getByTestId('fields-after').focus();
  assert.deepEqual(await page.evaluate(()=>window.commits),[]);
  for(const state of [{disabled:true},{fieldsetDisabled:true}]) {
    await page.evaluate(state=>{window.commits=[];window.renderFixture('fields',state,true);},state);
    for(const kind of ['text','number','select','checkbox'])await expect(page.getByTestId('field-'+kind)).toBeDisabled();
    await page.getByTestId('fields-before').focus();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('fields-after')).toBeFocused();
    await page.getByTestId('field-checkbox-field').click({force:true});
    assert.deepEqual(await page.evaluate(()=>window.commits),[]);
  }
  await page.evaluate(()=>{window.commits=[];window.renderFixture('fields',{},true);});
  await number.fill('99');
  await page.evaluate(()=>window.renderFixture('fields',{fieldsetDisabled:true}));
  await page.getByTestId('fields-after').focus();
  assert.deepEqual(await page.evaluate(()=>window.commits),[],'a pending fieldset cannot commit a local number draft on blur');
});

test('number drafts preserve empty semantics and ignore IME confirmation Enter',async()=>{
  const number=page.getByTestId('field-number');
  const blur=()=>page.getByTestId('fields-after').focus();
  for(const [state,expected] of [[{},[]],[{allowEmpty:true},['unset']],[{allowEmpty:true,emptyNull:true},[null]]]) {
    await page.evaluate(state=>{window.commits=[];window.renderFixture('fields',state,true);},state);
    await number.fill('');await blur();
    assert.deepEqual(await page.evaluate(()=>window.commits),expected);
    await expect(number).toHaveValue(state.allowEmpty?'':'7');
  }
  await page.evaluate(()=>{window.commits=[];window.renderFixture('fields',{},true);});
  await number.fill('0');await blur();
  assert.deepEqual(await page.evaluate(()=>window.commits),[0]);
  await number.fill('12');await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(()=>window.commits),[0,12]);
  await number.fill('13');
  await number.evaluate(element=>{
    element.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    element.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));
    element.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:229,bubbles:true,cancelable:true}));
    element.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));
    element.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  });
  assert.deepEqual(await page.evaluate(()=>window.commits),[0,12]);
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(()=>window.commits),[0,12,13]);
});

test('field gallery preserves layout and native focus in both themes and densities',async()=>{
  await page.evaluate(()=>window.renderFixture('gallery'));
  for(const theme of ['light','dark'])for(const density of ['compact','comfortable']) {
    await page.evaluate(({theme,density})=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.density=density;},{theme,density});
    for(const width of [1184,1280,1440]) {
      await page.setViewportSize({width,height:900});
      const field=page.getByTestId('gallery-text');
      await field.focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
      await expect(field).toBeFocused();
      assert.equal(await field.evaluate(element=>element.matches(':focus-visible')),true);
      assert.equal(await field.evaluate(element=>getComputedStyle(element).outlineWidth),'2px');
      assert.equal(await page.getByTestId('fields-gallery').evaluate(element=>element.scrollWidth>element.clientWidth),false);
      const controls=await page.locator('input:not([type="checkbox"]),select').evaluateAll(elements=>elements.map(element=>({height:element.getBoundingClientRect().height,fontSize:parseFloat(getComputedStyle(element).fontSize)})));
      assert.ok(controls.every(control=>control.height===(density==='compact'?32:36)&&control.fontSize>=12));
      const audit=await page.evaluate(source=>(0,eval)(source)({viewport:true}),clipSource);
      assert.equal(audit.cut,0,JSON.stringify({theme,density,width,issues:audit.issues}));
      if(process.env.ROC_UI_AUDIT_DIR) {
        await mkdir(process.env.ROC_UI_AUDIT_DIR,{recursive:true});
        await page.screenshot({path:join(process.env.ROC_UI_AUDIT_DIR,`form-fields-${theme}-${density}-${width}.png`)});
      }
    }
    await page.getByTestId('fields-gallery').evaluate(element=>{element.style.width='320px';element.querySelector('[data-testid="fields-gallery-grid"]').style.gridTemplateColumns='minmax(0,1fr)';});
    assert.equal(await page.getByTestId('fields-gallery').evaluate(element=>element.scrollWidth>element.clientWidth),false);
    await page.getByTestId('gallery-checkbox-field').click();
    const checked=await page.getByTestId('gallery-checkbox').isChecked();
    await page.getByTestId('gallery-checkbox-field').click();
    assert.notEqual(await page.getByTestId('gallery-checkbox').isChecked(),checked);
    assert.equal((await page.evaluate(source=>(0,eval)(source)({viewport:true}),clipSource)).cut,0);
    await page.getByTestId('fields-gallery').evaluate(element=>{element.style.width='';element.querySelector('[data-testid="fields-gallery-grid"]').style.gridTemplateColumns='';});
  }
});
