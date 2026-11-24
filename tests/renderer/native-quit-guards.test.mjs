import {after, afterEach, before, beforeEach, test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import {build} from 'esbuild';

let directory, app, appProcess, page, logPath;
let fixture = 0;
const errors = [];

before(async () => {
  directory = mkdtempSync(join(process.cwd(), '.runtime/tmp/roc-native-quit-'));
  for (const area of ['main', 'preload', 'renderer']) mkdirSync(join(directory, 'dist', area), {recursive: true});
  mkdirSync(join(directory, 'resources'));
  copyFileSync('resources/trayTemplate.png', join(directory, 'resources/trayTemplate.png'));
  writeFileSync(join(directory, 'dist/preload/index.cjs'), '');
  writeFileSync(join(directory, 'dist/renderer/index.html'), `<html><body><input aria-label="Draft">
    <script>
      window.veto=false;
      window.addEventListener('beforeunload',event=>{
        if(window.veto){event.preventDefault();event.returnValue='';}
      });
    </script></body></html>`);

  const entry = resolve('src/main/index.ts');
  const replacements = {
    './macos-environment': 'export async function initializeMacOSPath() {}',
    './plugins/agent/runtime': 'export const agentChatRunEventType="agent.chat.run";',
    './plugins/workspace': 'export const workspaceChangedEventType="workspace.changed";',
    './plugins/skills': 'export const builtinSkillsUpdatedEventType="skills.updated";',
    './plugins/workspace/terminal-capabilities': `
      export const terminalSessionExitEventType="terminal.exit";
      export const terminalSessionOutputEventType="terminal.output";`,
    './ipc/register-ipc': 'export function registerIpc() {}',
    './main-kernel-bootstrap': `
      import {mkdirSync,appendFileSync} from 'node:fs';
      import {join} from 'node:path';
      import {app} from 'electron';
      export function createMainKernelBootstrap(input) {
        const configDir=join(app.getPath('userData'),'config');
        mkdirSync(configDir,{recursive:true});
        return {
          paths:{configDir},performanceObserverService:input.performanceObserverService,
          logService:{info(){},warn(){},error(){}},
          configService:{getSettings:()=>({startup:{openAtLogin:false},globalHotkey:null})},
          runtime:{async publishEvent(event) {
            globalThis.auditPublishedEvents.push(event);
            appendFileSync(globalThis.auditLogPath,'terminal-owner-closed\\n');
          }},
          async start(){},startDatabaseMaintenance(){},subscribeEvent(){},
          async invokeCapability() {
            globalThis.auditCapabilityReads++;
            if(globalThis.auditShutdownCount) throw new Error('kernel shut down');
            return {residentEnabled:true,backgroundPaused:false,
              backgroundTasks:{total:0,running:0,pendingConfirmation:0,failed:0,nextRunAt:null},
              nextRunAt:null,updatedAt:'2026-11-12T00:00:00Z'};
          },
          async shutdown() {
            globalThis.auditShutdownCount++;
            appendFileSync(globalThis.auditLogPath,'shutdown-start\\n');
            await globalThis.auditShutdownGate;
            appendFileSync(globalThis.auditLogPath,'shutdown-end\\n');
          }
        };
      }`,
    './macos-host-service': `
      import {MacOSHostService as RealHost} from ${JSON.stringify(resolve('src/main/macos-host-service.ts'))};
      export class MacOSHostService extends RealHost {
        constructor(input) {
          super({...input,createTray(path) {
            const tray=input.createTray(path);
            globalThis.auditTrayCreated++;
            return {...tray,destroy() {globalThis.auditTrayDestroyed++;tray.destroy();}};
          }});
          globalThis.auditHost=this;
        }
      }`
  };
  await build({
    entryPoints: [entry], outfile: join(directory, 'dist/main/index.mjs'),
    bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
    plugins: [{
      name: 'controlled-kernel-and-observed-native-host',
      setup(builder) {
        builder.onResolve({filter: /^\.\//}, args => {
          if (args.importer === entry && Object.hasOwn(replacements, args.path)) {
            return {path: args.path, namespace: 'quit-fixture'};
          }
        });
        builder.onLoad({filter: /.*/, namespace: 'quit-fixture'}, args => ({
          contents: replacements[args.path], loader: 'js', resolveDir: process.cwd()
        }));
      }
    }]
  });
});

beforeEach(async () => {
  fixture++;
  logPath = join(directory, `quit-${fixture}.log`);
  const main = join(directory, `launch-${fixture}.cjs`);
  writeFileSync(main, `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, `data-${fixture}`))});
    globalThis.auditLogPath=${JSON.stringify(logPath)};
    globalThis.auditShutdownCount=0;globalThis.auditCapabilityReads=0;
    globalThis.auditPublishedEvents=[];
    globalThis.auditTrayCreated=0;globalThis.auditTrayDestroyed=0;globalThis.auditPrevented=0;
    app.on('browser-window-created',(_event,window)=>{
      window.webContents.on('will-prevent-unload',()=>globalThis.auditPrevented++);
    });
    import('./dist/main/index.mjs');`);
  app = await _electron.launch({executablePath: electronPath, args: [main]});
  appProcess = app.process();
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.getByLabel('Draft').waitFor();
  await expect.poll(() => app.evaluate(() => globalThis.auditTrayCreated)).toBe(1);
});

afterEach(async () => {
  if (appProcess?.exitCode === null && appProcess.signalCode === null) {
    // Veto tests intentionally leave the fixture running with an unsaved draft.
    const exited = once(appProcess, 'exit', {signal: AbortSignal.timeout(5000)});
    appProcess.kill('SIGKILL');
    await exited;
  }
  appProcess = null;
  app = null;
});
after(() => {
  if (directory) rmSync(directory, {recursive: true, force: true});
  assert.deepEqual(errors, []);
});

async function cancelQuit() {
  await page.getByLabel('Draft').fill('unsaved draft');
  await page.evaluate(() => {window.veto = true;});
  await app.evaluate(({app}) => app.quit());
  await expect.poll(() => app.evaluate(() => globalThis.auditPrevented)).toBe(1);
}

test('a native quit veto preserves the live kernel, tray and renderer draft', {timeout: 15_000}, async () => {
  await cancelQuit();
  assert.equal(await page.getByLabel('Draft').inputValue(), 'unsaved draft');
  const state = await app.evaluate(() => ({
    shutdown: globalThis.auditShutdownCount, destroyed: globalThis.auditTrayDestroyed,
    reads: globalThis.auditCapabilityReads
  }));
  assert.equal(state.shutdown, 0);
  assert.equal(state.destroyed, 0);
  assert.deepEqual(await app.evaluate(() => globalThis.auditPublishedEvents), []);
  await app.evaluate(() => globalThis.auditHost.refreshTray());
  await expect.poll(() => app.evaluate(() => globalThis.auditCapabilityReads)).toBe(state.reads + 1);
});

test('a cancelled explicit quit restores macOS close-to-hide while retaining the draft', {timeout: 15_000}, async () => {
  await cancelQuit();
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].close());
  await expect.poll(() => app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
  assert.equal(await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().length), 1);
  assert.deepEqual(await app.evaluate(() => globalThis.auditPublishedEvents), []);
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].show());
  assert.equal(await page.getByLabel('Draft').inputValue(), 'unsaved draft');
});

test('an accepted native quit closes windows before shutdown and awaits exactly one kernel shutdown', {timeout: 15_000}, async () => {
  const ownerId = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.id);
  await app.evaluate(() => {
    globalThis.auditShutdownGate = new Promise(resolve => {globalThis.auditFinishShutdown = resolve;});
  });
  const exited = once(appProcess, 'exit');
  try {
    await app.evaluate(({app}) => app.quit());
    await expect.poll(() => app.evaluate(() => globalThis.auditShutdownCount)).toBe(1);
    assert.equal(await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().length), 0);
    assert.equal(appProcess.exitCode, null);
    assert.equal(await app.evaluate(() => globalThis.auditTrayDestroyed), 1);
    const events = await app.evaluate(() => globalThis.auditPublishedEvents);
    assert.deepEqual(events.map(({type, source, payload}) => ({type, source, payload})),
      [{type: 'terminal.owner.closed', source: '@roc/main', payload: ownerId}]);
    assert.ok(Number.isFinite(Date.parse(events[0].createdAt)));
  } finally {
    if (appProcess.exitCode === null) {
      await app.evaluate(() => {
        setTimeout(() => globalThis.auditFinishShutdown(), 25);
      });
    }
  }
  assert.deepEqual(await exited, [0, null]);
  assert.deepEqual(readFileSync(logPath, 'utf8').trim().split('\n'),
    ['terminal-owner-closed', 'shutdown-start', 'shutdown-end']);
});
