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
      import { projectChatTranscript } from './src/renderer/assistant/transcript';
      import { createEmptyChatRunState } from './src/renderer/assistant/run-state';
      window.projectChatTranscript = projectChatTranscript;
      window.createEmptyChatRunState = createEmptyChatRunState;
      import { useGitWorkspace } from './src/renderer/workspace/use-git-workspace';
      import { useBoundWorkspace } from './src/renderer/workspace/use-bound-workspace';
      import { useFileNameSearch } from './src/renderer/workspace/use-file-search';
      import { useFileTree } from './src/renderer/workspace/use-file-tree';
      import { useRtkStatus } from './src/renderer/workspace/use-rtk-status';
      import { useLiteratureImportActions } from './src/renderer/literature/use-literature-import-actions';
      import { useLiteratureStore } from './src/renderer/literature/use-literature-store';
      import { BEFORE_READING_CHANGE } from './src/renderer/literature/reading-interactions';
      window.BEFORE_READING_CHANGE = BEFORE_READING_CHANGE;
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
        git: p => useGitWorkspace(p.client, p.workspacePath),
        workspaceBinding: p => useBoundWorkspace(p.client, p.project),
        fileNames: p => useFileNameSearch(p.client, p.workspacePath, p.query),
        fileTree: p => useFileTree(p.client, {workspacePathKey: p.workspacePath, projectId: null}),
        rtk: p => useRtkStatus(p.client, p.enabled),
        literatureImport: p => useLiteratureImportActions(p),
        literature: p => useLiteratureStore(p.client, p.projectId)
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
      window.clearHook = () => flushSync(() => root.render(null));
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

async function mountLiteratureSelection() {
  await page.evaluate(() => {
    clearHook();
    window.literatureProps = {projectId: 'project-a', client: {api: {research: {
      listLibrary: () => Promise.resolve(ok([])),
      getLibraryItem: ({id}) => Promise.resolve(ok({id})),
      listDocuments: () => Promise.resolve(ok([])),
      wikiSnapshot: () => Promise.resolve(ok({sources: [], claims: []})),
      onLibraryChanged: () => () => {}
    }}}};
    mount('literature', literatureProps, true);
    latest.select('paper-a');
  });
  await page.waitForFunction(() => latest.selectedId === 'paper-a');
}

test('literature selection honors the last request within one event before React commits', async () => {
  await mountLiteratureSelection();
  await page.evaluate(() => {
    latest.select('paper-b');
    latest.select('paper-a');
  });
  await page.waitForFunction(() => latest.selectedId === 'paper-a', null, {timeout: 1200});
});

test('literature selection cannot resume a discarded project continuation', async () => {
  await mountLiteratureSelection();
  await page.evaluate(() => {
    window.selectionGuard = event => {window.resumeLiterature = event.detail.defer();};
    window.addEventListener(BEFORE_READING_CHANGE, selectionGuard);
    latest.select('paper-b');
    mount('literature', {...literatureProps, projectId: 'project-b'});
    window.removeEventListener(BEFORE_READING_CHANGE, selectionGuard);
  });
  await page.waitForFunction(() => latest.selectedId === null);
  await page.evaluate(() => {
    resumeLiterature();
    window.afterSelectionTurn = new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await page.evaluate(() => afterSelectionTurn);
  assert.equal(await page.evaluate(() => latest.selectedId), null);
});

test('literature choosing the current paper cancels its earlier deferred selection', async () => {
  await mountLiteratureSelection();
  await page.evaluate(() => {
    window.selectionGuard = event => {window.resumeLiterature = event.detail.defer();};
    window.addEventListener(BEFORE_READING_CHANGE, selectionGuard);
    latest.select('paper-b');
    latest.select('paper-a');
    window.removeEventListener(BEFORE_READING_CHANGE, selectionGuard);
    resumeLiterature();
    window.afterSelectionTurn = new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await page.evaluate(() => afterSelectionTurn);
  assert.equal(await page.evaluate(() => latest.selectedId), 'paper-a');
});

for (const reader of ['current workspace', 'workspace selection', 'file search', 'file tree', 'RTK status']) {
  for (const transport of ['throw', 'reject']) {
    test(`workspace reader ${reader} reports a transport ${transport} and can recover`, async () => {
      await page.evaluate(({reader, transport}) => {
        clearHook();
        window.readerFailed = true;
        const failure = () => {
          if (!readerFailed) return null;
          if (transport === 'throw') throw new Error('reader transport failed');
          return Promise.reject(new Error('reader transport failed'));
        };
        const workspace = {path: '/workspace-a'};
        const names = {query: 'draft', matches: [], truncated: false};
        const tree = {workspacePath: workspace.path, relativePath: '', entries: [], truncated: false};
        const status = {enabledForAgentCommands: true, binaryPath: '/rtk', configPath: '/rtk.toml',
          teeDir: '', resourceState: 'ready'};
        window.readerProps = {workspacePath: workspace.path, project: {workspacePath: workspace.path},
          query: 'draft', enabled: true, client: {api: {
            workspace: {
              getCurrent: () => reader === 'current workspace' ? failure() ?? Promise.resolve(ok(workspace)) : Promise.resolve(ok(null)),
              select: () => reader === 'workspace selection' ? failure() ?? Promise.resolve(ok(workspace)) : Promise.resolve(ok(workspace)),
              onChanged: () => () => {}
            },
            files: {
              searchByName: () => failure() ?? Promise.resolve(ok(names)),
              listTree: () => failure() ?? Promise.resolve(ok(tree))
            },
            rtk: {status: () => failure() ?? Promise.resolve(ok(status))}
          }}};
        window.readerKind = reader === 'current workspace' || reader === 'workspace selection' ? 'workspaceBinding' :
          reader === 'file search' ? 'fileNames' : reader === 'file tree' ? 'fileTree' : 'rtk';
        mount(readerKind, readerProps, true);
      }, {reader, transport});
      await page.waitForFunction(() => readerKind === 'fileTree' ? latest.rootError !== null : latest.status === 'error', null, {timeout: 1200});
      assert.equal(await page.evaluate(() => readerKind === 'fileTree' ? latest.rootError : latest.error), 'reader transport failed');
      assert.equal(await page.evaluate(() => readerKind === 'fileTree' ? latest.loadingRoot : false), false);
      await page.evaluate(() => {
        readerFailed = false;
        if (readerKind === 'workspaceBinding') latest.rebind();
        else if (readerKind === 'rtk') {
          mount(readerKind, {...readerProps, enabled: false});
          mount(readerKind, readerProps);
        } else latest.reload();
      });
      await page.waitForFunction(() => readerKind === 'fileTree' ?
        !latest.loadingRoot && latest.rootError === null : latest.status === (readerKind === 'workspaceBinding' ? 'bound' : 'ready'));
    });
  }
}

test('workspace file search clears the old workspace results while the new request is pending', async () => {
  await page.evaluate(() => {
    clearHook();
    window.searchNewWorkspace = deferred();
    window.searchProps = {workspacePath: '/workspace-a', query: 'draft', client: {api: {files: {
      searchByName: () => Promise.resolve(ok({query: 'draft', matches: [{relativePath: 'old-draft.txt'}], truncated: false}))
    }}}};
    mount('fileNames', searchProps, true);
  });
  await page.waitForFunction(() => latest.status === 'ready');
  await page.evaluate(() => mount('fileNames', {...searchProps, workspacePath: '/workspace-b',
    client: {api: {files: {searchByName: () => searchNewWorkspace.promise}}}}));
  assert.deepEqual(await page.evaluate(() => ({status: latest.status, data: latest.data})), {status: 'loading', data: null});
  await page.evaluate(() => searchNewWorkspace.resolve(ok({query: 'draft', matches: [], truncated: false})));
  await page.waitForFunction(() => latest.status === 'ready');
});

for (const olderFirst of [true, false]) {
  test(`workspace file tree keeps the newest directory read when the ${olderFirst ? 'older' : 'newer'} response arrives first`, async () => {
    await page.evaluate(() => {
      clearHook();
      window.treeReads = [];
      window.treeChanged = null;
      const client = {api: {
        files: {listTree: () => {const read = deferred(); treeReads.push(read); return read.promise;}},
        workspace: {onChanged: listener => {treeChanged = listener; return () => {treeChanged = null;};}}
      }};
      window.treeResult = name => ok({workspacePath: '/workspace-a', relativePath: '',
        entries: [{name, relativePath: name, type: 'file', size: 1, updatedAt: '2026-11-12T00:00:00Z'}], truncated: false});
      mount('fileTree', {client, workspacePath: '/workspace-a'}, true);
      treeChanged({workspacePath: '/workspace-a', relativePath: 'draft.txt', eventType: 'change'});
    });
    assert.equal(await page.evaluate(() => treeReads.length), 2);
    if (olderFirst) {
      await page.evaluate(async () => {treeReads[0].resolve(treeResult('old.txt')); await treeReads[0].promise;});
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      assert.equal(await page.evaluate(() => latest.loadingRoot), true);
      await page.evaluate(() => treeReads[1].resolve(treeResult('new.txt')));
    } else {
      await page.evaluate(() => treeReads[1].resolve(treeResult('new.txt')));
      await page.waitForFunction(() => latest.rows[0]?.entry.name === 'new.txt');
      await page.evaluate(async () => {treeReads[0].resolve(treeResult('old.txt')); await treeReads[0].promise;});
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    }
    await page.waitForFunction(() => !latest.loadingRoot);
    assert.deepEqual(await page.evaluate(() => latest.rows.map(row => row.entry.name)), ['new.txt']);
  });
}

test('literature search action keeps page failures visible and sends a bounded project-scoped request', async () => {
  const outcome = await page.evaluate(async () => {
    window.literatureCalls = [];
    const partial = {schemaVersion: 14, strategy: null, status: 'partial', searchId: 'partial-search',
      sources: [{source: 'crossref', status: 'partial', errorCode: 'literature_provider_response_invalid',
        stopReason: 'failed', pages: [{position: {kind: 'offset', value: 0}, cache: {state: 'hit'}},
          {position: {kind: 'offset', value: 1}, coverage: {state: 'failed'}}]}]};
    const store = {projectId: 'project-a', reload: () => {}, client: {api: {research: {
      searchLiterature: async request => { literatureCalls.push(request); return ok(partial); }
    }}}};
    mount('literatureImport', {store}, true);
    const result = await latest.searchLiterature('page query', ['crossref'], 2);
    mount('literatureImport', {store: {...store, projectId: 'project-b',
      client: {api: {research: {searchLiterature: async request => {
        literatureCalls.push(request); return fail('search audit refused');
      }}}}}});
    const failed = await latest.searchLiterature('second query', ['openalex'], 1);
    return {result, failed, calls: literatureCalls};
  });
  assert.equal(outcome.result.result.schemaVersion, 14);
  assert.equal(outcome.result.result.status, 'partial');
  assert.equal(outcome.result.result.sources[0].pages[1].coverage.state, 'failed');
  assert.deepEqual(outcome.failed, {ok: false, message: 'search audit refused'});
  assert.deepEqual(outcome.calls, [
    {query: 'page query', sources: ['crossref'], limit: 2, maxPages: 1, projectId: 'project-a'},
    {query: 'second query', sources: ['openalex'], limit: 1, maxPages: 1, projectId: 'project-b'}
  ]);
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
        replayRunEvents: async request => {replayCalls.push(request); return replayA.promise;}
      },
      tasks: {getThreadMessages: async () => ok({items: [], hasMoreBefore: false, hasMoreAfter: false, oldestSequence: null, newestSequence: null})}
    }};
    window.props = {client, threadId: 'a', projectId: 'p', workspacePath: '/p', onThreadId: id => { window.selected = id; }};
    mount('chat', props, true);
  });
  await page.waitForFunction(() => typeof live === 'function');
}

async function chatSendFixture() {
  await chatFixture();
  await page.evaluate(() => {
    window.sendCalls = [];
    window.mcpConfig = {schemaVersion: 1, approvalMode: 'default', servers: [
      {id: 'enabled-exa', enabled: true}, {id: 'disabled-server', enabled: false}
    ]};
    client.api.mcp = {getConfig: async () => ok(structuredClone(mcpConfig))};
    client.api.chat.startRun = async request => {
      sendCalls.push(structuredClone(request));
      return ok({runId: 'send-run', threadId: request.threadId});
    };
    window.sendInput = {text: ' Search once ', mode: 'chat', skillIds: ['reader'], attachments: []};
    window.selected = null;
  });
}

test('chat send includes currently enabled MCP servers and rereads changes for the next run', async () => {
  await chatSendFixture();
  assert.equal(await page.evaluate(() => latest.send(sendInput)), true);
  assert.deepEqual(await page.evaluate(() => sendCalls[0].enabledCapabilities), {
    mcpServers: ['enabled-exa'], skills: ['reader']
  });
  await page.evaluate(() => { mcpConfig.servers[0].enabled = false; mcpConfig.servers[1].enabled = true; });
  assert.equal(await page.evaluate(() => latest.send(sendInput)), true);
  assert.deepEqual(await page.evaluate(() => sendCalls[1].enabledCapabilities.mcpServers), ['disabled-server']);
});

test('chat send keeps the prompt and exposes MCP config lookup failure without starting a run', async () => {
  await chatSendFixture();
  await page.evaluate(() => { client.api.mcp.getConfig = async () => fail('MCP config unavailable'); });
  assert.equal(await page.evaluate(() => latest.send(sendInput)), false);
  await page.waitForFunction(() => latest.sending === false);
  assert.deepEqual(await page.evaluate(() => ({
    calls: sendCalls.length, pending: latest.pendingUserInput, error: latest.errorMessage
  })), {calls: 0, pending: 'Search once', error: 'MCP config unavailable'});
});

test('chat send stops before starting a run if its scope changes during MCP config lookup', async () => {
  await chatSendFixture();
  await page.evaluate(() => {
    window.mcpLookup = deferred();
    client.api.mcp.getConfig = () => mcpLookup.promise;
    window.sendingPromise = latest.send(sendInput);
  });
  await page.evaluate(() => mount('chat', {...props, threadId: 'b'}));
  await page.evaluate(() => mcpLookup.resolve(ok(mcpConfig)));
  assert.equal(await page.evaluate(() => sendingPromise), false);
  assert.deepEqual(await page.evaluate(() => ({calls: sendCalls.length, selected})), {calls: 0, selected: null});
});

test('chat dispatch serializes same-event sends before creating distinct dispatch keys', async () => {
  await chatSendFixture();
  await page.evaluate(() => {
    window.pendingDispatch = deferred();
    client.api.chat.startRun = request => {sendCalls.push(request); return pendingDispatch.promise;};
    window.dispatchResults = Promise.all([latest.send(sendInput), latest.send(sendInput)]);
  });
  await page.waitForFunction(() => sendCalls.length > 0);
  const count = await page.evaluate(() => sendCalls.length);
  await page.evaluate(() => pendingDispatch.resolve(ok({runId: 'send-run', threadId: 'a'})));
  assert.deepEqual(await page.evaluate(() => dispatchResults), [true, false]);
  assert.equal(count, 1);
});

async function chatControlFixture() {
  await chatSendFixture();
  await page.evaluate(() => live({
    type: 'run_started', runId: 'ra', threadId: 'a', providerId: 'p', modelId: 'm', mode: 'chat', createdAt: 'now'
  }));
  await page.waitForFunction(() => latest.runState.runId === 'ra');
}

for (const kind of ['question', 'approval', 'checkpoint']) {
  test(`chat resume serializes ${kind} with visible pending state`, async () => {
    await chatControlFixture();
    await page.evaluate(kind => {
      window.resumeCalls = [];
      window.pendingResume = deferred();
      client.api.chat.resumeRun = request => {resumeCalls.push(request); return pendingResume.promise;};
      client.api.chat.replayRunEvents = async () => ok({kind: 'events', runId: 'ra', events: []});
      const resume = () => kind === 'question' ? latest.resumeQuestion('q1', '保留回答') :
        kind === 'approval' ? latest.resumeApproval('a1', [{type: 'approve'}]) : latest.resumeCheckpoint('ra');
      window.resumeResults = Promise.all([resume(), resume()]);
    }, kind);
    const pending = await page.evaluate(() => ({count: resumeCalls.length, sending: latest.sending}));
    await page.evaluate(() => pendingResume.resolve(ok({runId: 'ra', threadId: 'a', resumedAt: 'now'})));
    const results = await page.evaluate(() => resumeResults);
    assert.deepEqual(pending, {count: 1, sending: true}, kind);
    assert.deepEqual(results, [true, false], kind);
    await page.waitForFunction(() => latest.sending === false);
  });

  test(`chat resume catches ${kind} bridge errors and unlocks a retry`, async () => {
    await chatControlFixture();
    const result = await page.evaluate(async kind => {
      const resume = () => kind === 'question' ? latest.resumeQuestion('q1', '保留回答') :
        kind === 'approval' ? latest.resumeApproval('a1', [{type: 'approve'}]) : latest.resumeCheckpoint('ra');
      client.api.chat.resumeRun = () => {throw new Error('bridge unavailable');};
      const sync = await Promise.allSettled([resume()]);
      client.api.chat.resumeRun = () => Promise.reject(new Error('transport disconnected'));
      const rejected = await Promise.allSettled([resume()]);
      client.api.chat.resumeRun = async () => ok({runId: 'ra', threadId: 'a', resumedAt: 'now'});
      client.api.chat.replayRunEvents = async () => ok({kind: 'events', runId: 'ra', events: []});
      return {sync: sync[0], rejected: rejected[0], retry: await resume()};
    }, kind);
    assert.deepEqual(result, {
      sync: {status: 'fulfilled', value: false}, rejected: {status: 'fulfilled', value: false}, retry: true
    }, kind);
    await page.waitForFunction(() => !latest.sending);
  });
}

test('chat stop sends one signal, catches bridge failures and retains the real run state', async () => {
  await chatControlFixture();
  await page.evaluate(() => {
    window.cancelCalls = 0; window.pendingCancel = deferred();
    client.api.chat.cancelRun = () => {cancelCalls++; return pendingCancel.promise;};
    window.cancelResults = Promise.all([latest.cancel(), latest.cancel()]);
  });
  const count = await page.evaluate(() => cancelCalls);
  await page.evaluate(() => pendingCancel.resolve(ok({runId: 'ra', cancelled: true})));
  await page.evaluate(() => cancelResults);
  assert.equal(count, 1);
});

test('chat stop retains the real run state after the request is accepted', async () => {
  await chatControlFixture();
  await page.evaluate(() => {
    client.api.chat.cancelRun = async () => ok({runId: 'ra', cancelled: true});
    return latest.cancel();
  });
  assert.equal(await page.evaluate(() => latest.runState.status), 'running');
});

test('chat stop catches bridge failures and unlocks a retry', async () => {
  await chatControlFixture();
  const failure = await page.evaluate(async () => {
    client.api.chat.cancelRun = () => {throw new Error('stop unavailable');};
    return (await Promise.allSettled([latest.cancel()]))[0].status;
  });
  assert.equal(failure, 'fulfilled');
  await page.waitForFunction(() => latest.errorMessage === 'stop unavailable');
});

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
        replayRunEvents: async () => ok({kind:'events', runId:'ra', events: []})
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

test('latest history reload has one visible pending request and permits retry after failure', async () => {
  await persistedHistoryFixture({
    initialPage: persistedPage('history-a', 101, 500, {hasMoreBefore: true}),
    beforePages: [persistedPage('history-a', 1, 100)]
  });
  await page.evaluate(() => latest.history.loadOlder());
  await page.waitForFunction(() => latest.history.tailTrimmed);
  const requestCount = await page.evaluate(() => {
    window.latestPageDeferred = deferred();
    client.api.tasks.getThreadMessages = request => {
      historyCalls.push(request);
      return latestPageDeferred.promise;
    };
    window.reloadResults = Promise.all([latest.history.reloadLatest(), latest.history.reloadLatest()]);
    return historyCalls.length - 2;
  });
  const pending = {count: requestCount, pending: await page.evaluate(() => latest.history.loadingLatest === true)};
  await page.evaluate(() => latestPageDeferred.reject(new Error('history bridge unavailable')));
  await page.evaluate(() => reloadResults);
  await page.waitForFunction(() => latest.history.error === 'history bridge unavailable');
  await page.evaluate(async latestPage => {
    client.api.tasks.getThreadMessages = async request => {
      historyCalls.push(request);
      return ok(latestPage);
    };
    await latest.history.reloadLatest();
  }, persistedPage('history-a', 401, 500, {hasMoreBefore: true}));
  await page.waitForFunction(() => latest.history.windowEpoch === 1 && !latest.history.loadingLatest);
  const result = await page.evaluate(() => ({count: historyCalls.length - 2,
    first: latest.history.events[0].sequence, epoch: latest.history.windowEpoch, error: latest.history.error}));
  assert.deepEqual(pending, {count: 1, pending: true});
  assert.deepEqual(result, {count: 2, first: 401, epoch: 1, error: null});
});

test('unmounting initial history prevents its delayed catch-up request', async () => {
  await persistedHistoryFixture({
    initialPage: persistedPage('history-a', 1, 2),
    afterPages: [persistedPage('history-a', 3, 4)],
    deferredInitial: true
  });
  await page.evaluate(() => live({
    type: 'run_started', runId: 'run-history-a', threadId: 'history-a',
    providerId: 'p', modelId: 'm', mode: 'chat', createdAt: 'now'
  }));
  await page.evaluate(async initialPage => {
    clearHook();
    initialPageDeferred.resolve(ok(initialPage));
    await new Promise(resolve => setTimeout(resolve, 0));
  }, persistedPage('history-a', 1, 2));
  assert.equal(await page.evaluate(() => historyCalls.length), 1);
});

test('failed initial history can retry without requiring a trimmed tail', async () => {
  await persistedHistoryFixture({initialPage: persistedPage('history-a', 1, 2), deferredInitial: true});
  await page.evaluate(() => initialPageDeferred.resolve(fail('initial history unavailable')));
  await page.waitForFunction(() => latest.history.error === 'initial history unavailable');
  await page.evaluate(() => latest.history.reloadLatest());
  assert.deepEqual(await page.evaluate(() => ({count: historyCalls.length,
    ids: latest.history.events.map(event => event.id), error: latest.history.error})), {
    count: 2, ids: ['history-a-event-1', 'history-a-event-2'], error: null
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

test('transcript follows a live review gate after opening a message taller than its viewport', async () => {
  await page.evaluate(() => {
    window.gateMessages = [{
      key: 'long-history', source: 'persisted', role: 'user',
      content: 'Review the formal manuscript and retain the evidence boundaries. '.repeat(80),
      reasoning: null, blocks: [], interrupts: [], isStreaming: false
    }];
    window.renderGateTranscript = messages => mountTranscript({
      threadId: 'long-review-gate', messages, prependRevision: 0, trimRevision: 0,
      windowEpoch: 0, tailTrimmed: false, hasMoreBefore: false, loadingOlder: false,
      loadOlder: async () => {}, onJumpToLatest: async () => {},
      onOpenArtifact: () => {}, onReadGateContext: async () => null,
      onApprovalDecision: () => {}
    });
    renderGateTranscript(gateMessages);
  });
  await page.waitForFunction(() => {
    const parent = document.getElementById('transcript-scroll-parent');
    return parent.scrollHeight > parent.clientHeight &&
      parent.scrollHeight - parent.clientHeight - parent.scrollTop <= 2;
  });
  await page.evaluate(() => {
    window.liveGateMessage = {
      key: 'live-review', source: 'live', role: 'assistant', content: '', reasoning: null,
      blocks: [{id: 'gate-tool', kind: 'tool_call', callId: 'gate-tool',
        name: 'research_approve_gate', input: {}, output: null, error: null, status: 'end'}],
      interrupts: [], isStreaming: true
    };
    renderGateTranscript([...gateMessages, liveGateMessage]);
  });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="assistant-message-assistant"]').length === 1);
  await page.evaluate(() => {
    renderGateTranscript([...gateMessages, {...liveGateMessage, isStreaming: false, interrupts: [{
      kind: 'approval', interruptId: 'live-gate',
      actionRequests: [{name: 'research_approve_gate', description: 'Review decision',
        args: {projectId: 'project-review', stage: 'review', artifactLinks: [],
          reviewError: null, summary: 'Review is ready for a human decision.'}}],
      reviewConfigs: [{actionName: 'research_approve_gate', allowedDecisions: ['approve', 'revise', 'reject']}]
    }]}]);
  });
  await page.getByTestId('assistant-gate-stage').waitFor();
  await page.waitForFunction(() => {
    const parent = document.getElementById('transcript-scroll-parent').getBoundingClientRect();
    const gate = document.querySelector('[data-testid="assistant-gate-card"]').getBoundingClientRect();
    return gate.top < parent.bottom && gate.bottom > parent.top;
  });
});

test('transcript preserves an intentional scroll away from the bottom when new output arrives', async () => {
  await page.evaluate(() => {
    window.readingMessages = Array.from({length: 80}, (_, index) => ({
      key: `reading-${index}`, source: 'persisted', role: 'user', content: `Reading message ${index}`,
      reasoning: null, blocks: [], interrupts: [], isStreaming: false
    }));
    window.renderReadingTranscript = messages => mountTranscript({
      threadId: 'reading-history', messages, prependRevision: 0, trimRevision: 0,
      windowEpoch: 0, tailTrimmed: false, hasMoreBefore: false, loadingOlder: false,
      loadOlder: async () => {}, onJumpToLatest: async () => {},
      onOpenArtifact: () => {}, onReadGateContext: async () => null
    });
    renderReadingTranscript(readingMessages);
  });
  await page.waitForFunction(() => {
    const parent = document.getElementById('transcript-scroll-parent');
    return parent.scrollTop > 0 && parent.scrollHeight - parent.clientHeight - parent.scrollTop <= 2;
  });
  await page.evaluate(() => {
    const parent = document.getElementById('transcript-scroll-parent');
    parent.scrollTop = Math.floor(parent.scrollTop / 2);
    parent.dispatchEvent(new Event('scroll'));
  });
  await page.getByTestId('assistant-scroll-bottom').waitFor();
  const beforeTop = await page.evaluate(() => document.getElementById('transcript-scroll-parent').scrollTop);
  await page.evaluate(() => renderReadingTranscript([...readingMessages, {
    ...readingMessages[0], key: 'new-output', role: 'assistant', source: 'live', content: 'New output'
  }]));
  await page.waitForTimeout(200);
  const afterTop = await page.evaluate(() => document.getElementById('transcript-scroll-parent').scrollTop);
  assert.ok(Math.abs(afterTop - beforeTop) <= 2, `reading position moved from ${beforeTop}px to ${afterTop}px`);
});

test('switching conversations ignores replay already in flight', async () => {
  await chatFixture();
  await page.evaluate(() => activeA.resolve(ok({runId: 'ra'})));
  await page.waitForFunction(() => replayCalls.length === 1);
  await page.evaluate(() => {
    mount('chat', {...props, threadId: 'b'});
    replayA.resolve(ok({kind:'events', runId:'ra', events: [{runId:'ra', sequence:1, createdAt:'now', event:{type:'run_started', runId:'ra', threadId:'a', providerId:'p', modelId:'m', mode:'chat', createdAt:'now'}}]}));
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
    replayA.resolve(ok({kind:'events', runId:'ra', events:[started, first, {runId:'ra', sequence:3, createdAt:'now', event:{type:'assistant_block', runId:'ra', block:{kind:'text', blockId:'t', phase:'delta', text:'b'}}}]}));
  });
  await page.waitForFunction(() => latest.runState.assistantMessage === 'ab');
});

test('replay snapshot rebases a complete live projection when its sequence is newer', async () => {
  await chatFixture();
  await page.evaluate(() => {
    const started = {runId:'ra', sequence:1, createdAt:'now', event:{type:'run_started', runId:'ra', threadId:'a', providerId:'p', modelId:'m', mode:'chat', createdAt:'now'}};
    const first = {runId:'ra', sequence:2, createdAt:'now', event:{type:'assistant_block', runId:'ra', block:{kind:'text', blockId:'t', phase:'delta', text:'live'}}};
    activeA.resolve(ok({runId:'ra'}));
    live(started);
    live(first);
  });
  await page.waitForFunction(() => replayCalls.length === 1 && latest.runState.assistantMessage === 'live');
  await page.evaluate(() => {
    const state = { ...latest.runState, historyComplete: true, assistantMessage: 'snapshot-through-four' };
    replayA.resolve(ok({
      kind:'replay_gap',
      runId:'ra',
      requestedAfterSequence:0,
      firstAvailableSequence:5,
      snapshot:{version:1, runId:'ra', throughSequence:4, historyComplete:true, state},
      events:[{runId:'ra', sequence:5, createdAt:'now', event:{type:'assistant_block', runId:'ra', block:{kind:'text', blockId:'t', phase:'delta', text:'-five'}}}]
    }));
  });
  await page.waitForFunction(() => latest.runState.assistantMessage === 'snapshot-through-four-five');
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

for (const action of ['stage', 'unstage', 'discard', 'commit', 'createBranch', 'checkoutBranch', 'push', 'refresh']) {
  test(`Git ${action} rejects a second operation in the same event`, async () => {
    await page.evaluate(action => {
      window.heldGit = deferred();
      window.gitCalls = [];
      window.gitSnapshot = {workspacePath: '/git', isRepository: true, branch: 'main', porcelain: [], changes: [], changedFiles: 0};
      window.client = {api: {
        workspace: {onChanged: () => () => {}},
        git: {
          status: async () => ok(gitSnapshot),
          diffStat: async () => ok({workspacePath: '/git', stat: ''}),
          listBranches: async () => ok({workspacePath: '/git', currentBranch: 'main', branches: []}),
          stageFile: async request => {gitCalls.push(request); return ok(gitSnapshot);},
          cancel: async () => ok(true)
        }
      }};
      const method = {stage: 'stageFile', unstage: 'unstageFile', discard: 'discardFile',
        commit: 'commit', createBranch: 'createBranch', checkoutBranch: 'checkoutBranch', push: 'push', refresh: 'status'}[action];
      window.installOperation = () => {
        client.api.git[method] = request => {gitCalls.push(request); return heldGit.promise;};
      };
      mount('git', {client, workspacePath: '/git'}, true);
    }, action);
    await page.waitForFunction(() => latest.phase === 'ready');
    await page.evaluate(action => {
      installOperation();
      const args = action === 'stage' ? [['file.txt']] : action === 'refresh' || action === 'push' ? [] : ['file.txt', false];
      window.firstGit = latest[action](...args);
      window.secondGit = latest[action](...args);
      window.overlappingGit = latest.stage(['another.txt']);
    }, action);
    const count = await page.evaluate(() => gitCalls.length);
    await page.evaluate(async action => {
      const data = action === 'push' ? {workspacePath: '/git', remoteName: 'origin', branch: 'main', output: '', status: gitSnapshot}
        : action === 'commit' ? {workspacePath: '/git', commitMessage: 'file.txt', status: gitSnapshot}
        : action.endsWith('Branch') ? {branchInfo: {workspacePath: '/git', currentBranch: 'main', branches: []}, status: gitSnapshot}
        : gitSnapshot;
      heldGit.resolve(ok(data));
      await Promise.all([firstGit, secondGit, overlappingGit]);
    }, action);
    assert.equal(count, 1, `${action} must hold a synchronous workspace operation lock`);
    await page.waitForFunction(() => latest.pending === null);
  });

  if (action !== 'refresh') {
    test(`Git ${action} reports transport errors, releases pending and permits retry`, async () => {
      await page.evaluate(action => {
        window.gitSnapshot = {workspacePath: '/git', isRepository: true, branch: 'main', porcelain: [], changes: [], changedFiles: 0};
        const method = {stage: 'stageFile', unstage: 'unstageFile', discard: 'discardFile',
          commit: 'commit', createBranch: 'createBranch', checkoutBranch: 'checkoutBranch', push: 'push'}[action];
        window.client = {api: {workspace: {onChanged: () => () => {}}, git: {
          status: async () => ok(gitSnapshot), diffStat: async () => ok({workspacePath: '/git', stat: ''}),
          listBranches: async () => ok({workspacePath: '/git', currentBranch: 'main', branches: []}),
          cancel: async () => ok(true),
          [method]: () => {throw new Error('Git bridge unavailable');}
        }}};
        mount('git', {client, workspacePath: '/git'}, true);
      }, action);
      await page.waitForFunction(() => latest.phase === 'ready');
      const escaped = await page.evaluate(async action => {
        const args = action === 'stage' ? [['file.txt']] : action === 'push' ? [] : ['file.txt', false];
        try {await latest[action](...args); return null;} catch (error) {return error.message;}
      }, action);
      assert.equal(escaped, null, 'the UI action boundary must handle bridge rejection');
      await page.waitForFunction(() => latest.pending === null);
      assert.match(await page.evaluate(() => latest.actionError), /Git bridge unavailable/u);
      await page.evaluate(async () => {await latest.refresh();});
      await page.waitForFunction(() => latest.phase === 'ready' && latest.pending === null);
    });
  }
}

test('Git cancels once and holds pending until both push and cancellation settle', async () => {
  await page.evaluate(() => {
    window.heldPush = deferred(); window.heldCancel = deferred(); window.cancelCalls = [];
    window.gitSnapshot = {workspacePath: '/git', isRepository: true, branch: 'main', porcelain: [], changes: [], changedFiles: 0};
    window.client = {api: {workspace: {onChanged: () => () => {}}, git: {
      status: async () => ok(gitSnapshot), diffStat: async () => ok({workspacePath: '/git', stat: ''}),
      listBranches: async () => ok({workspacePath: '/git', currentBranch: 'main', branches: []}),
      push: () => heldPush.promise,
      cancel: request => {cancelCalls.push(request); return heldCancel.promise;}
    }}};
    mount('git', {client, workspacePath: '/git'}, true);
  });
  await page.waitForFunction(() => latest.phase === 'ready');
  await page.evaluate(() => {
    window.pushPromise = latest.push();
    window.cancelPromise = latest.cancelPush();
    window.secondCancel = latest.cancelPush();
  });
  const cancelCount = await page.evaluate(() => cancelCalls.length);
  await page.evaluate(async () => {heldPush.resolve(fail('Push cancelled')); await pushPromise;});
  const pending = await page.evaluate(() => latest.pending);
  await page.evaluate(async () => {heldCancel.resolve(ok(true)); await Promise.all([cancelPromise, secondCancel]);});
  await page.waitForFunction(() => latest.pending === null);
  assert.deepEqual({cancelCount, pending}, {cancelCount: 1, pending: 'push'},
    'cancellation is singular and remains an operation until it settles');
});

test('Git does not let an old watcher snapshot overwrite a completed mutation', async () => {
  await page.evaluate(() => {
    window.heldWatch = deferred();
    window.gitSnapshot = {workspacePath: '/git', isRepository: true, branch: 'main', porcelain: [],
      changes: [{porcelain: ' M file.txt', index: ' ', worktree: 'M', relativePath: 'file.txt'}], changedFiles: 1};
    window.client = {api: {workspace: {onChanged: callback => {window.gitWatcher = callback; return () => {};}},
      git: {
        status: async () => ok(gitSnapshot), diffStat: async () => ok({workspacePath: '/git', stat: ''}),
        listBranches: async () => ok({workspacePath: '/git', currentBranch: 'main', branches: []}),
        stageFile: async () => ok({...gitSnapshot, changes: [{porcelain: 'M  file.txt', index: 'M', worktree: ' ', relativePath: 'file.txt'}]})
      }}};
    mount('git', {client, workspacePath: '/git'}, true);
  });
  await page.waitForFunction(() => latest.phase === 'ready');
  await page.evaluate(() => {
    client.api.git.status = () => heldWatch.promise;
    gitWatcher({workspacePath: '/git'});
  });
  await page.evaluate(async () => {await latest.stage(['file.txt']);});
  await page.waitForFunction(() => latest.snapshot?.changes[0]?.index === 'M');
  await page.evaluate(async () => {heldWatch.resolve(ok(gitSnapshot)); await heldWatch.promise;});
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => latest.snapshot.changes[0].index), 'M');
});

test('Git skips late mutation follow-up reads after its renderer consumer unmounts', async () => {
  await page.evaluate(() => {
    window.heldStage = deferred(); window.statCalls = 0;
    window.gitSnapshot = {workspacePath: '/git', isRepository: true, branch: 'main', porcelain: [], changes: [], changedFiles: 0};
    window.client = {api: {workspace: {onChanged: () => () => {}}, git: {
      status: async () => ok(gitSnapshot),
      diffStat: async () => {statCalls++; return ok({workspacePath: '/git', stat: ''});},
      listBranches: async () => ok({workspacePath: '/git', currentBranch: 'main', branches: []}),
      stageFile: () => heldStage.promise
    }}};
    mount('git', {client, workspacePath: '/git'}, true);
  });
  await page.waitForFunction(() => latest.phase === 'ready');
  await page.evaluate(() => {window.stagePromise = latest.stage(['file.txt']); clearHook();});
  const before = await page.evaluate(() => statCalls);
  await page.evaluate(async () => {heldStage.resolve(ok(gitSnapshot)); await stagePromise;});
  assert.equal(await page.evaluate(() => statCalls), before);
});

test('conversation renders its answer without historical or live task acceptance cards', async () => {
  for (const source of ['persisted', 'live']) {
    await page.evaluate(source => {
      const report = {status: 'passed', criteria: [], summary: '任务验收'};
      const events = [{id: 'acceptance', threadId: 'no-acceptance', runId: 'past', sequence: 1,
        type: 'task_acceptance', payload: report, createdAt: '2026-11-09T00:00:00.000Z'}];
      if (source === 'persisted') events.push({id: 'answer', threadId: 'no-acceptance', runId: 'past', sequence: 2,
        type: 'message', payload: {role: 'assistant', content: 'Answer remains visible'}, createdAt: '2026-11-09T00:00:01.000Z'});
      const liveRun = source === 'live' ? {...createEmptyChatRunState(), threadId: 'no-acceptance', runId: 'live',
        status: 'completed', assistantMessage: 'Answer remains visible',
        activityBlocks: [{id: 'acceptance', kind: 'task_acceptance', report}]} : null;
      mountTranscript({threadId: 'no-acceptance', messages: projectChatTranscript({events, liveRun, pendingUserInput: null, threadId: 'no-acceptance'}),
        prependRevision: 0, trimRevision: 0, windowEpoch: 0, tailTrimmed: false, hasMoreBefore: false, loadingOlder: false,
        loadOlder: async () => {}, onJumpToLatest: async () => {}});
    }, source);
    await page.getByText('Answer remains visible', {exact: true}).waitFor();
    assert.equal(await page.getByText('任务验收').count(), 0);
    assert.equal(await page.locator('[data-testid="assistant-message-assistant"]').count(), 1);
  }
});
