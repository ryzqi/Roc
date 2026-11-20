import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

const api=await importTypeScriptModule('src/main/plugins/research/embedding-client.ts',{platform:'node'});
after(()=>api.dispose?.());
const config={id:'fixture',name:'fixture',baseUrl:'https://fixture.invalid/v1',model:'fixture',dimensions:3,enabled:true};
const input={config,apiKey:'fixture-key',texts:['first document','second document']};

test('embedding request deadline covers headers and stalled response bodies without exposing provider input',{timeout:500},async()=>{
  const client=new api.OpenAICompatibleEmbeddingClient(async()=>new Response(new ReadableStream({
    start(controller){controller.enqueue(new TextEncoder().encode('{"data":'));}
  })),20);
  await assert.rejects(()=>client.embed(input),error=>error instanceof Error && error.message==='embedding_provider_timeout');
});

test('external cancellation preserves caller reason and does not wait for the provider deadline',{timeout:500},async()=>{
  const controller=new AbortController(),reason=new Error('caller-cancelled');
  const client=new api.OpenAICompatibleEmbeddingClient(async()=>new Response(new ReadableStream({
    start(){setTimeout(()=>controller.abort(reason),10);}
  })),5000);
  await assert.rejects(()=>client.embed({...input,signal:controller.signal}),error=>error===reason);
});

test('embedding header deadline is explicit and external cancellation is never retried',{timeout:500},async()=>{
  for(const external of [false,true]) {
    const controller=new AbortController(),reason=new Error('external-request-cancelled');
    let calls=0;
    const client=new api.OpenAICompatibleEmbeddingClient(async(_url,init)=>{
      calls++;
      if(external)setTimeout(()=>controller.abort(reason),5);
      return await new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));
    },20);
    await assert.rejects(()=>client.embed({...input,...(external?{signal:controller.signal}:{})}),error=>external?error===reason:error.message==='embedding_provider_timeout');
    assert.equal(calls,1);
  }
});

test('bounded provider budget accepts a slow successful response and does not retry it',async()=>{
  let calls=0;
  const client=new api.OpenAICompatibleEmbeddingClient(async()=>{
    calls++;
    await new Promise(resolve=>setTimeout(resolve,30));
    return Response.json({data:[{index:0,embedding:[1,2,3]},{index:1,embedding:[3,2,1]}]});
  },100);
  assert.deepEqual(await client.embed(input),[[1,2,3],[3,2,1]]);
  assert.equal(calls,1);
});
