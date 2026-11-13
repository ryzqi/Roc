import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
const errors = [];
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-management-draft-guards-'));
  await buildViteRenderer({directory, style: 'html,body,#root{height:100%;margin:0}', script: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion, domMax, MotionConfig} from 'motion/react';
    import {SWRConfig} from 'swr';
    import {ManagementStoresProvider, useManagementStores} from './src/renderer/management/management-stores-provider';
    import {MemorySection} from './src/renderer/management/sections/MemorySection';
    import {McpSection} from './src/renderer/management/sections/McpSection';
    import {BackgroundTasksSection} from './src/renderer/management/sections/BackgroundTasksSection';
    import {SkillsSection} from './src/renderer/management/sections/SkillsSection';
    import {MEMORY_SLOTS} from './src/renderer/management/memory-model';
    import {requestNavigation} from './src/renderer/app/navigation-guard';
    const ok = data => ({ok: true, data});
    const meta = slot => ({scope: slot.scope, kind: slot.kind, exists: true, effective: true,
      charCount: 5, charLimit: 20000, absolutePath: slot.virtualPath, updatedAt: null});
    const skillWrite = (kind, input) => {
      window.skillWrites.push({kind, input});
      if (window.skillTransport === 'throw') throw new Error('Skill transport refused');
      if (window.skillTransport === 'reject') return Promise.reject(new Error('Skill transport refused'));
      return new Promise(resolve => {window.finishSkillWrite = resolve; window.skillSettlers.push(resolve);});
    };
    function createClient() {
      const config = {schemaVersion: 1, approvalMode: 'default', servers: []};
      return {api: {
        memory: {
          status: async () => ok({root: '/memory', workspaceHash: 'workspace-a', workspaceLabel: 'Project A',
            files: MEMORY_SLOTS.map(meta), autoMemory: {recent: []}, snapshot: {enabled: true, totalChars: 5, totalLimit: 20000},
            sessionMessages: {totalRows: 0, retentionDays: 30, oldestAt: null}, fullTextIndex: {healthy: true}}),
          readFile: async () => ok('Saved'),
          writeFile: request => {window.writes.push(request); return new Promise(resolve => {window.finishWrite = resolve;});}
        },
        skills: {list: async () => {window.skillReads++; return ok(window.installedSkills);},
          builtinStatus: async () => ok(window.builtinSkills),
          listFiles: async () => ok({entries: [], truncated: false, rootPath: '/skills'}),
          setEnabled: input => skillWrite('toggle', input),
          importSkill: input => skillWrite('import', input),
          deleteSkill: input => skillWrite('remove', input),
          builtinCheck: input => skillWrite('check', input),
          builtinAutoUpdate: input => skillWrite('autoUpdate', input),
          builtinRestore: input => skillWrite('restore', input),
          onUpdated: () => () => {}},
        tasks: {listBackgroundTasks: async () => ok(window.backgrounds), getSchedulerStatus: async () => ok({running: false, registeredTaskCount: window.backgrounds.length}),
          listScheduledRuns: async () => ok([]),
          updateBackgroundTask: request => {window.updates.push(request); return new Promise(resolve => {window.finishUpdate = resolve;});},
          createBackgroundTaskPreview: request => {window.previews.push(request); return new Promise(resolve => {window.finishPreview = resolve;});},
          createBackgroundTask: request => {window.creates.push(request); return new Promise(resolve => {window.finishCreate = resolve;});},
          onUpdated: () => () => {}},
        mcp: {
          getConfig: async () => ok(config), listServers: async () => ok([]),
          upsertServer: request => {window.saves.push(request); return new Promise(resolve => {window.finishSave = resolve;});},
          ensureExaPreset: () => {window.presets++; return new Promise(resolve => {window.finishPreset = resolve;});}
        },
        agent: {getCapabilityPreview: async () => ok({builtInTools: [], toolCards: [], skillCards: [], subagents: [],
          manifest: {tools: [], skippedCapabilities: []}})}
      }};
    }
    function Surfaces({scope, tab}) {
      const memory = useManagementStores(stores => stores.memory);
      const mcp = useManagementStores(stores => stores.mcp);
      const tasks = useManagementStores(stores => stores.tasks);
      const skills = useManagementStores(stores => stores.skills);
      window.stores = {memory, mcp, tasks, skills};
      return memory === null || mcp === null ? null :
        tab === 'memory' ? <MemorySection scope={scope} store={memory} /> :
        tab === 'tasks' ? <BackgroundTasksSection store={tasks} /> :
        tab === 'skills' ? <SkillsSection store={skills} /> : <McpSection scope={scope} store={mcp} />;
    }
    function Harness({client}) {
      const [projectId, setProjectId] = useState('project-a');
      const [tab, setTab] = useState('mcp');
      const scope = {client, projectId, workspacePath: '/project-a', researchTaskId: null,
        onSelectResearchTask: () => {}, onAskAssistant: () => {}, onOpenThread: () => {}, openSettings: () => {}};
      window.setTab = next => flushSync(() => setTab(next));
      window.navigate = () => requestNavigation({page: 'project', projectId: 'project-b'}, () => {
        window.navigations++; setProjectId('project-b');
      });
      return <ManagementStoresProvider enabled scope={scope} scopeKey={projectId}>
        <main style={{padding: 40}}><Surfaces scope={scope} tab={tab} /></main>
      </ManagementStoresProvider>;
    }
    const root = createRoot(document.getElementById('root'));
    window.unmount = () => flushSync(() => root.unmount());
    let instance = 0;
    window.mount = (backgrounds = []) => {
      window.saves = []; window.presets = 0; window.writes = []; window.navigations = 0;
      window.previews = []; window.creates = []; window.updates = []; window.backgrounds = backgrounds;
      window.skillWrites = []; window.skillSettlers = []; window.skillReads = 0; window.skillTransport = null;
      window.installedSkills = [{id: 'skill-a', name: 'Skill A', enabled: true, path: '/skills/skill-a',
        description: 'Installed skill', status: 'ready', origin: 'user', sourceId: null,
        upstreamRepo: null, upstreamCommit: null}];
      window.builtinSkills = {schemaVersion: 1, sources: [{id: 'source-a', displayName: 'Source A',
        repo: 'local-source', ref: 'main', license: 'Apache-2.0', homepage: null, bundledCommit: 'a'.repeat(40),
        installedCommit: 'a'.repeat(40), skillIds: ['skill-a'], lastCheckedAt: null, lastError: null}],
        autoUpdate: true, updating: false, lastCheckedAt: null};
      window.runSkillAction = kind => {
        const skills = window.stores.skills;
        return kind === 'toggle' ? skills.toggleEnabled.run(skills.skills[0], false) :
          kind === 'import' ? skills.importFrom.run('/imports/skill-b') :
          kind === 'remove' ? skills.remove.run('skill-a') :
          kind === 'check' ? skills.builtin.check.run(true) :
          kind === 'autoUpdate' ? skills.builtin.autoUpdate.run(false) :
          skills.builtin.restore.run('source-a');
      };
      flushSync(() => root.render(<SWRConfig key={++instance} value={{provider: () => new Map(), dedupingInterval: 0}}>
        <MotionConfig reducedMotion="always"><LazyMotion features={domMax} strict>
          <Harness client={createClient()} />
        </LazyMotion></MotionConfig>
      </SWRConfig>));
    };
    window.mount();
  `});
  await writeFile(join(directory, 'main.cjs'), `
    const {app, BrowserWindow} = require('electron');
    app.setPath('userData', ${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(() => new BrowserWindow({show: false, width: 1100, height: 800})
      .loadFile(${JSON.stringify(join(directory, 'index.html'))}));
  `);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow();
  page.setDefaultTimeout(7000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('mgmt-mcp-create').waitFor();
});
after(async () => {
  try {await page?.evaluate(() => window.unmount?.()); await app?.close();}
  finally {if (directory) await rm(directory, {recursive: true, force: true});}
  assert.deepEqual(errors, [], 'management operations must surface errors in the UI');
});

async function editMcp() {
  await page.getByTestId('mgmt-mcp-create').click();
  await page.getByTestId('mgmt-mcp-custom').click();
  await page.getByTestId('mgmt-mcp-draft-name').fill('Retained service');
  await page.getByTestId('mgmt-mcp-draft-command').fill('local-tool');
  await page.evaluate(() => {
    const mcp = window.stores.mcp;
    mcp.setDraft({...mcp.draft, id: 'retained-service'});
  });
}

async function mountSkills() {
  await page.evaluate(() => {window.mount(); window.setTab('skills');});
  await page.getByTestId('mgmt-skill-enabled-skill-a').waitFor();
  await page.waitForFunction(() => window.stores.skills.builtin.snapshot !== null);
  await page.getByTestId('mgmt-skills-import-path').fill('/imports/skill-b');
}

for (const kind of ['toggle', 'import', 'remove', 'check', 'autoUpdate', 'restore']) {
  test(`skills ${kind} shares one write boundary with every conflicting action`, async () => {
    await mountSkills();
    await page.evaluate(kind => {
      window.skillOperations = [window.runSkillAction(kind), window.runSkillAction(kind),
        window.runSkillAction(kind === 'import' ? 'check' : 'import')];
    }, kind);
    try {
      assert.equal(await page.evaluate(() => window.skillWrites.length), 1, 'one event must issue one write');
      await expect(page.getByTestId('mgmt-skill-enabled-skill-a')).toBeDisabled();
      await expect(page.getByTestId('mgmt-skill-delete-skill-a')).toBeDisabled();
      await expect(page.getByTestId('mgmt-skills-import-path')).toBeDisabled();
      await expect(page.getByTestId('mgmt-skills-import-run')).toBeDisabled();
      await expect(page.getByTestId('mgmt-skills-builtin-check')).toBeDisabled();
      await expect(page.getByTestId('mgmt-skills-builtin-auto-update')).toBeDisabled();
    } finally {
      await page.evaluate(async () => {
        for (const resolve of window.skillSettlers) resolve({ok: false, error: {message: 'Skill write refused'}});
        await Promise.all(window.skillOperations);
      });
    }
    const error = kind === 'check' || kind === 'autoUpdate' || kind === 'restore'
      ? 'mgmt-skills-builtin-action-error' : 'mgmt-skills-mutation-error';
    await expect(page.getByTestId(error)).toContainText('Skill write refused');
    await expect(page.getByTestId('mgmt-skills-import-path')).toHaveValue('/imports/skill-b');
    await expect(page.getByTestId('mgmt-skills-import-run')).toBeEnabled();
  });
}

for (const transport of ['throw', 'reject']) {
  test(`skills toggle ${transport} restores the authoritative value and allows retry`, async () => {
    await mountSkills();
    await page.evaluate(async transport => {
      window.skillTransport = transport;
      window.toggleResult = await window.runSkillAction('toggle');
    }, transport);
    assert.equal(await page.evaluate(() => window.toggleResult), false);
    await expect(page.getByTestId('mgmt-skills-mutation-error')).toContainText('Skill transport refused');
    await expect(page.getByTestId('mgmt-skill-enabled-skill-a')).toBeChecked();
    await expect(page.getByTestId('mgmt-skill-enabled-skill-a')).toBeEnabled();
    await page.evaluate(() => {
      window.skillTransport = null;
      window.retryToggle = window.runSkillAction('toggle');
      window.finishSkillWrite({ok: false, error: {message: 'Retry explicitly refused'}});
    });
    assert.equal(await page.evaluate(() => window.skillWrites.length), 2);
    assert.equal(await page.evaluate(() => window.retryToggle), false);
  });
}

test('skills revalidation clears intent even when the authoritative list is unchanged', async () => {
  await mountSkills();
  await page.evaluate(() => {
    window.pendingToggle = window.runSkillAction('toggle');
    window.finishSkillWrite({ok: true, data: null});
  });
  assert.equal(await page.evaluate(() => window.pendingToggle), true);
  await page.waitForFunction(() => window.skillReads >= 2 && window.stores.skills.status === 'ready');
  await expect(page.getByTestId('mgmt-skill-enabled-skill-a')).toBeChecked();
});

test('skills delete confirmation cannot bypass another pending write', async () => {
  await mountSkills();
  await page.getByTestId('mgmt-skill-delete-skill-a').click();
  await page.getByTestId('mgmt-skills-delete-confirm-panel').waitFor();
  await page.evaluate(() => {window.pendingBuiltin = window.runSkillAction('autoUpdate');});
  try {
    await expect(page.getByTestId('mgmt-skills-delete-confirm-confirm')).toBeDisabled();
    await page.evaluate(() => document.querySelector('[data-testid="mgmt-skills-delete-confirm-confirm"]').click());
    assert.equal(await page.evaluate(() => window.skillWrites.length), 1);
  } finally {
    await page.evaluate(() => window.finishSkillWrite({ok: false, error: {message: 'Update refused'}}));
    await page.evaluate(() => window.pendingBuiltin);
    await page.getByTestId('mgmt-skills-delete-confirm-cancel').click();
  }
});

test('skills committed after a project switch refresh the global list without restoring the old panel state', async () => {
  await mountSkills();
  await page.evaluate(() => {
    window.oldSkills = window.stores.skills;
    window.oldImport = window.runSkillAction('import');
    window.navigate();
  });
  await page.waitForFunction(() => window.navigations === 1 && window.stores.skills !== null
    && window.stores.skills !== window.oldSkills);
  await page.evaluate(() => {
    const imported = {...window.installedSkills[0], id: 'skill-b', name: 'Skill B', path: '/skills/skill-b'};
    window.installedSkills = [...window.installedSkills, imported];
    window.finishSkillWrite({ok: true, data: imported});
  });
  assert.equal(await page.evaluate(() => window.oldImport), false, 'the unmounted initiator cannot resume its UI');
  await page.getByTestId('mgmt-skill-skill-b').waitFor();
  assert.equal(await page.evaluate(() => window.stores.skills.importFrom.lastImported), null);
  assert.equal(await page.evaluate(() => window.stores.skills.selectedId), 'skill-a');
});

test('shared MCP edits issue one write and cannot be cleared during a pending save', async () => {
  await page.evaluate(() => window.mount());
  await page.getByTestId('mgmt-mcp-create').waitFor();
  await editMcp();
  await page.evaluate(() => {
    window.firstSave = window.stores.mcp.save.run();
    window.secondSave = window.stores.mcp.save.run();
    window.stores.mcp.cancelEdit();
  });
  assert.equal(await page.evaluate(() => window.saves.length), 1);
  await expect(page.getByTestId('mgmt-mcp-draft-name')).toBeDisabled();
  await page.evaluate(() => window.finishSave({ok: false, error: {message: 'MCP write refused'}}));
  await expect(page.getByTestId('mgmt-mcp-mutation-error')).toContainText('MCP write refused');
  await expect(page.getByTestId('mgmt-mcp-draft-name')).toHaveValue('Retained service');
  assert.deepEqual(await page.evaluate(async () => [await window.firstSave, await window.secondSave]), [false, false]);
});

test('MCP save followed by navigation in the same event blocks discard until the write settles', async () => {
  await page.evaluate(() => window.mount());
  await page.getByTestId('mgmt-mcp-create').waitFor();
  await editMcp();
  await page.evaluate(() => {window.pendingSave = window.stores.mcp.save.run(); window.navigate();});
  assert.equal(await page.evaluate(() => window.saves.length), 1);
  assert.equal(await page.evaluate(() => window.navigations), 0);
  await expect(page.getByTestId('mgmt-navigation-discard-panel')).toHaveCount(0);
  await page.evaluate(() => window.finishSave({ok: false, error: {message: 'Same-event MCP refusal'}}));
  await expect(page.getByTestId('mgmt-mcp-mutation-error')).toContainText('Same-event MCP refusal');
  await expect(page.getByTestId('mgmt-mcp-draft-name')).toHaveValue('Retained service');
  await page.evaluate(() => window.navigate());
  await expect(page.getByTestId('mgmt-navigation-discard-panel')).toBeVisible();
  await page.getByTestId('mgmt-navigation-discard-cancel').click();
  await page.getByTestId('mgmt-navigation-discard-panel').waitFor({state: 'detached'});
});

test('memory save followed by navigation in the same event retains the file without offering discard', async () => {
  await page.evaluate(() => {window.mount(); window.setTab('memory');});
  await page.getByTestId('mgmt-memory-edit').click();
  await page.getByTestId('mgmt-memory-textarea').fill('Retained in-flight memory');
  await page.evaluate(() => {window.pendingWrite = window.stores.memory.save.run(); window.navigate();});
  assert.equal(await page.evaluate(() => window.writes.length), 1);
  assert.equal(await page.evaluate(() => window.navigations), 0);
  await expect(page.getByTestId('mgmt-navigation-discard-panel')).toHaveCount(0);
  await page.evaluate(() => window.finishWrite({ok: false, error: {message: 'Same-event memory refusal'}}));
  await expect(page.getByTestId('mgmt-memory-textarea')).toHaveValue('Retained in-flight memory');
  assert.equal(await page.evaluate(() => window.pendingWrite), false);
  await page.evaluate(() => window.navigate());
  await expect(page.getByTestId('mgmt-navigation-discard-panel')).toBeVisible();
  await page.getByTestId('mgmt-navigation-discard-cancel').click();
  await page.getByTestId('mgmt-navigation-discard-panel').waitFor({state: 'detached'});
});

test('task preview followed by navigation in the same event keeps its operation boundary', async () => {
  await page.evaluate(() => {window.mount(); window.setTab('tasks');});
  await page.getByTestId('mgmt-tasks-create').click();
  await page.getByTestId('mgmt-task-draft-goal').fill('Retained in-flight preview');
  await page.evaluate(() => {window.pendingPreview = window.stores.tasks.runPreview(); window.navigate();});
  assert.equal(await page.evaluate(() => window.previews.length), 1);
  assert.equal(await page.evaluate(() => window.navigations), 0);
  await expect(page.getByTestId('mgmt-navigation-discard-panel')).toHaveCount(0);
  await page.evaluate(() => window.finishPreview({ok: false, error: {message: 'Same-event preview refusal'}}));
  await expect(page.getByTestId('mgmt-task-draft-goal')).toHaveValue('Retained in-flight preview');
  assert.equal(await page.evaluate(() => window.pendingPreview), false);
});

test('MCP back and cancel paths confirm authored draft loss', async () => {
  await page.evaluate(() => window.mount());
  await page.getByTestId('mgmt-mcp-create').waitFor();
  await editMcp();
  await page.getByTestId('mgmt-mcp-back').click();
  await expect(page.getByTestId('mgmt-mcp-discard-panel')).toBeVisible();
  await page.getByTestId('mgmt-mcp-discard-cancel').click();
  await page.getByTestId('mgmt-mcp-discard-panel').waitFor({state: 'detached'});
  await expect(page.getByTestId('mgmt-mcp-draft-name')).toHaveValue('Retained service');
  await page.getByTestId('mgmt-mcp-cancel').click();
  await page.getByTestId('mgmt-mcp-discard-confirm').click();
  await page.getByTestId('mgmt-mcp-editor').waitFor({state: 'detached'});
});

test('the management source protects shared memory and MCP drafts on project navigation', async () => {
  await page.evaluate(() => window.mount());
  await page.getByTestId('mgmt-mcp-create').waitFor();
  await editMcp();
  await page.evaluate(() => window.setTab('memory'));
  await page.getByTestId('mgmt-memory-edit').click();
  await page.getByTestId('mgmt-memory-textarea').fill('Retained memory');
  const prevented = await page.evaluate(() => {
    const event = new Event('beforeunload', {cancelable: true});
    window.dispatchEvent(event); return event.defaultPrevented;
  });
  assert.equal(prevented, true);
  await page.evaluate(() => window.navigate());
  assert.equal(await page.evaluate(() => window.navigations), 0);
  await expect(page.getByTestId('mgmt-navigation-discard-panel')).toBeVisible();
  await page.getByTestId('mgmt-navigation-discard-cancel').click();
  await page.getByTestId('mgmt-navigation-discard-panel').waitFor({state: 'detached'});
  await expect(page.getByTestId('mgmt-memory-textarea')).toHaveValue('Retained memory');
  assert.equal(await page.evaluate(() => window.stores.mcp.draft.name), 'Retained service');
  await page.evaluate(() => window.navigate());
  await page.getByTestId('mgmt-navigation-discard-confirm').click();
  await page.waitForFunction(() => window.navigations === 1);
  await page.waitForFunction(() => window.stores.memory?.dirtyCount === 0 && window.stores.mcp?.draft === null);
});

test('task preview and creation freeze authored inputs and use the accepted preview once', async () => {
  await page.evaluate(() => {window.mount(); window.setTab('tasks');});
  await page.getByTestId('mgmt-tasks-create').click();
  await page.getByTestId('mgmt-task-draft-goal').fill('Review local papers');
  await page.evaluate(() => {
    window.firstPreview = window.stores.tasks.runPreview();
    window.secondPreview = window.stores.tasks.runPreview();
    window.stores.tasks.cancelEdit();
  });
  assert.equal(await page.evaluate(() => window.previews.length), 1);
  await expect(page.getByTestId('mgmt-task-draft-goal')).toBeDisabled();
  await expect(page.getByTestId('mgmt-task-editor-cancel')).toBeDisabled();
  await page.evaluate(() => window.finishPreview({ok: true, data: {scheduled: false, cronExpression: null,
    nextRunAt: null, riskLevel: 'low', requiresConfirmation: false}}));
  await expect(page.getByTestId('mgmt-task-create-run')).toBeEnabled();
  await page.evaluate(() => {
    window.firstCreate = window.stores.tasks.create.run();
    window.secondCreate = window.stores.tasks.create.run();
  });
  assert.equal(await page.evaluate(() => window.creates.length), 1);
  assert.deepEqual(await page.evaluate(() => window.creates[0]), await page.evaluate(() => window.previews[0]));
  await page.evaluate(() => window.finishCreate({ok: false, error: {message: 'Task creation refused'}}));
  await expect(page.getByTestId('mgmt-task-create-error')).toContainText('Task creation refused');
  await expect(page.getByTestId('mgmt-task-draft-goal')).toHaveValue('Review local papers');
  assert.deepEqual(await page.evaluate(async () => [await window.firstCreate, await window.secondCreate]), [false, false]);
});

test('task cancel and replacement preserve a draft until discard is confirmed', async () => {
  await page.evaluate(() => {window.mount(); window.setTab('tasks');});
  await page.getByTestId('mgmt-tasks-create').click();
  await page.getByTestId('mgmt-task-draft-goal').fill('Retained task goal');
  await page.getByTestId('mgmt-task-editor-cancel').click();
  await expect(page.getByTestId('mgmt-task-discard-panel')).toBeVisible();
  await page.getByTestId('mgmt-task-discard-cancel').click();
  await page.getByTestId('mgmt-task-discard-panel').waitFor({state: 'detached'});
  await page.getByTestId('mgmt-tasks-create').click();
  await expect(page.getByTestId('mgmt-task-discard-panel')).toBeVisible();
  await page.getByTestId('mgmt-task-discard-cancel').click();
  await page.getByTestId('mgmt-task-discard-panel').waitFor({state: 'detached'});
  await expect(page.getByTestId('mgmt-task-draft-goal')).toHaveValue('Retained task goal');
  await page.evaluate(() => window.navigate());
  await expect(page.getByTestId('mgmt-navigation-discard-panel')).toBeVisible();
  await page.evaluate(() => window.mount());
});

const background = id => ({
  id, goal: `Task ${id}`, status: 'paused', triggerType: 'manual', triggerDescription: '手动触发',
  nextRunAt: null, cronExpression: null, allowedActions: [], forbiddenActions: [], runCount: 0
});

async function editBackground() {
  await page.evaluate(backgrounds => {window.mount(backgrounds); window.setTab('tasks');}, [background('a'), background('b')]);
  await page.getByTestId('mgmt-task-select-a').waitFor();
  await page.evaluate(() => window.stores.tasks.startEdit(window.backgrounds[0]));
  await page.getByTestId('mgmt-task-draft-goal').fill('Edited task A');
  await page.evaluate(() => {
    const store = window.stores.tasks;
    store.setDraft({...store.draft, reason: 'Update the original task'});
  });
}

test('task details selection does not replace the authored update target', async () => {
  await editBackground();
  await page.getByTestId('mgmt-task-select-b').click();
  await expect(page.getByTestId('mgmt-task-draft-goal')).toHaveValue('Edited task A');
  await page.evaluate(() => {window.pendingUpdate = window.stores.tasks.update.run();});
  assert.equal(await page.evaluate(() => window.updates.length), 1);
  assert.equal(await page.evaluate(() => window.updates[0].taskId), 'a');
  await page.evaluate(() => window.finishUpdate({ok: false, error: {message: 'Update refused'}}));
  assert.equal(await page.evaluate(() => window.pendingUpdate), false);
  await expect(page.getByTestId('mgmt-task-draft-goal')).toHaveValue('Edited task A');
});

test('task selection cannot move during an update started in the same event', async () => {
  await editBackground();
  await page.evaluate(() => {
    const store = window.stores.tasks;
    window.pendingUpdate = store.update.run();
    store.select('b');
  });
  await expect(page.getByTestId('mgmt-task-select-b')).toBeDisabled();
  assert.equal(await page.evaluate(() => window.stores.tasks.selectedId), 'a');
  await page.evaluate(() => window.finishUpdate({ok: false, error: {message: 'Update refused'}}));
  assert.equal(await page.evaluate(() => window.pendingUpdate), false);
  await expect(page.getByTestId('mgmt-task-select-b')).toBeEnabled();
});
