import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import {build} from 'esbuild';

let directory;

before(async () => {
  mkdirSync('.runtime/tmp', {recursive: true});
  directory = mkdtempSync(join(process.cwd(), '.runtime/tmp/roc-startup-ipc-'));
  for (const area of ['main', 'preload', 'renderer']) mkdirSync(join(directory, 'dist', area), {recursive: true});
  mkdirSync(join(directory, 'resources'));
  copyFileSync('resources/trayTemplate.png', join(directory, 'resources/trayTemplate.png'));
  writeFileSync(join(directory, 'dist/renderer/index.html'), `<html><body><output id="result"></output>
    <script>
      window.firstRequests = Promise.all([window.roc.app.getStatus(), window.roc.window.getState()])
        .then(results => ({results}), error => ({error: error.message}));
      window.firstRequests.then(result => document.querySelector('#result').textContent = JSON.stringify(result));
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
    './main-kernel-bootstrap': `
      import {mkdirSync} from 'node:fs';
      import {join} from 'node:path';
      import {app} from 'electron';
      import {RocPaths} from ${JSON.stringify(resolve('src/main/services/paths.ts'))};
      export function createMainKernelBootstrap(input) {
        const paths = new RocPaths(join(app.getPath('userData'),'roc'));
        mkdirSync(paths.configDir,{recursive:true});
        return {
          paths, performanceObserverService:input.performanceObserverService,
          logService:{info(){},warn(){},error(message,error){globalThis.startupErrors.push({message,error});}},
          configService:{getSettings:()=>({startup:{openAtLogin:false},globalHotkey:null})},
          runtime:{async publishEvent(){},reclaimTransientMemory(){return {}; }},
          async start(){
            if(globalThis.startupDelayed) await new Promise(resolve=>setTimeout(resolve,250));
            globalThis.startupReady=true;
          },
          startDatabaseMaintenance(){},subscribeEvent(){},async shutdown(){},
          async invokeCapability(name){
            if(!globalThis.startupReady) throw new Error('kernel_not_ready');
            if(name==='app.status.get') return {
              appName:'Roc',version:'0.1.0',mode:'development',startedAt:new Date().toISOString(),
              appearance:input.getAppearance(),workspace:{selectedPath:null,label:'No workspace'},
              paths:paths.snapshot(),services:{app:'ready'},defaultModelConfigured:false,
              rendererBoundary:{contextIsolation:true,nodeIntegration:false,
                sandbox:{enabled:false,evaluated:true,reason:null,compensatingControls:[]}}
            };
            if(name==='lifecycle.getTraySummary') return {
              residentEnabled:true,backgroundPaused:false,
              backgroundTasks:{total:0,running:0,pendingConfirmation:0,failed:0,nextRunAt:null},
              nextRunAt:null,updatedAt:new Date().toISOString()
            };
            throw new Error('Unexpected capability: '+name);
          }
        };
      }`
  };
  // Keep the real entry point, IPC registry, sender checks and generated preload.
  // Only the kernel and unrelated plugin imports are replaced.
  await build({
    entryPoints: [entry], outfile: join(directory, 'dist/main/index.mjs'),
    bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
    plugins: [{name: 'controlled-startup', setup(builder) {
      builder.onResolve({filter: /^\.\//}, args => {
        if (args.importer === entry && Object.hasOwn(replacements, args.path)) {
          return {path: args.path, namespace: 'startup-fixture'};
        }
      });
      builder.onLoad({filter: /.*/, namespace: 'startup-fixture'}, args => ({
        contents: replacements[args.path], loader: 'js', resolveDir: process.cwd()
      }));
    }}]
  });
  await build({
    entryPoints: ['src/preload/index.ts'], outfile: join(directory, 'dist/preload/index.cjs'),
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent'
  });
});

after(() => {
  if (directory) rmSync(directory, {recursive: true, force: true});
});

for (const delayed of [false, true]) {
  test(`first renderer IPC calls succeed with ${delayed ? 'delayed' : 'immediate'} kernel startup`, {timeout: 15_000}, async () => {
    const main = join(directory, `launch-${delayed}.cjs`);
    writeFileSync(main, `const {app}=require('electron');
      app.setPath('userData',${JSON.stringify(join(directory, `data-${delayed}`))});
      globalThis.startupErrors=[];
      globalThis.startupDelayed=${delayed};
      import('./dist/main/index.mjs');`);
    const env = {...process.env, ROC_DATA_ROOT: join(directory, `data-${delayed}/roc`)};
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_RENDERER_URL;
    const application = await _electron.launch({executablePath: electronPath, args: [main], env});
    try {
      const page = await application.firstWindow();
      await expect(page.locator('#result')).not.toHaveText('');
      const result = await page.evaluate(() => window.firstRequests);
      assert.equal(result.error, undefined, result.error);
      assert.deepEqual(result.results.map(item => item.ok), [true, true], JSON.stringify(result));
      assert.equal(result.results[0].data.appName, 'Roc');
      assert.equal(typeof result.results[1].data.maximized, 'boolean');
      assert.deepEqual(await application.evaluate(() => globalThis.startupErrors), []);
      await expect.poll(() => application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
    } finally {
      await application.close();
    }
  });
}
