import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import tailwindcss from '@tailwindcss/vite';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
const errors=[];
const clipSource=await readFile('scripts/ui-audit/clip-audit.js','utf8');
before(async()=>{
  directory=await mkdtemp(join(tmpdir(),'roc-overview-'));
  await buildViteRenderer({directory,plugins:[tailwindcss()],style:'html,body,#root{height:100%}',script:`
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {OverviewView} from './src/renderer/project/OverviewView';
    import {WorkspaceScopeProvider} from './src/renderer/app/workspace-scope';
    import {LiteratureScopeProvider} from './src/renderer/literature/literature-scope';
    import './src/renderer/styles/index.css';
    const root=createRoot(document.getElementById('root'));let instance=0;
    const ok=data=>({ok:true,data});
    const task=(id,status,statusReason=null)=>({id,projectId:'project',status,statusReason,goal:'研究任务 '+id,updatedAt:'2026-11-23T00:00:00Z'});
    window.task=task;window.actions=[];window.reads=[];
    window.mount=(state={})=>{
      window.actions=[];window.reads=[];
      const tasks=state.tasks??[];
      const client={api:{research:{
        getProject:async()=>ok({id:'project',title:'科学证据复核',status:state.archived?'archived':'active',currentStage:'reading',description:state.goal??'核对已有文献与实验条件。'}),
        listTasks:async()=>state.taskError?{ok:false,error:{message:state.taskError}}:ok({tasks,hasMore:state.hasMore??false,nextTaskId:null}),
        listArtifacts:async()=>ok(state.artifacts??[]),onTaskUpdated:()=>()=>{},
        getTaskDiagnostics:async({taskId})=>{window.reads.push(taskId);return ok({task:tasks.find(task=>task.id===taskId),executions:[],
          continuationRunId:state.resumable?'run':null,canRestoreApproval:state.restoreApproval??false});},
        continueTask:()=>{throw new Error('Overview cannot resume a run');}
      },chat:{startRun:()=>{throw new Error('Overview cannot start a run');}}}};
      const scope={client,projectId:'project',projectTitle:state.title??'科学证据复核',writable:!state.archived,workspaceError:null,
        firstStepsVisible:false,firstStepsRequestId:0,dismissFirstSteps:()=>{},rebindWorkspace:()=>{},
        openTasks:id=>window.actions.push({kind:'task',id}),openAssistant:()=>window.actions.push({kind:'assistant'}),
        openView:view=>window.actions.push({kind:'view',view}),openLiterature:target=>window.actions.push(target),
        openArtifact:target=>window.actions.push(target)};
      const literature={items:[],query:'',selectedId:null,error:null,status:'ready',reload:()=>{},requestImport:()=>{}};
      flushSync(()=>root.render(<WorkspaceScopeProvider value={scope}><LiteratureScopeProvider value={literature}>
        <OverviewView key={++instance}/></LiteratureScopeProvider></WorkspaceScopeProvider>));
    };
    window.mount();
  `});
  await writeFile(join(directory,'main.cjs'),`const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory,'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1440,height:1000}).loadFile(${JSON.stringify(join(directory,'index.html'))}));`);
  app=await _electron.launch({executablePath:electronPath,args:[join(directory,'main.cjs')]});
  page=await app.firstWindow();page.setDefaultTimeout(6000);page.on('pageerror',error=>errors.push(error.message));
  await page.getByTestId('overview').waitFor();
});
after(async()=>{try{await app?.close();}finally{if(directory)await rm(directory,{recursive:true,force:true});}assert.deepEqual(errors,[]);});

test('overview opens the authoritative destination without starting or resuming a run',async()=>{
  await page.evaluate(()=>window.mount());
  const action=page.getByTestId('overview-primary-action');
  await expect(action).toHaveText('开始研究');
  await action.click();assert.deepEqual(await page.evaluate(()=>window.actions),[{kind:'assistant'}]);
  for(const [status,label,resumable] of [['active','查看运行',false],['waiting_approval','处理审批',false],['paused','继续研究',true],['failed','查看任务',false]]) {
    await page.evaluate(({status,resumable})=>window.mount({tasks:[window.task('current',status)],resumable}),{status,resumable});
    await expect(action).toHaveText(label);
    await action.click();assert.deepEqual(await page.evaluate(()=>window.actions),[{kind:'task',id:'current'}]);
  }
  for(const state of [{restoreApproval:true},{reason:'research_task_cleanup_failed'}]) {
    await page.evaluate(state=>window.mount({tasks:[window.task('blocked','paused',state.reason??null)],resumable:true,...state}),state);
    await expect.poll(()=>page.evaluate(()=>window.reads.length)).toBe(1);
    await expect(action).toHaveText('查看任务');
  }
  await page.evaluate(()=>window.mount({archived:true}));await expect(action).toBeDisabled();
});

test('overview shows real task reasons, artifact kinds and the partial history boundary',async()=>{
  await page.evaluate(()=>window.mount({hasMore:true,tasks:[window.task('first','failed','模型暂时不可用'),window.task('second','waiting_approval','请核对实验条件')],
    artifacts:[{id:'figure',kind:'figure',title:'实验比较图',status:'draft',updatedAt:'2026-11-23T00:00:00Z'},
      {id:'notes',kind:'reading_notes',title:'方法笔记',status:'approved',updatedAt:'2026-11-22T00:00:00Z'}]}));
  await expect(page.getByTestId('overview-task-scope')).toContainText('仅显示近期 2 项任务');
  await expect(page.getByTestId('overview-task-reason-first')).toHaveText('模型暂时不可用');
  await expect(page.getByTestId('overview-task-reason-second')).toHaveText('请核对实验条件');
  await expect(page.getByTestId('overview-artifacts')).toContainText('图稿');
  await expect(page.getByTestId('overview-artifacts')).toContainText('阅读笔记');
  await page.getByTestId('overview-artifacts').getByRole('button',{name:/实验比较图/}).click();
  assert.deepEqual(await page.evaluate(()=>window.actions),[{projectId:'project',artifactId:'figure',expectedVersion:null}]);
  await page.evaluate(()=>window.mount({tasks:[window.task('cleanup','failed','research_task_cleanup_failed'),window.task('unknown','failed','research_unknown_reason')]}));
  await expect(page.getByTestId('overview-task-reason-cleanup')).toContainText('资源清理尚未确认');
  await expect(page.getByTestId('overview-task-reason-unknown')).toHaveCount(0);
  await expect(page.getByTestId('overview-pending')).not.toContainText('research_unknown_reason');
  await page.evaluate(()=>window.mount({hasMore:true,tasks:[window.task('complete','completed')]}));
  await expect(page.getByTestId('overview-tasks-empty')).toHaveText('近期任务中没有进行中的研究');
  await page.evaluate(()=>window.mount({taskError:'任务暂时不可读取'}));
  await expect(page.getByRole('alert')).toContainText('任务暂时不可读取');
  await expect(page.getByTestId('overview-primary-action')).toHaveText('查看任务');
});

test('overview goal expands by keyboard and layouts stay readable in both themes and densities',async()=>{
  await page.evaluate(()=>window.mount({goal:'核对完整研究条件和原始证据。'.repeat(45),tasks:[window.task('paused','paused','等待补充实验来源')],resumable:true}));
  const toggle=page.getByTestId('overview-goal-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded','false');
  const collapsed=await page.getByTestId('overview-goal').boundingBox();
  await toggle.focus();await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded','true');
  assert.ok((await page.getByTestId('overview-goal').boundingBox()).height>collapsed.height);
  await toggle.press('Enter');
  for(const theme of ['light','dark'])for(const density of ['compact','comfortable'])for(const width of [1184,1280,1440]) {
    await page.setViewportSize({width,height:1000});
    await page.evaluate(({theme,density})=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.density=density;},{theme,density});
    assert.equal(await page.getByTestId('overview').evaluate(element=>element.scrollWidth>element.clientWidth),false);
    assert.equal((await page.evaluate(source=>(0,eval)(source)({viewport:true}),clipSource)).cut,0);
    if(process.env.ROC_UI_AUDIT_DIR) {
      await mkdir(process.env.ROC_UI_AUDIT_DIR,{recursive:true});
      await page.screenshot({path:join(process.env.ROC_UI_AUDIT_DIR,`overview-${theme}-${density}-${width}.png`)});
    }
  }
  await page.evaluate(()=>document.getElementById('root').style.width='320px');
  assert.equal(await page.getByTestId('overview').evaluate(element=>element.scrollWidth>element.clientWidth),false);
  await page.getByTestId('overview-primary-action').focus();
  await expect(page.getByTestId('overview-primary-action')).toBeFocused();
});
