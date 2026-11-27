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

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-library-state-motion-'));
  await buildViteRenderer({directory, plugins: [tailwindcss()], style: 'body{margin:0}', script: `
    import React,{useRef,useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion,domMax} from 'motion/react';
    import {MotionPreferenceProvider} from './src/renderer/shared/motion-preference';
    import {useCopyFeedback} from './src/renderer/shared/hooks/use-copy-feedback';
    import {CopyFeedbackIcon} from './src/renderer/shared/CopyFeedbackIcon';
    import {AnimatedCount} from './src/renderer/shared/AnimatedCount';
    import {LibraryLoading} from './src/renderer/literature/LibraryLoading';
    import {useLibraryRowMotion} from './src/renderer/literature/use-library-row-motion';
    import './src/renderer/styles/index.css';
    import './src/renderer/literature/library-list.css';
    window.copyRequests=[];
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:value=>new Promise((resolve,reject)=>{
      window.copyRequests.push({value,resolve,reject});
    })}});
    window.settleCopy=(index,success=true)=>{
      const request=window.copyRequests[index];
      if(success)request.resolve();else request.reject(new Error('clipboard fixture'));
    };
    function CopyFixture() {
      const copy=useCopyFeedback();
      window.copyValue=copy.copy;
      return <button data-testid="copy-feedback" onClick={()=>copy.copy('citation')}>
        <CopyFeedbackIcon copied={copy.copied}/><span data-testid="copy-label">{copy.copied?'已复制':'复制'}</span>
        {copy.error?<span role="alert">{copy.error}</span>:null}
      </button>;
    }
    function CountFixture() {
      const [value,setValue]=useState(128);
      window.setCount=value=>flushSync(()=>setValue(value));
      return <div data-testid="count"><AnimatedCount value={value}/></div>;
    }
    const makeRows=count=>Array.from({length:count},(_,index)=>({id:'row-'+index}));
    function RowFixture({count}) {
      const [items,setItems]=useState(()=>makeRows(count));
      const [removed,setRemoved]=useState(()=>new Set());
      const body=useRef(null),scope=useRef({});
      useLibraryRowMotion(body,items,scope.current,true,removed);
      window.rowClicks=[];
      window.setRows=(ids,removedIds=[])=>flushSync(()=>{
        setRemoved(new Set(removedIds));setItems(ids.map(id=>({id})));
      });
      return <div ref={body} className="library-list-body" data-testid="row-body"
        style={{width:500,height:256,flex:'none'}}>
        <div data-testid="row-scroll" style={{height:'100%',overflowY:'auto'}}>
          {items.slice(0,40).map(item=><div key={item.id} className="library-row" data-library-row={item.id}
            id={item.id} data-testid={item.id} style={{height:64}}>
            <button id={item.id+'-action'} data-testid={item.id+'-action'}
              onClick={()=>window.rowClicks.push(item.id)}>{item.id}</button>
          </div>)}
        </div>
      </div>;
    }
    const root=createRoot(document.getElementById('root'));let generation=0;
    window.mount=(mode='copy',count=1000)=>flushSync(()=>root.render(
      <LazyMotion features={domMax} strict><MotionPreferenceProvider>
        <main key={++generation} data-testid="state-fixture" style={{padding:24}}>
          {mode==='copy'?<CopyFixture/>:mode==='count'?<CountFixture/>:
            mode==='rows'?<RowFixture count={count}/>:mode==='loading'?<LibraryLoading/>:null}
        </main>
      </MotionPreferenceProvider></LazyMotion>));
    window.mount();
  `});
  await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:true,width:900,height:700})
      .loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('state-fixture').waitFor();
});

after(async () => {
  try {await app?.close();} finally {if (directory) await rm(directory, {recursive: true, force: true});}
  assert.deepEqual(errors, []);
});

async function mount(mode, count = 1000) {
  await page.emulateMedia({reducedMotion: 'no-preference'});
  await page.evaluate(async ({mode, count}) => {
    for (const node of [document.documentElement, document.body, document.getElementById('root')]) {
      node.removeAttribute('data-reduce-motion');
      node.removeAttribute('data-reduced-motion');
    }
    window.mount(mode, count);
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  }, {mode, count});
}

const rowIds = count => Array.from({length: count}, (_, index) => `row-${index}`);

test('copy feedback follows the latest clipboard receipt and ignores stale and unmounted completions', async () => {
  await mount('copy');
  const first = await page.evaluate(() => {
    const first = window.copyRequests.length;
    window.copyValue('old');window.copyValue('new');
    return first;
  });
  await expect(page.getByTestId('copy-label')).toHaveText('复制');
  await page.evaluate(first => window.settleCopy(first + 1), first);
  await expect(page.getByTestId('copy-label')).toHaveText('已复制');
  await page.evaluate(first => window.settleCopy(first, false), first);
  await expect(page.getByTestId('copy-label')).toHaveText('已复制');
  await expect(page.getByRole('alert')).toHaveCount(0);
  const pending = await page.evaluate(() => {
    const index = window.copyRequests.length;
    window.copyValue('unmounted');window.mount('empty');window.mount('copy');
    return index;
  });
  await page.evaluate(index => window.settleCopy(index), pending);
  await expect(page.getByTestId('copy-label')).toHaveText('复制');
  await page.waitForTimeout(1600);
  await expect(page.getByTestId('copy-label')).toHaveText('复制');
});

test('copy glyphs crossfade in a fixed slot and remove scale when reduced motion changes mid-flight', async () => {
  await mount('copy');
  const result = await page.evaluate(async () => {
    const icon = document.querySelector('.copy-feedback-icon');
    const initial = icon.getBoundingClientRect();
    const index = window.copyRequests.length;
    window.copyValue('citation');window.settleCopy(index);
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const read = () => [...icon.children].map(node => ({opacity: Number(getComputedStyle(node).opacity),
      transform: getComputedStyle(node).transform, duration: getComputedStyle(node).transitionDuration}));
    const moving = read();
    document.body.dataset.reduceMotion = 'true';
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return {moving,reduced:read(),width:icon.getBoundingClientRect().width,height:icon.getBoundingClientRect().height,
      initial:{width:initial.width,height:initial.height}};
  });
  assert.equal(result.width, result.initial.width);
  assert.equal(result.height, result.initial.height);
  assert.ok(result.moving.some(value => value.opacity > 0 && value.opacity < 1), JSON.stringify(result));
  assert.ok(result.reduced.every(value => value.transform === 'none' && value.duration === '0.1s'), JSON.stringify(result));
  await expect(page.locator('.copy-feedback-icon__check')).toHaveCSS('opacity', '1');
  await page.evaluate(() => {delete document.body.dataset.reduceMotion;});
  await expect(page.locator('html')).toHaveAttribute('data-motion-reduced', 'false');
});

test('fast loading avoids a flash and delayed skeletons match eight real row tracks', async () => {
  const result = await page.evaluate(async () => {
    window.mount('loading');
    const started = performance.now();
    const immediate = document.querySelectorAll('.library-loading-rows > div').length;
    await new Promise(resolve => setTimeout(resolve, 70));
    const early = document.querySelectorAll('.library-loading-rows > div').length;
    await new Promise(resolve => setTimeout(resolve, 110));
    return {immediate,early,elapsed:performance.now()-started,
      heights:[...document.querySelectorAll('.library-loading-rows > div')].map(node=>node.getBoundingClientRect().height)};
  });
  assert.equal(result.immediate, 0);
  assert.equal(result.early, 0);
  assert.ok(result.elapsed >= 150);
  assert.deepEqual(result.heights, Array(8).fill(64));
  await page.evaluate(() => {window.mount('loading');window.mount('empty');});
  await page.waitForTimeout(180);
  await expect(page.locator('.library-loading-rows')).toHaveCount(0);
});

test('only the changed units glyph moves and both retained digits react to reduced motion', async () => {
  await mount('count');
  const result = await page.evaluate(async () => {
    const count = document.querySelector('[data-testid="count"] > span');
    const visual = count.querySelector('[aria-hidden="true"]');
    const prefix = visual.firstElementChild;
    const before = count.getBoundingClientRect();
    window.setCount(129);
    await new Promise(requestAnimationFrame);
    const during = {label:count.querySelector('.sr-only').textContent,prefix:prefix.textContent,
      prefixSame:prefix===visual.firstElementChild,glyphs:visual.lastElementChild.children.length};
    document.getElementById('root').dataset.reducedMotion = 'true';
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return {during,transforms:[...visual.lastElementChild.children].map(node=>getComputedStyle(node).transform),
      width:count.getBoundingClientRect().width,beforeWidth:before.width};
  });
  assert.deepEqual(result.during, {label:'129',prefix:'12',prefixSame:true,glyphs:2});
  assert.equal(result.width, result.beforeWidth);
  assert.ok(result.transforms.every(transform => transform === 'none'), JSON.stringify(result));
  await expect.poll(() => page.getByTestId('count').ariaSnapshot()).toBe('- text: "129"');
});

test('visible removal retains only inert decorative pixels and bounds work to the viewport', async () => {
  await mount('rows');
  const result = await page.evaluate(ids => {
    const body = document.querySelector('[data-testid="row-body"]');
    window.setRows(ids.slice(1), ['row-0']);
    const ghosts = [...body.querySelectorAll('.library-row-ghost')];
    for (const ghost of ghosts) ghost.querySelector('button')?.click();
    return {ghosts:ghosts.map(ghost=>({inert:ghost.inert,hidden:ghost.getAttribute('aria-hidden'),
      hooks:[ghost,...ghost.querySelectorAll('*')].some(node=>node.hasAttribute('id')||node.hasAttribute('data-testid')||node.hasAttribute('data-library-row'))})),
      mounted:body.querySelectorAll('[data-library-row]').length,
      animated:body.getAnimations({subtree:true}).map(animation=>animation.effect.target.closest('[data-library-row]')?.dataset.libraryRow ?? 'ghost'),
      clicks:window.rowClicks};
  }, rowIds(1000));
  assert.deepEqual(result.ghosts, [{inert:true,hidden:'true',hooks:false}]);
  assert.deepEqual(result.clicks, []);
  assert.ok(result.mounted <= 40, JSON.stringify(result));
  assert.ok(result.animated.length > 0 && result.animated.length <= 5, JSON.stringify(result));
  assert.ok(result.animated.every(id => ['row-1','row-2','row-3','row-4','ghost'].includes(id)), JSON.stringify(result));
  await expect(page.locator('.library-row-ghost')).toHaveCount(0);
});

test('filtering a large collection does not fabricate removal or move rows through the viewport', async () => {
  await mount('rows');
  const result = await page.evaluate(ids => {
    window.setRows(ids.slice(1), []);
    const body = document.querySelector('[data-testid="row-body"]');
    return {ghosts:body.querySelectorAll('.library-row-ghost').length,
      frames:body.getAnimations({subtree:true}).flatMap(animation=>animation.effect.getKeyframes())};
  }, rowIds(1000));
  assert.equal(result.ghosts, 0);
  assert.ok(result.frames.length > 0);
  assert.ok(result.frames.every(frame => frame.transform === undefined), JSON.stringify(result));
});

for (const cancelBy of ['preference', 'scroll', 'second-removal']) {
  test(`${cancelBy} cancels current row animations and removes decorative clones`, async () => {
    await mount('rows');
    const result = await page.evaluate(async ({ids,cancelBy}) => {
      const body = document.querySelector('[data-testid="row-body"]');
      window.setRows(ids.slice(1), ['row-0']);
      const started = body.getAnimations({subtree:true}).length;
      if (cancelBy==='preference') document.documentElement.dataset.reduceMotion='true';
      else if (cancelBy==='scroll') document.querySelector('[data-testid="row-scroll"]').scrollTop=64;
      else window.setRows(ids.slice(2), ['row-0','row-1']);
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      return {started,ghosts:body.querySelectorAll('.library-row-ghost').length,
        running:body.getAnimations({subtree:true}).filter(animation=>animation.playState==='running').length,
        scrollTop:document.querySelector('[data-testid="row-scroll"]').scrollTop,
        transforms:[...body.querySelectorAll('[data-library-row]')].map(node=>getComputedStyle(node).transform)};
    }, {ids:rowIds(1000),cancelBy});
    assert.ok(result.started > 0, JSON.stringify(result));
    assert.equal(result.ghosts, 0, JSON.stringify(result));
    assert.equal(result.running, 0, JSON.stringify(result));
    assert.ok(result.transforms.every(transform => transform === 'none'), JSON.stringify(result));
    if (cancelBy==='scroll') assert.equal(result.scrollTop, 64);
  });
}
