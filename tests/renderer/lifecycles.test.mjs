import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import electronPath from 'electron';
import { _electron } from '@playwright/test';

// Actual React hooks in an isolated Electron renderer; only the typed preload seam is replaced.
let dir, app, page;
const rendererErrors = [];
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'roc-renderer-lifecycles-'));
  await esbuild.build({
    stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { useAsyncAction } from './src/renderer/app/use-async-resource';
      import { SWRConfig } from 'swr';
      import { APP_SWR_CONFIG } from './src/renderer/app/swr-config';
      import { IpcResourceError } from './src/renderer/app/ipc-resource';
      import { useInvalidateProjectList, useProjectList } from './src/renderer/project/use-project-list';
      import { useSettingsStore } from './src/renderer/settings/settings-scope';
      import { useMcp } from './src/renderer/management/use-mcp';
      import { useChatSession } from './src/renderer/assistant/use-chat-session';
      import { buildTranscriptVirtuosoWindow, ChatTranscriptPanel, useTranscriptFirstItemIndex } from './src/renderer/assistant/transcript-panel';
      import { useGitWorkspace } from './src/renderer/workspace/use-git-workspace';
      import { researchIndexSettingsSaveSchema } from './src/shared/schemas/research-index';
      window.validateIndexWrite = request => researchIndexSettingsSaveSchema.parse(request);
      const actionContainer = document.createElement('div');
      document.body.appendChild(actionContainer);
      const actionRoot = createRoot(actionContainer);
      function AsyncActionHarness({operation}) {
        const action = useAsyncAction(operation, {label: 'Lifecycle action'});
        window.latestAction = action;
        window.actionRenderCount = (window.actionRenderCount ?? 0) + 1;
        return null;
      }
      window.mountAsyncAction = operation => flushSync(() => actionRoot.render(
        React.createElement(React.StrictMode, null, React.createElement(AsyncActionHarness, {operation}))
      ));
      window.clearAsyncAction = () => flushSync(() => actionRoot.render(null));
      const projectListContainer = document.createElement('div');
      document.body.appendChild(projectListContainer);
      const projectListRoot = createRoot(projectListContainer);
      function ProjectListPairHarness({client}) {
        const portal = useProjectList(client);
        const palette = useProjectList(client);
        const invalidate = useInvalidateProjectList();
        window.projectListResources = {portal, palette, invalidate};
        return null;
      }
      window.mountProjectLists = client => flushSync(() => projectListRoot.render(
        React.createElement(SWRConfig, {value: APP_SWR_CONFIG},
          React.createElement(React.StrictMode, null, React.createElement(ProjectListPairHarness, {client}))
        )
      ));
      window.clearProjectLists = () => flushSync(() => {
        projectListRoot.render(null);
        window.projectListResources = null;
      });
      window.createProjectListError = error => new IpcResourceError(error);
      window.shouldRetryProjectListError = error => APP_SWR_CONFIG.shouldRetryOnError?.(error) ?? false;
      const root = createRoot(document.getElementById('root'));
      const hooks = {
        settings: p => useSettingsStore(p.client, p.projectId ?? null),
        mcp: p => useMcp(p.client, p.skills ?? []),
        mcpPair: p => { window.authorization = useMcp(p.client, null); return useMcp(p.client, p.skills ?? []); },
        chat: p => useChatSession(p),
        transcriptIndex: p => useTranscriptFirstItemIndex(p),
        git: p => useGitWorkspace(p.client, p.workspacePath)
      };
      window.buildTranscriptVirtuosoWindow = buildTranscriptVirtuosoWindow;
      function TranscriptHarness(props) {
        const scrollRef = React.useRef(null);
        return React.createElement('div', {
          id: 'transcript-scroll-parent', ref: scrollRef,
          style: {height: '320px', width: '480px', overflowY: 'auto', position: 'relative', display: 'flex', flexDirection: 'column'}
        }, React.createElement(ChatTranscriptPanel, {...props, scrollContainerRef: scrollRef}));
      }
      window.mountTranscript = props => flushSync(() => root.render(React.createElement(TranscriptHarness, props)));
      let serial = 0;
      window.mount = (kind, props, fresh = false) => {
        if (fresh) serial++;
        const Hook = hooks[kind];
        // Keep the same React identity on updates, so switches exercise lifecycle cleanup.
        window.capture ??= {};
        const cacheKey = kind + serial;
        window.capture[cacheKey] ??= p => { window.latest = Hook(p); return null; };
        flushSync(() => root.render(React.createElement(window.capture[cacheKey], props)));
      };
      window.ok = data => ({ok: true, data});
      window.fail = message => ({ok: false, error: {message}});
      window.deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return {promise, resolve, reject}; };
    `, resolveDir: process.cwd(), loader: 'js' },
    outfile: join(dir, 'hooks.js'), bundle: true, platform: 'browser', format: 'iife', logLevel: 'silent'
  });
  writeFileSync(join(dir, 'index.html'), `
    <style>
      #transcript-scroll-parent > [data-testid="assistant-transcript-host"] { height: 100%; flex: 1 1 0; min-height: 0; }
      #transcript-scroll-parent .h-full { height: 100%; }
    </style>
    <div id="root"></div><script src="hooks.js"></script>
  `);
  writeFileSync(join(dir, 'main.cjs'), `
    const { app, BrowserWindow } = require('electron');
    app.setPath('userData', ${JSON.stringify(join(dir, 'data'))});
    app.whenReady().then(() => {
      const w = new BrowserWindow({show: false});
      w.loadFile(${JSON.stringify(join(dir, 'index.html'))});
    });
  `);
  app = await _electron.launch({ executablePath: electronPath, args: [join(dir, 'main.cjs')] });
  page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => rendererErrors.push(error.message));
  await page.waitForFunction(() => typeof window.mount === 'function');
});
after(async () => {
  try {
    await app?.close();
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(rendererErrors, [], 'renderer must not throw during lifecycle tests');
});

test('async action survives StrictMode effect replay and preserves a null success value', async () => {
  await page.evaluate(() => {
    clearAsyncAction();
    window.actionDeferred = deferred();
    mountAsyncAction(() => actionDeferred.promise);
    window.actionRun = latestAction.run();
  });
  await page.waitForFunction(() => latestAction.pending);
  await page.evaluate(() => actionDeferred.resolve(ok(null)));
  assert.deepEqual(await page.evaluate(() => actionRun), {ok: true, data: null});
  assert.deepEqual(await page.evaluate(() => ({pending: latestAction.pending, error: latestAction.error})), {
    pending: false,
    error: null
  });
});

test('async action clears pending and records backend failures under StrictMode', async () => {
  await page.evaluate(() => {
    clearAsyncAction();
    window.actionDeferred = deferred();
    mountAsyncAction(() => actionDeferred.promise);
    window.actionRun = latestAction.run();
  });
  await page.waitForFunction(() => latestAction.pending);
  await page.evaluate(() => actionDeferred.resolve(fail('backend refused')));
  assert.deepEqual(await page.evaluate(() => actionRun), {ok: false, error: 'backend refused'});
  assert.deepEqual(await page.evaluate(() => ({pending: latestAction.pending, error: latestAction.error})), {
    pending: false,
    error: 'backend refused'
  });
});

test('async action does not render after unmount while its operation settles', async () => {
  await page.evaluate(() => {
    clearAsyncAction();
    window.actionDeferred = deferred();
    mountAsyncAction(() => actionDeferred.promise);
    window.actionRun = latestAction.run();
  });
  await page.waitForFunction(() => latestAction.pending);
  await page.evaluate(() => {
    clearAsyncAction();
    window.actionRendersAtUnmount = actionRenderCount;
    actionDeferred.resolve(ok('done'));
  });
  assert.deepEqual(await page.evaluate(() => actionRun), {ok: true, data: 'done'});
  assert.equal(await page.evaluate(() => actionRenderCount), await page.evaluate(() => actionRendersAtUnmount));
});

test('async action counts concurrent requests and keeps the latest error', async () => {
  await page.evaluate(() => {
    clearAsyncAction();
    window.actionDeferreds = [deferred(), deferred()];
    window.actionRunIndex = 0;
    mountAsyncAction(() => actionDeferreds[actionRunIndex++].promise);
    window.olderActionRun = latestAction.run();
    window.newerActionRun = latestAction.run();
  });
  await page.waitForFunction(() => latestAction.pending);
  await page.evaluate(() => actionDeferreds[1].resolve(fail('latest failure')));
  assert.deepEqual(await page.evaluate(() => newerActionRun), {ok: false, error: 'latest failure'});
  assert.deepEqual(await page.evaluate(() => ({pending: latestAction.pending, error: latestAction.error})), {
    pending: true,
    error: 'latest failure'
  });
  await page.evaluate(() => actionDeferreds[0].resolve(fail('stale failure')));
  assert.deepEqual(await page.evaluate(() => olderActionRun), {ok: false, error: 'stale failure'});
  await page.waitForFunction(() => !latestAction.pending);
  assert.equal(await page.evaluate(() => latestAction.error), 'latest failure');
});

test('portal and palette share a project-list request and keep cached results during refresh', async () => {
  await page.evaluate(() => {
    clearProjectLists();
    window.projectListCalls = 0;
    window.projectListResponse = deferred();
    const client = {api: {research: {listProjects: async () => {
      window.projectListCalls++;
      return projectListResponse.promise;
    }}}};
    window.mountProjectLists(client);
  });
  await page.waitForFunction(() => window.projectListCalls === 1);
  await page.evaluate(() => projectListResponse.resolve(ok([
    {id: 'p1', title: 'Shared project', status: 'active', workspacePath: null}
  ])));
  await page.waitForFunction(() => projectListResources?.portal.status === 'ready' && projectListResources?.palette.status === 'ready');
  assert.equal(await page.evaluate(() => projectListCalls), 1);
  assert.equal(await page.evaluate(() => projectListResources.portal.data[0].title), 'Shared project');
  assert.equal(await page.evaluate(() => projectListResources.palette.data[0].title), 'Shared project');

  await page.evaluate(() => {
    projectListResponse = deferred();
    projectListResources.invalidate();
  });
  await page.waitForFunction(() => window.projectListCalls === 2);
  await page.evaluate(() => projectListResponse.resolve(ok([
    {id: 'p1', title: 'Mutated project', status: 'active', workspacePath: null}
  ])));
  await page.waitForFunction(() => projectListResources?.palette.data?.[0]?.title === 'Mutated project');

  await page.evaluate(() => {
    projectListResponse = deferred();
    projectListResources.portal.reload();
  });
  await page.waitForFunction(() => window.projectListCalls === 3);
  assert.deepEqual(await page.evaluate(() => ({
    status: projectListResources.portal.status,
    title: projectListResources.portal.data?.[0]?.title,
    error: projectListResources.portal.error
  })), {status: 'ready', title: 'Mutated project', error: null});
  await page.evaluate(() => projectListResponse.resolve(ok([
    {id: 'p1', title: 'Updated project', status: 'active', workspacePath: null}
  ])));
  await page.waitForFunction(() => projectListResources?.palette.data?.[0]?.title === 'Updated project');
  assert.equal(await page.evaluate(() => projectListCalls), 3);

  await page.evaluate(() => {
    projectListResponse = deferred();
    projectListResources.palette.reload();
  });
  await page.waitForFunction(() => window.projectListCalls === 4);
  await page.evaluate(() => projectListResponse.resolve({ok: false, error: {
    code: 'temporarily_unavailable', message: 'Project list offline', category: 'system', retryable: false
  }}));
  await page.waitForFunction(() => projectListResources?.portal.error === 'Project list offline');
  assert.deepEqual(await page.evaluate(() => ({
    status: projectListResources.portal.status,
    title: projectListResources.portal.data?.[0]?.title,
    paletteStatus: projectListResources.palette.status
  })), {status: 'ready', title: 'Updated project', paletteStatus: 'ready'});
});

test('non-retryable project-list failures preserve their RocError details', async () => {
  await page.evaluate(() => {
    clearProjectLists();
    window.projectListCalls = 0;
    const failure = {
      code: 'permission_denied', message: 'Access denied', category: 'permission', retryable: false,
      userAction: 'Check project access', auditEventId: 'audit-1'
    };
    const client = {api: {research: {listProjects: async () => {
      window.projectListCalls++;
      return {ok: false, error: failure};
    }}}};
    window.mountProjectLists(client);
  });
  await page.waitForFunction(() => projectListResources?.portal.status === 'error');
  assert.equal(await page.evaluate(() => projectListCalls), 1);
  assert.equal(await page.evaluate(() => projectListResources.portal.error), 'Access denied');
  assert.deepEqual(await page.evaluate(() => projectListResources.portal.failure), {
    code: 'permission_denied', message: 'Access denied', category: 'permission', retryable: false,
    userAction: 'Check project access', auditEventId: 'audit-1'
  });
  assert.equal(await page.evaluate(() => window.shouldRetryProjectListError(
    window.createProjectListError(projectListResources.portal.failure)
  )), false);
  assert.equal(await page.evaluate(() => window.shouldRetryProjectListError(window.createProjectListError({
    code: 'temporarily_unavailable', message: 'Try again', category: 'system', retryable: true
  }))), true);
});

async function settingsFixture(projectId = null) {
  await page.evaluate((projectId) => {
    window.snapshot = {
      settings: { startup: {openAtLogin: false}, globalHotkey: null }, providers: [], defaultModelId: null,
      permissions: {schemaVersion: 3, mode: 'default', grants: []}, hooks: {config: {schemaVersion: 1, hooks: {}}}
    };
    window.index = {projectId: 'p1', revision: 1, kinds: ['markdown'], include: ['**/*'], exclude: [], watch: true, paused: false, embeddingConfigId: null};
    window.writes = [];
    window.hooksFail = true; window.indexFail = false;
    window.client = {api: {
      settings: {
        get: async () => ok(structuredClone(snapshot)),
        save: async (request) => { writes.push('core'); Object.assign(snapshot, structuredClone(request)); return ok(structuredClone(snapshot)); },
        saveHooks: async ({config}) => { writes.push('hooks'); if (hooksFail) return fail('hooks refused'); snapshot.hooks.config = structuredClone(config); return ok(snapshot.hooks); }
      },
      research: {
        getIndexStatus: async () => ok({settings: structuredClone(index)}),
        saveIndexSettings: async (request) => { validateIndexWrite(request); writes.push('index'); if (window.indexFail) return fail('revision conflict'); index = {...request, revision: index.revision + 1}; return ok({settings: structuredClone(index)}); }
      }
    }};
    mount('settings', {client, projectId}, true);
  }, projectId);
  await page.waitForFunction(() => window.latest.draft !== null);
}

test('partial save advances committed baseline, retry writes only remaining changes', async () => {
  await settingsFixture();
  await page.evaluate(() => latest.update(d => { d.settings.startup.openAtLogin = true; d.hooks.hooks = {PreToolUse: []}; }));
  await page.waitForFunction(() => latest.diff.count > 0);
  assert.equal(await page.evaluate(() => latest.save.run()), false);
  assert.deepEqual(await page.evaluate(() => ({base: latest.base.settings.startup.openAtLogin, dirty: [...latest.dirtySections], committed: latest.save.outcome.committed})),
    {base: true, dirty: ['hooks'], committed: ['core']});
  await page.evaluate(() => { hooksFail = false; });
  assert.equal(await page.evaluate(() => latest.save.run()), true);
  await page.waitForFunction(() => latest.diff.count === 0);
  assert.deepEqual(await page.evaluate(() => writes), ['core', 'hooks', 'hooks']);
});

test('discard after index failure keeps successful core and Hooks commits', async () => {
  await settingsFixture('p1');
  await page.evaluate(() => {
    hooksFail = false; window.indexFail = true;
    latest.update(d => {d.settings.startup.openAtLogin = true; d.hooks.hooks = {PreToolUse: []}; d.index.paused = true;});
  });
  await page.waitForFunction(() => latest.diff.count > 0);
  assert.equal(await page.evaluate(() => latest.save.run()), false);
  await page.waitForFunction(() => latest.save.outcome !== null);
  assert.deepEqual(await page.evaluate(() => [...latest.dirtySections]), ['rag']);
  await page.evaluate(() => latest.discard());
  await page.waitForFunction(() => latest.diff.count === 0);
  assert.deepEqual(await page.evaluate(() => [latest.draft.settings.startup.openAtLogin, latest.draft.hooks.hooks, latest.draft.index.paused]), [true, {PreToolUse: []}, false]);
});

test('edits made during save survive normalized commit', async () => {
  await settingsFixture();
  await page.evaluate(() => {
    window.write = deferred();
    client.api.settings.save = async request => { await write.promise; Object.assign(snapshot, request); return ok(structuredClone(snapshot)); };
    latest.update(d => {d.settings.startup.openAtLogin = true;});
  });
  await page.waitForFunction(() => latest.diff.count > 0);
  await page.evaluate(() => { window.saving = latest.save.run(); });
  await page.waitForFunction(() => latest.save.pending);
  await page.evaluate(() => latest.update(d => {d.settings.globalHotkey = 'Command+F9';}));
  await page.waitForFunction(() => latest.draft.settings.globalHotkey === 'Command+F9');
  await page.evaluate(async () => { write.resolve(); await saving; });
  assert.equal(await page.evaluate(() => latest.draft.settings.globalHotkey), 'Command+F9');
  assert.equal(await page.evaluate(() => latest.base.settings.globalHotkey), null);
});

async function mcpFixture(kind = 'mcp') {
  await page.evaluate((kind) => {
    window.server = {id: 'm1', name: 'MCP one', transport: 'stdio', command: 'node', args: [], env: {}, enabled: true, allowedTools: [], riskLevel: 'medium'};
    window.config = {schemaVersion: 1, approvalMode: 'default', servers: [server]};
    window.previews = [];
    window.client = {api: {
      mcp: {getConfig: async () => ok(structuredClone(config)), listServers: async () => fail('runtime offline'),
        setServerEnabled: async ({enabled}) => {if (window.toggleFail) return fail('toggle refused'); server.enabled = enabled; return ok(structuredClone(server));},
        setApprovalMode: async ({approvalMode}) => {config.approvalMode = approvalMode; return ok(structuredClone(config));}
      },
      agent: {getCapabilityPreview: async () => { const d = deferred(); previews.push(d); return d.promise; }}
    }};
    mount(kind, {client, skills: []}, true);
  }, kind);
  await page.waitForFunction(() => latest.status === 'ready');
}

test('MCP retains authored rows without runtime and hides stale preview during reload', async () => {
  await mcpFixture();
  assert.deepEqual(await page.evaluate(() => [latest.rows.length, latest.rows[0].snapshot, latest.runtimeError]), [1, null, 'runtime offline']);
  await page.waitForFunction(() => previews.length > 0);
  await page.evaluate(() => previews.at(-1).resolve(ok({manifest: {tools: [], skippedCapabilities: []}})));
  await page.waitForFunction(() => latest.previewStatus === 'ready');
  await page.evaluate(() => latest.reloadPreview());
  await page.waitForFunction(() => latest.previewStatus === 'loading');
  assert.equal(await page.evaluate(() => latest.preview), null);
});

test('MCP refreshes same-enabled-set edits and ignores earlier preview completion', async () => {
  await mcpFixture();
  await page.waitForFunction(() => previews.length > 0);
  await page.evaluate(() => { window.oldPreview = previews.at(-1); server.command = 'new-command'; latest.reload(); });
  await page.waitForFunction(() => previews.length >= 2);
  await page.evaluate(() => oldPreview.resolve(ok({manifest: {tools: [], skippedCapabilities: []}, marker: 'old'})));
  assert.equal(await page.evaluate(() => latest.preview), null);
  await page.evaluate(() => previews.at(-1).resolve(ok({manifest: {tools: [], skippedCapabilities: []}, marker: 'new'})));
  await page.waitForFunction(() => latest.previewStatus === 'ready');
  assert.equal(await page.evaluate(() => latest.preview.marker), 'new');
});

test('MCP failed toggle rolls back and another mounted reader adopts authorization changes', async () => {
  await mcpFixture('mcpPair');
  await page.evaluate(() => { window.toggleFail = true; });
  assert.equal(await page.evaluate(() => latest.toggle.run('m1', false)), false);
  await page.waitForFunction(() => !latest.toggle.pending);
  assert.equal(await page.evaluate(() => latest.rows[0].enabled), true);
  await page.evaluate(() => { window.toggleFail = false; });
  assert.equal(await page.evaluate(() => authorization.approvalMode.run('fully_automatic')), true);
  await page.waitForFunction(() => latest.config.approvalMode === 'fully_automatic');
});

async function chatFixture() {
  await page.evaluate(() => {
    window.activeA = deferred(); window.replayA = deferred(); window.live = null; window.replayCalls = [];
    window.client = {api: {
      window: {onHidden: () => () => {}},
      chat: {onRunEvent: cb => {live = cb; return () => {live = null;};},
        getActiveRun: async ({threadId}) => threadId === 'a' ? activeA.promise : ok(null),
        getRunEvents: async request => {replayCalls.push(request); return replayA.promise;}
      },
      tasks: {getThreadMessages: async () => ok({items: [], hasMoreBefore: false, hasMoreAfter: false, oldestSequence: null, newestSequence: null})}
    }};
    window.props = {client, threadId: 'a', projectId: 'p', workspacePath: '/p', onThreadId: id => { window.selected = id; }};
    mount('chat', props, true);
  });
  await page.waitForFunction(() => typeof live === 'function');
}

async function persistedHistoryFixture({
  threadId = 'history-a',
  initialPage,
  switchedPage,
  reloadPages = [],
  beforePages = [],
  afterPages = [],
  deferredInitial = false,
  deferredBefore = false
}) {
  await page.evaluate((input) => {
    window.historyCalls = [];
    window.initialCounts = {};
    window.reloadPages = input.reloadPages;
    window.beforePages = input.beforePages;
    window.afterPages = input.afterPages;
    window.initialPageDeferred = input.deferredInitial ? deferred() : null;
    window.beforePageDeferred = input.deferredBefore ? deferred() : null;
    window.beforeDeferredUsed = false;
    window.live = null;
    window.client = {api: {
      window: {onHidden: () => () => {}},
      chat: {
        onRunEvent: cb => { live = cb; return () => { live = null; }; },
        getActiveRun: async () => ok(null),
        getRunEvents: async () => ok({events: []})
      },
      tasks: {
        getThreadMessages: async request => {
          historyCalls.push(structuredClone(request));
          if (request.cursor === null) {
            const count = initialCounts[request.threadId] ?? 0;
            initialCounts[request.threadId] = count + 1;
            if (count === 0 && request.threadId === input.threadId && initialPageDeferred !== null) {
              return initialPageDeferred.promise;
            }
            if (count === 0) {
              return ok(request.threadId === input.threadId ? input.initialPage : input.switchedPage);
            }
            return ok(reloadPages.shift() ?? input.initialPage);
          }
          if (request.cursor.direction === 'before') {
            if (!beforeDeferredUsed && beforePageDeferred !== null) {
              beforeDeferredUsed = true;
              return beforePageDeferred.promise;
            }
            return ok(beforePages.shift());
          }
          return ok(afterPages.shift());
        }
      }
    }};
    window.props = {client, threadId: input.threadId, projectId: 'p', workspacePath: '/p', onThreadId: () => {}};
    mount('chat', props, true);
  }, {threadId, initialPage, switchedPage, reloadPages, beforePages, afterPages, deferredInitial, deferredBefore});
  await page.waitForFunction(() => typeof live === 'function' && historyCalls.length > 0);
  if (!deferredInitial) {
    await page.waitForFunction(() => latest.history.loadingInitial === false);
  }
}

function persistedEvent(threadId, sequence) {
  return {
    id: threadId + '-event-' + sequence,
    threadId,
    runId: 'run-' + threadId,
    createdAt: '2026-10-27T00:00:00.000Z',
    sequence,
    type: 'message',
    payload: {role: 'user', content: 'message ' + sequence}
  };
}

function persistedPage(threadId, first, last, options = {}) {
  const items = [];
  for (let sequence = first; sequence <= last; sequence += 1) {
    items.push(persistedEvent(threadId, sequence));
  }
  return {
    items,
    hasMoreBefore: options.hasMoreBefore ?? false,
    hasMoreAfter: options.hasMoreAfter ?? false,
    oldestSequence: items[0]?.sequence ?? null,
    newestSequence: items.at(-1)?.sequence ?? null
  };
}

test('switching conversations ignores old active-run response and unrelated live events', async () => {
  await chatFixture();
  await page.evaluate(() => { mount('chat', {...props, threadId: 'b'}); activeA.resolve(ok({runId: 'ra'})); });
  await page.waitForFunction(() => latest.history.threadId === 'b');
  assert.equal(await page.evaluate(() => replayCalls.length), 0);
  await page.evaluate(() => live({type:'run_started', runId:'ra', threadId:'a', providerId:'p', modelId:'m', mode:'chat', createdAt:'now'}));
  assert.equal(await page.evaluate(() => latest.runState.status), 'idle');
});

test('persisted history reconciles an event that arrives during initial load and retains the newest window', async () => {
  await persistedHistoryFixture({
    initialPage: persistedPage('history-a', 1, 400),
    afterPages: [
      persistedPage('history-a', 400, 450, {hasMoreAfter: true}),
      persistedPage('history-a', 450, 500)
    ],
    deferredInitial: true
  });
  await page.evaluate(() => live({
    type: 'run_started', runId: 'run-history-a', threadId: 'history-a',
    providerId: 'p', modelId: 'm', mode: 'chat', createdAt: 'now'
  }));
  await page.evaluate((initialPage) => initialPageDeferred.resolve(ok(initialPage)), persistedPage('history-a', 1, 400));
  await page.waitForFunction(() => historyCalls.length === 3 && latest.history.events.length === 400 && latest.history.events.at(-1).sequence === 500);
  assert.deepEqual(await page.evaluate(() => ({
    cursors: historyCalls.slice(1).map(request => request.cursor),
    first: latest.history.events[0].sequence,
    last: latest.history.events.at(-1).sequence,
    count: latest.history.events.length,
    hasMoreBefore: latest.history.hasMoreBefore,
    tailTrimmed: latest.history.tailTrimmed,
    trimRevision: latest.history.trimRevision
  })), {
    cursors: [
      {direction: 'after', sequence: 400},
      {direction: 'after', sequence: 450}
    ],
    first: 101,
    last: 500,
    count: 400,
    hasMoreBefore: true,
    tailTrimmed: false,
    trimRevision: 2
  });
});

test('older-page prepend trims the tail, and reloadLatest starts a new window', async () => {
  await persistedHistoryFixture({
    initialPage: persistedPage('history-a', 101, 500, {hasMoreBefore: true}),
    beforePages: [persistedPage('history-a', 1, 100)],
    reloadPages: [persistedPage('history-a', 401, 500, {hasMoreBefore: true})]
  });
  await page.evaluate(() => latest.history.loadOlder());
  await page.waitForFunction(() => latest.history.prependRevision === 1 && latest.history.tailTrimmed);
  assert.deepEqual(await page.evaluate(() => ({
    cursor: historyCalls[1].cursor,
    first: latest.history.events[0].sequence,
    last: latest.history.events.at(-1).sequence,
    count: latest.history.events.length,
    hasMoreBefore: latest.history.hasMoreBefore,
    prependRevision: latest.history.prependRevision
  })), {
    cursor: {direction: 'before', sequence: 101},
    first: 1,
    last: 400,
    count: 400,
    hasMoreBefore: false,
    prependRevision: 1
  });
  await page.evaluate(() => latest.history.reloadLatest());
  await page.waitForFunction(() => latest.history.windowEpoch === 1 && !latest.history.tailTrimmed);
  assert.deepEqual(await page.evaluate(() => ({
    cursor: historyCalls[2].cursor,
    first: latest.history.events[0].sequence,
    last: latest.history.events.at(-1).sequence,
    count: latest.history.events.length,
    hasMoreBefore: latest.history.hasMoreBefore
  })), {
    cursor: null,
    first: 401,
    last: 500,
    count: 100,
    hasMoreBefore: true
  });
});

test('stale older-page response cannot replace the selected thread history', async () => {
  await persistedHistoryFixture({
    initialPage: persistedPage('history-a', 201, 300, {hasMoreBefore: true}),
    switchedPage: persistedPage('history-b', 1001, 1001),
    deferredBefore: true
  });
  await page.evaluate(() => { window.olderLoad = latest.history.loadOlder(); });
  await page.waitForFunction(() => historyCalls.length === 2 && latest.history.loadingOlder);
  await page.evaluate(() => mount('chat', {...props, threadId: 'history-b'}));
  await page.waitForFunction(() => latest.history.threadId === 'history-b' && !latest.history.loadingInitial);
  await page.evaluate((beforePage) => beforePageDeferred.resolve(ok(beforePage)), persistedPage('history-a', 101, 200));
  await page.evaluate(async () => await olderLoad);
  assert.deepEqual(await page.evaluate(() => ({
    threadId: latest.history.threadId,
    ids: latest.history.events.map(event => event.id),
    loadingOlder: latest.history.loadingOlder,
    error: latest.history.error
  })), {
    threadId: 'history-b',
    ids: ['history-b-event-1001'],
    loadingOlder: false,
    error: null
  });
});

test('stale initial history response cannot replace the selected thread', async () => {
  await persistedHistoryFixture({
    initialPage: persistedPage('history-a', 1, 2),
    switchedPage: persistedPage('history-b', 1001, 1001),
    deferredInitial: true
  });
  await page.evaluate(() => mount('chat', {...props, threadId: 'history-b'}));
  await page.waitForFunction(() => latest.history.threadId === 'history-b' && !latest.history.loadingInitial);
  await page.evaluate(async (initialPage) => {
    initialPageDeferred.resolve(ok(initialPage));
    await new Promise(resolve => setTimeout(resolve, 0));
  }, persistedPage('history-a', 1, 2));
  assert.deepEqual(await page.evaluate(() => ({
    threadId: latest.history.threadId,
    eventIds: latest.history.events.map(event => event.id),
    loadingInitial: latest.history.loadingInitial,
    error: latest.history.error
  })), {
    threadId: 'history-b',
    eventIds: ['history-b-event-1001'],
    loadingInitial: false,
    error: null
  });
});

test('transcript virtual index preserves the visible key across prepend, trim, and reload', async () => {
  const original = Array.from({length: 400}, (_, index) => 'event-' + (101 + index));
  const prepended = Array.from({length: 400}, (_, index) => 'event-' + (1 + index));
  await page.evaluate((messageKeys) => mount('transcriptIndex', {
    threadId: 'history-a', messageCount: messageKeys.length, messageKeys,
    prependRevision: 0, trimRevision: 0, windowEpoch: 0
  }, true), original);
  const originalIndex = await page.evaluate(() => latest);
  await page.evaluate((messageKeys) => mount('transcriptIndex', {
    threadId: 'history-a', messageCount: messageKeys.length, messageKeys,
    prependRevision: 1, trimRevision: 0, windowEpoch: 0
  }), prepended);
  const prependedIndex = await page.evaluate(() => latest);
  assert.equal(prependedIndex + 100, originalIndex);

  await page.evaluate((messageKeys) => mount('transcriptIndex', {
    threadId: 'history-a', messageCount: messageKeys.length, messageKeys,
    prependRevision: 1, trimRevision: 0, windowEpoch: 1
  }), Array.from({length: 100}, (_, index) => 'event-' + (401 + index)));
  assert.equal(await page.evaluate(() => latest), 1_000_000);
  assert.deepEqual(await page.evaluate(() => buildTranscriptVirtuosoWindow({firstItemIndex: latest, messageCount: 100})), {
    firstItemIndex: 1_000_000,
    initialTopMostItemIndex: 1_000_099
  });

  const recentStart = Array.from({length: 400}, (_, index) => 'event-' + (1 + index));
  const recentEnd = Array.from({length: 400}, (_, index) => 'event-' + (51 + index));
  await page.evaluate((messageKeys) => mount('transcriptIndex', {
    threadId: 'history-trim', messageCount: messageKeys.length, messageKeys,
    prependRevision: 0, trimRevision: 0, windowEpoch: 0
  }, true), recentStart);
  const beforeTrimIndex = await page.evaluate(() => latest);
  await page.evaluate((messageKeys) => mount('transcriptIndex', {
    threadId: 'history-trim', messageCount: messageKeys.length, messageKeys,
    prependRevision: 0, trimRevision: 1, windowEpoch: 0
  }), recentEnd);
  assert.equal(await page.evaluate(() => latest), beforeTrimIndex + 50);
});

test('rendered transcript keeps the same visible message anchored across prepend and retention trim', async () => {
  const initial = Array.from({length: 80}, (_, index) => ({
    key: `event-${index}`,
    source: 'persisted',
    role: 'user',
    content: `Message ${index}`,
    reasoning: null,
    blocks: [],
    interrupts: [],
    isStreaming: false
  }));
  const prepended = Array.from({length: 20}, (_, index) => ({
    key: `event-${index - 20}`,
    source: 'persisted',
    role: 'user',
    content: `Message ${index - 20}`,
    reasoning: null,
    blocks: [],
    interrupts: [],
    isStreaming: false
  }));
  const props = {
    threadId: 'history-anchor',
    messages: initial,
    prependRevision: 0,
    trimRevision: 0,
    windowEpoch: 0,
    tailTrimmed: false,
    hasMoreBefore: true,
    loadingOlder: false
  };
  await page.evaluate(props => mountTranscript({...props, loadOlder: async () => {}, onJumpToLatest: async () => {}}), props);
  const visibleAnchorHandle = await page.waitForFunction(() => {
    const parent = document.getElementById('transcript-scroll-parent');
    if (!parent) return null;
    const parentRect = parent.getBoundingClientRect();
    const anchor = Array.from(document.querySelectorAll('[data-testid="assistant-message-user"]')).find(element => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > parentRect.top && rect.top < parentRect.bottom;
    });
    if (!anchor) return null;
    return {
      content: anchor.textContent,
      top: anchor.getBoundingClientRect().top - parentRect.top
    };
  });
  const visibleAnchor = await visibleAnchorHandle.jsonValue();
  const readAnchorTop = async () => {
    const handle = await page.waitForFunction(content => {
      const parent = document.getElementById('transcript-scroll-parent');
      const anchor = Array.from(document.querySelectorAll('[data-testid="assistant-message-user"]'))
        .find(element => element.textContent === content);
      if (!parent || !anchor) return null;
      const parentRect = parent.getBoundingClientRect();
      const rect = anchor.getBoundingClientRect();
      if (rect.bottom <= parentRect.top || rect.top >= parentRect.bottom) return null;
      return rect.top - parentRect.top;
    }, visibleAnchor.content);
    return handle.jsonValue();
  };
  const beforeTop = visibleAnchor.top;

  await page.evaluate(({props, prepended}) => {
    mountTranscript({
      ...props,
      messages: [...prepended, ...props.messages],
      prependRevision: 1,
      loadOlder: async () => {},
      onJumpToLatest: async () => {}
    });
  }, {props, prepended});
  const afterTop = await readAnchorTop();
  assert.ok(Math.abs(afterTop - beforeTop) <= 2, `visible message moved from ${beforeTop}px to ${afterTop}px`);

  const retainedWindow = [
    ...prepended.slice(10),
    ...initial,
    ...Array.from({length: 10}, (_, index) => ({
      key: `event-${80 + index}`,
      source: 'persisted',
      role: 'user',
      content: `Message ${80 + index}`,
      reasoning: null,
      blocks: [],
      interrupts: [],
      isStreaming: false
    }))
  ];
  await page.evaluate(({props, retainedWindow}) => {
    mountTranscript({
      ...props,
      messages: retainedWindow,
      prependRevision: 1,
      trimRevision: 1,
      loadOlder: async () => {},
      onJumpToLatest: async () => {}
    });
  }, {props, retainedWindow});
  const afterTrimTop = await readAnchorTop();
  assert.ok(Math.abs(afterTrimTop - afterTop) <= 2, `visible message moved from ${afterTop}px to ${afterTrimTop}px after trim`);
});

test('switching conversations ignores replay already in flight', async () => {
  await chatFixture();
  await page.evaluate(() => activeA.resolve(ok({runId: 'ra'})));
  await page.waitForFunction(() => replayCalls.length === 1);
  await page.evaluate(() => {
    mount('chat', {...props, threadId: 'b'});
    replayA.resolve(ok({events: [{runId:'ra', sequence:1, createdAt:'now', event:{type:'run_started', runId:'ra', threadId:'a', providerId:'p', modelId:'m', mode:'chat', createdAt:'now'}}]}));
  });
  await page.waitForFunction(() => latest.history.threadId === 'b');
  assert.equal(await page.evaluate(() => latest.runState.status), 'idle');
});


test('index save obeys strict preload request and advances its revision for the next save', async () => {
  await settingsFixture('p1');
  await page.evaluate(() => latest.update(d => {d.index.paused = true;}));
  await page.waitForFunction(() => latest.diff.count > 0);
  assert.equal(await page.evaluate(() => latest.save.run()), true);
  await page.waitForFunction(() => latest.diff.count === 0);
  assert.equal(await page.evaluate(() => latest.base.index.revision), 2);
  await page.evaluate(() => latest.update(d => {d.index.paused = false;}));
  await page.waitForFunction(() => latest.diff.count > 0);
  assert.equal(await page.evaluate(() => latest.save.run()), true);
  await page.waitForFunction(() => latest.diff.count === 0);
  assert.equal(await page.evaluate(() => latest.base.index.revision), 3);
  assert.deepEqual(await page.evaluate(() => writes), ['index', 'index']);
});

test('project switch stops remaining writes and waits for the new index before building a draft', async () => {
  await settingsFixture('p1');
  await page.evaluate(() => {
    window.write = deferred(); window.nextIndex = deferred();
    client.api.settings.save = async request => {writes.push('core'); await write.promise; Object.assign(snapshot, request); return ok(structuredClone(snapshot));};
    client.api.research.getIndexStatus = async () => nextIndex.promise;
    latest.update(d => {d.settings.startup.openAtLogin = true; d.hooks.hooks = {PreToolUse: []};});
  });
  await page.waitForFunction(() => latest.diff.count > 0);
  await page.evaluate(() => {window.saving = latest.save.run();});
  await page.waitForFunction(() => latest.save.pending);
  await page.evaluate(() => mount('settings', {client, projectId: 'p2'}));
  await page.waitForFunction(() => latest.draft === null);
  await page.evaluate(async () => {write.resolve(); await saving;});
  assert.deepEqual(await page.evaluate(() => writes), ['core']);
  await page.evaluate(() => nextIndex.resolve(ok({settings: {...index, projectId: 'p2', revision: 7}})));
  await page.waitForFunction(() => latest.draft?.index?.projectId === 'p2');
  assert.equal(await page.evaluate(() => latest.base.index.revision), 7);
  assert.equal(await page.evaluate(() => latest.save.outcome), null);
});

test('replay drains buffered live events before applying its deduplicated tail', async () => {
  await chatFixture();
  await page.evaluate(() => {
    window.started = {runId:'ra', sequence:1, createdAt:'now', event:{type:'run_started', runId:'ra', threadId:'a', providerId:'p', modelId:'m', mode:'chat', createdAt:'now'}};
    window.first = {runId:'ra', sequence:2, createdAt:'now', event:{type:'assistant_block', runId:'ra', block:{kind:'text', blockId:'t', phase:'delta', text:'a'}}};
    live(started); live(first);
    activeA.resolve(ok({runId:'ra'}));
    replayA.resolve(ok({runId:'ra', events:[started, first, {runId:'ra', sequence:3, createdAt:'now', event:{type:'assistant_block', runId:'ra', block:{kind:'text', blockId:'t', phase:'delta', text:'b'}}}]}));
  });
  await page.waitForFunction(() => latest.runState.assistantMessage === 'ab');
});

test('checkpoint continuation cannot replay into a different conversation', async () => {
  await chatFixture();
  await page.evaluate(() => {
    activeA.resolve(ok(null));
    window.checkpoint = deferred();
    client.api.chat.resumeRun = async () => checkpoint.promise;
    window.resuming = latest.resumeCheckpoint('ra');
    mount('chat', {...props, threadId:'b'});
  });
  await page.waitForFunction(() => latest.history.threadId === 'b');
  assert.equal(await page.evaluate(async () => {checkpoint.resolve(ok({})); return await resuming;}), false);
  assert.equal(await page.evaluate(() => replayCalls.length), 0);
});

test('switching workspaces cancels an in-flight push and ignores its stale result', async () => {
  await page.evaluate(() => {
    window.currentWorkspace = '/old';
    window.pendingPush = deferred();
    window.cancelledPushIds = [];
    window.client = {api: {
      workspace: {onChanged: () => () => {}},
      git: {
        status: async () => ok({workspacePath: currentWorkspace, isRepository: true, branch: 'main', porcelain: [], changes: [], changedFiles: 0}),
        diffStat: async () => ok({workspacePath: currentWorkspace, stat: ''}),
        listBranches: async () => ok({workspacePath: currentWorkspace, currentBranch: 'main', branches: [{name: 'main', current: true}]}),
        push: async request => { window.pushRequest = request; return pendingPush.promise; },
        cancel: async request => { cancelledPushIds.push(request.operationId); return ok(true); }
      }
    }};
    mount('git', {client, workspacePath: currentWorkspace}, true);
  });
  await page.waitForFunction(() => latest.phase === 'ready');

  await page.evaluate(() => { window.pushPromise = latest.push(); });
  await page.waitForFunction(() => latest.pending === 'push' && window.pushRequest !== undefined);
  const operationId = await page.evaluate(() => pushRequest.operationId);
  await page.evaluate(() => {
    window.currentWorkspace = '/new';
    mount('git', {client, workspacePath: currentWorkspace});
  });
  await page.waitForFunction((id) => cancelledPushIds.includes(id), operationId);
  await page.waitForFunction(() => latest.phase === 'ready' && latest.snapshot?.workspacePath === '/new');

  await page.evaluate(async () => {
    pendingPush.resolve(ok({
      workspacePath: '/old', remoteName: 'origin', branch: 'main', output: 'pushed',
      status: {workspacePath: '/old', isRepository: true, branch: 'main', porcelain: [], changes: [], changedFiles: 0}
    }));
    await pushPromise;
  });
  assert.deepEqual(await page.evaluate(() => ({workspacePath: latest.snapshot.workspacePath, lastPush: latest.lastPush, pending: latest.pending})), {
    workspacePath: '/new', lastPush: null, pending: null
  });
});

test('file actions from an old workspace ignore late success and skip stale error recovery', async () => {
  await page.evaluate(() => {
    window.currentWorkspace = '/old';
    window.firstStage = deferred();
    window.secondStage = deferred();
    window.pendingStageResults = [firstStage, secondStage];
    window.stageCallCount = 0;
    window.statusCallCount = 0;
    window.client = {api: {
      workspace: {onChanged: () => () => {}},
      git: {
        status: async () => {
          statusCallCount += 1;
          return ok({workspacePath: currentWorkspace, isRepository: true, branch: 'main', porcelain: [], changes: [], changedFiles: 0});
        },
        diffStat: async () => ok({workspacePath: currentWorkspace, stat: ''}),
        listBranches: async () => ok({workspacePath: currentWorkspace, currentBranch: 'main', branches: [{name: 'main', current: true}]}),
        stageFile: async () => { stageCallCount += 1; return pendingStageResults.shift().promise; },
        cancel: async () => ok(true)
      }
    }};
    mount('git', {client, workspacePath: currentWorkspace}, true);
  });
  await page.waitForFunction(() => latest.phase === 'ready');

  await page.evaluate(() => { window.oldFailure = latest.stage(['file.txt']); });
  await page.waitForFunction(() => stageCallCount === 1);
  await page.evaluate(() => {
    window.currentWorkspace = '/new';
    mount('git', {client, workspacePath: currentWorkspace});
  });
  await page.waitForFunction(() => latest.phase === 'ready' && latest.snapshot?.workspacePath === '/new');
  const statusCallsAfterSwitch = await page.evaluate(() => statusCallCount);
  await page.evaluate(async () => {
    firstStage.resolve(fail('old workspace stage failed'));
    await oldFailure;
  });
  assert.deepEqual(await page.evaluate(() => ({workspacePath: latest.snapshot.workspacePath, actionError: latest.actionError, pending: latest.pending})), {
    workspacePath: '/new', actionError: null, pending: null
  });
  assert.equal(await page.evaluate(() => statusCallCount), statusCallsAfterSwitch);

  await page.evaluate(() => { window.oldSuccess = latest.stage(['file.txt']); });
  await page.waitForFunction(() => stageCallCount === 2);
  await page.evaluate(() => {
    window.currentWorkspace = '/third';
    mount('git', {client, workspacePath: currentWorkspace});
  });
  await page.waitForFunction(() => latest.phase === 'ready' && latest.snapshot?.workspacePath === '/third');
  await page.evaluate(async () => {
    secondStage.resolve(ok({
      workspacePath: '/new', isRepository: true, branch: 'main', porcelain: [],
      changes: [{porcelain: 'A  stale.txt', index: 'A', worktree: ' ', relativePath: 'stale.txt'}], changedFiles: 1
    }));
    await oldSuccess;
  });
  assert.deepEqual(await page.evaluate(() => ({workspacePath: latest.snapshot.workspacePath, actionError: latest.actionError, pending: latest.pending})), {
    workspacePath: '/third', actionError: null, pending: null
  });
});
