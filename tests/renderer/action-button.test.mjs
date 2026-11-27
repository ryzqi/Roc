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
const errors = [];
const clipSource = await readFile('scripts/ui-audit/clip-audit.js','utf8');
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-action-button-'));
  await buildViteRenderer({directory, plugins: [tailwindcss()], script: `
    import React,{createRef} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {ActionButton} from './src/renderer/shared/form-ui';
    import {StickySaveBar} from './src/renderer/settings/StickySaveBar';
    import {ActionButtonGallery} from ${JSON.stringify(join(process.cwd(), 'tests/renderer/fixtures/action-button-gallery.tsx'))};
    import './src/renderer/styles/index.css';
    const root=createRoot(document.getElementById('root'));
    const buttonRef=createRef();
    window.focusAction=()=>buttonRef.current.focus();
    window.actions=[];
    window.submissions=[];
    window.renderFixture=(mode='gallery',state={})=>flushSync(()=>root.render(mode==='gallery'?<ActionButtonGallery/>:
      mode==='savebar'?<main className="p-6"><StickySaveBar dirtyCount={state.dirtyCount??2} savedAt={state.savedAt??null}
        highImpactCount={0} busy={state.busy??false} saving={state.saving??false} transientDirty={state.transientDirty??false}
        onDiscard={()=>window.actions.push('discard')} onSave={()=>window.actions.push('save')}/></main>:
      <main className="p-6">
        <form id="settings-fixture" onSubmit={event=>{
          event.preventDefault();
          window.submissions.push(Object.fromEntries(new FormData(event.currentTarget,event.nativeEvent.submitter)));
        }}>
          <label>接入地址<input name="endpoint" defaultValue="https://models.example/v1"/></label>
          <ActionButton data-testid="action-default-type" onClick={()=>window.actions.push('default')}>测试连通</ActionButton>
          <fieldset disabled><ActionButton data-testid="action-fieldset" onClick={()=>window.actions.push('fieldset')}>保存密钥</ActionButton></fieldset>
        </form>
        <ActionButton ref={buttonRef} type="submit" form="settings-fixture" name="operation" value="save"
          data-testid="action-submit" loading={state.loading??false} disabled={state.disabled??false}
          loadingLabel={state.loadingLabel} aria-describedby="action-description" className="max-w-full">
          保存设置
        </ActionButton>
        <p id="action-description">保存当前供应商配置</p>
        <button data-testid="action-next">下一项设置</button>
      </main>));
    window.renderFixture();
  `, style:'body{overflow:auto}'});
  await writeFile(join(directory,'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory,'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1440,height:900}).loadFile(${JSON.stringify(join(directory,'index.html'))}));`);
  app=await _electron.launch({executablePath:electronPath,args:[join(directory,'main.cjs')]});
  page=await app.firstWindow();
  page.setDefaultTimeout(5000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.getByTestId('action-gallery').waitFor();
});
after(async()=>{
  try {await app?.close();} finally {if(directory)await rm(directory,{recursive:true,force:true});}
  assert.deepEqual(errors,[]);
});

const variants=['primary','secondary','compact'];
const visual=locator=>locator.evaluate(element=>{
  const css=getComputedStyle(element);
  return {background:css.backgroundColor,color:css.color,opacity:css.opacity,translate:css.translate,scale:css.scale,
    outlineStyle:css.outlineStyle,outlineWidth:css.outlineWidth,outlineColor:css.outlineColor,
    height:element.getBoundingClientRect().height};
});

test('gallery exposes all six native button states in both themes and densities',async()=>{
  await page.emulateMedia({reducedMotion:'no-preference'});
  for(const theme of ['light','dark']) for(const density of ['compact','comfortable']) {
    await page.evaluate(({theme,density})=>{
      document.documentElement.dataset.theme=theme;
      document.documentElement.dataset.density=density;
      window.renderFixture();
    },{theme,density});
    for(const variant of variants) {
      const button=page.getByTestId(`action-${variant}-hover`);
      await page.mouse.move(0,0);
      const normal=await visual(button);
      assert.equal(normal.height,variant==='compact'?(density==='compact'?28:32):(density==='compact'?32:36));
      await button.hover();
      await expect.poll(async()=>(await visual(button)).background).not.toBe(normal.background);
      const pressed=page.getByTestId(`action-${variant}-active`);
      await pressed.hover();
      await page.mouse.down();
      try {await expect.poll(async()=>(await visual(pressed)).scale).toBe('0.97');}
      finally {await page.mouse.up();}
      await expect.poll(async()=>(await visual(pressed)).scale).toBe('none');
      const disabled=page.getByTestId(`action-${variant}-disabled`);
      await expect(disabled).toBeDisabled();
      await page.mouse.move(0,0);
      const before=await visual(disabled);
      await disabled.hover({force:true});
      assert.deepEqual(await visual(disabled),before,'disabled controls do not advertise a hover action');
      const loading=page.getByTestId(`action-${variant}-loading`);
      await expect(loading).toBeDisabled();
      await expect(loading).toHaveAttribute('aria-busy','true');
      await expect(loading.locator('svg[aria-hidden="true"]')).toBeVisible();
      const focus=page.getByTestId(`action-${variant}-focus`);
      await focus.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(focus).toBeFocused();
      assert.equal(await focus.evaluate(element=>element.matches(':focus-visible')),true);
      const focused=await visual(focus);
      assert.equal(focused.outlineStyle,'solid');
      assert.equal(focused.outlineWidth,'2px');
      assert.notEqual(focused.outlineColor,'rgba(0, 0, 0, 0)');
    }
    for(const width of [1184,1280,1440]) {
      await page.setViewportSize({width,height:900});
      const layout=await page.getByTestId('action-gallery').evaluate(element=>({
        overflowing:element.scrollWidth>element.clientWidth,
        textSizes:[...element.querySelectorAll('*')].filter(node=>
          [...node.childNodes].some(child=>child.nodeType===Node.TEXT_NODE && child.textContent.trim()))
          .map(node=>Number.parseFloat(getComputedStyle(node).fontSize)),
        controls:[...element.querySelectorAll('button,input,select,textarea')].map(node=>{
          const bounds=node.getBoundingClientRect();
          return {label:node.textContent||node.getAttribute('aria-label')||node.getAttribute('data-testid'),width:bounds.width,height:bounds.height};
        })
      }));
      assert.equal(layout.overflowing,false);
      assert.ok(layout.textSizes.every(size=>size>=12),JSON.stringify({theme,density,width,textSizes:layout.textSizes}));
      assert.ok(layout.controls.every(control=>control.width>=28 && control.height>=28),JSON.stringify({theme,density,width,controls:layout.controls}));
      const clip=await page.evaluate(source=>(0,eval)(source)({viewport:true}),clipSource);
      assert.equal(clip.cut,0,JSON.stringify({theme,density,width,issues:clip.issues}));
      if(process.env.ROC_UI_AUDIT_DIR) {
        await mkdir(process.env.ROC_UI_AUDIT_DIR,{recursive:true});
        await page.screenshot({path:join(process.env.ROC_UI_AUDIT_DIR,`action-buttons-${theme}-${density}-${width}.png`)});
      }
    }
  }
});

test('reduced motion preserves press feedback and a static loading indicator',async()=>{
  await page.evaluate(()=>window.renderFixture());
  await page.emulateMedia({reducedMotion:'reduce'});
  for(const variant of variants) {
    const button=page.getByTestId(`action-${variant}-active`);
    await button.hover();
    const before=await visual(button);
    await page.mouse.down();
    try {
      assert.equal(await button.evaluate(element=>element.matches(':active')),true);
      // Reduced motion keeps color/opacity feedback while spatial press motion
      // stays at rest, including during the pointer's active state.
      await expect.poll(async()=>{
        const pressed=await visual(button);
        assert.equal(pressed.translate,'none');
        assert.equal(pressed.scale,'1');
        return pressed.background!==before.background || pressed.opacity!==before.opacity;
      }).toBe(true);
    } finally {await page.mouse.up();}
    assert.equal(await page.getByTestId(`action-${variant}-loading`).locator('svg').evaluate(element=>getComputedStyle(element).animationName),'none');
  }
});

test('native submit, external form association, refs and controlled loading remain intact',async()=>{
  await page.evaluate(()=>{window.actions=[];window.submissions=[];window.renderFixture('form');});
  const submit=page.getByTestId('action-submit');
  await page.getByTestId('action-default-type').click();
  assert.deepEqual(await page.evaluate(()=>window.actions),['default']);
  assert.deepEqual(await page.evaluate(()=>window.submissions),[],'the default action does not submit its surrounding form');
  await expect(page.getByTestId('action-fieldset')).toBeDisabled();
  await page.getByTestId('action-fieldset').evaluate(element=>element.click());
  assert.deepEqual(await page.evaluate(()=>window.actions),['default']);
  await expect(submit).toHaveAttribute('aria-describedby','action-description');
  await page.evaluate(()=>window.focusAction());
  await expect(submit).toBeFocused();
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(()=>window.submissions),[{endpoint:'https://models.example/v1',operation:'save'}]);

  await page.evaluate(()=>window.renderFixture('form',{loading:true}));
  await expect(submit).toBeDisabled();
  await expect(submit).toHaveAttribute('aria-busy','true');
  await expect(submit).toHaveText('保存设置');
  await submit.evaluate(element=>{element.click();element.click();});
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('action-next')).toBeFocused();
  assert.equal(await page.evaluate(()=>window.submissions.length),1);
  await page.evaluate(()=>window.renderFixture('form',{loading:true,loadingLabel:'保存中…'}));
  await expect(submit).toHaveText('保存中…');

  await page.evaluate(()=>window.renderFixture('form',{disabled:true}));
  await expect(submit).toBeDisabled();
  await expect(submit).not.toHaveAttribute('aria-busy','true');
  await expect(submit.locator('svg')).toHaveCount(0);
  await page.evaluate(()=>window.renderFixture('form'));
  await expect(submit).toBeEnabled();
  await expect(page.getByTestId('action-next')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(submit).toBeFocused();
  await page.keyboard.press('Space');
  assert.equal(await page.evaluate(()=>window.submissions.length),2);
});

test('settings save bar separates saving from other busy work and locks both actions',async()=>{
  await page.evaluate(()=>{window.actions=[];window.renderFixture('savebar',{busy:true,saving:false});});
  const save=page.getByTestId('settings-save');
  const discard=page.getByTestId('settings-discard-draft');
  await expect(save).toBeDisabled();
  await expect(discard).toBeDisabled();
  await expect(save).not.toHaveAttribute('aria-busy','true');
  await expect(save.locator('svg')).toHaveCount(0);
  await page.evaluate(()=>window.renderFixture('savebar',{busy:true,saving:true}));
  await expect(save).toHaveAttribute('aria-busy','true');
  await expect(save).toHaveText('保存中…');
  await expect(save.locator('svg[aria-hidden="true"]')).toBeVisible();
  await save.evaluate(element=>element.click());
  await discard.evaluate(element=>element.click());
  assert.deepEqual(await page.evaluate(()=>window.actions),[]);
  await page.evaluate(()=>window.renderFixture('savebar'));
  await save.click();await discard.click();
  assert.deepEqual(await page.evaluate(()=>window.actions),['save','discard']);
  await page.evaluate(()=>window.renderFixture('savebar',{dirtyCount:0,transientDirty:true}));
  await expect(save).toBeDisabled();
  await expect(discard).toBeEnabled();
});
