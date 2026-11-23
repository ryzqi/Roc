import assert from 'node:assert/strict';

export function sustainedStreamConfig(value = '0') {
  const minutes = Number(value);
  assert.ok(Number.isInteger(minutes) && minutes >= 0 && minutes <= 120, 'stream_minutes_must_be_integer_0_to_120');
  if (minutes === 0) return null;
  const durationMs = minutes * 60_000, chunkIntervalMs = 360, sampleWindowMs = 3000;
  return {minutes, durationMs, chunkIntervalMs, sampleWindowMs,
    // Leave time for the final instrumented window before the provider sends its terminal frame.
    providerChunks: Math.ceil((durationMs + 15_000) / chunkIntervalMs) + 1,
    checkpointMinutes: [0, ...[5, 15].filter(point => point < minutes), minutes]};
}

const readStream = page => page.evaluate(() => ({...window.__rocWorkloadStream,
  observedAt: performance.now(), terminals: window.__rocWorkloadTerminals}));

function assertStreaming(state, runId, previousDeltaCount) {
  assert.equal(state.runId, runId, 'sustained_stream_run_changed');
  assert.deepEqual(state.terminals.filter(event => event.runId === runId), [], 'sustained_stream_ended_early');
  assert.ok(state.textDeltaCount > previousDeltaCount, 'sustained_stream_not_advancing');
  assert.ok(state.lastTextDeltaAt !== null && state.observedAt - state.lastTextDeltaAt < 5000,
    'sustained_stream_no_recent_text_delta');
}

/** The existing real local HTTP provider feeds the production model adapter, IPC and UI.
 * Long intervals contain no RAF/tracing loop. Only the explicit short checkpoints are instrumented.
 */
export async function runSustainedStream({page, report, save, record, config}) {
  await page.evaluate(() => {
    window.__rocWorkloadTerminals = [];
    window.__rocWorkloadEventCount = 0;
    window.__rocWorkloadStream = {runId: null, textDeltaCount: 0, firstTextDeltaAt: null, lastTextDeltaAt: null};
  });
  const input = page.getByTestId('assistant-composer-input');
  const tag = 'SUSTAINED';
  await input.fill(`ROC-P4-MODE:slow ROC-P4-RUN:sustained ROC-P4-SLOW:${config.providerChunks}x${config.chunkIntervalMs} ROC-P4-SLOW-TAG:${tag}`);
  // A terminal IPC event can precede the composer's rendered transition out of
  // correction mode. A new-run workload must submit through the ready Send UI.
  await page.waitForFunction(() => {
    const send = document.querySelector('[data-testid="assistant-composer-send"]');
    return send?.textContent === '发送' && !send.disabled;
  }, null, {timeout: 5000});
  const submitted = performance.now();
  await input.press('Enter');
  await page.waitForFunction(() => window.__rocWorkloadStream.textDeltaCount > 0 || window.__rocWorkloadTerminals.length > 0,
    null, {timeout: 30_000});
  const firstState = await readStream(page);
  assert.ok(firstState.textDeltaCount > 0, `sustained_stream_failed_before_text:${JSON.stringify(firstState.terminals)}`);
  await page.waitForFunction(tag => document.querySelector('[data-testid="assistant-transcript"]')?.textContent?.includes(`${tag}-0001`), tag);
  const started = performance.now();
  const initial = await readStream(page);
  const runId = initial.runId;
  assert.ok(typeof runId === 'string' && runId.length > 0, 'sustained_stream_run_id_missing');
  report.sustainedStream = {config, runId, seededHistoryMessages: 5000, precedingShortRunsInThread: 1,
    firstChunkMs: started - submitted, checkpoints: []};
  save();
  let previousDeltaCount = 0;
  for (const minutes of config.checkpointMinutes) {
    let remaining = minutes * 60_000 - (performance.now() - started);
    while (remaining > 0) {
      // A fractional final timeout can wake before the checkpoint. Keep each
      // progression observation longer than the provider's 360 ms cadence.
      await new Promise(done => setTimeout(done, Math.max(1000, Math.min(remaining, 60_000))));
      const state = await readStream(page);
      assertStreaming(state, runId, previousDeltaCount);
      previousDeltaCount = state.textDeltaCount;
      remaining = minutes * 60_000 - (performance.now() - started);
      console.log(JSON.stringify({sustainedStream: 'progress', elapsedMs: performance.now() - started,
        textDeltaCount: state.textDeltaCount}));
    }
    const id = `history-5000-sustained-${minutes}m`;
    const scenario = await record(id, async () => {
      const before = await readStream(page);
      assertStreaming(before, runId, 0);
      const draft = `input probe at sustained stream minute ${minutes}`;
      await input.fill(draft);
      await new Promise(done => setTimeout(done, config.sampleWindowMs));
      assert.equal(await input.inputValue(), draft, 'sustained_stream_composer_draft_lost');
      const after = await readStream(page);
      assertStreaming(after, runId, before.textDeltaCount);
      previousDeltaCount = after.textDeltaCount;
      const mountedRows = await page.locator('[data-testid="assistant-message-user"], [data-testid="assistant-message-assistant"]').count();
      assert.ok(mountedRows > 0 && mountedRows < 100, 'sustained_stream_rows_not_windowed');
      return {minutes, elapsedMs: performance.now() - started, textDeltaCount: after.textDeltaCount,
        windowTextDeltas: after.textDeltaCount - before.textDeltaCount, mountedRows};
    });
    report.sustainedStream.checkpoints.push({scenarioId: id, ...scenario.samples[0]});
    save();
  }
  await page.waitForFunction(runId => window.__rocWorkloadTerminals.some(event => event.runId === runId), runId,
    {timeout: 120_000, polling: 250});
  const completed = await readStream(page);
  const terminal = completed.terminals.find(event => event.runId === runId);
  assert.equal(terminal.type, 'run_completed', JSON.stringify(terminal));
  const streamDurationMs = completed.lastTextDeltaAt - completed.firstTextDeltaAt;
  assert.ok(streamDurationMs >= config.durationMs, 'provider_did_not_stream_for_requested_duration');
  await page.waitForFunction(marker => document.querySelector('[data-testid="assistant-transcript"]')?.textContent?.includes(marker),
    `${tag}-${String(config.providerChunks).padStart(4, '0')}`);
  report.sustainedStream.completed = {terminal, elapsedMs: performance.now() - started, streamDurationMs,
    textDeltaCount: completed.textDeltaCount, receivedEvents: await page.evaluate(() => window.__rocWorkloadEventCount)};
  await input.fill('');
  save();
}
