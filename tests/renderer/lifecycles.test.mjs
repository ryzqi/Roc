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
      import { useSettingsStore } from './src/renderer/settings/settings-scope';
      import { useMcp } from './src/renderer/management/use-mcp';
      import { useChatSession } from './src/renderer/assistant/use-chat-session';
      import { useGitWorkspace } from './src/renderer/workspace/use-git-workspace';
      import { researchIndexSettingsSaveSchema } from './src/shared/schemas/research-index';
      window.validateIndexWrite = request => researchIndexSettingsSaveSchema.parse(request);
      const root = createRoot(document.getElementById('root'));
      const hooks = {
        settings: p => useSettingsStore(p.client, p.projectId ?? null),
        mcp: p => useMcp(p.client, p.skills ?? []),
        mcpPair: p => { window.authorization = useMcp(p.client, null); return useMcp(p.client, p.skills ?? []); },
        chat: p => useChatSession(p),
        git: p => useGitWorkspace(p.client, p.workspacePath)
      };
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
      window.deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return {promise, resolve}; };
    `, resolveDir: process.cwd(), loader: 'js' },
    outfile: join(dir, 'hooks.js'), bundle: true, platform: 'browser', format: 'iife', logLevel: 'silent'
  });
  writeFileSync(join(dir, 'index.html'), '<div id="root"></div><script src="hooks.js"></script>');
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
  await app?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(rendererErrors, [], 'renderer must not throw during lifecycle tests');
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

test('switching conversations ignores old active-run response and unrelated live events', async () => {
  await chatFixture();
  await page.evaluate(() => { mount('chat', {...props, threadId: 'b'}); activeA.resolve(ok({runId: 'ra'})); });
  await page.waitForFunction(() => latest.history.threadId === 'b');
  assert.equal(await page.evaluate(() => replayCalls.length), 0);
  await page.evaluate(() => live({type:'run_started', runId:'ra', threadId:'a', providerId:'p', modelId:'m', mode:'chat', createdAt:'now'}));
  assert.equal(await page.evaluate(() => latest.runState.status), 'idle');
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
