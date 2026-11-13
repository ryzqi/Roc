import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from 'esbuild';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';

let directory, app, page;
const pageErrors = [];

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-canvas-view-loading-'));
  await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
        import React, {useState} from 'react';
        import {createRoot} from 'react-dom/client';
        import {flushSync} from 'react-dom';
        import {ViewContent} from './src/renderer/app/ViewContent';
        import {LazyBoundary, retryableLazy} from './src/renderer/shell/LazyBoundary';
        import {ChatMessageRow} from './src/renderer/assistant/blocks/message-row';
        const root = createRoot(document.getElementById('root'));
        let session = 0;
        window.fixtureView = view => {
          window.loadCalls.push(view);
          const module = {default: () => <section data-testid={'fixture-'+view}>
            <label>Draft for {view}<input defaultValue={'Original '+view}/></label>
          </section>};
          const mode = window.modes[view];
          if(mode === 'throw') throw new Error('Synthetic chunk load failure for '+view);
          if(mode === 'fail') return Promise.reject(new Error('Synthetic chunk load failure for '+view));
          if(mode === 'defer') return new Promise((resolve,reject) => {
            window.finishView[view] = success => success ? resolve(module) : reject(new Error('Synthetic delayed failure'));
          });
          if(mode === 'nested-fail' || mode === 'nested-defer') {
            const Nested = React.lazy(() => {
              window.loadCalls.push('nested-'+view);
              if(mode === 'nested-fail') return Promise.reject(new Error('Synthetic nested chunk failure'));
              return new Promise((resolve,reject) => {
                window.finishView['nested-'+view] = success => success ?
                  resolve({default: () => <p>Nested content ready</p>}) :
                  reject(new Error('Synthetic delayed nested failure'));
              });
            });
            module.default = () => <section data-testid={'fixture-'+view}>
              <React.Suspense fallback={<p role="status">Nested content loading</p>}><Nested/></React.Suspense>
            </section>;
          }
          return Promise.resolve(module);
        };
        function Harness({initial}) {
          const [view,setView] = useState(initial);
          window.selectView = setView;
          return <main style={{height:480}}><ViewContent view={view} projectId="fixture"/></main>;
        }
        window.mountFixture = initial => {
          flushSync(() => root.render(<Harness key={++session} initial={initial}/>));
        };
        const Fragment = retryableLazy(() => {
          window.fragmentCalls++;
          return window.fragmentImporter();
        });
        function LocalRegion() {
          const [revision,setRevision] = useState(0);
          const [active,setActive] = useState(true);
          window.bumpRegion = () => setRevision(value => value+1);
          window.showRegion = setActive;
          return <main><label>Retained parent draft<input defaultValue="Original parent"/></label>
            <p>Parent revision {revision}</p>
            <LazyBoundary active={active} fallback={<p role="status">Fragment loading</p>}><Fragment/></LazyBoundary>
          </main>;
        }
        window.mountRegionFixture = () => {
          window.fragmentCalls = 0;
          window.fragmentImporter = () => new Promise((resolve,reject) => {
            window.finishFragment = success => success ? resolve({default: () => <p>Fragment ready</p>}) :
              reject(new Error('Synthetic fragment load failure'));
          });
          flushSync(() => root.render(<LocalRegion key={++session}/>));
        };
        window.fixtureMarkdown = () => {
          window.markdownCalls++;
          if(!window.markdownReady)return Promise.reject(new Error('Synthetic answer formatting load failure'));
          return Promise.resolve({StreamingMarkdownView: ({text}) => <div data-testid="fixture-markdown">{text}</div>});
        };
        window.mountAnswerFixture = () => {
          window.markdownCalls = 0; window.markdownReady = false;
          flushSync(() => root.render(<main>
            <label>Adjacent draft<input defaultValue="Original adjacent draft"/></label>
            <ChatMessageRow message={{key:'answer',source:'persisted',role:'assistant',content:'已收到的完整原始回答',
              attachments:[],reasoning:null,blocks:[],interrupts:[],isStreaming:false}}
              onOpenArtifact={()=>{}} onReadGateContext={()=>Promise.resolve({ok:false})}/>
          </main>));
        };
        window.modes = {}; window.finishView = {}; window.loadCalls = [];
      `
    },
    bundle: true,
    format: 'esm',
    jsx: 'automatic',
    outfile: join(directory, 'app.js'),
    plugins: [{
      name: 'controlled-chunk-importers',
      setup(builder) {
        builder.onLoad({filter: /\/app\/view-registry\.ts$/}, async ({path}) => {
          // Replace only the leaf importers; exercise the production registry and host.
          const contents = (await readFile(path, 'utf8')).replace(
            /const viewLoaders: Record<AppViewId, \(\) => Promise<ViewModule>> = \{[\s\S]*?\n\};/u,
            `const viewLoaders: Record<AppViewId, () => Promise<ViewModule>> = {
              literature: () => window.fixtureView('literature'),
              latex: () => window.fixtureView('latex'),
              terminal: () => window.fixtureView('terminal'),
              mcp: () => window.fixtureView('mcp'),
              skills: () => window.fixtureView('skills'),
              memory: () => window.fixtureView('memory')
            };`
          );
          return {contents, loader: 'ts'};
        });
        builder.onLoad({filter: /\/blocks\/message-row\.tsx$/}, async ({path}) => ({
          contents: (await readFile(path, 'utf8')).replaceAll("import('./streaming-markdown-view')", 'window.fixtureMarkdown()'),
          loader: 'tsx'
        }));
      }
    }],
    logLevel: 'silent'
  });
  const assets = join(process.cwd(), 'dist/renderer/assets');
  const styles = await Promise.all((await readdir(assets)).filter(file => file.endsWith('.css'))
    .map(file => readFile(join(assets, file), 'utf8')));
  await writeFile(join(directory, 'app.css'), styles.join('\n'));
  await writeFile(join(directory, 'index.html'), '<html data-theme="light"><link rel="stylesheet" href="./app.css"><div id="root"></div><script type="module" src="./app.js"></script></html>');
  await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:800,height:620}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.setDefaultTimeout(3000);
  await page.waitForFunction(() => typeof window.mountFixture === 'function');
});

after(async () => {
  try {await app?.close();}
  finally {if(directory) await rm(directory, {recursive: true, force: true});}
});

async function fresh() {
  await page.reload();
  await page.waitForFunction(() => typeof window.mountFixture === 'function');
  pageErrors.length = 0;
}

test('failed cold navigation preserves the current editor and offers a working retry', async () => {
  await fresh();
  await page.evaluate(() => window.mountFixture('literature'));
  await page.getByLabel('Draft for literature').fill('Unsaved literature draft');
  await page.evaluate(() => {window.modes.terminal = 'fail'; window.selectView('terminal');});
  await expect(page.getByTestId('view-load-error')).toContainText('Synthetic chunk load failure');
  await expect(page.getByLabel('Draft for literature')).toHaveValue('Unsaved literature draft');
  await page.evaluate(() => {window.modes.terminal = 'ready';});
  await page.getByTestId('view-load-error').getByRole('button', {name: '重试', exact: true}).click();
  await expect(page.getByTestId('fixture-terminal')).toBeVisible();
  assert.equal(await page.evaluate(() => window.loadCalls.filter(view => view === 'terminal').length), 2);
  await page.evaluate(() => window.selectView('literature'));
  await expect(page.getByLabel('Draft for literature')).toHaveValue('Unsaved literature draft');
  assert.deepEqual(pageErrors, []);
});

test('the first view catches synchronous import failures and can recover in the same shell', async () => {
  await fresh();
  await page.evaluate(() => {window.modes.latex = 'throw'; window.mountFixture('latex');});
  await expect(page.getByTestId('view-load-error')).toContainText('Synthetic chunk load failure');
  await page.evaluate(() => {window.modes.latex = 'ready';});
  await page.getByTestId('view-load-error').getByRole('button', {name: '重试', exact: true}).click();
  await expect(page.getByTestId('fixture-latex')).toBeVisible();
  assert.equal(await page.evaluate(() => window.loadCalls.filter(view => view === 'latex').length), 2);
  assert.deepEqual(pageErrors, []);
});

test('a stale chunk failure cannot replace the newly selected view or reveal hidden editors', async () => {
  await fresh();
  await page.evaluate(() => window.mountFixture('literature'));
  await expect(page.getByTestId('fixture-literature')).toBeVisible();
  await page.evaluate(() => {window.modes.terminal = 'defer'; window.selectView('terminal');});
  await page.waitForFunction(() => typeof window.finishView.terminal === 'function');
  await page.evaluate(() => window.selectView('latex'));
  await expect(page.getByTestId('fixture-latex')).toBeVisible();
  await page.evaluate(() => window.finishView.terminal(false));
  await expect(page.getByTestId('view-load-error')).toHaveCount(0);
  await expect(page.getByTestId('fixture-latex')).toBeVisible();
  await expect(page.getByLabel('Draft for literature')).toBeHidden();
  assert.equal(await page.evaluate(() => window.loadCalls.filter(view => view === 'latex').length), 1);
  assert.deepEqual(pageErrors, []);
});

test('a nested chunk failure stays inside its canvas and recovery retains the other visited editor', async () => {
  await fresh();
  await page.evaluate(() => window.mountFixture('literature'));
  await page.getByLabel('Draft for literature').fill('Retained beside a failed nested view');
  await page.evaluate(() => {window.modes.terminal = 'nested-fail'; window.selectView('terminal');});
  await expect(page.getByTestId('view-content-error')).toContainText('Synthetic nested chunk failure');
  await page.evaluate(() => window.selectView('literature'));
  await expect(page.getByLabel('Draft for literature')).toHaveValue('Retained beside a failed nested view');
  await page.evaluate(() => {window.modes.terminal = 'ready'; window.selectView('terminal');});
  await page.getByTestId('view-content-error').getByRole('button', {name: '重试', exact: true}).click();
  await expect(page.getByLabel('Draft for terminal')).toBeVisible();
  assert.equal(await page.evaluate(() => window.loadCalls.filter(view => view === 'terminal').length), 2);
  await page.evaluate(() => window.selectView('literature'));
  await expect(page.getByLabel('Draft for literature')).toHaveValue('Retained beside a failed nested view');
  assert.deepEqual(pageErrors, []);
});

test('a delayed nested rejection in a hidden canvas cannot dismiss the active view', async () => {
  await fresh();
  await page.evaluate(() => {window.modes.terminal = 'nested-defer'; window.mountFixture('terminal');});
  await page.waitForFunction(() => typeof window.finishView['nested-terminal'] === 'function');
  await page.evaluate(() => window.selectView('latex'));
  await page.getByLabel('Draft for latex').fill('Active canvas remains intact');
  await page.evaluate(() => window.finishView['nested-terminal'](false));
  await expect(page.getByTestId('view-content-error')).toBeHidden();
  await expect(page.getByLabel('Draft for latex')).toHaveValue('Active canvas remains intact');
  assert.deepEqual(pageErrors, []);
});

test('a local retry replaces a cached rejection without remounting the parent or duplicating a suspended importer', async () => {
  await fresh();
  await page.evaluate(() => window.mountRegionFixture());
  await page.getByLabel('Retained parent draft').fill('Retained while the child loads');
  await page.evaluate(() => {window.bumpRegion(); window.bumpRegion();});
  assert.equal(await page.evaluate(() => window.fragmentCalls), 1);
  await page.evaluate(() => {window.showRegion(false); window.finishFragment(false);});
  await expect(page.getByTestId('content-load-error')).toHaveCount(0);
  await expect(page.getByLabel('Retained parent draft')).toHaveValue('Retained while the child loads');
  await page.evaluate(() => window.showRegion(true));
  await expect(page.getByTestId('content-load-error')).toContainText('Synthetic fragment load failure');
  await page.getByTestId('content-load-error').getByRole('button', {name: '重试', exact: true}).click();
  assert.equal(await page.evaluate(() => window.fragmentCalls), 2);
  await page.evaluate(() => window.finishFragment(true));
  await expect(page.getByText('Fragment ready', {exact: true})).toBeVisible();
  await expect(page.getByLabel('Retained parent draft')).toHaveValue('Retained while the child loads');
  assert.deepEqual(pageErrors, []);
});

test('answer formatting failure retains received text and retries locally without losing an adjacent draft', async () => {
  await fresh();
  await page.evaluate(() => window.mountAnswerFixture());
  await page.getByLabel('Adjacent draft').fill('Unsaved beside the received answer');
  await expect(page.getByTestId('assistant-answer-load-error')).toContainText('Synthetic answer formatting load failure');
  await expect(page.getByText('已收到的完整原始回答', {exact: true})).toBeVisible();
  assert.equal(await page.evaluate(() => window.markdownCalls), 1);
  await page.evaluate(() => {window.markdownReady = true;});
  await page.getByTestId('assistant-answer-load-error').getByRole('button', {name: '重试', exact: true}).click();
  await expect(page.getByTestId('fixture-markdown')).toContainText('已收到的完整原始回答');
  await expect(page.getByLabel('Adjacent draft')).toHaveValue('Unsaved beside the received answer');
  assert.equal(await page.evaluate(() => window.markdownCalls), 2);
  assert.deepEqual(pageErrors, []);
});
