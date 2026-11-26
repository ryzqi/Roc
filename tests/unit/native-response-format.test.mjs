import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HumanMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { createDeepAgent } from 'deepagents';
import { toolStrategy } from 'langchain';
import { readFileSync } from 'node:fs';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';
import { testArtifacts } from '../../evaluation/tests/test-artifacts.mjs';

const packages = JSON.parse(readFileSync('package.json', 'utf8'));
const { createRocToolExposureMiddleware } = await importTypeScriptModule(
  'src/main/services/deep-agent/model-tool-exposure.ts', {
    platform: 'node', tempDir: testArtifacts('native-response-format'),
    external: [...Object.keys(packages.dependencies), ...Object.keys(packages.devDependencies)]
  }
);

test('Deep Agents structuredResponse is produced even with Roc capability-only model tool exposure', async () => {
  let invoked = 0;
  const model = new ChatOpenAI({
    model: 'structured-output-fixture', apiKey: 'fixture-only', streaming: false, maxRetries: 0,
    configuration: { baseURL: 'http://fixture.invalid/v1', fetch: async (_url, init) => {
      invoked++;
      const request = JSON.parse(String(init.body));
      const structuredTool = request.tools?.find(tool => tool.type === 'function' &&
        tool.function.parameters?.properties?.answer !== undefined);
      assert.ok(structuredTool, 'native structured output tool must not be hidden by Roc exposure');
      return new Response(JSON.stringify({
        id: `structured-${invoked}`, object: 'chat.completion', created: 0, model: request.model,
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
          tool_calls: [{ type: 'function', id: `structured-call-${invoked}`,
            function: { name: structuredTool.function.name, arguments: '{"answer":"native result"}' } }] } }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }
      }), { headers: { 'content-type': 'application/json' } });
    } }
  });
  const agent = createDeepAgent({
    model,
    responseFormat: toolStrategy({ type: 'object', properties: { answer: { type: 'string' } },
      required: ['answer'], additionalProperties: false }),
    middleware: [createRocToolExposureMiddleware({ tools: [] }, 'main', 'run')]
  });
  const run = await agent.streamEvents({ messages: [new HumanMessage('Return the answer in the required structure.')] },
    { version: 'v3' });
  const output = await run.output;
  assert.deepEqual(output.structuredResponse, { answer: 'native result' });
  assert.equal(invoked, 1);
});
