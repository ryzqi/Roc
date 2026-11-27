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
const capture = process.env.ROC_CONTEXT_CAPTURE;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-context-menu-'));
  if (capture) await mkdir(capture, {recursive: true});
  audit = await readFile('.agents/skills/desktop-agent-ui/scripts/clip-audit.js', 'utf8');
  await buildViteRenderer({
    directory, plugins: [tailwindcss()],
    style: 'html,body,#root{height:100%;margin:0}body{background:var(--surface-app);color:var(--ink-primary)}',
    script: `
      import React,{useState,useRef} from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {FileText,Copy,Clock,Unlink} from 'lucide-react';
      import {ContextMenu} from './src/renderer/shell/ContextMenu';
      import './src/renderer/styles/index.css';
      function Harness() {
        const [manual,setManual]=useState(false),[coordinate,setCoordinate]=useState(false);
        const [point,setPoint]=useState({x:360,y:240});
        const row=useRef(null);
        const change=(name,setOpen)=>(next)=>{window.menuEvents.push(name+':'+(next?'open':'close'));setOpen(next);};
        const actions=(name)=>[
          {id:'open',label:'打开 PDF',icon:<FileText/>,shortcut:'⌘↵',onSelect:()=>window.menuEvents.push(name+':selected:open')},
          {id:'disabled',label:'稍后处理',icon:<Clock/>,disabled:true,onSelect:()=>window.menuEvents.push(name+':selected:disabled')},
          {id:'copy',label:'复制引用',icon:<Copy/>,shortcut:'⌘C',onSelect:()=>window.menuEvents.push(name+':selected:copy')},
          {id:'remove',label:'从当前项目移除',icon:<Unlink/>,danger:true,onSelect:()=>window.menuEvents.push(name+':selected:remove')}
        ];
        window.openContextAt=(x,y)=>{setPoint({x,y});setCoordinate(true);};
        return <main style={{width:280,padding:24}}>
          <div style={{display:'flex',gap:8}}>
            <button data-testid="context-before">前项</button>
            <ContextMenu open={manual} onOpenChange={change('manual',setManual)} label="文献操作"
              testId="context-manual" actions={actions('manual')}
              renderTrigger={props=><button {...props} data-testid="context-trigger">更多</button>}/>
            <button data-testid="context-after">后项</button>
          </div>
          <div data-testid="context-track" style={{height:300,overflow:'auto',scrollbarGutter:'stable',marginTop:20}}>
            <div style={{height:900,paddingTop:160}}>
              <button ref={row} data-testid="context-row" onContextMenu={event=>{
                event.preventDefault();setPoint({x:event.clientX,y:event.clientY});setCoordinate(true);
              }}>现有文献</button>
            </div>
          </div>
          <ContextMenu open={coordinate} onOpenChange={change('coordinate',setCoordinate)} label="文献操作"
            anchor={point} returnFocusRef={row} testId="context-coordinate" actions={actions('coordinate')}/>
        </main>;
      }
      const root=createRoot(document.getElementById('root'));let key=0;
      window.mount=()=>{window.menuEvents=[];document.documentElement.dataset.theme='light';
        flushSync(()=>root.render(<Harness key={++key}/>));};
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
  await expect(page.getByRole('menu')).toHaveCount(0);
}

async function openManual() {
  await page.getByTestId('context-trigger').click();
  await expect(page.getByTestId('context-manual')).toBeVisible();
  await expect(page.getByTestId('context-manual-open')).toBeFocused();
}

async function tokenColor(token) {
  return page.evaluate(token => {
    const probe = document.createElement('span');
    probe.style.display = 'none';
    probe.style.color = `var(${token})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

async function assertShadows(state) {
  const result = await page.evaluate(source => (0, eval)(source)({root: 'body', viewport: true}), audit);
  assert.equal(result.cut, 0, JSON.stringify({state, result}));
  assert.equal(result.hidden, 0, JSON.stringify({state, result}));
}

test('explicit menus expose labels, shortcuts and separators and execute keyboard actions after requesting close', async () => {
  await mount();
  await openManual();
  await expect(page.getByTestId('context-manual')).toHaveAccessibleName('文献操作');
  await expect(page.getByTestId('context-manual-open')).toHaveAccessibleDescription('⌘↵');
  await expect(page.getByTestId('context-manual').getByRole('separator')).toHaveCount(1);
  await expect(page.getByTestId('context-manual-disabled')).toBeDisabled();
  await page.keyboard.press('End');
  await expect(page.getByTestId('context-manual-remove')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('context-manual-open')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('context-manual-copy')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByTestId('context-manual-open')).toBeFocused();
  assert.equal(await page.getByTestId('context-manual').locator('[role="menuitem"][tabindex="0"]').count(), 1);
  await page.evaluate(() => {window.menuEvents = [];});
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('context-manual')).toHaveCount(0);
  assert.deepEqual(await page.evaluate(() => window.menuEvents), ['manual:close', 'manual:selected:open']);
  await expect(page.getByTestId('context-trigger')).toBeFocused();
});

test('roving menu focus lets Tab and Shift+Tab leave the portal in document order', async () => {
  await mount();
  await openManual();
  await page.keyboard.press('End');
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('context-after')).toBeFocused();
  await expect(page.getByTestId('context-manual')).toHaveCount(0);
  await openManual();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('context-manual-copy')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByTestId('context-trigger')).toBeFocused();
  await expect(page.getByTestId('context-manual')).toHaveCount(0);
});

test('danger items stay neutral until hover or keyboard focus and disabled items never select', async () => {
  for (const theme of ['light', 'dark']) {
    await mount();
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await openManual();
    const danger = page.getByTestId('context-manual-remove');
    await expect(danger).toHaveCSS('color', await tokenColor('--ink-muted'));
    await assertShadows(`${theme}:default`);
    if (capture) await page.screenshot({path: join(capture, `context-menu-${theme}.png`)});
    const before = await page.evaluate(() => window.menuEvents);
    await page.getByTestId('context-manual-disabled').evaluate(element => element.click());
    assert.deepEqual(await page.evaluate(() => window.menuEvents), before);
    await expect(page.getByTestId('context-manual')).toBeVisible();
    await expect(page.getByTestId('context-manual-disabled')).toHaveCSS('opacity', '0.5');
    await danger.hover();
    await expect(danger).toHaveCSS('color', await tokenColor('--status-danger-ink'));
    await assertShadows(`${theme}:hover`);
    if (capture) await page.screenshot({path: join(capture, `context-menu-danger-${theme}.png`)});
    await page.getByTestId('context-trigger').hover();
    await page.keyboard.press('End');
    await expect(danger).toBeFocused();
    await expect(danger).toHaveCSS('color', await tokenColor('--status-danger-ink'));
    await assertShadows(`${theme}:keyboard-focus`);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('context-trigger')).toBeFocused();
  }
});

test('coordinate menus preserve their shadows in each narrow-window corner in both themes', async () => {
  await mount();
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(380, 518));
  const viewport = await page.evaluate(() => ({width: innerWidth, height: innerHeight}));
  for (const theme of ['light', 'dark']) for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.getByTestId('context-row').focus();
    const x = corner.endsWith('left') ? 0 : viewport.width - 1;
    const y = corner.startsWith('top') ? 0 : viewport.height - 1;
    await page.evaluate(({x, y}) => window.openContextAt(x, y), {x, y});
    await expect(page.getByTestId('context-coordinate')).toHaveAccessibleName('文献操作');
    await expect(page.getByTestId('context-coordinate-open')).toBeFocused();
    await expect(page.getByTestId('context-coordinate').locator('.context-menu-surface')).toHaveCSS('opacity', '1');
    const result = await page.evaluate(source => (0, eval)(source)({root: 'body', viewport: true}), audit);
    assert.equal(result.cut, 0, JSON.stringify({theme, corner, result}));
    assert.equal(result.hidden, 0, JSON.stringify({theme, corner, result}));
    if (capture && corner === 'bottom-right') {
      await page.screenshot({path: join(capture, `context-menu-coordinate-${theme}-380.png`)});
    }
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('context-coordinate')).toHaveCount(0);
  }
});

test('context actions protect composition Escape and reopen without losing the row scroll position', async () => {
  await mount();
  await page.getByTestId('context-track').evaluate(element => element.scrollTop = 120);
  await page.getByTestId('context-row').focus();
  const scroll = await page.getByTestId('context-track').evaluate(element => element.scrollTop);
  await page.getByTestId('context-row').click({button: 'right'});
  const menu = page.getByTestId('context-coordinate');
  await expect(page.getByTestId('context-coordinate-open')).toBeFocused();
  await page.getByTestId('context-coordinate-open').evaluate(element =>
    element.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true})));
  await page.keyboard.press('Escape');
  await expect(menu).toBeVisible();
  await page.getByTestId('context-coordinate-open').evaluate(element =>
    element.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true})));
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('context-row')).toBeFocused();
  assert.equal(await page.getByTestId('context-track').evaluate(element => element.scrollTop), scroll);
  await page.evaluate(() => window.openContextAt(360, 240));
  await expect(menu).toBeVisible();
  await expect(page.getByTestId('context-coordinate-open')).toBeFocused();
  await page.keyboard.press('End');
  await page.evaluate(() => {window.menuEvents = [];});
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  assert.deepEqual(await page.evaluate(() => window.menuEvents), ['coordinate:close', 'coordinate:selected:remove']);
  await expect(page.getByTestId('context-row')).toBeFocused();
  assert.equal(await page.getByTestId('context-track').evaluate(element => element.scrollTop), scroll);
});
