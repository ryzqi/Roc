import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {build} from 'esbuild';
import electronPath from 'electron';
import {_electron} from '@playwright/test';

test('built app runs sandboxed and rejects foreign-window IPC and injected scripts', {timeout: 90_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'roc-security-'));
  let app;
  const errors = [];
  try {
    const env = {...process.env, ROC_SMOKE: '1', ROC_DATA_ROOT: directory};
    delete env.ELECTRON_RENDERER_URL;
    app = await _electron.launch({executablePath: electronPath, args: [resolve('dist/main/index.js')], env});
    const page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForSelector('[data-testid="portal"]', {timeout: 40_000});
    assert.equal((await page.evaluate(() => window.roc.app.getStatus())).ok, true);
    const prefs = await app.evaluate(({BrowserWindow}) => {
      const window = BrowserWindow.getAllWindows()[0];
      const p = window.webContents.getLastWebPreferences();
      return {sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration};
    });
    assert.deepEqual(prefs, {sandbox: true, contextIsolation: true, nodeIntegration: false});
    assert.deepEqual(await page.evaluate(() => [typeof process, typeof require]), ['undefined', 'undefined']);

    const workspaceBefore = await page.evaluate(() => window.roc.workspace.getCurrent());
    const foreign = await app.evaluate(async ({BrowserWindow}, {preload, path}) => {
      // Deliberately grant the real bridge to an untrusted window: the main
      // process must still reject both reads and writes before side effects.
      const w = new BrowserWindow({show: false, webPreferences: {preload, sandbox: true, contextIsolation: true}});
      try {
        await w.loadURL('data:text/html,<title>untrusted</title>');
        return await w.webContents.executeJavaScript(`Promise.all([
          window.roc.app.getStatus(), window.roc.workspace.select({path: ${JSON.stringify(path)}})
        ])`);
      } finally { w.destroy(); }
    }, {preload: resolve('dist/preload/index.cjs'), path: directory});
    for (const response of foreign) {
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'ipc_sender_forbidden');
    }
    assert.deepEqual(await page.evaluate(() => window.roc.workspace.getCurrent()), workspaceBefore);

    const policyResult = await page.evaluate(async () => {
      const violations = [];
      const listener = event => violations.push(event.effectiveDirective);
      document.addEventListener('securitypolicyviolation', listener);
      const inline = document.createElement('script');
      inline.textContent = 'window.injected = true';
      document.head.append(inline);
      const remote = document.createElement('script');
      remote.src = 'https://untrusted.invalid/injected.js';
      document.head.append(remote);
      // Leave DevTools' evaluation stack: it intentionally permits unsafe eval
      // for debugger expressions, which must not be mistaken for page authority.
      await new Promise(resolve => setTimeout(resolve, 0));
      let evaluated = false;
      try { new Function('window.injected = true')(); evaluated = true; } catch {}
      let connected = false;
      try { await fetch('https://untrusted.invalid/data'); connected = true; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
      document.removeEventListener('securitypolicyviolation', listener);
      inline.remove(); remote.remove();
      return {injected: window.injected === true, evaluated, connected, violations};
    });
    assert.equal(policyResult.injected, false);
    assert.equal(policyResult.evaluated, false);
    assert.equal(policyResult.connected, false);
    assert.ok(policyResult.violations.includes('script-src-elem'));
    assert.ok(policyResult.violations.includes('connect-src'));
    assert.deepEqual(errors, []);
  } finally {
    try { await app?.close(); } finally { await rm(directory, {recursive: true, force: true}); }
  }
});

test('real child frames and a navigated main frame cannot inherit IPC authority', {timeout: 30_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'roc-sender-frames-'));
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(request.url === '/' ? '<title>trusted</title><iframe src="/child"></iframe>' : '<title>other</title>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const entry = `http://127.0.0.1:${server.address().port}/`;
  let app;
  try {
    await build({entryPoints: ['src/main/ipc/ipc-sender.ts'], outfile: join(directory, 'sender.cjs'),
      bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent'});
    await writeFile(join(directory, 'preload.cjs'), `
      const {contextBridge,ipcRenderer}=require('electron');
      contextBridge.exposeInMainWorld('probe',()=>ipcRenderer.invoke('probe'));`);
    await writeFile(join(directory, 'main.cjs'), `
      const {app,BrowserWindow,ipcMain}=require('electron');
      const {createIpcSenderValidator}=require('./sender.cjs');
      app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
      app.whenReady().then(()=>{
        const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,
          preload:${JSON.stringify(join(directory, 'preload.cjs'))},nodeIntegrationInSubFrames:true}});
        const validate=createIpcSenderValidator(window,${JSON.stringify(entry)});
        ipcMain.handle('probe',event=>validate(event));
        window.loadURL(${JSON.stringify(entry)});
      });`);
    app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof window.probe === 'function');
    assert.equal(await page.evaluate(() => window.probe()), true);
    const frame = page.frame({url: entry + 'child'});
    assert.ok(frame);
    await frame.waitForFunction(() => typeof window.probe === 'function');
    assert.equal(await frame.evaluate(() => window.probe()), false);
    await page.goto(entry + 'other');
    assert.equal(await page.evaluate(() => window.probe()), false);
  } finally {
    try { await app?.close(); } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(directory, {recursive: true, force: true});
    }
  }
});

test('development renderer keeps its bridge and Vite refresh under the development CSP', {timeout: 90_000}, async () => {
  const {createServer: createViteServer, loadConfigFromFile} = await import('vite');
  const loaded = await loadConfigFromFile({command: 'serve', mode: 'development'}, resolve('electron.vite.config.ts'));
  assert.ok(loaded);
  const server = await createViteServer({...loaded.config.renderer, configFile: false,
    server: {host: '127.0.0.1', port: 0}});
  const directory = await mkdtemp(join(tmpdir(), 'roc-security-dev-'));
  let app;
  try {
    await server.listen();
    const url = server.resolvedUrls.local[0];
    app = await _electron.launch({executablePath: electronPath, args: [resolve('dist/main/index.js')],
      env: {...process.env, ROC_SMOKE: '1', ROC_DATA_ROOT: directory, ELECTRON_RENDERER_URL: url}});
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForSelector('[data-testid="portal"]', {timeout: 60_000});
    assert.equal((await page.evaluate(() => window.roc.app.getStatus())).ok, true);
    assert.deepEqual(await page.evaluate(() => [typeof window.$RefreshReg$, typeof window.$RefreshSig$]),
      ['function', 'function']);
    const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    assert.match(policy, /script-src 'self' 'unsafe-inline'/u);
    assert.match(policy, /connect-src 'self' roc-preview: ws: wss:/u);
    assert.deepEqual(errors, []);
  } finally {
    try { await app?.close(); } finally {
      await server.close();
      await rm(directory, {recursive: true, force: true});
    }
  }
});
