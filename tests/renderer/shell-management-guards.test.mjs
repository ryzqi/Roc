import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';

let directory, app, page;
const errors = [];

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-shell-management-guards-'));
  await build({
    stdin: {resolveDir: process.cwd(), loader: 'tsx', contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {LazyMotion, domMax, MotionConfig} from 'motion/react';
      import {AppShell} from './src/renderer/app/AppShell';
      import {BEFORE_NAVIGATE} from './src/renderer/app/navigation-guard';
      import {BEFORE_ARTIFACT_CHANGE} from './src/renderer/artifacts/artifact-interactions';
      const ok = data => ({ok: true, data});
      const task = id => ({id, projectId: 'project-a', goal: id, status: 'active', statusReason: null});
      const diagnostics = id => ({
        task: task(id), executions: [], graph: {revision: 0, nodes: [], edges: []}, recoveryIssues: [],
        eventDelivery: {pending: 0, failed: 0}, canRestoreApproval: false, continuationRunId: null,
        usage: {tokens: {settled: 0, reserved: 0, unknown: 0},
          calls: {models: {total: 0}, tools: {total: 0}, children: {total: 0}}}
      });
      window.calls = [];
      window.gitCalls = [];
      const gitSnapshot=()=>({workspacePath:window.boundPath??'/workspace',isRepository:true,branch:'main',
        porcelain:[],changes:[],changedFiles:1});
      window.menuListeners = new Set();
      const client = {api: {
        app: {
          getStatus: async () => ok({mode: 'normal', appearance: {
            resolvedTheme: 'light', themeSource: 'system', accentColor: '#007aff',
            inForcedColorsMode: false, shouldUseHighContrastColors: false, prefersReducedTransparency: false
          }}),
          onAppearanceUpdated: () => () => {},
          onNavigate: listener => {menuListeners.add(listener); return () => menuListeners.delete(listener);}
        },
        window: {getState: async () => ok({maximized: false, minimized: false, fullscreen: false}),
          onHidden: () => () => {}},
        lifecycle: {getTraySummary: async () => ok({backgroundPaused: false,
          backgroundTasks: {running: 0, pendingConfirmation: 0, failed: 0},
          researchTasks: {running: 0, pendingConfirmation: 0, failed: 0}})},
        workspace:{onChanged:()=>()=>{}},
        rtk:{status:async()=>({ok:false,error:{message:'Synthetic RTK unavailable'}})},
        git:{
          status:async()=>ok(gitSnapshot()),diffStat:async()=>ok({workspacePath:gitSnapshot().workspacePath,stat:''}),
          listBranches:async()=>ok({workspacePath:gitSnapshot().workspacePath,currentBranch:'main',branches:[]}),
          commit:request=>{window.gitCalls.push(request);return new Promise(resolve=>{window.finishCommit=resolve;});}
        },
        research: {
          getProject: async ({id}) => ok({id, title: id, status: 'active', workspacePath: '/workspace'}),
          listPythonEnvironmentSelections: async () => ok([]),
          listTasks: async () => ok({tasks: [task('task-a'), task('task-b')], nextTaskId: 'task-b', hasMore: false}),
          getTaskDiagnostics: async ({taskId}) => ok(diagnostics(taskId)),
          getTaskEvents: async () => ok({events: [], hasMore: false, nextSequence: 0, gap: null}),
          getTaskFacts: async () => ok({snapshot: null, freshness: [], authority: 'research_data_only'}),
          getTaskFactsHistory: async () => ok({snapshots: [], nextRevision: null, hasMore: false}),
          saveTaskFacts: request => {
            window.calls.push(request);
            return new Promise(resolve => {window.finishSave = resolve;});
          },
          onTaskUpdated: () => () => {}
        }
      }};
      const root = createRoot(document.getElementById('root'));
      const veto = event => event.preventDefault();
      window.setVeto = (kind, enabled) => window[enabled ? 'addEventListener' : 'removeEventListener'](
        kind === 'navigation' ? BEFORE_NAVIGATE : BEFORE_ARTIFACT_CHANGE, veto);
      window.unmount = () => flushSync(() => root.render(null));
      window.mount = (view = 'literature') => {
        unmount(); setVeto('navigation', false); setVeto('artifact', false);
        window.gitCalls=[];window.boundPath='/workspace';
        history.replaceState(null, '', '?project=project-a&view=' + view + '&assistant=1');
        flushSync(() => root.render(<MotionConfig reducedMotion="always"><LazyMotion features={domMax} strict>
          <AppShell client={client}/>
        </LazyMotion></MotionConfig>));
      };
      window.menu = page => {for (const listener of menuListeners) listener(page);};
      window.mount();
    `},
    bundle: true, format: 'iife', outfile: join(directory, 'app.js'), logLevel: 'silent',
    plugins: [{
      name: 'controlled-shell-data-sources',
      setup(builder) {
        const sources = {
          '/project/use-projects.ts': `export function useCurrentProject(client, id) {
            return {status: 'ready', data: id ? {id, title: id, status: 'active', workspacePath: '/workspace'} : null,
              reload: () => {}};
          }`,
          '/project/use-project-workspace.ts': `export const useProjectWorkspace = () => ({
            bind: () => {}, pending: false, error: null
          });`,
          '/workspace/use-bound-workspace.ts': `export const useBoundWorkspace = () => ({
            path: window.boundPath??'/workspace', status: 'ready', error: null, rebind: () => {}
          });`,
          '/literature/use-literature-store.ts': `export const useLiteratureStore = () => ({
            items: [], claims: null, evidence: null, wikiSnapshot: null, assistant: {threadId: null},
            select: () => {}, adoptAssistantThread: () => {}
          });`,
          '/shell/use-search-groups.ts': `export function useSearchGroups(input) {
            window.searchEntries = input; return [];
          }`,
          '/shell/LeftSidebar.tsx': `import React from 'react';
            export function LeftSidebar(props) {window.sidebarEntries = props; return <aside/>;}`,
          '/project/ProjectPortalView.tsx': `import React from 'react';
            export function ProjectPortalView() {return <section>科研项目</section>;}`,
          '/management/management-stores-provider.tsx': `export const ManagementStoresProvider = ({children}) => children;
            export const useManagementStores = () => null;`,
          '/app/ViewContent.tsx': `import React from 'react';
            import {ManagementView} from '../management/ManagementView';
            import {useWorkspaceScope} from './workspace-scope';
            import {useManagement} from '../management/management-scope';
            export function ViewContent(props) {
              window.workspaceEntries = useWorkspaceScope(); window.managementEntries = useManagement();
              return ['memory', 'skills', 'mcp'].includes(props.view)
                ? <ManagementView {...props}/> : <section data-testid="shell-canvas-content">{props.view}</section>;
            }`,
          '/assistant/AssistantPanel.tsx': `import React from 'react';
            export function AssistantPanel(props) {window.assistantEntries = props;
              return <section data-testid="shell-assistant-content">助手</section>;}`,
          '/settings/SettingsModal.tsx': `import React from 'react';
            import {ModalShell} from '../shell/ModalShell';
            export function SettingsModal({open, onClose}) {
              return <ModalShell open={open} onClose={onClose} title="设置" testId="shell-settings"><p>设置</p></ModalShell>;
            }`,
          '/artifacts/ArtifactInspector.tsx': `import React,{useState,useRef} from 'react';
            import {ModalShell} from '../shell/ModalShell';
            import {ArtifactEditorBoundary,useArtifactEditorGuard,useArtifactEditorStatus} from './artifact-editor-guard';
            export function ArtifactInspector(props) {return <ArtifactEditorBoundary projectId={props.selection.request.projectId}>
              <Content {...props}/></ArtifactEditorBoundary>;}
            function Content(props){window.artifactEntries=props;
              const [note,setNote]=useState('');const fields=useRef('');const guard=useArtifactEditorGuard();
              useArtifactEditorStatus({label:'工件备注',dirty:()=>fields.current!=='',pending:false});
              return <ModalShell open onClose={()=>guard.request(props.onClose)} title="工件" testId="shell-artifact">
                <p>{props.selection.request.artifactId}</p>
                <textarea aria-label="工件备注" value={note} onChange={event=>{fields.current=event.target.value;setNote(event.target.value);}}/>
              </ModalShell>;
            }`
        };
        builder.onLoad({filter: /\/src\/renderer\/.*\.(?:tsx|ts)$/}, ({path}) => {
          const key = Object.keys(sources).find(suffix => path.endsWith(suffix));
          return key ? {contents: sources[key], loader: 'tsx'} : undefined;
        });
      }
    }]
  });
  const assets = join(process.cwd(), 'dist/renderer/assets');
  const styles = await Promise.all((await readdir(assets)).filter(file => file.endsWith('.css'))
    .map(file => readFile(join(assets, file), 'utf8')));
  await writeFile(join(directory, 'app.css'), styles.join('\n'));
  await writeFile(join(directory, 'index.html'), `<html data-theme="light"><link rel="stylesheet" href="app.css">
    <style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="app.js"></script></html>`);
  await writeFile(join(directory, 'main.cjs'), `
    const {app, BrowserWindow} = require('electron');
    app.setPath('userData', ${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(() => new BrowserWindow({show: false, width: 1280, height: 900})
      .loadFile(${JSON.stringify(join(directory, 'index.html'))}));
  `);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow();
  page.setDefaultTimeout(4000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('roc-app').waitFor();
});

after(async () => {
  await page?.evaluate(() => unmount()).catch(() => {});
  try {await app?.close();} finally {if (directory) await rm(directory, {recursive: true, force: true});}
  assert.deepEqual(errors, []);
});

const content = () => page.getByTestId('mgmt-task-fact-content');
const discard = () => page.getByTestId('mgmt-editor-discard');
const cancel = () => discard().getByRole('button', {name: '继续编辑', exact: true}).click();
const confirm = () => discard().getByRole('button', {name: '放弃修改并继续', exact: true}).click();

async function openTask() {
  await page.evaluate(() => {mount();});
  await page.getByTestId('shell-assistant-content').waitFor();
  await page.evaluate(() => assistantEntries.onOpenTask('task-a'));
  await page.getByTestId('mgmt-task-select').waitFor();
  await page.evaluate(() => document.querySelector('[data-testid="titlebar-toggle-assistant"]').click());
  await content().fill('当前任务尚未保存的事实');
}

test('actual shell assistant and management selections preserve facts until the selected transition is accepted', async () => {
  for (const entry of ['assistant', 'management', 'chrome']) {
    await openTask();
    await page.evaluate(entry => {
      if (entry === 'assistant') assistantEntries.onOpenTask('task-b');
      else if (entry === 'management') managementEntries.onSelectResearchTask('task-b');
      else document.querySelector('[data-testid="titlebar-management"]').click();
    }, entry);
    await discard().waitFor();
    await cancel();
    await expect(content()).toHaveValue('当前任务尚未保存的事实');
    await expect(page.getByTestId('mgmt-task-select')).toHaveValue('task-a');
  }
  await page.evaluate(() => assistantEntries.onOpenTask('task-b'));
  await confirm();
  await expect(page.getByTestId('mgmt-task-select')).toHaveValue('task-b');
  await expect(content()).toHaveValue('');
});

test('actual shell management exits keep the drawer until facts and navigation guards have both released', async () => {
  for (const entry of ['settings', 'workspace-settings', 'thread', 'assistant', 'canvas']) {
    await openTask();
    await page.evaluate(entry => {
      setVeto('navigation', true);
      if (entry === 'settings') managementEntries.openSettings();
      else if (entry === 'workspace-settings') workspaceEntries.openSettings();
      else if (entry === 'thread') managementEntries.onOpenThread('thread-b');
      else if (entry === 'assistant') managementEntries.onAskAssistant('验证草稿');
      else searchEntries.onOpenManagementView('memory');
    }, entry);
    await discard().waitFor();
    await confirm();
    await expect(page.getByTestId('management-panel')).toBeVisible();
    assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get('view')), 'literature');
    assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get('page')), 'research');
    assert.equal(await page.evaluate(() => assistantEntries.threadId), null);
    assert.equal(await page.evaluate(() => assistantEntries.composerSeed), null);
  }
  await page.evaluate(() => {setVeto('navigation', false); managementEntries.openSettings();});
  await page.getByTestId('shell-settings').waitFor();
  await expect(page.getByTestId('management-panel')).toHaveCount(0);
});

test('actual shell artifact handoff waits for its inspector guard and returns to the selected task', async () => {
  await openTask();
  await page.evaluate(() => {
    setVeto('artifact', true);
    managementEntries.onOpenArtifact({projectId: 'project-a', artifactId: 'artifact-a', expectedVersion: 'a'.repeat(64)}, () => {});
  });
  await discard().waitFor();
  await confirm();
  await expect(page.getByTestId('management-panel')).toBeVisible();
  await expect(page.getByTestId('shell-artifact')).toHaveCount(0);
  await page.evaluate(() => {
    setVeto('artifact', false);
    managementEntries.onOpenArtifact({projectId: 'project-a', artifactId: 'artifact-a', expectedVersion: 'a'.repeat(64)}, () => {});
  });
  await page.getByTestId('shell-artifact').waitFor();
  await page.evaluate(() => artifactEntries.onOpenTask('task-b'));
  await expect(page.getByTestId('mgmt-task-select')).toHaveValue('task-b');
  await expect(page.getByTestId('shell-artifact')).toHaveCount(0);
});

test('actual canvas management facts veto view navigation and native unload while a save is pending', async () => {
  await page.evaluate(() => mount('memory'));
  await page.getByTestId('mgmt-view-tab-tasks').click();
  await page.getByTestId('mgmt-task-select').selectOption('task-a');
  await content().fill('画布中未保存的任务事实');
  await page.evaluate(() => workspaceEntries.openView('terminal'));
  await discard().waitFor();
  await cancel();
  await expect(content()).toHaveValue('画布中未保存的任务事实');
  await page.getByTestId('mgmt-task-fact-save').click();
  await expect(content()).toBeDisabled();
  await page.evaluate(() => workspaceEntries.openView('terminal'));
  assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get('view')), 'memory');
  assert.equal(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', {cancelable: true}))), true);
  await page.evaluate(() => finishSave({ok: false, error: {message: '保留事实以重试'}}));
  await expect(content()).toBeEnabled();
  await page.evaluate(() => workspaceEntries.openView('terminal'));
  await confirm();
  await expect(page.getByTestId('shell-canvas-content')).toHaveText('terminal');
});

async function openGit() {
  await page.getByTestId('titlebar-git').click();
  await expect(page.getByTestId('git-commit-message')).toBeVisible();
  await expect(page.getByTestId('git-commit-message')).toBeEnabled();
}

test('actual shell Git draft survives close, reopens by workspace and guards native unload while hidden',async()=>{
  await page.evaluate(()=>mount());await openGit();
  await page.getByTestId('git-commit-message').fill('Uncommitted repository message');
  await page.getByTestId('git-drawer-scrim').click({position:{x:20,y:20}});
  await expect(page.getByTestId('git-commit-message')).toHaveValue('Uncommitted repository message');
  await page.keyboard.press('Escape');await expect(page.getByTestId('git-drawer')).toHaveCount(0);
  assert.equal(await page.evaluate(()=>!window.dispatchEvent(new Event('beforeunload',{cancelable:true}))),true);
  await openGit();await expect(page.getByTestId('git-commit-message')).toHaveValue('Uncommitted repository message');
  await page.keyboard.press('Escape');await expect(page.getByTestId('git-drawer')).toHaveCount(0);
  await page.evaluate(()=>{boundPath='/workspace-other';searchEntries.onOpenProject('project-b');});
  await openGit();await expect(page.getByTestId('git-commit-message')).toHaveValue('');
  await page.getByTestId('git-commit-message').fill('Different workspace draft');
  await page.keyboard.press('Escape');await expect(page.getByTestId('git-drawer')).toHaveCount(0);
  await page.evaluate(()=>{boundPath='/workspace';searchEntries.onOpenProject('project-a');});
  await openGit();await expect(page.getByTestId('git-commit-message')).toHaveValue('Uncommitted repository message');
});

test('actual shell Git pending commit synchronously vetoes closing and retains failure for retry',async()=>{
  await page.evaluate(()=>mount());await openGit();
  await page.getByTestId('git-commit-message').fill('Original commit message');
  await page.evaluate(()=>{
    const commit=document.querySelector('[data-testid="git-commit"]');commit.click();commit.click();
    document.querySelector('[data-testid="git-drawer-close"]').click();
  });
  assert.equal(await page.evaluate(()=>gitCalls.length),1);
  assert.equal(await page.evaluate(()=>new URLSearchParams(location.search).get('tool')),'git');
  assert.equal(await page.evaluate(()=>!window.dispatchEvent(new Event('beforeunload',{cancelable:true}))),true);
  await expect(page.getByTestId('git-drawer')).toBeVisible();
  await expect(page.getByTestId('git-commit-message')).toBeDisabled();
  await page.evaluate(()=>searchEntries.onOpenProject('project-b'));
  assert.equal(await page.evaluate(()=>new URLSearchParams(location.search).get('project')),'project-a');
  await page.keyboard.press('Escape');await expect(page.getByTestId('git-drawer')).toBeVisible();
  await page.evaluate(()=>finishCommit({ok:false,error:{message:'Synthetic commit refused'}}));
  await expect(page.getByRole('alert')).toContainText('Synthetic commit refused');
  await expect(page.getByTestId('git-commit-message')).toHaveValue('Original commit message');
  await page.getByTestId('git-commit').click();
  assert.deepEqual(await page.evaluate(()=>gitCalls),[{message:'Original commit message'},{message:'Original commit message'}]);
  await page.evaluate(()=>finishCommit({ok:true,data:{workspacePath:'/workspace',commitMessage:'Original commit message',
    commitSha:'a'.repeat(40),status:{workspacePath:'/workspace',isRepository:true,branch:'main',porcelain:[],changes:[],changedFiles:0}}}));
  await expect(page.getByTestId('git-commit-message')).toHaveValue('');
  assert.equal(await page.evaluate(()=>!window.dispatchEvent(new Event('beforeunload',{cancelable:true}))),false);
});

test('actual shell artifact replacement keeps the previous editor until all deferrals release',async()=>{
  await page.evaluate(()=>mount());await page.getByTestId('shell-assistant-content').waitFor();
  await page.evaluate(()=>assistantEntries.onOpenArtifact({projectId:'project-a',artifactId:'artifact-a',expectedVersion:'a'.repeat(64)},()=>{}));
  await expect(page.getByTestId('shell-artifact')).toContainText('artifact-a');
  await page.getByLabel('工件备注',{exact:true}).fill('Draft on original artifact');
  await page.evaluate(()=>assistantEntries.onOpenArtifact({projectId:'project-a',artifactId:'artifact-b',expectedVersion:'b'.repeat(64)},()=>{}));
  await page.getByTestId('artifact-draft-discard-cancel').click();
  await expect(page.getByLabel('工件备注',{exact:true})).toHaveValue('Draft on original artifact');
  await page.evaluate(()=>{
    setVeto('artifact',true);
    assistantEntries.onOpenArtifact({projectId:'project-a',artifactId:'artifact-b',expectedVersion:'b'.repeat(64)},()=>{});
  });
  await page.getByTestId('artifact-draft-discard-confirm').click();
  await expect(page.getByTestId('shell-artifact')).toContainText('artifact-a');
  await page.evaluate(()=>{
    setVeto('artifact',false);
    assistantEntries.onOpenArtifact({projectId:'project-a',artifactId:'artifact-b',expectedVersion:'b'.repeat(64)},()=>{});
    assistantEntries.onOpenArtifact({projectId:'project-a',artifactId:'artifact-c',expectedVersion:'c'.repeat(64)},()=>{});
  });
  await page.getByTestId('artifact-draft-discard-confirm').click();
  await expect(page.getByTestId('shell-artifact')).toContainText('artifact-c');
  await expect(page.getByLabel('工件备注',{exact:true})).toHaveValue('');
});
