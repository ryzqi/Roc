import {_electron as electron,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createSmokePaths,seedSmokeWorkspace} from '../tests/smoke/lib/fixtures.mjs';
import {resolveSmokeTarget} from '../tests/smoke/lib/smoke-target.mjs';
import {navigate} from './lib/gate-harness.mjs';
import {buildPerformancePdf} from './lib/research-pdf-performance-fixture.mjs';
const paths=await createSmokePaths();seedSmokeWorkspace(paths.workspaceRoot,paths.remoteRoot);
const dir=resolve('.artifacts/reading-radar');mkdirSync(dir,{recursive:true});
const fixturePath=resolve(dir,'reading-fixture.pdf');
const streams=['Introduction: explicit synthetic reading fixture.','Methods: second page for navigation acceptance.'].map(text=>`BT /F1 18 Tf 40 740 Td (${text}) Tj ET`);
writeFileSync(fixturePath,buildPerformancePdf([
 '<< /Type /Catalog /Pages 2 0 R /Outlines 8 0 R >>',
 '<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>',
 '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
 '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
 `<< /Length ${Buffer.byteLength(streams[0])} >>\nstream\n${streams[0]}\nendstream`,
 '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 7 0 R >>',
 `<< /Length ${Buffer.byteLength(streams[1])} >>\nstream\n${streams[1]}\nendstream`,
 '<< /Type /Outlines /First 9 0 R /Last 10 0 R /Count 2 >>',
 '<< /Title (Introduction) /Parent 8 0 R /Next 10 0 R /Dest [4 0 R /Fit] >>',
 '<< /Title (Methods) /Parent 8 0 R /Prev 9 0 R /Dest [6 0 R /Fit] >>',
]));
const target=resolveSmokeTarget({env:{...process.env,ROC_SMOKE_TARGET:'dist'}});
const launch=()=>electron.launch({executablePath:target.executablePath,args:target.launchArgs,env:{...process.env,ROC_SMOKE:'1',ROC_DATA_ROOT:paths.dataRoot}});
let app=await launch();
const results=[],errors=[];let page;
const check=(name,detail='')=>{results.push({name,detail});console.log(`PASS ${name} ${detail}`);};
const auditSource=readFileSync('.agents/skills/desktop-agent-ui/scripts/clip-audit.js','utf8');
const layouts=async(name)=>{
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setMinimumSize(800,640));
 for(const width of [800,1000,1099,1100]){
  await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,800),width);
  await expect.poll(()=>page.evaluate(()=>innerWidth)).toBe(width);
  while(await page.getByRole('dialog').count()){await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);}
  for(const theme of ['light','dark']){
   await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   if(name==='pdf-notes'){
    const notes=page.getByLabel('论文关联笔记',{exact:true});
    assert.ok(await notes.getByLabel('笔记标题',{exact:true}).evaluate(element=>element.getBoundingClientRect().width>=140),'associated note title remains usable');
    await notes.getByTestId('notes-editor').scrollIntoViewIfNeeded();
    assert.ok(await notes.getByTestId('notes-editor').evaluate(element=>element.parentElement.parentElement.clientHeight>=100),'associated note text retains editing space');
   }
   const audit=await page.evaluate(source=>(0,eval)(source)({root:'body',viewport:true}),auditSource);
   assert.equal(audit.cut,0,`${name} ${width} ${theme}: ${JSON.stringify(audit)}`);
   results.push({name:`${name} layout`,width,theme,audit});
   await page.screenshot({path:resolve(dir,`${name}-${theme}-${width}.png`)});
  }
 }
};
try{
 page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')console.error('RENDERER',message.text());});page.on('requestfailed',request=>console.error('REQUEST',request.url(),request.failure()));
 await page.waitForSelector('[data-testid="roc-app"]',{timeout:30000});
 const project=await page.evaluate(async workspacePath=>{const result=await window.roc.research.createProject({title:'Reading runtime',description:'Reading acceptance',workspacePath});if(!result.ok)throw new Error(result.error.message);return result.data;},paths.workspaceRoot);
 const doc=await page.evaluate(async({projectId,sourcePath})=>{const result=await window.roc.research.importDocument({target:'new-item',sourcePath,title:'Reading PDF fixture',citationKey:'readingFixture',projectId});if(!result.ok)throw new Error(result.error.message);return result.data;},{projectId:project.id,sourcePath:fixturePath});
 const sourceUrl=`roc-preview://research/projects/${project.id}/documents/${doc.id}/source/${doc.sourceHash}`;
 const original=await page.evaluate(async url=>{const response=await fetch(url);return {status:response.status,bytes:(await response.arrayBuffer()).byteLength};},sourceUrl);
 assert.equal(original.status,200);assert.equal(original.bytes,doc.size);check('cold-start preview protocol serves original PDF bytes');
 await navigate(page,`page=research&project=${project.id}&view=literature`);
 await page.waitForSelector('[data-testid="literature-hub"]');
 await page.getByRole('tab',{name:'笔记',exact:true}).click();
 await page.getByTestId('notes-create').click();await page.getByLabel('笔记标题',{exact:true}).fill('Runtime note');
 await page.getByRole('button',{name:'Markdown 源码',exact:true}).click();
 const markdown='# Heading\n\nHello [[Linked note]] with $E=mc^2$.\n\n$$\nx^2+y^2=z^2\n$$\n\n| A | B |\n| --- | --- |\n| 1 | 2 |';
 await page.getByRole('textbox',{name:'Markdown 源码',exact:true}).fill(markdown);
 await expect(page.getByRole('button',{name:'粗体',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Markdown 源码',exact:true}).click();
 await expect(page.locator('[data-wiki-link="Linked note"]')).toBeVisible();await expect(page.locator('.katex').first()).toBeVisible();
 await page.getByTestId('notes-editor').locator('h1').evaluate(element=>{const range=document.createRange();range.selectNodeContents(element);range.collapse(false);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);element.closest('[contenteditable]').focus();});
 await page.keyboard.type(' roundtrip');
 await page.getByTestId('notes-save').click();
 await expect.poll(async()=>{const rows=await page.evaluate(async projectId=>(await window.roc.research.listReadingNotes({projectId})).data,project.id);return rows?.find(row=>row.title==='Runtime note')?.markdown??'';}).toContain('roundtrip');
 const saved=await page.evaluate(async projectId=>(await window.roc.research.listReadingNotes({projectId})).data.find(row=>row.title==='Runtime note'),project.id);
 assert.ok(saved.markdown.includes('[[Linked note]]'));assert.ok(saved.markdown.includes('E=mc^2'));
 assert.equal(saved.markdown.match(/\$\$([\s\S]+?)\$\$/)?.[1].trim(),markdown.match(/\$\$([\s\S]+?)\$\$/)?.[1].trim());assert.ok(saved.markdown.includes('|'));
 check('Markdown, formulas, tables, wiki links persist through rich editor');
 await page.getByRole('button',{name:'/ 插入',exact:true}).click();await layouts('notes-expanded');
 await page.getByRole('button',{name:'/ 插入',exact:true}).click();
 await page.screenshot({path:resolve(dir,'notes.png')});
 await page.locator('[data-wiki-link="Linked note"]').click();await expect(page.getByLabel('笔记标题',{exact:true})).toHaveValue('Linked note');
 await page.getByTestId('notes-editor').click();await page.keyboard.type('/');await expect(page.getByLabel('插入块',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'标题 2',exact:true}).click();await page.keyboard.type('Linked heading');
 await page.getByTestId('notes-save').click();await expect(page.getByTestId('notes-panel').getByRole('status')).toHaveText('已保存');
 await expect(page.getByRole('button',{name:'Runtime note',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'归档笔记',exact:true}).click();await expect(page.getByTestId('notes-panel').getByRole('status')).toHaveText('已保存');
 await page.getByRole('button',{name:'恢复笔记',exact:true}).click();await expect(page.getByTestId('notes-panel').getByRole('status')).toHaveText('已保存');
 check('wiki-link creation, backlink navigation, slash heading and archive recovery');
 await page.getByRole('tab',{name:'阅读',exact:true}).click();
 await page.getByTestId(`literature-row-${doc.libraryItemId}`).last().click();
 await expect(page.getByTestId('reader-pdf-text')).toBeVisible({timeout:30000});
 await expect.poll(()=>page.getByTestId('reader-pdf-text').innerText()).toContain('Introduction');
 check('raw PDF renders text before OCR');
 await page.getByLabel('查找 PDF 全文').fill('Introduction');await expect(page.locator('.pdf-find-hit').first()).toBeVisible();
 await page.getByTestId('reader-pdf-text').evaluate(element=>{const text=[...element.querySelectorAll('span')].find(span=>span.textContent.includes('Introduction'));const range=document.createRange();range.selectNodeContents(text);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);element.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));});
 await expect(page.getByTestId('reader-selection-actions')).toBeVisible();await page.getByRole('button',{name:'保存高亮',exact:true}).click();
 await expect(page.locator('.pdf-saved-highlight').first()).toBeVisible();
 check('PDF search, selection and persisted highlight');
 await page.getByRole('button',{name:/^目录 \d+$/}).click();await expect(page.getByLabel('PDF 目录',{exact:true})).toBeVisible();
 await expect(page.getByLabel('PDF 目录',{exact:true}).getByRole('button')).toHaveCount(2);
 await page.getByRole('button',{name:/^目录 \d+$/}).click();
 await page.getByRole('button',{name:'适页',exact:true}).click();
 await expect(page.getByRole('button',{name:'适页',exact:true})).toHaveAttribute('aria-pressed','true');
 await expect.poll(async()=>page.getByTestId('reader-pdf-scroll').evaluate(element=>element.querySelector('canvas').getBoundingClientRect().height<=element.clientHeight)).toBe(true);
 await page.getByRole('button',{name:'PDF 适宽',exact:true}).click();
 await page.getByRole('spinbutton',{name:'PDF 页码'}).fill('2');await page.getByRole('button',{name:'前往',exact:true}).click();
 await expect(page.getByTestId('reader-pdf-canvas')).toHaveAttribute('aria-label','原 PDF 第 2 页');
 await page.getByRole('spinbutton',{name:'PDF 页码'}).fill('1');await page.getByRole('button',{name:'前往',exact:true}).click();
 await expect(page.locator('.pdf-saved-highlight').first()).toBeVisible();
 check('PDF outline, fit page, fit width and page navigation');
 // Page navigation intentionally clears the selection. Select it again for translation.
 await page.getByTestId('reader-pdf-text').evaluate(element=>{const text=[...element.querySelectorAll('span')].find(span=>span.textContent.includes('Introduction'));const range=document.createRange();range.selectNodeContents(text);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);element.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));});
 await page.getByRole('button',{name:'翻译选区',exact:true}).click();await page.getByRole('button',{name:'翻译设置',exact:true}).click();
 await page.getByLabel('翻译渠道',{exact:true}).selectOption('deepl');await page.getByRole('button',{name:'保存翻译设置',exact:true}).click();
 await page.getByRole('button',{name:'开始翻译',exact:true}).click();await expect(page.getByTestId('reader-translation').getByRole('alert')).toContainText('API Key');
 await page.getByTestId('reader-translation').getByRole('button',{name:'关闭',exact:true}).click();
 check('translation missing-key error through renderer and main IPC');
 await page.getByRole('button',{name:'摘录到笔记',exact:true}).click();await expect(page.getByLabel('论文关联笔记')).toBeVisible();
 await expect.poll(async()=>{const result=await page.evaluate(async projectId=>window.roc.research.listReadingNotes({projectId}),project.id);return result.ok&&result.data.some(note=>note.itemId===doc.libraryItemId&&note.markdown.includes('Introduction'));}).toBe(true);
 check('PDF selection creates associated note');await page.screenshot({path:resolve(dir,'pdf-notes.png')});
 await layouts('pdf-notes');
 await page.getByRole('button',{name:'引文发现 / 批量入库',exact:true}).click();await expect(page.getByTestId('reader-discovery')).toBeVisible();check('citation discovery surface');
 await page.getByRole('tab',{name:'学术雷达',exact:true}).click();await expect(page.getByTestId('radar-panel')).toBeVisible();
 await expect(page.getByLabel('RSS 地址')).toBeVisible();await page.getByRole('tab',{name:'每日 arXiv',exact:true}).click();await expect(page.getByLabel('推荐分类')).toBeVisible();check('RSS and daily recommendation surfaces');
 await layouts('recommendation');
 await app.close();app=await launch();page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));
 await page.waitForSelector('[data-testid="roc-app"]');
 const restored=await page.evaluate(async({projectId,documentId,sourceHash})=>{
   const notes=await window.roc.research.listReadingNotes({projectId});const highlights=await window.roc.research.listReadingHighlights({projectId,documentId,sourceHash});
   if(!notes.ok||!highlights.ok)throw new Error('Restore failed');return {notes:notes.data,highlights:highlights.data};
 },{projectId:project.id,documentId:doc.id,sourceHash:doc.sourceHash});
 assert.equal(restored.notes.find(note=>note.id===saved.id).markdown,saved.markdown);
 assert.ok(restored.notes.some(note=>note.title==='Linked note'&&!note.archived&&note.markdown.includes('## Linked heading')));
 assert.equal(restored.highlights.length,1);assert.ok(restored.highlights[0].text.includes('Introduction'));
 check('notes and PDF highlights survive a full application restart');
 assert.deepEqual(errors,[]);check('no renderer exceptions');
}catch(error){if(page)await page.screenshot({path:resolve(dir,'failure.png')}).catch(()=>{});console.error(error);process.exitCode=1;results.push({error:String(error),rendererErrors:errors});}
finally{writeFileSync(resolve(dir,'results.json'),JSON.stringify({results,dataRoot:paths.dataRoot},null,2));await app.close();}
