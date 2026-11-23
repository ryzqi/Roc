import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import electronPath from 'electron';
import {_electron,expect} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory,app,page;
const errors=[];
before(async()=>{
  directory=await mkdtemp(join(tmpdir(),'roc-reading-boundary-'));
  await buildViteRenderer({directory,style:'html,body,#root{height:100%;margin:0}',script:`
    import React,{useRef,useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {ReadingViewBoundary} from './src/renderer/literature/ReadingViewBoundary';
    window.readingObservers=0;
    for(const name of ['ResizeObserver','MutationObserver']) {
      const Native=window[name];window[name]=class extends Native {
        tracked=false;
        observe(...args){
          const target=args[0];
          if(!this.tracked&&target instanceof Element&&target.closest('[data-testid="reading-root"]')){window.readingObservers++;this.tracked=true;}
          return super.observe(...args);
        }
        disconnect(){if(this.tracked){window.readingObservers--;this.tracked=false;}return super.disconnect();}
      };
    }
    const root=createRoot(document.getElementById('root'));let session=0;
    function Harness(){
      const ref=useRef(null),[state,setState]=useState({active:true,ready:true,identity:'a'});
      window.updateReading=value=>flushSync(()=>setState(current=>({...current,...value})));
      return <><button data-testid="other">Other workspace</button><div hidden={!state.active}>
        <ReadingViewBoundary selected={state.active} identity={state.identity} containerRef={ref} scrollSelectors={['.reading-scroll']}>
          <section ref={ref} data-testid="reading-root"><div className="reading-scroll" style={{height:120,overflow:'auto'}}>
            {state.active&&state.ready?<div><details data-reading-detail="source"><summary>Source details</summary><p>Verified receipt</p></details>
              <div data-testid="heavy-content" style={{height:1000}}>Long readonly result</div></div>:null}
          </div></section>
        </ReadingViewBoundary></div></>;
    }
    window.mountReading=()=>flushSync(()=>root.render(<Harness key={++session}/>));
    window.unmountReading=()=>flushSync(()=>root.render(null));
    mountReading();
  `});
  await writeFile(join(directory,'main.cjs'),`const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory,'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:600,height:400}).loadFile(${JSON.stringify(join(directory,'index.html'))}));`);
  app=await _electron.launch({executablePath:electronPath,args:[join(directory,'main.cjs')]});
  page=await app.firstWindow();page.setDefaultTimeout(4000);page.on('pageerror',error=>errors.push(error.message));
  await page.getByTestId('heavy-content').waitFor();
});
after(async()=>{try{await app?.close();}finally{if(directory)await rm(directory,{recursive:true,force:true});}assert.deepEqual(errors,[]);});
async function suspend(){
  await page.evaluate(()=>{mountReading();document.querySelector('details').open=true;document.querySelector('.reading-scroll').scrollTop=280;updateReading({active:false});});
  await expect(page.getByTestId('heavy-content')).toHaveCount(0);
}
const position=()=>page.locator('.reading-scroll').evaluate(node=>node.scrollTop);

test('late readonly content restores the pre-hide scroll and details without focusing the resumed view',async()=>{
  await suspend();await page.getByTestId('other').focus();
  await page.evaluate(()=>updateReading({active:true,ready:false}));
  assert.ok(await page.evaluate(()=>readingObservers)>0);
  await page.evaluate(()=>updateReading({ready:true}));
  await expect.poll(position).toBe(280);
  await expect(page.locator('details')).toHaveAttribute('open','');
  await expect(page.getByTestId('other')).toBeFocused();
  await expect.poll(()=>page.evaluate(()=>readingObservers)).toBe(0);
});
test('a second hide during late restoration preserves the original position and cleans observers on hidden unmount',async()=>{
  await suspend();
  await page.evaluate(()=>{updateReading({active:true,ready:false});updateReading({active:false});});
  assert.equal(await page.evaluate(()=>readingObservers),0);
  await page.evaluate(()=>updateReading({active:true,ready:true}));
  await expect.poll(position).toBe(280);
  await page.evaluate(()=>{updateReading({active:false});unmountReading();});
  assert.equal(await page.evaluate(()=>readingObservers),0);
});
test('reader interaction cancels pending restoration instead of replacing a new scroll choice',async()=>{
  await suspend();await page.evaluate(()=>updateReading({active:true,ready:false}));
  await page.getByTestId('reading-root').dispatchEvent('wheel',{deltaY:40});
  assert.equal(await page.evaluate(()=>readingObservers),0);
  await page.evaluate(()=>updateReading({ready:true}));
  assert.equal(await position(),0);
});
test('a new result identity cannot inherit old scroll or disclosure and late observers have a bounded lifetime',async()=>{
  await suspend();await page.evaluate(()=>updateReading({active:true,identity:'b'}));
  assert.equal(await position(),0);
  await expect(page.locator('details')).not.toHaveAttribute('open','');
  await suspend();await page.evaluate(()=>updateReading({active:true,ready:false}));
  await expect.poll(()=>page.evaluate(()=>readingObservers),{timeout:2500}).toBe(0);
});
