import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
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
      import {clearUiState, readOnboardingDismissed} from './src/renderer/app/ui-state';
      import {exportUxMetrics} from './src/renderer/app/ux-metrics';
      window.onboardingDismissed=readOnboardingDismissed;
      window.resetUiState=clearUiState;
      window.uxMetrics=()=>JSON.parse(exportUxMetrics());
      const ok = data => ({ok: true, data});
      const task = id => ({id, projectId: 'project-a', goal: id, status: 'active', statusReason: null,
        updatedAt: '2026-11-20T00:00:00.000Z'});
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
          onHidden: () => () => {}, onResourcePressure: () => () => {}},
        lifecycle: {getTraySummary: async () => ok({backgroundPaused: false,
          backgroundTasks: {running: 0, pendingConfirmation: 0, failed: 0},
          researchTasks: {running: 0, pendingConfirmation: 0, failed: 0}})},
        workspace:{onChanged:()=>()=>{}},
        tasks: {listBackgroundTasks: async () => ok([]), getSnapshot: async () => ok({threads: []}), onUpdated: () => () => {}},
        rtk:{status:async()=>({ok:false,error:{message:'Synthetic RTK unavailable'}})},
        git:{
          status:async()=>ok(gitSnapshot()),diffStat:async()=>ok({workspacePath:gitSnapshot().workspacePath,stat:''}),
          listBranches:async()=>ok({workspacePath:gitSnapshot().workspacePath,currentBranch:'main',branches:[]}),
          commit:request=>{window.gitCalls.push(request);return new Promise(resolve=>{window.finishCommit=resolve;});}
        },
        research: {
          getProject: async ({id}) => ok({id, title: id, status: 'active', workspacePath: '/workspace'}),
          listProjects: async () => ok([]),
          listPythonEnvironmentSelections: async () => ok([]),
          listTasks: async () => ok({tasks: window.overviewTasks ?? [task('task-a'), task('task-b')], nextTaskId: 'task-b', hasMore: false}),
          listArtifacts: async () => ok([]),
          listAcquisition: async () => ok({jobs: [], total: 0, nextOffset: null}),
          onLibraryChanged: () => () => {},
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
      window.mount = (view = 'library') => {
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
            query: '', error: null, status: 'ready', selectedId: null, requestImport: () => {},
            select: () => {}, adoptAssistantThread: () => {}
          });`,
          '/shell/use-search-groups.ts': `export function useSearchGroups(input) {
            window.searchEntries = input; return [];
          }`,
          '/canvas/files/FileSidebarPanel.tsx': `export const FileSidebarPanel = () => null;`,
          '/literature/LibraryList.tsx': `export const LibraryList = () => null;`,
          '/project/ProjectPortalView.tsx': `import React from 'react';
            export function ProjectPortalView() {return <section>科研项目</section>;}`,
          '/management/management-stores-provider.tsx': `export const ManagementStoresProvider = ({children}) => children;
            export const useManagementStores = () => null;`,
          '/app/ViewContent.tsx': `import React from 'react';
            import {useWorkspaceScope} from './workspace-scope';
            import {useManagement} from '../management/management-scope';
            import {RunsView} from '../management/RunsView';
            import {OverviewView} from '../project/OverviewView';
            export function ViewContent(props) {
              const scope=useWorkspaceScope();window.workspaceEntries = scope;window.managementEntries = useManagement();
              return <><section data-testid="shell-canvas-content">{props.subview ?? props.view}</section>
                {props.view==='runs' ? <RunsView/> : null}
                {props.view==='overview' && props.subview===null ? <OverviewView/> : null}</>;
            }`,
          '/assistant/AssistantPanel.tsx': `import React from 'react';
            export function AssistantPanel(props) {window.assistantEntries = props;
              return <section data-testid="shell-assistant-content">助手
                {props.showNewThread ? <button onClick={()=>props.onThreadIdChange(null)}>新建会话</button> : null}</section>;}`,
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

async function openTask(view = 'library') {
  await page.evaluate(view => {mount(view);}, view);
  await page.getByTestId('shell-assistant-content').waitFor();
  await page.evaluate(() => assistantEntries.onOpenTask('task-a'));
  await page.getByTestId('mgmt-task-select').waitFor();
  await expect(page.getByTestId('titlebar-toggle-assistant')).toHaveAttribute('aria-pressed', 'false');
  await content().fill('当前任务尚未保存的事实');
}

test('project management stays reachable from every view without opening the assistant or sidebar', async () => {
  for (const view of ['overview', 'library', 'writing', 'runs']) {
    await page.evaluate(view => mount(view), view);
    await page.getByTestId('shell-assistant-content').waitFor();
    await page.getByTestId('titlebar-toggle-assistant').click();
    const sidebar = page.getByTestId('titlebar-toggle-sidebar');
    if (await sidebar.getAttribute('aria-pressed') === 'true') await sidebar.click();
    const management = page.getByRole('button', {name: '管理', exact: true});
    await expect(management).toHaveCount(1);
    await expect(management).toBeVisible();
    await management.click();
    await expect(page.getByTestId('management-panel-panel')).toBeVisible();
    await expect(page.getByTestId('mgmt-tab-memory')).toHaveAttribute('aria-selected', 'true');
    assert.equal(new URL(page.url()).searchParams.get('view'), view);
    await expect(page.getByTestId('titlebar-toggle-assistant')).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId('management-panel-close').click();
  }
});

test('layout choices share one trigger and opening it does not open the assistant', async () => {
  await page.evaluate(() => mount());
  await page.getByTestId('shell-assistant-content').waitFor();
  await page.getByTestId('titlebar-toggle-assistant').click();
  await expect(page.getByTestId('layout-preset-research')).toBeHidden();
  await expect(page.getByTestId('layout-preset-writing')).toBeHidden();
  await expect(page.getByTestId('layout-preset-review')).toBeHidden();
  const trigger = page.getByRole('button', {name: '工作布局', exact: true});
  await expect(trigger).toHaveCount(1);
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('layout-preset-research')).toBeVisible();
  await expect(page.getByTestId('titlebar-toggle-assistant')).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('layout-preset-writing').click();
  await expect(page.getByTestId('layout-preset-writing')).toBeHidden();
  assert.equal(new URL(page.url()).searchParams.get('layoutPreset'), 'writing');
  await expect(page.getByTestId('titlebar-toggle-assistant')).toHaveAttribute('aria-pressed', 'false');
  await trigger.click();
  await page.getByTestId('layout-preset-review').click();
  assert.equal(new URL(page.url()).searchParams.get('layoutPreset'), 'review');
  await expect(page.getByTestId('titlebar-toggle-assistant')).toHaveAttribute('aria-pressed', 'true');
});

test('overview onboarding and shortcuts never repeat the same action', async () => {
  await page.evaluate(() => {window.overviewTasks = []; mount('overview');});
  await page.getByTestId('titlebar-toggle-assistant').click();
  const overview = page.getByTestId('overview');
  await page.getByTestId('overview-first-steps').waitFor();
  for (const name of ['检索论文', '导入 PDF', '打开写作', '问我的资料', '打开文献库']) {
    await expect(overview.getByRole('button', {name, exact: true})).toHaveCount(1);
  }
  await expect(overview.getByRole('button', {name: '打开助手', exact: true})).toHaveCount(0);
  await page.getByTestId('overview-first-steps-skip').click();
  for (const name of ['检索论文', '导入 PDF', '打开写作', '问我的资料', '打开文献库']) {
    await expect(overview.getByRole('button', {name, exact: true})).toHaveCount(1);
  }
  await page.evaluate(() => {delete window.overviewTasks;});
});

test('new session has one reachable action when context and assistant share the window', async () => {
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  try {
    await page.evaluate(() => {resetUiState(); mount('runs');});
    await expect(page.getByTestId('workspace-layout')).toHaveAttribute('data-layout-mode', 'wide');
    await expect(page.getByTestId('sidebar-column')).toBeVisible();
    await expect(page.getByRole('button', {name: '新建会话', exact: true})).toHaveCount(1);
    await page.getByTestId('titlebar-toggle-assistant').click();
    await expect(page.getByTestId('session-new')).toBeVisible();
    await page.getByTestId('session-new').click();
    await expect(page.getByTestId('titlebar-toggle-assistant')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', {name: '新建会话', exact: true})).toHaveCount(1);
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1184, 900));
    await expect(page.getByTestId('workspace-layout')).toHaveAttribute('data-layout-mode', 'balanced');
    await expect(page.getByTestId('sidebar-column')).toBeVisible();
    await page.getByTestId('titlebar-toggle-assistant').click();
    await expect(page.getByTestId('session-new')).toBeVisible();
    await expect(page.getByRole('button', {name: '新建会话', exact: true})).toHaveCount(1);
  } finally {
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 900));
  }
});

test('titlebar actions remain distinct and keyboard reachable across desktop sizes and themes', async () => {
  const audit = await readFile('scripts/ui-audit/clip-audit.js', 'utf8');
  const captureDir = process.env.ROC_ACTION_CAPTURE;
  if (captureDir) await mkdir(captureDir, {recursive: true});
  const auditChrome = async () => {
    const result = await page.evaluate(source => (0, eval)(source)({root: '.app-shell', viewport: true}), audit);
    assert.equal(result.cut, 0, JSON.stringify(result.issues));
  };
  try {
    for (const theme of ['light', 'dark']) for (const width of [640, 920, 1099, 1184, 1280, 1440]) {
      await app.evaluate(({BrowserWindow}, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
      await page.evaluate(() => mount('writing'));
      await page.getByTestId('shell-assistant-content').waitFor();
      await page.getByTestId('titlebar-toggle-assistant').click();
      await page.evaluate(theme => {document.documentElement.dataset.theme = theme;}, theme);
      const buttons = page.getByTestId('titlebar').getByRole('button');
      const boxes = await buttons.evaluateAll(elements => elements.map(element => {
        const rect = element.getBoundingClientRect();
        return {id: element.dataset.testid, x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom};
      }));
      for (let index = 0; index < boxes.length; index++) {
        const box = boxes[index];
        assert.ok(box.x >= 0 && box.right <= width, JSON.stringify({theme, width, box}));
        for (const other of boxes.slice(index + 1)) {
          assert.ok(Math.min(box.right, other.right) <= Math.max(box.x, other.x), JSON.stringify({theme, width, box, other}));
        }
      }
      await auditChrome();
      const layout = page.getByTestId('titlebar-layout');
      await layout.hover();
      await auditChrome();
      await layout.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('layout-preset-research')).toBeVisible();
      await auditChrome();
      if (captureDir && [640, 1184, 1440].includes(width)) {
        await page.screenshot({path: join(captureDir, `titlebar-${theme}-${width}.png`)});
      }
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('layout-preset-research')).toBeHidden();
      await auditChrome();
      await page.getByTestId('titlebar-management').focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('management-panel-panel')).toBeVisible();
      await expect(page.getByTestId('titlebar-toggle-assistant')).toHaveAttribute('aria-pressed', 'false');
      await page.getByTestId('management-panel-close').click();
      await expect(page.getByTestId('titlebar-management')).toBeFocused();
    }
  } finally {
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 900));
    await page.evaluate(() => {document.documentElement.dataset.theme = 'light';});
  }
});

test('actual shell assistant and management selections preserve facts until the selected transition is accepted', async () => {
  for (const entry of ['assistant', 'management', 'chrome']) {
    await openTask();
    await page.evaluate(entry => {
      if (entry === 'assistant') assistantEntries.onOpenTask('task-b');
      else if (entry === 'management') managementEntries.onSelectResearchTask('task-b');
      else document.querySelector('[data-testid="activity-nav-library"]').click();
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

test('actual shell management exits keep the task canvas until all guards release', async () => {
  for (const entry of ['settings', 'workspace-settings', 'thread', 'assistant', 'palette']) {
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
    await expect(page.getByTestId('canvas-runs')).toBeVisible();
    assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get('view')), 'runs');
    assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get('page')), 'research');
    assert.equal(await page.evaluate(() => assistantEntries.threadId), null);
    assert.equal(await page.evaluate(() => assistantEntries.composerSeed), null);
  }
  await page.evaluate(() => {setVeto('navigation', false); managementEntries.openSettings();});
  await page.getByTestId('shell-settings').waitFor();
  await expect(page.getByTestId('canvas-runs')).toHaveCount(1);
});

test('actual shell artifact handoff waits for its inspector guard and returns to the selected task', async () => {
  await openTask();
  await page.evaluate(() => {
    setVeto('artifact', true);
    managementEntries.onOpenArtifact({projectId: 'project-a', artifactId: 'artifact-a', expectedVersion: 'a'.repeat(64)}, () => {});
  });
  await discard().waitFor();
  await confirm();
  await expect(page.getByTestId('canvas-runs')).toBeVisible();
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

test('pending task facts veto project navigation and native unload during save', async () => {
  await openTask('writing');
  await content().fill('写作任务中未保存的事实');
  await page.getByTestId('canvas-task-category-background').click();
  await discard().waitFor();
  await cancel();
  await expect(page.getByTestId('canvas-task-category-research')).toHaveAttribute('aria-selected', 'true');
  await expect(content()).toHaveValue('写作任务中未保存的事实');
  await page.evaluate(() => searchEntries.onOpenProject('project-b'));
  await discard().waitFor();
  await cancel();
  await expect(content()).toHaveValue('写作任务中未保存的事实');
  await page.getByTestId('mgmt-task-fact-save').click();
  await expect(content()).toBeDisabled();
  await page.getByTestId('canvas-task-category-background').click();
  await expect(page.getByTestId('canvas-task-category-research')).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => searchEntries.onOpenProject('project-b'));
  assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get('view')), 'runs');
  assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get('project')), 'project-a');
  assert.equal(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', {cancelable: true}))), true);
  await page.evaluate(() => finishSave({ok: false, error: {message: '保留事实以重试'}}));
  await expect(content()).toBeEnabled();
  await page.evaluate(() => searchEntries.onOpenProject('project-b'));
  await confirm();
  await expect(page.getByTestId('shell-canvas-content')).toHaveText('overview');
  assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get('project')), 'project-b');
});

test('activity and workspace task entries open the same project task canvas', async () => {
  await page.evaluate(() => mount('writing'));
  await page.getByTestId('activity-nav-runs').click();
  await expect(page.getByTestId('canvas-task-category-overview')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('canvas-task-open-research:task-a')).toContainText('task-a');
  assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get('view')), 'runs');
  await page.getByTestId('activity-nav-writing').click();
  await page.evaluate(() => workspaceEntries.openTasks());
  await expect(page.getByTestId('canvas-task-center')).toBeVisible();
  await expect(page.getByTestId('management-panel')).toHaveCount(0);
  await expect(page.getByTestId('shell-canvas-content')).toHaveText('runs');
});

test('first steps can be skipped, persist only dismissal and reopen after navigation accepts',async()=>{
  const dismissedBefore=await page.evaluate(()=>window.uxMetrics().events.filter(event=>event.event==='onboarding_dismissed').length);
  await page.evaluate(()=>{resetUiState();mount('overview');});
  await page.getByTestId('titlebar-toggle-assistant').click();
  await expect(page.getByTestId('overview-first-steps')).toBeVisible();
  await expect(page.getByTestId('overview-first-steps').locator('ol > li')).toHaveCount(3);
  await page.getByTestId('overview-first-steps-skip').click();
  await expect(page.getByTestId('overview-first-steps')).toHaveCount(0);
  assert.equal(await page.evaluate(()=>window.onboardingDismissed()),true);
  const dismissal=await page.evaluate(()=>window.uxMetrics().events.filter(event=>event.event==='onboarding_dismissed'));
  assert.equal(dismissal.length,dismissedBefore+1);
  assert.deepEqual(Object.keys(dismissal[0]).sort(),['elapsedMs','event','surface']);
  assert.equal(dismissal[0].surface,'overview');

  await page.evaluate(()=>mount('writing'));
  await page.getByTestId('titlebar-toggle-assistant').click();
  if (!await page.getByTestId('context-help').isVisible()) await page.getByTestId('titlebar-toggle-sidebar').click();
  await expect(page.getByTestId('context-help')).toBeVisible();
  await page.evaluate(()=>setVeto('navigation',true));
  await page.getByTestId('context-help').click();
  await expect(page.getByTestId('shell-canvas-content')).toHaveText('writing');
  assert.equal(await page.evaluate(()=>window.workspaceEntries.firstStepsVisible),false);
  await page.evaluate(()=>setVeto('navigation',false));
  await page.getByTestId('context-help').click();
  await expect(page.getByTestId('overview-first-steps')).toBeVisible();
  await expect(page.locator('#overview-first-steps-heading')).toBeFocused();
  assert.equal(await page.evaluate(()=>window.onboardingDismissed()),true);
  await page.evaluate(()=>setVeto('navigation',true));
  await page.getByTestId('overview-first-steps-discover').click();
  await expect(page.getByTestId('shell-canvas-content')).toHaveText('overview');
  await page.evaluate(()=>setVeto('navigation',false));
  await page.getByTestId('overview-first-steps-discover').click();
  await expect(page.getByTestId('shell-canvas-content')).toHaveText('discover');
  await page.evaluate(()=>mount('overview'));
  await expect(page.getByTestId('overview-first-steps')).toHaveCount(0);
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
