import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sustainedStreamConfig} from '../../scripts/performance/sustained-stream-scenario.mjs';
import {startSmokeProvider} from '../smoke/lib/fixtures.mjs';

test('sustained stream configuration schedules a real duration and leaves room for the last sampling window', () => {
  assert.equal(sustainedStreamConfig(), null);
  assert.equal(sustainedStreamConfig('0'), null);
  const config = sustainedStreamConfig('30');
  assert.deepEqual(config.checkpointMinutes, [0, 5, 15, 30]);
  assert.ok((config.providerChunks - 1) * config.chunkIntervalMs >= config.durationMs + config.sampleWindowMs);
  assert.deepEqual(sustainedStreamConfig('1').checkpointMinutes, [0, 1]);
  assert.deepEqual(sustainedStreamConfig('5').checkpointMinutes, [0, 5]);
  for (const value of ['-1', '0.5', '121', 'invalid']) assert.throws(() => sustainedStreamConfig(value));
});

async function requestSlowStream(provider, chunks, interval) {
  return await fetch(`${provider.endpoint}/chat/completions`, {method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({model: 'performance-fixture', stream: true, messages: [{role: 'user',
      content: `ROC-P4-MODE:slow ROC-P4-RUN:nodecheck ROC-P4-SLOW:${chunks}x${interval} ROC-P4-SLOW-TAG:NODECHECK`}]})});
}

test('local SSE provider emits separately paced chunks and a completed terminal frame over HTTP', async () => {
  const provider = await startSmokeProvider({});
  try {
    const started = performance.now();
    const response = await requestSlowStream(provider, 3, 20);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/u);
    const text = await response.text();
    assert.ok(performance.now() - started >= 60, 'provider_must_wait_between_chunks');
    for (const marker of ['NODECHECK-0001', 'NODECHECK-0002', 'NODECHECK-0003']) assert.ok(text.includes(marker));
    assert.match(text, /"finish_reason":"stop"/u);
    assert.ok(text.endsWith('data: [DONE]\n\n'));
    assert.equal(provider.requests.length, 1);
  } finally {await provider.close({force: true});}
});

test('a new slow turn selects its own cadence and marker after a completed long response in the same thread', async () => {
  const provider = await startSmokeProvider({});
  try {
    const started = performance.now();
    const response = await fetch(`${provider.endpoint}/chat/completions`, {method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({model: 'performance-fixture', stream: true, messages: [
        {role: 'user', content: 'ROC-P4-MODE:slow ROC-P4-RUN:scale5000 ROC-P4-SLOW:5000x1 ROC-P4-SLOW-TAG:SCALE5000'},
        {role: 'assistant', content: Array.from({length: 5000}, (_, index) => `SCALE5000-${String(index + 1).padStart(4, '0')}`).join(' ')},
        {role: 'user', content: 'ROC-P4-MODE:slow ROC-P4-RUN:sustained ROC-P4-SLOW:3x20 ROC-P4-SLOW-TAG:SUSTAINED'}
      ]})});
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(performance.now() - started >= 60, 'new_turn_cadence_was_ignored');
    assert.equal((text.match(/SUSTAINED-\d+/gu) ?? []).length, 3);
    assert.ok(text.includes('SUSTAINED-0001') && text.includes('SUSTAINED-0003'));
    assert.ok(!text.includes('SCALE5000-'), 'previous_turn_marker_was_reused');
    assert.match(text, /"finish_reason":"stop"/u);
  } finally {await provider.close({force: true});}
});

test('forced provider cleanup interrupts an active long SSE delay instead of awaiting the soak duration', async () => {
  const provider = await startSmokeProvider({});
  let reader, closed = false;
  try {
    const response = await requestSlowStream(provider, 1000, 60_000);
    reader = response.body.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /NODECHECK-0001/u);
    const started = performance.now();
    await provider.close({force: true});
    closed = true;
    assert.ok(performance.now() - started < 2000, 'forced_close_waited_for_active_stream');
  } finally {
    await reader?.cancel().catch(() => {});
    if (!closed) await provider.close({force: true});
  }
});
