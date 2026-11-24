import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import tailwindcss from '@tailwindcss/vite';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
const errors=[];
before(async()=>{
  directory=await mkdtemp(join(tmpdir(),'roc-project-session-'));
  await buildViteRenderer({directory,plugins:[tailwindcss()],style:'html,body,#root{height:100%;margin:0}body{background:var(--bg);color:var(--ink);font-family:-apple-system,sans-serif}#root{width:1100px}',script:`
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion,domMax,MotionConfig} from 'motion/react';
    import {SWRConfig} from 'swr';
    import {ProjectPortalView} from './src/renderer/project/ProjectPortalView';
    import {SessionListView} from './src/renderer/assistant/SessionListView';
    import {SearchPaletteModal} from './src/renderer/shell/SearchPaletteModal';
    import {WindowChrome} from './src/renderer/shell/WindowChrome';
    import './src/renderer/styles/index.css';
    const ok=data=>({ok:true,data});
    const project=(id,title,status='active')=>({id,title,status,description:'研究科学证据的可追溯性，保留实验条件与原始来源以便复核。',workspacePath:'/synthetic/'+id,language:'zh',origin:null,currentStage:'reading',createdAt:'2026-11-20T00:00:00Z',updatedAt:'2026-11-20T00:00:00Z'});
    const projects=[project('first','科学证据与可重复研究方法的完整验证计划'),project('second','图像与文本模型比较'),project('archived','已完成研究','archived')];
    window.projectData=projects;window.opened=[];window.deleted=[];window.created=0;window.updates=[];
    window.threadData=[{id:'one',kind:'chat',title:'分析实验方法和科学证据的可靠性与可重复性',goal:'',status:'completed',updatedAt:'2026-11-20T00:00:00Z'}, {id:'two',kind:'chat',title:'文献摘要',goal:'',status:'active',updatedAt:'2026-11-19T00:00:00Z'}];
    const client={api:{research:{listProjects:async()=>ok(projects),createProject:async request=>{const created=project('created',request.title);projects.push({...created,...request});return ok({...created,...request});},updateProject:async request=>{window.updates.push(request);return ok({...projects.find(p=>p.id===request.id),...request});}},workspace:{selectFromDialog:async()=>ok({path:'/synthetic/new'})},tasks:{
      getSnapshot:async()=>{
        if(window.holdThreads) return new Promise(resolve=>{window.finishThreads=resolve;});
        return ok({threads:window.threadData});
      },onUpdated:()=>()=>{},deleteThread:async({threadId})=>{window.deleted.push(threadId);return ok(null);}}}};
    function Search(){const [query,setQuery]=useState('研究');return <SearchPaletteModal open onClose={()=>{}} query={query} onQueryChange={setQuery} groups={[{id:'project',label:'项目',status:'ready',items:projects.map(p=>({id:p.id,title:p.title,subtitle:p.description,onOpen:()=>window.opened.push(p.id)}))}]}/>;}
    function Chrome(){const [current,setCurrent]=useState(projects[0].id);return <WindowChrome
      projectId={current} projectName={projects.find(p=>p.id===current)?.title??null} projects={projects}
      onOpenProject={id=>{window.opened.push(id);setCurrent(id);}} onBackToPortal={()=>{}} onOpenSearch={()=>{}}
      sidebarCollapsed={false} onToggleSidebar={()=>{}} assistantOpen={false} onToggleAssistant={()=>{}}
      assistantRunning={false} onOpenGit={()=>{}} onOpenManagement={()=>{}} layoutPreset="research" onChangePreset={()=>{}}/>;}
    const root=createRoot(document.getElementById('root'));let key=0;
    window.mount=(surface)=>flushSync(()=>root.render(<SWRConfig value={{provider:()=>new Map()}}><MotionConfig reducedMotion="always"><LazyMotion features={domMax} strict><React.Fragment key={++key}>
      {surface==='chrome'?<Chrome/>:surface==='portal'?<ProjectPortalView client={client} createFormRequested={false} onRequestConsumed={()=>{}} onOpenProject={id=>window.opened.push(id)}/>:surface==='search'?<Search/>:<SessionListView client={client} activeThreadId="one" onSelectThread={id=>window.opened.push(id)} onStartNewThread={()=>window.created++} onThreadDeleted={()=>{}}/>}
    </React.Fragment></LazyMotion></MotionConfig></SWRConfig>));
  `});
  await writeFile(join(directory,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory,'data'))});app.whenReady().then(()=>new BrowserWindow({show:false,width:1450,height:900}).loadFile(${JSON.stringify(join(directory,'index.html'))}));`);
  app=await _electron.launch({executablePath:electronPath,args:[join(directory,'main.cjs')]});
  page=await app.firstWindow();page.setDefaultTimeout(6000);page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(()=>typeof window.mount==='function');
});
after(async()=>{try{await app?.close();}finally{if(directory)await rm(directory,{recursive:true,force:true});}assert.deepEqual(errors,[]);});

test('project menu searches one hundred titles, clears empty results and retains native keyboard closing',async()=>{
  await page.evaluate(()=>{
    window.savedProjects=structuredClone(window.projectData);window.savedOpened=window.opened.length;
    const base=window.projectData[0];window.projectData.length=0;
    for(let index=0;index<100;index++)window.projectData.push({...base,id:'menu-'+index,title:'规模项目 '+index});
    mount('chrome');
  });
  try {
    const trigger=page.getByTestId('titlebar-projects');
    await trigger.focus();await page.keyboard.press('Enter');
    const search=page.getByTestId('titlebar-project-search');
    await expect(search).toBeFocused();
    await expect(page.getByTestId('titlebar-project-menu-0')).toHaveAttribute('aria-current','page');
    await search.fill('不存在');
    await expect(page.getByTestId('titlebar-project-empty')).toBeVisible();
    await page.getByRole('button',{name:'清空项目搜索',exact:true}).click();
    await expect(search).toHaveValue('');
    await expect(search).toBeFocused();
    await expect(page.locator('[data-testid^="titlebar-project-menu-"]')).toHaveCount(100);
    await search.fill('规模项目 99');
    await expect(page.locator('[data-testid^="titlebar-project-menu-"]')).toHaveCount(1);
    await page.getByTestId('titlebar-project-menu-99').focus();await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(()=>window.opened.at(-1)),'menu-99');
    await expect(search).toBeHidden();
    await trigger.click();
    await expect(search).toBeFocused();
    await expect(search).toHaveValue('');
    await expect(page.getByTestId('titlebar-project-menu-99')).toHaveAttribute('aria-current','page');
    await page.getByTestId('titlebar-project-menu-99').focus();await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(()=>window.opened.length-window.savedOpened),1,'choosing current project does not navigate again');
    await expect(search).toBeHidden();
    await trigger.click();await expect(search).toBeFocused();
    await search.fill('规模项目');await page.keyboard.press('Escape');
    await expect(search).toHaveValue('');
    await page.keyboard.press('Escape');
    await expect(search).toBeHidden();
    await expect(trigger).toBeFocused();
  } finally {
    await page.evaluate(()=>{window.projectData.splice(0,window.projectData.length,...window.savedProjects);delete window.savedProjects;mount('portal');});
  }
});

test('project actions disclose locally and editing retains the current project and draft guard',async()=>{
  await page.evaluate(()=>mount('portal'));
  const row=page.getByTestId('portal-card-first');
  await expect(row).toContainText('研究科学证据的可追溯性');
  await expect(page.getByTestId('portal-card-edit-first')).toBeHidden();
  const disclosure=page.getByTestId('portal-card-actions-first');await disclosure.focus();await page.keyboard.press('Enter');
  await page.getByTestId('portal-card-edit-first').click();
  await expect(page.getByTestId('project-form-title')).toHaveValue('科学证据与可重复研究方法的完整验证计划');
  await page.getByTestId('project-form-title').fill('修改后的研究');
  await page.getByTestId('project-form-cancel').click();
  await expect(page.getByTestId('project-form-discard')).toBeVisible();
  await page.getByTestId('project-form-discard').getByRole('button',{name:'继续编辑'}).click();
  await expect(page.getByTestId('project-form-title')).toHaveValue('修改后的研究');
  await page.getByTestId('project-form-submit').click();
  await expect(page.getByTestId('portal-edit-dialog')).toHaveCount(0);
  assert.equal(await page.evaluate(()=>updates[0].id),'first');
  await page.getByTestId('portal-filter-archived').click();
  await expect(page.getByRole('heading',{name:'已归档项目 1 个'})).toBeVisible();
});

test('zero and one project keep creation and keyboard opening available',async()=>{
  await page.evaluate(()=>{window.savedProjects=structuredClone(window.projectData);window.projectData.length=0;mount('portal');});
  try {
    await expect(page.getByTestId('portal-empty')).toContainText('按研究目标整理文献');
    await expect(page.getByTestId('portal-new-project')).toHaveText('新建第一个研究项目');
    await page.getByTestId('portal-new-project').focus();await page.keyboard.press('Enter');
    await expect(page.getByTestId('portal-create-dialog')).toBeVisible();
    await page.getByTestId('project-form-cancel').click();
    await page.evaluate(()=>{window.projectData.push(window.savedProjects[0]);mount('portal');});
    await expect(page.locator('[data-project-body]')).toHaveCount(1);
    await page.getByTestId('portal-card-open-first').focus();await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(()=>window.opened.at(-1)),'first');
  } finally {
    await page.evaluate(()=>{window.projectData.splice(0,window.projectData.length,...window.savedProjects);delete window.savedProjects;mount('portal');});
  }
});

test('one hundred projects mount progressively while search and keyboard reach every identity',async()=>{
  await page.evaluate(()=>{
    window.savedProjects=structuredClone(window.projectData);
    const base=window.projectData[0];window.projectData.length=0;
    for(let index=0;index<100;index++)window.projectData.push({...base,id:'scale-'+index,title:index===99?'长标题'.repeat(400):'规模项目 '+index});
    mount('portal');
  });
  try {
    await page.getByTestId('portal-view-list').click();
    await expect(page.locator('[data-project-body]')).toHaveCount(40);
    await expect(page.getByRole('heading',{name:'进行中的项目 100 个'})).toBeVisible();
    await page.getByTestId('portal-search').fill('长标题');
    await expect(page.locator('[data-project-body]')).toHaveCount(1);
    await expect(page.getByTestId('portal-card-open-scale-99')).toBeVisible();
    await page.getByTestId('portal-search').fill('');
    await expect(page.locator('[data-project-body]')).toHaveCount(40);
    await page.getByTestId('portal-load-more').click();
    await expect(page.locator('[data-project-body]')).toHaveCount(80);
    await expect(page.getByTestId('portal-card-open-scale-40')).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.getByTestId('portal-card-open-scale-99')).toBeFocused();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(()=>window.opened.at(-1)),'scale-99');
    await page.keyboard.press('Home');
    await expect(page.getByTestId('portal-card-open-scale-0')).toBeFocused();
    assert.equal(await page.getByTestId('portal').evaluate(element=>element.scrollWidth>element.clientWidth),false);
  } finally {
    await page.evaluate(()=>{window.projectData.splice(0,window.projectData.length,...window.savedProjects);delete window.savedProjects;mount('portal');});
  }
});

test('project search and create action stay visible while the project list scrolls',async()=>{
  await page.evaluate(()=>{
    document.getElementById('root').style.width='1100px';
    for(let index=0;index<40;index++) window.projectData.push({...window.projectData[0],id:'long-'+index,title:'研究项目 '+index});
    mount('portal');
  });
  try {
    await page.getByTestId('portal-view-list').click();
    const header=page.getByTestId('portal-header');
    const before=await header.boundingBox();
    const content=page.getByTestId('portal-content');
    await content.evaluate(element=>{element.scrollTop=element.scrollHeight;});
    assert.ok(await content.evaluate(element=>element.scrollTop)>0);
    assert.deepEqual(await header.boundingBox(),before);
    await expect(page.getByTestId('portal-new-project')).toBeInViewport();
    await page.getByTestId('portal-search').fill('研究项目 39');
    await expect(page.locator('[data-project-body]')).toHaveCount(1);
    const result=page.getByTestId('portal-card-open-long-39');
    await result.focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(()=>opened.at(-1)),'long-39');
  } finally {
    await page.evaluate(()=>{window.projectData.splice(3);mount('portal');});
  }
});

test('short viewports scroll the whole portal so zoom cannot hide every project',async()=>{
  await page.setViewportSize({width:296,height:160});
  await page.evaluate(()=>{
    const root=document.getElementById('root');
    root.style.width='244px';root.style.height='122px';
    mount('portal');
  });
  try {
    const result=page.getByTestId('portal-card-open-first');
    await result.focus();
    await expect(result).toBeInViewport();
    assert.ok(await page.getByTestId('portal-content').evaluate(element=>element.clientHeight)>0);
    assert.ok(await page.getByTestId('portal').evaluate(element=>element.scrollTop)>0);
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(()=>opened.at(-1)),'first');
    await page.getByTestId('portal-search').focus();
    await expect(page.getByTestId('portal-search')).toBeInViewport();
  } finally {
    await page.setViewportSize({width:1450,height:900});
    await page.evaluate(()=>{const root=document.getElementById('root');root.style.width='1100px';root.style.height='100%';});
  }
});

test('session search filters real titles, clearing preserves selection and empty state retains new action',async()=>{
  await page.evaluate(()=>mount('sessions'));
  await expect(page.getByTestId('session-row-one')).toBeVisible();
  await page.getByLabel('搜索会话').fill('摘要');
  await expect(page.getByTestId('session-row-one')).toHaveCount(0);
  await expect(page.getByTestId('session-row-two')).toBeVisible();
  await page.getByRole('button',{name:'清空',exact:true}).click();
  await expect(page.getByTestId('session-row-one')).toHaveAttribute('aria-current','true');
  await page.evaluate(()=>{window.threadData=[];mount('sessions');});
  await expect(page.getByTestId('sidebar-empty-sessions')).toBeVisible();
  await page.getByTestId('session-new').focus();await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(()=>created),1);
});

test('new session remains available while history loads or fails, and retry still recovers',async()=>{
  const before=await page.evaluate(()=>{window.holdThreads=true;mount('sessions');return window.created;});
  try {
    await expect(page.getByTestId('session-list-loading')).toBeVisible();
    const create=page.getByRole('button',{name:'新建会话',exact:true});
    await expect(create).toHaveCount(1);
    await create.focus();await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(()=>window.created),before+1);
    await page.evaluate(()=>window.finishThreads({ok:false,error:{message:'Session history unavailable'}}));
    await expect(page.getByTestId('session-list-error')).toContainText('Session history unavailable');
    await expect(create).toHaveCount(1);
    await create.click();
    assert.equal(await page.evaluate(()=>window.created),before+2);
    await page.evaluate(()=>{window.holdThreads=false;});
    await page.getByRole('button',{name:'重试',exact:true}).click();
    await expect(page.getByTestId('session-list-error')).toHaveCount(0);
    await expect(page.getByTestId('session-list-loading')).toHaveCount(0);
    await expect(create).toHaveCount(1);
    await expect(page.getByLabel('搜索会话')).toBeVisible();
  } finally {
    await page.evaluate(()=>{window.holdThreads=false;window.finishThreads?.({ok:true,data:{threads:window.threadData}});});
  }
});

test('project and search surfaces keep long content readable in narrow and wide themes',async()=>{
  const audit=await readFile('scripts/ui-audit/clip-audit.js','utf8');
  for(const theme of ['light','dark']) for(const width of [380,820,1280]) {
    await page.evaluate(({theme,width})=>{document.documentElement.dataset.theme=theme;document.getElementById('root').style.width=width+'px';mount('portal');},{theme,width});
    await page.getByTestId('portal-card-first').waitFor();
    await page.getByTestId('portal-view-list').click();
    for(const view of ['list','cards']) {
      await page.getByTestId('portal-view-'+view).click();
      const bounds=await page.getByTestId('portal').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));
      assert.ok(bounds.scroll<=bounds.width+1,JSON.stringify({width,theme,view,bounds}));
      await page.getByTestId('portal-card-actions-first').evaluate(el=>{el.parentElement.open=true;});
      await page.getByTestId('portal-card-edit-first').hover();
      const result=await page.evaluate(source=>(0,eval)(source)({root:'#root',viewport:true}),audit);assert.equal(result.cut,0,JSON.stringify(result.issues));
      if(process.env.ROC_WORKSPACE_CAPTURE){await mkdir(process.env.ROC_WORKSPACE_CAPTURE,{recursive:true});await page.getByTestId('portal').screenshot({path:join(process.env.ROC_WORKSPACE_CAPTURE,theme+'-'+width+'-'+view+'.png')});}
    }
  }
  await page.evaluate(()=>mount('search'));
  await expect(page.getByTestId('search-item-first')).toBeVisible();
  await expect(page.getByTestId('search-palette-input')).toBeFocused();
  await page.getByTestId('search-palette-input').press('Enter');
  assert.equal(await page.evaluate(()=>opened.at(-1)),'first');
});
