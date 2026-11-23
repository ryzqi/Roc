import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
const built = await build({stdin:{contents:`
  export {createPluginCapabilityAdapter} from './src/main/ipc/plugin-capability-adapter';
  export {terminalOwner} from './src/main/services/terminal-owner-context';
  export {terminalSessionAttachRequestSchema,terminalSessionDetachRequestSchema} from './src/shared/schemas/ipc-workspace';
`,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent',external:['electron']});
const {createPluginCapabilityAdapter,terminalOwner,terminalSessionAttachRequestSchema,terminalSessionDetachRequestSchema} =
  await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);

test('terminal IPC binds the real sender across asynchronous capability calls and restores main caller scope',async()=>{
  const calls=[];
  const adapter=createPluginCapabilityAdapter({async invokeCapability(name,input){await Promise.resolve();calls.push({name,input,owner:terminalOwner()});return {};}});
  const input={projectId:'p',cwd:'/workspace',cols:80,rows:24};
  assert.equal((await adapter.invoke('terminal.attachSession',[input],17)).ok,true);
  assert.equal((await adapter.invoke('terminal.detachSession',[{sessionId:'s',attachmentId:'a',projectId:'p'}],23)).ok,true);
  assert.deepEqual(calls.map(call=>[call.name,call.owner]),[['terminal.attachSession',17],['terminal.detachSession',23]]);
  assert.equal(terminalOwner(),0);
  assert.equal((await adapter.invoke('terminal.attachSession',[input])).ok,false);
  assert.equal((await adapter.invoke('terminal.attachSession',[input],-1)).ok,false);
  assert.equal(calls.length,2);
});

test('wire contracts cannot forge window ownership and detach requires a lease identity',()=>{
  const input={projectId:'p',cwd:'/workspace',cols:80,rows:24};
  for(const field of ['owner','windowId','senderId']) assert.equal(terminalSessionAttachRequestSchema.safeParse({...input,[field]:17}).success,false);
  assert.equal(terminalSessionDetachRequestSchema.safeParse({sessionId:'s',projectId:'p'}).success,false);
});
