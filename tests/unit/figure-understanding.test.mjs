import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {ChatOpenAI} from '@langchain/openai';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadScientificSearchApi, scientificSearchFixture, hash} from './fixtures/scientific-search-fixture.mjs';

let api, figure;
before(async () => {
  [api,figure] = await Promise.all([loadScientificSearchApi(),
    importTypeScriptModule('tests/unit/fixtures/figure-understanding-api.ts',
      {platform:'node',tempDir:'.runtime/tmp',external:['@napi-rs/canvas']})]);
});
after(()=>api?.dispose());
const model={provider:'fixture-provider',modelId:'fixture-vision',model:'fixture-vision',revision:'fixture-revision'};
const interpretation=()=>({
  panels:[{id:'a',label:'(a)',description:'Architecture and performance panels'}],
  modules:[{id:'encoder',panelId:'a',label:'Encoder',role:'Encodes input'},
    {id:'decoder',panelId:'a',label:'Decoder',role:'Produces output'}],
  connections:[{from:'encoder',to:'decoder',direction:'directed',description:'Visible arrow connects modules'}],
  lineTrends:[{panelId:'a',series:'Method A',direction:'increasing',description:'Rises across the displayed range'}],
  barComparisons:[{panelId:'a',firstCategory:'Method A',secondCategory:'Method B',relation:'higher',description:'A is visually taller'}],
  legends:[{panelId:'a',label:'Method A',visualEncoding:'Solid line'}],
  axes:[{panelId:'a',orientation:'x',label:'Epoch',scale:'linear'}],
  limitations:['Controlled fixture output, not a model accuracy measurement.']
});
async function fixture(options={}) {
  const f=await scientificSearchFixture(api,{image:true,embedded:false,...options});
  let stamp='first',calls=0,created=0,invoke=async()=>interpretation(),construct=async()=>{};
  const service=new figure.FigureUnderstandingService(f.repository,{library:f.root,index:null},async()=>{
    created++;await construct();return {model,interpret:async(...args)=>{calls++;return invoke(...args);}};
  },()=>stamp);
  return {...f,service,request:{projectId:f.project.id,documentId:f.document.id,objectId:f.ir.figures[0].id},
    calls:()=>calls,created:()=>created,stamp:()=>{stamp='changed';},invoke:fn=>{invoke=fn;},construct:fn=>{construct=fn;},
    close:async()=>{await service.shutdown();await f.close();}};
}
test('explicit figure interpretation binds original PNG/PDF and all six categories without database writes',async()=>{
  const f=await fixture();
  try {
    assert.equal(f.created(),0);
    const changes=f.db.prepare('SELECT total_changes() AS n').get().n;
    f.invoke(async input=>{assert.deepEqual(input.bytes,f.imageBytes);assert.match(input.caption,/Original architecture/);return interpretation();});
    const result=await f.service.analyze(f.request);
    assert.equal(result.interpretationKind,'derived');assert.equal(result.scientificApproval,'unreviewed');
    assert.equal(result.exactValues,'requires_table_or_text');assert.equal(result.verification,'verify_original_pdf');
    assert.deepEqual(result.interpretation,interpretation());assert.deepEqual(result.model,model);
    assert.deepEqual(result.source.image.sourceLocator,f.ir.figures[0].sourceLocator);
    assert.equal(result.source.image.sha256,hash(f.imageBytes));assert.equal(hash(await readFile(f.source)),hash(f.bytes));
    assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,changes);
    assert.deepEqual(f.ir.tables[0].cells.map(c=>c.text),['Method','F1 (%)','Original baseline','90','91']);
  } finally {await f.close();}
});
test('foreign scope, missing image and non-Figure selections fail before model construction',async()=>{
  const f=await fixture({image:false});
  try {
    await assert.rejects(f.service.analyze({...f.request,documentId:'foreign'}),/scope_invalid/);
    await assert.rejects(f.service.analyze({...f.request,objectId:f.ir.tables[0].id}),/object_invalid/);
    await assert.rejects(f.service.analyze(f.request),/asset_unavailable/);
    assert.equal(f.created(),0);
  } finally {await f.close();}
});
test('registered capability validates scope, returns derived candidates and propagates caller cancellation',async()=>{
  const f=await fixture(),registry=new figure.CapabilityRegistry(),controller=new AbortController();
  try {
    registry.declare('research',figure.figureUnderstandingCapability);
    figure.registerFigureUnderstandingCapability({pluginId:'research',capabilities:registry},f.service);
    const invoke=(input=f.request,signal)=>registry.invoke('research.visual.understandFigure',input,signal);
    await assert.rejects(invoke({...f.request,path:'/caller/path.png'}));assert.equal(f.calls(),0);
    const result=await invoke();assert.equal(result.interpretationKind,'derived');
    assert.deepEqual(result.source.image.sourceLocator,f.ir.figures[0].sourceLocator);
    let ready;const entered=new Promise(resolve=>{ready=resolve;});
    f.invoke(async(_input,signal)=>{ready();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
      signal.throwIfAborted();});
    const pending=invoke(f.request,controller.signal);pending.catch(()=>{});await entered;
    controller.abort(new Error('caller-cancel-figure'));await assert.rejects(pending,/caller-cancel-figure/);
  } finally {controller.abort();await f.close();}
});
test('unknown references, duplicates and invented numerical fields cannot become valid interpretations',()=>{
  const cases=[{...interpretation(),connections:[{from:'invented',to:'decoder',direction:'directed',description:'link'}]},
    {...interpretation(),axes:[{panelId:'unknown',orientation:'y',label:'F1',scale:'unknown'}]},
    {...interpretation(),modules:[...interpretation().modules,interpretation().modules[0]]},
    {...interpretation(),exactValue:123},
    {...interpretation(),barComparisons:[{...interpretation().barComparisons[0],value:99}]}];
  for(const value of cases) assert.equal(figure.figureInterpretationSchema.safeParse(value).success,false);
});
for(const change of ['image','source','generation','owner','model']) test(`late ${change} mutation refuses returned interpretations`,async()=>{
  const f=await fixture();
  try {
    f.invoke(async()=>{
      if(change==='image')await writeFile(join(f.root,'parser/figure.png'),Buffer.from('changed'));
      if(change==='source')await writeFile(f.source,Buffer.from('changed'));
      if(change==='generation')await f.publish();
      if(change==='owner')f.db.prepare('UPDATE research_library SET revision=revision+1 WHERE id=?').run(f.document.libraryItemId);
      if(change==='model')f.stamp();
      return interpretation();
    });
    await assert.rejects(f.service.analyze(f.request),/changed|source_hash|source_size|invalid/);
  } finally {await f.close();}
});
test('model selection changes during construction and provider errors produce no successful response',async()=>{
  const f=await fixture();
  try {
    f.construct(async()=>f.stamp());await assert.rejects(f.service.analyze(f.request),/model_changed/);assert.equal(f.calls(),0);
    f.construct(async()=>{});f.invoke(async()=>{throw new Error('vision unavailable');});
    await assert.rejects(f.service.analyze(f.request),/vision unavailable/);
    f.invoke(async()=>({...interpretation(),connections:[{from:'absent',to:'absent',direction:'uncertain',description:'unknown'}]}));
    await assert.rejects(f.service.analyze(f.request),/module_reference_invalid/);
  } finally {await f.close();}
});
for(const action of ['cancel','shutdown','delete'])test(`${action} waits for underlying inference settlement and prevents late results`,async()=>{
  const f=await fixture(),controller=new AbortController();let entered,settle,cleanup;
  const ready=new Promise(r=>{entered=r;}),gate=new Promise(r=>{settle=r;}),cleanupGate=new Promise(r=>{cleanup=r;});
  try {
    f.invoke(async(_input,signal)=>{entered();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));await gate;return interpretation();});
    const pending=f.service.analyze(f.request,controller.signal);pending.catch(()=>{});await ready;
    let finished=false,cleaning=false;
    const release=action==='shutdown'?f.service.shutdown():action==='delete'
      ?f.service.withProjectReleased(f.project.id,async()=>{cleaning=true;await cleanupGate;})
      :(controller.abort(new Error('caller cancelled')),pending.catch(()=>{}));
    release.then(()=>{finished=true;});await delay(10);assert.equal(finished,false);assert.equal(cleaning,false);
    await assert.rejects(f.service.analyze(f.request),/busy|closed|releasing/);
    settle();await assert.rejects(pending,/cancelled/);await delay(10);
    if(action==='delete'){assert.equal(cleaning,true);assert.equal(finished,false);await assert.rejects(f.service.analyze(f.request),/releasing/);cleanup();}
    await release;
  } finally {settle?.();cleanup?.();await f.close();}
});
test('actual LangChain HTTP serialization sends only the selected PNG and parses structured derived candidates',async()=>{
  const requests=[];
  const server=createServer(async(req,res)=>{
    const parts=[];for await(const part of req)parts.push(part);
    const body=JSON.parse(Buffer.concat(parts).toString());requests.push(body);
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:'fixture-vision',choices:[{
      index:0,message:{role:'assistant',content:JSON.stringify(interpretation())},finish_reason:'stop'}]}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const endpoint=`http://127.0.0.1:${server.address().port}/v1`;
  const handle={provider:{id:'fixture-provider',type:'openai',endpoint,options:{},models:[{id:'fixture-vision',options:{}}]},
    modelId:'fixture-vision',model:new ChatOpenAI({model:'fixture-vision',apiKey:'fixture-no-secret',maxRetries:0,timeout:5000,configuration:{baseURL:endpoint}}),
    runtime:{providerType:'openai',baseUrl:endpoint,streaming:false,modelKwargs:{},contextWindowTokens:64000,maxOutputTokens:6000}};
  try {
    const session=await figure.createFigureUnderstandingSessionFactory({createDefaultChatModel:async()=>handle})();
    const bytes=Buffer.from([137,80,78,71,13,10,26,10]);
    assert.deepEqual(await session.interpret({bytes,caption:'untrusted caption'},new AbortController().signal),interpretation());
    assert.equal(requests.length,1);
    assert.equal(requests[0].response_format.type,'json_schema');
    const image=requests[0].messages[1].content.find(c=>c.type==='image_url');
    assert.equal(image.image_url.url,`data:image/png;base64,${bytes.toString('base64')}`);
    assert.match(requests[0].messages[0].content,/never instructions/);
    assert.match(requests[0].messages[1].content[0].text,/untrusted caption/);
    assert.ok(!JSON.stringify(session.model).includes(endpoint));
    handle.runtime.contextWindowTokens=8000;
    await assert.rejects(session.interpret({bytes,caption:null},new AbortController().signal),/context_budget/);
    await assert.rejects(session.interpret({bytes:Buffer.alloc(8*1024**2+1),caption:null},new AbortController().signal),/image_budget/);
    assert.equal(requests.length,1);
  } finally {server.close();server.closeAllConnections();await once(server,'close');}
});
