import assert from 'node:assert/strict';
import {test} from 'node:test';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

const stream = await importTypeScriptModule('src/main/services/deep-agent/stream-consumers.ts', {platform: 'node', tempDir: '.runtime/tmp'});
const {validateOutcomeConsistency} = await importTypeScriptModule('src/main/services/deep-agent/outcome-validator.ts');
const {createOutcomeTextCollector, maxOutcomeTextCharacters} = await importTypeScriptModule(
  'src/main/services/deep-agent/outcome-text.ts', {platform: 'node', tempDir: '.runtime/tmp'});

test('stream validation retains counts instead of text while emitting every delta', async () => {
  const state = stream.createStreamConsumerState({usageAccumulator: stream.createUsageAccumulator()});
  let emitted = 0;
  const text = 'x'.repeat(4096);
  async function* events() {
    for (let index = 0; index < 2048; index++) {
      yield {type: 'assistant_delta', kind: index % 2 ? 'text' : 'reasoning', text, scope: null};
    }
  }
  await stream.consumeDeepAgentEventStream({events: events(), state, runId: 'memory-run', callbacks: {
    emitRuntimeEvent(event) { assert.equal(event.block.text, text); emitted++; }
  }});
  assert.equal(emitted, 2048);
  assert.deepEqual(state.assistantText, {chunks: 1024, characters: 4194304, hasContent: true});
  assert.deepEqual(state.reasoningText, state.assistantText);
  assert.ok(JSON.stringify(state).length < 1000, 'state must not retain streamed payloads');
  assert.equal(validateOutcomeConsistency({...state, toolCallsByBlockId: new Map(), hookDisplayTexts: [], usageAccumulated: false}), null);
});

test('whitespace and reasoning still require a conclusion without joining text', async () => {
  const state = stream.createStreamConsumerState({usageAccumulator: stream.createUsageAccumulator()});
  const outcome = () => validateOutcomeConsistency({...state, toolCallsByBlockId: new Map(), hookDisplayTexts: [], usageAccumulated: false});
  async function* events() { yield {type: 'assistant_delta', kind: 'text', text: ' \n', scope: null}; }
  await stream.consumeDeepAgentEventStream({events: events(), state, runId: 'empty', callbacks: {emitRuntimeEvent() {}}});
  assert.equal(outcome().code, 'agent_run_produced_no_output');
  assert.equal(outcome().diagnostics.assistantTotalChars, 2);
  stream.recordStreamText(state.reasoningText, 'reasoning');
  assert.equal(outcome().code, 'agent_run_missing_conclusion');
  stream.recordStreamText(state.assistantText, 'final fallback');
  assert.equal(outcome(), null);
});

test('final text preserves chunked hook stripping and stops overflow explicitly', () => {
  const collector = createOutcomeTextCollector(['hook prefix']);
  collector.push('hook ');
  collector.push('prefix\n');
  for (let index = 0; index < 1000; index++) collector.push('answer ');
  assert.equal(collector.finish(), 'answer '.repeat(1000));
  assert.equal(collector.finish(), '', 'finished fragments are released');
  const bounded = createOutcomeTextCollector([]);
  bounded.push('x'.repeat(maxOutcomeTextCharacters));
  assert.throws(() => bounded.push('extra'), error => error.code === 'agent_output_memory_limit' && !error.retryable);
  assert.equal(bounded.finish().length, maxOutcomeTextCharacters, 'overflow does not corrupt accepted content');
});
