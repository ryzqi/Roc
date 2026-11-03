import assert from 'node:assert/strict';
import {copyFile, mkdir, mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as wait} from 'node:timers/promises';
import {createResearchFixture, figureRequest} from './research-test-kit.mjs';

/** Actual local renderer, persisted publication and waiting human gate; no model or network. */
export async function createPublishedFigureFixture(api) {
  const temporary=await mkdtemp(join(tmpdir(),'roc-production-review-'));
  const root=await realpath(temporary),workspace=join(root,'workspace');
  await mkdir(workspace);
  for(const name of ['figure.vl.json','measurements.csv']) {
    await copyFile(join('tests/fixtures/research-workflow',name),join(workspace,name));
  }
  const f=createResearchFixture(api,'figure',workspace);
  const figureService=new api.ResearchFigureService(f.repository,{
    renderFigure: request=>api.renderResearchFigure({operation:'render_figure',projectRoot:request.projectRoot,
      sourcePath:request.sourcePath,outputDir:request.outputDir,inputPaths:request.inputPaths,label:request.label,
      timeoutMs:request.timeoutMs,figure:request.figure},request.signal)
  },root,{error:()=>assert.fail('unexpected figure persistence error')});
  const dispose=async()=>{await figureService.shutdown();f.close();await rm(temporary,{recursive:true,force:true});};
  try {
    const started=await figureService.start(figureRequest(f.project.id,f.run.id,{timeoutMs:10_000}));
    const deadline=Date.now()+10_000;
    while(['preparing','running'].includes(f.repository.figureRuns.get(f.project.id,started.id).status)) {
      assert.ok(Date.now()<deadline,'local figure rendering deadline exceeded');
      await wait(10);
    }
    const completed=f.repository.figureRuns.get(f.project.id,started.id);
    assert.equal(completed.status,'completed',completed.error);
    const publication=await figureService.publish(f.project.id,completed.id,null);
    const content=await readFile(join(workspace,'measurements.csv'),'utf8');
    const source=f.repository.knowledge.upsertFromSource({id:'synthetic-render-input',projectId:f.project.id,
      sourceType:'file',sourceId:'measurements.csv',title:'Fixed synthetic render input',content,
      chunks:[{content,locator:'input/measurements.csv'}],embeddingPolicy:'none'});
    const chunkId=f.db.prepare('SELECT id FROM research_knowledge_chunks WHERE document_id=?').pluck().get(source.id);
    const evidence=f.repository.evidence.capture({projectId:f.project.id,chunkId});
    f.repository.runs.complete(f.run.id,f.project.id,{title:'Recorded figure',markdown:'Original figure review body',
      claims:[{subjectType:'figure',content:'Fixed synthetic rendering uses the recorded input.',status:'supported',evidenceIds:[evidence.id]}],
      sections:[],verdict:'uncertain'});
    f.repository.transitionWorkflow({projectId:f.project.id,expectedStage:'figure',action:'complete'});
    return {...f,figureService,figureId:publication.id,artifactId:publication.artifactId,productionRun:completed,dispose};
  }catch(error){await dispose();throw error;}
}
