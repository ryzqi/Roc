import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import tailwindcss from '@tailwindcss/vite';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
const errors = [];
const panels = {
  popover: '[data-testid="motion-popover"] > .anchored-popover-surface',
  inspector: '[data-testid="motion-inspector"] > .inspector-pane-panel',
  modal: '[data-testid="motion-modal-panel"]',
  drawer: '[data-testid="motion-drawer-panel"]',
  radix: '[data-testid="motion-radix-panel"]'
};

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-surface-motion-'));
  await buildViteRenderer({directory, plugins: [tailwindcss()],
    style: 'html,body,#root{height:100%;margin:0}body{background:var(--surface-app)}',
    script: `
      import React,{useRef,useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {LazyMotion,domMax,MotionConfig} from 'motion/react';
      import {MotionPreferenceProvider} from './src/renderer/shared/motion-preference';
      import {AnchoredPopover} from './src/renderer/shell/AnchoredPopover';
      import {InspectorPane} from './src/renderer/shell/InspectorPane';
      import {ModalShell} from './src/renderer/shell/ModalShell';
      import {RadixSettingsDialogShell} from './src/renderer/settings/radix-dialog-pilot';
      import './src/renderer/styles/index.css';
      function Fixture({kind}) {
        const [open,setOpen]=useState(false);
        const anchor=useRef(null),opener=useRef(null);
        window.setSurface=value=>flushSync(()=>setOpen(value));
        window.toggleSurface=()=>flushSync(()=>setOpen(value=>!value));
        const content=<input aria-label="内容" data-testid="motion-input" defaultValue="保留草稿"/>;
        return <>
          <div style={{position:'absolute',left:60,top:30}}>
            {kind==='popover'?<AnchoredPopover open={open} onOpenChange={setOpen} label="筛选"
              testId="motion-popover" renderTrigger={props=><button {...props} data-testid="motion-trigger">筛选</button>}>
              {content}
            </AnchoredPopover>:<button ref={opener} data-testid="motion-trigger" data-inspector-trigger
              onClick={()=>setOpen(value=>!value)}>切换</button>}
          </div>
          <main ref={anchor} data-testid="motion-canvas"
            style={{position:'absolute',left:60,top:90,width:700,height:480}}>
            <button data-testid="motion-background">背景操作</button>
            {kind==='inspector'?<InspectorPane open={open} overlay anchorRef={anchor} returnFocusRef={opener}
              title="文献详情" testId="motion-inspector" onClose={()=>setOpen(false)}>{content}</InspectorPane>:null}
          </main>
          {kind==='modal'||kind==='drawer'?<ModalShell open={open} kind={kind} title="内容"
            testId={'motion-'+kind} onClose={()=>setOpen(false)}>{content}</ModalShell>:null}
          {kind==='radix'?<RadixSettingsDialogShell open={open} title="设置" testId="motion-radix"
            onClose={()=>setOpen(false)}>{content}</RadixSettingsDialogShell>:null}
        </>;
      }
      const root=createRoot(document.getElementById('root'));let key=0;
      window.mount=(kind,preference='provider')=>flushSync(()=>root.render(<LazyMotion features={domMax} strict>
        {preference==='provider'?<MotionPreferenceProvider><Fixture kind={kind} key={++key}/></MotionPreferenceProvider>
          :<MotionConfig reducedMotion={preference==='always'?'always':'never'}><Fixture kind={kind} key={++key}/></MotionConfig>}
      </LazyMotion>));
      window.mount('popover');
    `});
  await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:true,width:900,height:700})
      .loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof window.mount === 'function');
});

after(async () => {
  try {await app?.close();} finally {if (directory) await rm(directory, {recursive: true, force: true});}
  assert.deepEqual(errors, []);
});

async function mount(kind, reduced = false) {
  await page.emulateMedia({reducedMotion: reduced ? 'reduce' : 'no-preference'});
  await page.evaluate(kind => {
    for (const element of [document.documentElement, document.body, document.getElementById('root')]) {
      element.removeAttribute('data-reduce-motion');
      element.removeAttribute('data-reduced-motion');
    }
    window.mount(kind);
  }, kind);
  await page.getByTestId('motion-trigger').click();
  await expect(page.locator(panels[kind])).toHaveCSS('opacity', '1');
}

for (const kind of Object.keys(panels)) {
  test(`${kind} reverses five times within 500ms without flashing or replacing retained pixels`, async () => {
    await mount(kind);
    const result = await page.evaluate(async ({kind, selector}) => {
      const original = document.querySelector(selector);
      const wrapper = document.querySelector('[data-testid="motion-'+kind+'"]');
      const input = document.querySelector('[data-testid="motion-input"]');
      input.value = '未提交内容';
      const read = () => {
        const node = document.querySelector(selector);
        const rect = wrapper.getBoundingClientRect();
        const style = getComputedStyle(node);
        const scrim = document.querySelector('[data-testid="motion-'+kind+'-scrim"]');
        return {same: node === original, opacity: Number(style.opacity), visibility: style.visibility,
          x: rect.x, y: rect.y, inert: wrapper.inert, hidden: wrapper.getAttribute('aria-hidden'),
          scrim: scrim ? Number(getComputedStyle(scrim).opacity) : null,
          wrapperBorder: getComputedStyle(wrapper).borderInlineStartWidth,
          panelBorder: style.borderInlineStartWidth};
      };
      const baseline = read(), flips = [];
      const start = performance.now();
      for (let index = 0; index < 5; index++) {
        const before = read();
        window.toggleSurface();
        const immediate = read(), frames = [];
        // Sample a meaningful part of the exit on both 60Hz and high-refresh displays.
        const flipStart = performance.now();
        do {
          await new Promise(requestAnimationFrame);
          frames.push(read());
        } while (performance.now() - flipStart < 55);
        flips.push({before, immediate, frames});
      }
      return {baseline, flips, elapsed: performance.now() - start, draft: input.value};
    }, {kind, selector: panels[kind]});
    assert.ok(result.elapsed < 500, JSON.stringify(result));
    assert.equal(result.draft, '未提交内容');
    for (const [index, flip] of result.flips.entries()) {
      assert.ok(Math.abs(flip.before.opacity - flip.immediate.opacity) < 0.04,
        `${kind} flip ${index} snapped: ${JSON.stringify(flip)}`);
      assert.ok(flip.frames.every(frame => frame.same && frame.visibility === 'visible'), JSON.stringify(flip));
      if (kind !== 'radix') {
        assert.equal(flip.immediate.inert, index % 2 === 0);
        assert.equal(flip.immediate.hidden, index % 2 === 0 ? 'true' : null);
      }
      if (kind === 'popover' || kind === 'inspector') {
        for (const frame of flip.frames) {
          assert.equal(frame.x, result.baseline.x, JSON.stringify(flip));
          assert.equal(frame.y, result.baseline.y, JSON.stringify(flip));
        }
      }
      if (kind === 'inspector') {
        assert.equal(flip.immediate.wrapperBorder, '0px');
        assert.notEqual(flip.immediate.panelBorder, '0px');
        for (const frame of flip.frames) assert.ok(Math.abs(frame.opacity - frame.scrim) < 0.02, JSON.stringify(flip));
      }
    }
    assert.ok(result.flips[0].frames.some(frame => frame.opacity > 0 && frame.opacity < 0.99), JSON.stringify(result));
    await expect(page.locator(panels[kind])).toHaveCount(0);
    await expect(page.getByTestId('motion-trigger')).toBeFocused();
  });

  test(`${kind} reduced motion retains a 100ms opacity exit without spatial travel`, async () => {
    await mount(kind, true);
    const result = await page.evaluate(async ({kind, selector}) => {
      const node = document.querySelector(selector);
      const read = () => ({opacity: Number(getComputedStyle(node).opacity), transform: getComputedStyle(node).transform,
        visibility: getComputedStyle(node).visibility, connected: node.isConnected,
        duration: getComputedStyle(node).transitionDuration});
      window.setSurface(false);
      const frames = [read()];
      for (let frame = 0; frame < 3; frame++) {
        await new Promise(requestAnimationFrame);
        frames.push(read());
      }
      return {frames, kind};
    }, {kind, selector: panels[kind]});
    assert.ok(result.frames.every(frame => frame.connected && frame.visibility === 'visible'), JSON.stringify(result));
    assert.ok(result.frames.every(frame => frame.transform === 'none'), JSON.stringify(result));
    assert.ok(result.frames.some(frame => frame.opacity > 0 && frame.opacity < 0.99), JSON.stringify(result));
    if (kind === 'popover' || kind === 'inspector') assert.equal(result.frames[0].duration, '0.1s');
    await expect(page.locator(panels[kind])).toHaveCount(0);
    await expect(page.getByTestId('motion-trigger')).toBeFocused();
  });
}

test('live reduced preference stops travel on retained surfaces without remounting or resetting drafts', async () => {
  for (const kind of Object.keys(panels)) {
    await mount(kind);
    const result = await page.evaluate(async ({selector}) => {
      const original = document.querySelector(selector);
      const input = document.querySelector('[data-testid="motion-input"]');
      input.value = '偏好变化后仍保留';
      window.setSurface(false);
      await new Promise(requestAnimationFrame);
      document.documentElement.dataset.reducedMotion = 'true';
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const closingTransform = getComputedStyle(original).transform;
      window.setSurface(true);
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      return {same: original === document.querySelector(selector), draft: input.value,
        closingTransform, reopenedTransform: getComputedStyle(original).transform};
    }, {selector: panels[kind]});
    assert.deepEqual(result, {same: true, draft: '偏好变化后仍保留', closingTransform: 'none', reopenedTransform: 'none'}, kind);
    await expect(page.locator(panels[kind])).toHaveCSS('opacity', '1');
  }
});

for (const preference of ['always', 'body']) {
  test(`isolated floating surfaces honor ${preference} reduced preference without a global provider`, async () => {
    for (const kind of ['popover', 'inspector']) {
      await page.emulateMedia({reducedMotion: 'no-preference'});
      await page.evaluate(({kind, preference}) => {
        document.documentElement.removeAttribute('data-reduced-motion');
        document.body.removeAttribute('data-reduced-motion');
        window.mount(kind, preference);
        if (preference === 'body') document.body.dataset.reducedMotion = 'true';
      }, {kind, preference});
      await page.getByTestId('motion-trigger').click();
      await expect(page.getByTestId(`motion-${kind}`)).toHaveAttribute('data-motion-reduced', 'true');
      await expect(page.locator(panels[kind])).toHaveCSS('opacity', '1');
      assert.notEqual(await page.getByTestId(`motion-${kind}`).evaluate(element => getComputedStyle(element).transform), 'none');
      const frames = await page.evaluate(async ({kind, selector}) => {
        const node = document.querySelector(selector);
        const wrapper = document.querySelector('[data-testid="motion-'+kind+'"]');
        const read = () => ({transform: getComputedStyle(node).transform, opacity: Number(getComputedStyle(node).opacity),
          duration: getComputedStyle(node).transitionDuration, positioned: getComputedStyle(wrapper).transform,
          visibility: getComputedStyle(node).visibility, inert: wrapper.inert});
        window.setSurface(false);
        const frames = [read()];
        for (let index = 0; index < 3; index++) {
          await new Promise(requestAnimationFrame);
          frames.push(read());
        }
        return frames;
      }, {kind, selector: panels[kind]});
      assert.ok(frames.every(frame => frame.transform === 'none' && frame.duration === '0.1s'
        && frame.positioned !== 'none' && frame.visibility === 'visible' && frame.inert), JSON.stringify(frames));
      assert.ok(frames.some(frame => frame.opacity > 0 && frame.opacity < 0.99), JSON.stringify(frames));
      await expect(page.locator(panels[kind])).toHaveCount(0);
    }
  });
}
