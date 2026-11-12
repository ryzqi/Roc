import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Annotation, Command, END, MemorySaver, START, StateGraph, interrupt} from '@langchain/langgraph';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

const {adaptDeepAgentRun} = await importTypeScriptModule(
  'src/main/services/deep-agent/deep-agent-stream-adapter.ts',
  {platform:'node',tempDir:'.artifacts/research-harness/interrupt-stream'}
);
const {projectDeepAgentInterrupts} = await importTypeScriptModule(
  'src/main/plugins/agent/interrupt-projection.ts',
  {platform:'node',tempDir:'.artifacts/research-harness/interrupt-stream'}
);
const payload = {kind:'approval',request:{
  actionRequests:[{name:'research_approve_gate',args:{stage:'discovery'}}],
  reviewConfigs:[{actionName:'research_approve_gate',allowedDecisions:['approve','reject']}]
}};
async function* empty() {}

test('nested gate interrupt propagates once through the installed v3 stream and resumes once', async () => {
  const state = Annotation.Root({approved:Annotation()});
  let effects = 0;
  const gate = new StateGraph(state).addNode('review', () => {
    const approved = interrupt(payload);
    effects++;
    return {approved};
  }).addEdge(START,'review').addEdge('review',END).compile();
  const parent = new StateGraph(state).addNode('tool', async value => await gate.invoke(value))
    .addEdge(START,'tool').addEdge('tool',END).compile({checkpointer:new MemorySaver()});
  const config = {version:'v3',configurable:{thread_id:'nested-gate'}};
  const raw = await parent.streamEvents({},config);
  const adapted = adaptDeepAgentRun({...raw,
    messages:raw.messages,toolCalls:empty(),subagents:empty(),output:raw.output,
    get interrupted(){return raw.interrupted;},get interrupts(){return raw.interrupts;}
  },{projectToolOutput:({output})=>output});
  const events = [];
  for await (const event of adapted.events) events.push(event);
  assert.equal(effects,0);
  const pending = projectDeepAgentInterrupts(events.find(event=>event.type==='run_interrupted').interrupts);
  assert.equal(pending.length,1);
  assert.deepEqual(pending[0].payload,payload);
  const resumed = await parent.invoke(new Command({resume:{[pending[0].interruptId]:true}}),
    {configurable:config.configurable});
  assert.equal(resumed.approved,true);
  assert.equal(effects,1);
});

test('replaying an approval after a later network failure does not repeat the completed gate effect', async () => {
  const state = Annotation.Root({approved:Annotation(),done:Annotation()});
  let effects = 0;
  let modelAttempts = 0;
  const gate = new StateGraph(state).addNode('review', () => {
    const approved = interrupt(payload);
    effects++;
    return {approved};
  }).addEdge(START,'review').addEdge('review',END).compile();
  const parent = new StateGraph(state)
    .addNode('tool', async value => await gate.invoke(value))
    .addNode('model', () => {
      if (++modelAttempts === 1) throw new TypeError('fetch failed');
      return {done:true};
    })
    .addEdge(START,'tool').addEdge('tool','model').addEdge('model',END)
    .compile({checkpointer:new MemorySaver()});
  const config = {configurable:{thread_id:'approval-network-replay'}};
  const pending = await parent.invoke({},config);
  const resume = {[pending.__interrupt__[0].id]:{decisions:[{type:'reject'}]}};
  await assert.rejects(parent.invoke(new Command({resume}),config), /fetch failed/);
  assert.equal(effects,1);
  const result = await parent.invoke(new Command({resume}),config);
  assert.equal(result.done,true);
  assert.deepEqual(result.approved,resume[pending.__interrupt__[0].id]);
  assert.equal(effects,1,'a completed gate transition must not run twice');
  assert.equal(modelAttempts,2);
});

function interruptedRun(interrupts) {
  return adaptDeepAgentRun({messages:empty(),toolCalls:empty(),subagents:empty(),
    output:Promise.resolve({messages:[]}),interrupted:true,interrupts
  },{projectToolOutput:({output})=>output});
}

test('independent approvals keep their IDs and order', async () => {
  const run = interruptedRun([{interruptId:'first',payload},{interruptId:'second',payload},
    {interruptId:'first',payload:structuredClone(payload)}]);
  const events = [];
  for await (const event of run.events) events.push(event);
  assert.deepEqual(projectDeepAgentInterrupts(events[0].interrupts).map(value=>value.interruptId),
    ['first','second']);
});

test('conflicting payloads for the same interrupt fail before an approval is exposed', async () => {
  const run = interruptedRun([{interruptId:'same',payload},
    {interruptId:'same',payload:{...payload,request:{...payload.request,actionRequests:[]}}}]);
  const events = [];
  await assert.rejects(async()=>{for await (const event of run.events) events.push(event);},
    /deep_agents_v3_run_interrupt_conflict/);
  assert.equal(events.length,0);
});
