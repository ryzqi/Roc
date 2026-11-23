import assert from 'node:assert/strict';
import {join, resolve} from 'node:path';
import {startSmokeProvider} from '../../tests/smoke/lib/fixtures.mjs';
import {sampleElectronProcesses} from './electron-metrics.mjs';
import {measureRendererWorkload} from './renderer-workload-metrics.mjs';
import {summarizeRows} from './report-lib.mjs';
import {runSustainedStream} from './sustained-stream-scenario.mjs';

export const uiWorkloadFixture = {projects: 100, literature: [100, 2000, 10000],
  historyMessages: [500, 5000], streamChunks: [500, 5000], streamChunkIntervalMs: 1,
  viewSwitches: 20, viewport: {width: 1440, height: 900}};

/** Production application/IPC with an isolated seeded database and a local scripted provider.
 * Timing rows are observations, never synthetic pass thresholds or external-service claims.
 */
export async function runUiWorkloads({app, page, report, save, sustainedStream = null}) {
  const rawRoot = process.env.ROC_PERF_RAW_TRACE_DIR;
  const rawTracePath = id => rawRoot === undefined ? null : join(resolve(rawRoot), `${id}.trace.json`);
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  let provider, activeWorkloadId = 'ui-workload-setup';
  const captureFailure = async (id, error) => {
    report.failedWorkload = {id, error: String(error), state: await page.evaluate(() => ({
      text: document.body.innerText.slice(-2000), terminals: window.__rocWorkloadTerminals,
      stream: window.__rocWorkloadStream, events: window.__rocWorkloadEventCount,
      transcript: (() => {
        const node = document.querySelector('[data-testid="assistant-transcript"]');
        return node === null ? null : {scrollTop: node.scrollTop, scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight, messageCount: node.dataset.messageCount,
          jumpToLatest: document.querySelector('[data-testid="assistant-scroll-bottom"]') !== null,
          tail: node.textContent?.slice(-1000)};
      })(),
      composer: document.querySelector('[data-testid="assistant-composer-input"]')?.value,
      composerMode: document.querySelector('[data-testid="assistant-composer-mode"]')?.getAttribute('aria-label'),
      send: document.querySelector('[data-testid="assistant-composer-send"]')?.textContent,
      sendDisabled: document.querySelector('[data-testid="assistant-composer-send"]')?.disabled
    })).catch(() => null), providerRequests: (provider?.requests ?? []).map(request => ({
      method: request.method, url: request.url, model: request.body?.model,
      stream: request.body?.stream, messageCount: request.body?.messages?.length,
      scriptedTurns: request.body?.messages?.flatMap(message => {
        const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
        return text?.match(/ROC-P4-(?:RUN|SLOW-TAG):[A-Za-z0-9_-]+/gu) ?? [];
      })
    }))};
    save();
  };
  const record = async (id, action) => {
    activeWorkloadId = id;
    let measurement;
    try {
      measurement = await measureRendererWorkload(page, action, {rawTracePath: rawTracePath(id)});
    } catch (error) {
      await captureFailure(id, error);
      throw error;
    }
    const rows = Array.isArray(measurement.result) ? measurement.result : [measurement.result];
    const scenario = {id, samples: rows, summary: summarizeRows(rows), measurement,
      processes: await sampleElectronProcesses(app)};
    report.scenarios.push(scenario);
    save();
    console.log(JSON.stringify({uiWorkload: id, elapsedMs: measurement.elapsedMs,
      longTasks: measurement.trace.longTaskCount, heapUsedBytes: measurement.after.heapUsedBytes}));
    return scenario;
  };
  const paint = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const closeContext = async () => {
    if (await page.getByTestId('context-drawer').isVisible()) await page.getByTestId('titlebar-toggle-sidebar').click();
  };
  try {
    await record('100-project-search', async () => {
      await page.getByTestId('portal-search').fill('Performance Profile 99');
      await page.getByTestId('portal-card-open-project-performance-99').waitFor();
      const filteredRows = await page.locator('[data-testid^="portal-card-open-"]').count();
      assert.equal(filteredRows, 1, 'project_search_scope');
      await page.getByTestId('portal-search').fill('');
      await page.getByTestId('portal-card-open-project-performance-0').waitFor();
      return {projectCount: 100, filteredRows};
    });
    await page.getByTestId('portal-card-open-project-performance-0').click();
    await page.getByTestId('activity-nav-library').click();
    await closeContext();
    const library = page.locator('#literature-navigation');
    if (!await library.isVisible()) await page.getByTestId('literature-toggle-navigation').click();
    await library.waitFor({state: 'visible'});
    for (const count of uiWorkloadFixture.literature) {
      await record(`literature-${count}`, async () => {
        const started = performance.now();
        await library.getByTestId('literature-search').fill(`Scale${count} literature`);
        await library.getByTestId('literature-search').press('Enter');
        await page.waitForFunction(count => {
          const text = document.querySelector('#literature-navigation [data-testid="literature-count"]')?.textContent ?? '';
          return text.replaceAll(',', '').includes(`/ ${count} 条`);
        }, count);
        const queryReadyMs = performance.now() - started;
        let pagesLoaded = 1;
        const loadStarted = performance.now();
        const more = library.getByTestId('literature-load-more');
        while (await more.count() > 0) {
          assert.ok(pagesLoaded <= Math.ceil(count / 200), 'library_pagination_did_not_advance');
          const previous = await library.getByTestId('literature-count').textContent();
          await more.click();
          await page.waitForFunction(previous => document.querySelector('#literature-navigation [data-testid="literature-count"]')?.textContent !== previous, previous);
          pagesLoaded++;
        }
        const allPagesReadyMs = performance.now() - loadStarted;
        assert.equal((await library.getByTestId('literature-count').textContent()).replaceAll(',', ''),
          `已加载 ${count} / ${count} 条`, 'all_library_pages_loaded');
        const body = library.getByTestId('literature-list-body');
        await body.focus();
        await page.keyboard.press('End');
        const lastId = `performance-paper-${count}-${String(count).padStart(5, '0')}`;
        await library.getByTestId(`literature-row-${lastId}`).waitFor({state: 'visible'});
        await body.hover();
        for (let index = 0; index < 20; index++) {await page.mouse.wheel(0, index % 2 === 0 ? -500 : 500); await paint();}
        const mountedRows = await library.locator('[data-testid^="literature-row-"]').count();
        assert.ok(mountedRows > 0 && mountedRows < 100, 'library_rows_not_windowed');
        return {totalItems: count, pagesLoaded, queryReadyMs, allPagesReadyMs, mountedRows};
      });
    }
    await record('20-canvas-switches', async () => {
      const rows = [];
      const destinations = ['overview', 'library', 'writing', 'runs'];
      for (let index = 0; index < 20; index++) {
        const view = destinations[index % destinations.length];
        const started = performance.now();
        await page.getByTestId(`activity-nav-${view}`).click();
        await page.locator(`[data-shown-view="${view}"]`).waitFor({state: 'visible'});
        await paint();
        rows.push({index, view, readyMs: performance.now() - started,
          mountedViewHosts: await page.locator('[data-project="project-performance-0"]').count()});
      }
      return rows;
    });

    provider = await startSmokeProvider({});
    const configured = await page.evaluate(async endpoint => {
      const current = await window.roc.settings.get();
      if (!current.ok) return current;
      const providerId = 'ui-performance-provider', modelId = 'ui-performance-model';
      const saved = await window.roc.settings.save({settings: current.data.settings,
        permissions: current.data.permissions, defaultModelId: `${providerId}:${modelId}`,
        providers: [...current.data.providers.filter(provider => provider.id !== providerId),
          {id: providerId, name: 'UI performance fixture', type: 'openai_compatible', endpoint,
            credentialRef: `secret:${providerId}`, enabled: true,
            models: [{id: modelId, displayName: 'UI performance fixture', enabled: true,
              supportsStreaming: true, supportsToolCalls: true, supportsImages: false}]}]});
      if (!saved.ok) return saved;
      return await window.roc.settings.setProviderSecret({providerId, plaintext: 'isolated-performance-fixture'});
    }, provider.endpoint);
    assert.ok(configured.ok, JSON.stringify(configured));
    // Settings snapshots are loaded by the production shell on mount.
    await page.reload();
    await page.getByTestId('activity-nav-runs').waitFor();
    await page.evaluate(() => {
      window.__rocWorkloadTerminals = [];
      window.__rocWorkloadEventCount = 0;
      window.__rocWorkloadStream = {runId: null, textDeltaCount: 0, firstTextDeltaAt: null, lastTextDeltaAt: null};
      window.__rocWorkloadUnsubscribe = window.roc.chat.onRunEvent(raw => {
        const event = raw !== null && typeof raw === 'object' && !('type' in raw) && 'event' in raw ? raw.event : raw;
        window.__rocWorkloadEventCount++;
        const stream = window.__rocWorkloadStream;
        if (event.type === 'run_started') stream.runId = event.runId;
        if (event.runId === stream.runId && event.type === 'assistant_block' && event.block.kind === 'text' &&
          event.block.phase === 'delta' && event.block.text?.length > 0) {
          const now = performance.now();
          stream.textDeltaCount++;
          stream.firstTextDelta ??= event.block.text.slice(0, 80);
          stream.lastTextDelta = event.block.text.slice(-80);
          stream.firstTextDeltaAt ??= now;
          stream.lastTextDeltaAt = now;
        }
        if (['run_completed', 'run_cancelled', 'run_failed'].includes(event.type)) {
          window.__rocWorkloadTerminals.push({type: event.type, runId: event.runId,
            ...(event.code === undefined ? {} : {code: event.code}),
            ...(event.message === undefined ? {} : {message: event.message})});
        }
      });
    });
    for (const count of uiWorkloadFixture.historyMessages) {
      await page.getByTestId('activity-nav-runs').click();
      if (!await page.getByTestId('context-drawer').isVisible()) await page.getByTestId('titlebar-toggle-sidebar').click();
      await page.getByTestId(`session-row-thread-profile-${count}`).click();
      await page.getByTestId('assistant-composer-input').waitFor({state: 'visible'});
      await page.waitForFunction(marker => document.querySelector('[data-testid="assistant-transcript"]')?.textContent?.includes(marker), `profile-marker-${count}-${count}`);
      await closeContext();
      await record(`history-${count}-stream-${count}`, async () => {
        await page.evaluate(() => {window.__rocWorkloadTerminals = []; window.__rocWorkloadEventCount = 0;});
        const input = page.getByTestId('assistant-composer-input');
        const tag = `SCALE${count}`;
        await input.fill(`ROC-P4-MODE:slow ROC-P4-RUN:scale${count} ROC-P4-SLOW:${count}x1 ROC-P4-SLOW-TAG:${tag}`);
        const started = performance.now();
        await input.press('Enter');
        await page.waitForFunction(tag => document.querySelector('[data-testid="assistant-transcript"]')?.textContent?.includes(`${tag}-0001`), tag);
        const firstChunkMs = performance.now() - started;
        // Typing while the provider is still streaming exercises the real composer.
        await input.fill('input probe during streaming');
        assert.equal(await input.inputValue(), 'input probe during streaming');
        await page.waitForFunction(() => window.__rocWorkloadTerminals.length > 0, null, {timeout: 120_000});
        const terminal = await page.evaluate(() => window.__rocWorkloadTerminals[0]);
        assert.equal(terminal.type, 'run_completed', JSON.stringify(terminal));
        await page.waitForFunction(marker => document.querySelector('[data-testid="assistant-transcript"]')?.textContent?.includes(marker), `${tag}-${String(count).padStart(4, '0')}`);
        const completedMs = performance.now() - started;
        const mountedRows = await page.locator('[data-testid="assistant-message-user"], [data-testid="assistant-message-assistant"]').count();
        assert.ok(mountedRows > 0 && mountedRows < 100, 'assistant_rows_not_windowed');
        const receivedEvents = await page.evaluate(() => window.__rocWorkloadEventCount);
        await input.fill('');
        return {historyMessages: count, providerChunks: count, receivedEvents, firstChunkMs, completedMs, mountedRows};
      });
    }
    if (sustainedStream !== null) {
      activeWorkloadId = 'history-5000-sustained-start';
      await runSustainedStream({page, report, save, record, config: sustainedStream});
    }
    report.limitations.push('UI scale workloads use the production built app and IPC with 100 generated projects, 12,100 generated library records and seeded user-message histories. They do not measure real user data or external scholarly/model services.',
      'Library scales are explicit query subsets; every page is loaded via the production Load more action before End/scroll. Stream scenarios add 500/5000 local SSE chunks to 500/5000 persisted user messages, not 500/5000 independent model runs.',
      'Workload tracing and RAF sampling add overhead. RAF cadence is not compositor FPS; input-to-second-RAF is a paint-opportunity proxy. Raw CDP traces are opt-in via ROC_PERF_RAW_TRACE_DIR.',
      'UI scale scenarios run once per invocation; --samples controls independent startup samples. Continuous streaming requires the separately configured sustainedStream scenario; short 500/5000-chunk runs do not establish 30-minute behavior.');
    if (sustainedStream !== null) report.limitations.push('Sustained streaming uses a real local HTTP SSE provider at a nominal 360 ms interval, with production model, IPC and rendering paths. Text delta progression, recent receipt, run identity and completion are asserted. Only checkpoint windows use tracing/RAF; this is an engineering soak, not external-model throughput or scientific quality evidence.');
    assert.deepEqual(errors, [], 'ui_workload_renderer_errors');
    save();
  } catch (error) {
    if (report.failedWorkload === undefined) await captureFailure(activeWorkloadId, error);
    throw error;
  } finally {
    try {
      if (!page.isClosed()) await page.evaluate(() => {window.__rocWorkloadUnsubscribe?.(); delete window.__rocWorkloadUnsubscribe;});
    } finally {
      try {await provider?.close({force: true});}
      finally {page.off('pageerror', onError);}
    }
  }
}
