import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, test} from 'node:test';
import {AIMessage, HumanMessage} from '@langchain/core/messages';
import {ChatOpenAI, ChatOpenAICompletions} from '@langchain/openai';
import {build} from 'esbuild';

let directory, api;
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-context-summary-'));
  symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
  const outfile = join(directory, 'context-summary.mjs');
  await build({
    entryPoints: ['src/main/services/deep-agent/context/context-summary.ts'],
    outfile, bundle: true, format: 'esm', platform: 'node',
    packages: 'external', logLevel: 'silent'
  });
  api = await import(outfile);
});
after(() => rmSync(directory, {recursive: true, force: true}));

const summary = {
  goal: 'Compile the existing draft.',
  facts: ['The draft remains an engineering fixture report.'],
  decisions: ['Keep the existing approval boundary.'],
  filesTouched: ['ui-checks/engineering-report.tex'],
  toolEvidence: ['read_file confirmed 11pt and amsmath.'],
  verification: ['The draft has not been compiled.'],
  openQuestions: ['Build verification is still required.'],
  nextActions: ['Compile the saved draft.']
};
const input = {
  goal: summary.goal, workspacePath: '/workspace',
  artifactReferences: [], userConstraints: ['Do not change approvals.'],
  messages: [new HumanMessage('Continue the saved draft.')], recentMessages: []
};
const usage = {input_tokens: 100, output_tokens: 20, total_tokens: 120};

// Replays the E070 provider response shape through the installed structured-output
// pipeline: valid JSON text blocks, no tool call, and consequently parsed=null.
class ResponseModel extends ChatOpenAI {
  constructor(content) {
    const fields = {
      model: 'deepseek-regression', apiKey: 'offline-regression', maxRetries: 0,
      configuration: {fetch: async () => { throw new Error('regression_network_forbidden'); }}
    };
    const completions = new ChatOpenAICompletions(fields);
    completions.calls = 0;
    completions._generate = async () => {
      completions.calls++;
      return {
        generations: [{
          text: '', message: new AIMessage({
            content,
            tool_calls: [], invalid_tool_calls: [],
            response_metadata: {finish_reason: 'stop'},
            usage_metadata: usage
          })
        }]
      };
    };
    // ChatOpenAI.withConfig creates a new facade; it retains this completions
    // instance through fields, so the real parser receives the replayed message.
    super({...fields, completions});
    this.replay = completions;
  }
  get calls() { return this.replay.calls; }
}

test('summary accepts schema-valid raw text when the real structured pipeline returns parsed=null', async () => {
  const model = new ResponseModel([{type: 'text', text: JSON.stringify(summary)}]);
  const observed = [];
  const result = await api.summarizeWithCurrentModel({
    ...input, model, estimatedInputTokens: 200, estimateApproximate: true,
    usageObserver: {
      async invoke(call) {
        const response = await call.invoke();
        assert.equal(response.parsed, null);
        observed.push({
          purpose: call.purpose,
          estimatedInputTokens: call.estimatedInputTokens,
          usage: call.responseMessage(response).usage_metadata
        });
        return response;
      }
    }
  });
  assert.deepEqual(result, summary);
  assert.equal(model.calls, 1, 'Parsing valid raw JSON must not issue another model call.');
  assert.deepEqual(observed, [{purpose: 'summary', estimatedInputTokens: 200, usage}]);
});

test('summary preserves plain and fenced JSON string handling', async t => {
  for (const content of [JSON.stringify(summary), `\`\`\`json\n${JSON.stringify(summary)}\n\`\`\``]) {
    await t.test(content.startsWith('```') ? 'fenced' : 'plain', async () => {
      assert.deepEqual(await api.summarizeWithCurrentModel({
        ...input, model: new ResponseModel(content)
      }), summary);
    });
  }
});

test('invalid raw summaries still fail without another model call', async t => {
  for (const [name, content] of [
    ['empty', ''],
    ['malformed JSON', '{"goal":'],
    ['missing fields', '{"goal":"Compile"}'],
    ['wrong field type', JSON.stringify({...summary, facts: 'not an array'})],
    ['unrelated text', 'The draft is ready.']
  ]) {
    await t.test(name, async () => {
      const model = new ResponseModel([{type: 'text', text: content}]);
      await assert.rejects(api.summarizeWithCurrentModel({...input, model}), /context_summary_failed/);
      assert.equal(model.calls, 1);
    });
  }
});

test('existing parsed output remains authoritative and invalid parsed objects cannot use raw fallback', async () => {
  for (const parsed of [summary, {...summary, facts: 'invalid'}]) {
    let calls = 0;
    const model = {
      withStructuredOutput() {
        return {async invoke() {
          calls++;
          return {parsed, raw: new AIMessage(JSON.stringify(summary))};
        }};
      },
      async invoke() { throw new Error('unexpected_unstructured_call'); }
    };
    const promise = api.summarizeWithCurrentModel({...input, model});
    if (parsed === summary) assert.deepEqual(await promise, summary);
    else await assert.rejects(promise, /context_summary_failed/);
    assert.equal(calls, 1);
  }
});
