import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import tailwindcss from '@tailwindcss/vite';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory, app, page, audit;
const errors = [];
const capture = process.env.ROC_POPOVER_CAPTURE;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-anchored-popover-'));
  if (capture) await mkdir(capture, {recursive: true});
  audit = await readFile('.agents/skills/desktop-agent-ui/scripts/clip-audit.js', 'utf8');
  await buildViteRenderer({
    directory, plugins: [tailwindcss()],
    style: 'html,body,#root{height:100%;margin:0}body{background:var(--surface-app);color:var(--ink-primary)}button,select{padding:8px}',
    script: `
      import React,{useState,useRef,useId} from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {AnchoredPopover} from './src/renderer/shell/AnchoredPopover';
      import {ModalShell} from './src/renderer/shell/ModalShell';
      import {useOverlayBehavior} from './src/renderer/shell/use-overlay-behavior';
      import {hasOpenDialog,topOverlayId} from './src/renderer/shell/overlay-stack';
      import './src/renderer/styles/index.css';

      function Filter({prefix}) {
        const [open,setOpen]=useState(false);
        if(prefix==='popover') window.closeFilterSynchronously=()=>flushSync(()=>setOpen(false));
        return <AnchoredPopover open={open} onOpenChange={setOpen} label="筛选"
          testId={prefix+'-filter'} renderTrigger={props=><button {...props} data-testid={prefix+'-trigger'}>筛选</button>}>
          <div style={{display:'flex',flexDirection:'column',gap:8,minWidth:180}}>
            <label><input data-testid={prefix+'-checkbox'} type="checkbox"/> 已归档</label>
            <select aria-label="来源" data-testid={prefix+'-select'}><option>全部来源</option><option>DOI</option></select>
            <button data-testid={prefix+'-apply'}>应用</button>
          </div>
        </AnchoredPopover>;
      }
      function Harness() {
        const [menu,setMenu]=useState(false),[point,setPoint]=useState({x:100,y:100}),[count,setCount]=useState(3);
        const [ambient,setAmbient]=useState(false),[modal,setModal]=useState(false);
        const panel=useRef(null),row=useRef(null),id=useId();
        useOverlayBehavior({open:ambient,panelRef:panel,overlayId:id,layer:'ambient',inertBackground:false,modal:false,
          onRequestClose:()=>setAmbient(false),canClose:()=>true});
        window.openAt=(x,y)=>{setPoint({x,y});setMenu(true);};window.closeMenu=()=>setMenu(false);
        window.setAmbient=setAmbient;window.setMenuCount=setCount;window.openModal=()=>setModal(true);
        window.hasOpenDialog=hasOpenDialog;window.topOverlayId=topOverlayId;
        return <>
          <main ref={panel} data-testid="popover-frame" data-ambient={ambient}
            style={{width:240,height:440,overflow:'hidden',padding:32}}>
            <div data-testid="popover-toolbar" style={{display:'flex',height:40,alignItems:'center',gap:8}}>
              <button data-testid="popover-before">前项</button><Filter prefix="popover"/>
              <button data-testid="popover-after" onClick={()=>window.outerClicks++}>后项</button>
            </div>
            <div data-testid="popover-track" style={{height:300,overflow:'auto',scrollbarGutter:'stable'}}>
              <div style={{height:900,paddingTop:160}}><button ref={row} data-testid="popover-row">文献</button></div>
            </div>
            <button data-testid="popover-open-modal" onClick={()=>setModal(true)}>设置</button>
            <AnchoredPopover open={menu} onOpenChange={setMenu} label="文献操作" role="menu"
              anchor={point} returnFocusRef={row} testId="popover-menu">
              <div style={{display:'flex',flexDirection:'column',minWidth:160}}>
                {Array.from({length:count},(_,index)=><button key={index} role="menuitem" disabled={index===1}
                  data-testid={'popover-menu-'+index}>{index===0?'打开':index===1?'暂不可用':'归档 '+index}</button>)}
              </div>
            </AnchoredPopover>
          </main>
          <ModalShell open={modal} title="设置" onClose={()=>setModal(false)} testId="popover-modal">
            <Filter prefix="modal"/><button data-testid="modal-after">保存</button>
          </ModalShell>
        </>;
      }
      const root=createRoot(document.getElementById('root'));let key=0;
      window.withSynchronousCommit=flushSync;
      window.mount=()=>{window.outerClicks=0;flushSync(()=>root.render(<Harness key={++key}/>));};
      window.mount();
    `
  });
  await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:true,width:700,height:550})
      .loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof window.mount === 'function');
});

after(async () => {
  try {
    await app?.close();
  } finally {
    if (directory) await rm(directory, {recursive: true, force: true});
  }
  assert.deepEqual(errors, []);
});

async function mount() {
  await page.evaluate(() => window.mount());
  await expect(page.getByTestId('popover-filter')).toHaveCount(0);
}

async function openFilter(prefix = 'popover') {
  await page.getByTestId(`${prefix}-trigger`).click();
  await expect(page.getByTestId(`${prefix}-filter`)).toHaveAttribute('data-state', 'open');
  await expect(page.getByTestId(`${prefix}-checkbox`)).toBeFocused();
}

test('filter focus waits for positioning without changing the list or background access', async () => {
  await mount();
  await page.getByTestId('popover-track').evaluate(element => element.scrollTop = 120);
  const measure = () => page.evaluate(() => Object.fromEntries(['frame', 'toolbar', 'track', 'row'].map(name => {
    const element = document.querySelector(`[data-testid="popover-${name}"]`);
    const rect = element.getBoundingClientRect();
    return [name, {x: rect.x, y: rect.y, width: rect.width, height: rect.height, scrollTop: element.scrollTop}];
  })));
  const before = await measure();
  await openFilter();
  if (capture) await page.screenshot({path: join(capture, 'popover-filter-light.png')});
  await expect(page.getByTestId('popover-filter')).toHaveCSS('position', 'fixed');
  assert.equal(await page.getByTestId('popover-filter').evaluate(element => element.closest('#root')), null);
  assert.deepEqual(await measure(), before);
  assert.equal(await page.evaluate(() => document.getElementById('root').getAttribute('aria-hidden')), null);
  assert.equal(await page.evaluate(() => window.hasOpenDialog()), false);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('popover-trigger')).toBeFocused();
  assert.deepEqual(await measure(), before);
});

test('trigger toggle and outside actions close once and preserve the chosen focus', async () => {
  await mount();
  await openFilter();
  await page.getByTestId('popover-trigger').click();
  await expect(page.getByTestId('popover-filter')).toHaveCount(0);
  await expect(page.getByTestId('popover-trigger')).toBeFocused();
  await openFilter();
  await page.getByTestId('popover-after').click();
  await expect(page.getByTestId('popover-filter')).toHaveCount(0);
  await expect(page.getByTestId('popover-after')).toBeFocused();
  assert.equal(await page.evaluate(() => window.outerClicks), 1);
});

test('Escape and trigger close can reopen the retained portal before its exit finishes', async () => {
  for (const close of ['Escape', 'trigger']) {
    await mount();
    await page.getByTestId('popover-trigger').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('popover-checkbox')).toBeFocused();
    const retained = await page.evaluate(close => {
      const trigger = document.querySelector('[data-testid="popover-trigger"]');
      const surface = document.querySelector('[data-testid="popover-filter"]');
      window.withSynchronousCommit(() => {
        if (close === 'Escape') {
          document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
        } else {
          trigger.click();
        }
      });
      const retained = surface === document.querySelector('[data-testid="popover-filter"]') && surface.inert;
      trigger.focus({preventScroll: true});
      trigger.click();
      return retained;
    }, close);
    assert.equal(retained, true, `${close} must retain the exit portal for this regression`);
    await expect(page.getByTestId('popover-filter')).toBeVisible();
    await expect(page.getByTestId('popover-filter')).toHaveAttribute('data-state', 'open');
    await expect(page.getByTestId('popover-checkbox')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('popover-trigger')).toBeFocused();
  }
});

test('portal Tab and Shift+Tab follow the trigger position in the document', async () => {
  await mount();
  await openFilter();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('popover-select')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('popover-apply')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('popover-after')).toBeFocused();
  await expect(page.getByTestId('popover-filter')).toHaveCount(0);
  await openFilter();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByTestId('popover-trigger')).toBeFocused();
});

test('closing content immediately stops interaction and rapid toggles settle correctly', async () => {
  await mount();
  await openFilter();
  const closing = await page.evaluate(() => {
    window.closeFilterSynchronously();
    const element = document.querySelector('[data-testid="popover-filter"]');
    return {inert: element.inert, hidden: element.getAttribute('aria-hidden'), pointerEvents: getComputedStyle(element).pointerEvents};
  });
  assert.deepEqual(closing, {inert: true, hidden: 'true', pointerEvents: 'none'});
  await expect(page.getByTestId('popover-trigger')).toBeFocused();
  await page.getByTestId('popover-after').click();
  await expect(page.getByTestId('popover-filter')).toHaveCount(0);
  await expect(page.getByTestId('popover-after')).toBeFocused();
  for (let index = 0; index < 9; index++) await page.getByTestId('popover-trigger').click();
  await expect(page.getByTestId('popover-filter')).toBeVisible();
  await expect(page.getByTestId('popover-filter')).toHaveAttribute('data-state', 'open');
  await expect(page.getByTestId('popover-checkbox')).toBeFocused();
  await expect(page.getByTestId('popover-filter').locator('.anchored-popover-surface')).toHaveCSS('opacity', '1');
});

test('coordinate menu arrows skip disabled items and Escape returns without scrolling', async () => {
  await mount();
  await page.getByTestId('popover-row').focus();
  const scroll = await page.getByTestId('popover-track').evaluate(element => element.scrollTop);
  await page.evaluate(() => window.openAt(360, 240));
  await expect(page.getByTestId('popover-menu-0')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('popover-menu-2')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('popover-menu-0')).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByTestId('popover-menu-2')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByTestId('popover-menu-0')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('popover-row')).toBeFocused();
  assert.equal(await page.getByTestId('popover-track').evaluate(element => element.scrollTop), scroll);
});

test('coordinate menus retain their complete shadows at every viewport corner', async () => {
  await mount();
  for (const width of [700, 380]) {
    await app.evaluate(({BrowserWindow}, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 518), width);
    const viewport = await page.evaluate(() => ({width: innerWidth, height: innerHeight}));
    for (const theme of ['light', 'dark']) for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.getByTestId('popover-row').focus();
      const x = corner.endsWith('left') ? 0 : viewport.width - 1;
      const y = corner.startsWith('top') ? 0 : viewport.height - 1;
      await page.evaluate(({x, y}) => window.openAt(x, y), {x, y});
      await expect(page.getByTestId('popover-menu')).toHaveAttribute('data-state', 'open');
      await expect(page.getByTestId('popover-menu').locator('.anchored-popover-surface')).toHaveCSS('opacity', '1');
      await page.getByTestId('popover-menu').hover();
      if (capture && width === 380 && corner === 'bottom-right') {
        await page.screenshot({path: join(capture, `popover-menu-${theme}-380.png`)});
      }
      const result = await page.evaluate(source => (0, eval)(source)({viewport: true}), audit);
      assert.equal(result.cut, 0, JSON.stringify({width, theme, corner, result}));
      assert.equal(result.hidden, 0, JSON.stringify({width, theme, corner, result}));
      await page.evaluate(() => window.closeMenu());
      await expect(page.getByTestId('popover-menu')).toHaveCount(0);
    }
  }
});

test('long menus scroll within the viewport and reduced motion removes travel', async () => {
  await mount();
  await page.emulateMedia({reducedMotion: 'reduce'});
  try {
    await page.getByTestId('popover-row').focus();
    await page.evaluate(() => {window.setMenuCount(80); window.openAt(379, 517);});
    await expect(page.getByTestId('popover-menu')).toHaveAttribute('data-state', 'open');
    const bounds = await page.getByTestId('popover-menu').evaluate(element => {
      const surface = element.querySelector('.anchored-popover-surface');
      const gutter = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--shadow-popover-gutter'));
      const rect = element.getBoundingClientRect();
      return {height: rect.height, maxHeight: innerHeight - 2 * gutter, overflow: surface.scrollHeight > surface.clientHeight};
    });
    assert.ok(bounds.height <= bounds.maxHeight + 1, JSON.stringify(bounds));
    assert.equal(bounds.overflow, true);
    await expect(page.getByTestId('popover-menu').locator('.anchored-popover-surface')).toHaveCSS('transform', 'none');
  } finally {
    await page.emulateMedia({reducedMotion: 'no-preference'});
  }
});

test('ambient drawer delegates Tab to its portaled child and one Escape closes only the child', async () => {
  await mount();
  await page.evaluate(() => window.setAmbient(true));
  await openFilter();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('popover-select')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('popover-trigger')).toBeFocused();
  await expect(page.getByTestId('popover-frame')).toHaveAttribute('data-ambient', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('popover-frame')).toHaveAttribute('data-ambient', 'false');
});

test('modal child owns Tab and Escape while its parent keeps background modality', async () => {
  await mount();
  await page.getByTestId('popover-open-modal').click();
  await openFilter('modal');
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('modal-select')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('modal-trigger')).toBeFocused();
  await expect(page.getByTestId('modal-filter')).toHaveCount(0);
  await expect(page.getByTestId('popover-modal')).toBeVisible();
  assert.equal(await page.evaluate(() => document.getElementById('root').getAttribute('aria-hidden')), 'true');
  assert.equal(await page.evaluate(() => window.hasOpenDialog()), true);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('popover-modal')).toHaveCount(0);
  await expect(page.getByTestId('popover-open-modal')).toBeFocused();
  assert.equal(await page.evaluate(() => document.getElementById('root').getAttribute('aria-hidden')), null);
});

test('a later modal still hides the background when a non-modal filter was already open', async () => {
  await mount();
  await openFilter();
  await page.evaluate(() => window.openModal());
  await expect(page.getByTestId('popover-modal')).toBeVisible();
  assert.equal(await page.evaluate(() => document.getElementById('root').getAttribute('aria-hidden')), 'true');
  assert.equal(await page.evaluate(() => window.hasOpenDialog()), true);
});

test('composition Escape leaves the floating surface open until composition ends', async () => {
  await mount();
  await openFilter();
  await page.getByTestId('popover-checkbox').evaluate(element => element.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true})));
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('popover-filter')).not.toHaveAttribute('aria-hidden', 'true');
  await page.getByTestId('popover-checkbox').evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true})));
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('popover-filter')).toHaveCount(0);
});
