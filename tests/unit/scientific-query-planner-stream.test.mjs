import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Annotation, END, START, StateGraph} from '@langchain/langgraph';
import {FakeListChatModel} from '@langchain/core/utils/testing';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

const {createScientificQueryGenerator} = await importTypeScriptModule(
  'src/main/plugins/research/scientific-query-planner.ts', {platform:'node'});
const {adaptDeepAgentRun} = await importTypeScriptModule(
  'src/main/services/deep-agent/deep-agent-stream-adapter.ts', {platform:'node'});
const supplement = {intents:['overview'],documentIds:['paper'],datasets:[],metrics:[],sectionRoles:[]};
async function* empty() {}

// Exercise inherited callbacks in the installed graph and Roc's actual event projection.
// Both token streams and completed non-streaming responses must remain internal.
for (const disableStreaming of [false, true]) {
  test(`nested scientific planner stays out of assistant text (disableStreaming=${disableStreaming})`, async () => {
    const planner = new FakeListChatModel({responses:[JSON.stringify(supplement)],disableStreaming});
    const generator = createScientificQueryGenerator({createDefaultChatModel:async () => ({
      provider:{id:'provider'},modelId:'model',model:{withStructuredOutput:(schema, options) => {
        assert.equal(options.includeRaw,true);
        return planner.pipe(raw => ({parsed:schema.parse(JSON.parse(typeof raw.content === 'string'
          ? raw.content : raw.content.filter(block=>block.type==='text').map(block=>block.text).join('')))}));
      }}
    })});
    const answer = new FakeListChatModel({responses:['Source-supported answer.']});
    const graph = new StateGraph(Annotation.Root({messages:Annotation(),plan:Annotation()}))
      .addNode('tools', async () => ({plan:await generator({query:'unclear',papers:[]},new AbortController().signal)}))
      .addNode('model', async () => ({messages:[await answer.invoke('Answer from the retrieved source.')]}))
      .addEdge(START,'tools').addEdge('tools','model').addEdge('model',END).compile();
    const raw = await graph.streamEvents({}, {version:'v3'});
    const adapted = adaptDeepAgentRun({messages:raw.messages,toolCalls:empty(),subagents:empty(),
      output:raw.output, get interrupted(){return raw.interrupted;}
    },{projectToolOutput:({output})=>output});
    const events = [];
    for await (const event of adapted.events) events.push(event);
    assert.deepEqual((await raw.output).plan.output,supplement);
    assert.equal(await adapted.output,'Source-supported answer.');
    assert.equal(events.filter(e=>e.type==='assistant_delta' && e.kind==='text').map(e=>e.text).join(''),
      'Source-supported answer.');
  });
}
