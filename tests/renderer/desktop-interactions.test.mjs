import {before, after, test} from 'node:test';
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
  directory = await mkdtemp(join(tmpdir(), 'roc-desktop-interactions-'));
  await buildViteRenderer({directory, style: '', script: `
    import React, {useCallback, useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {AssistantComposer} from './src/renderer/assistant/composer';
    import {useAssistantComposerDraft} from './src/renderer/assistant/composer-draft';
    import {ResizableDivider} from './src/renderer/shell/ResizableDivider';
    import {ModalShell} from './src/renderer/shell/ModalShell';
    import {focusDialogInitialElement} from './src/renderer/shell/focus-trap';
    import {ModelPicker} from './src/renderer/assistant/model-picker';
    import {RemoteModelPicker} from './src/renderer/settings/RemoteModelPicker';
    import {RadixSettingsDialogShell} from './src/renderer/settings/radix-dialog-pilot';
    import {SearchPaletteModal} from './src/renderer/shell/SearchPaletteModal';
    import {WorkspaceCanvas} from './src/renderer/canvas/WorkspaceCanvas';
    import {ProjectFormDialog} from './src/renderer/project/ProjectFormDialog';
    import {LazyMotion, domMax, MotionConfig} from 'motion/react';
    function Harness() {
      const [composerThread, setComposerThread] = useState('test');
      const {draft, updateDraft} = useAssistantComposerDraft('test-project', composerThread);
      const setDraft = useCallback(update => updateDraft(typeof update === 'function' ? update : () => update), [updateDraft]);
      const [mode, setMode] = useState('chat');
      const [running, setRunning] = useState(false);
      const [sending, setSending] = useState(false);
      const [seed, setSeed] = useState(null);
      const [modelChoices, setModelChoices] = useState([]);
      const [modelKey, setModelKey] = useState(null);
      const [modelPending, setModelPending] = useState(false);
      const [modelError, setModelError] = useState(null);
      const [skills, setSkills] = useState([]);
      const [width, setWidth] = useState(240);
      const [divider, setDivider] = useState(true);
      const [drawerOpen, setDrawerOpen] = useState(false);
      const [settingsOpen, setSettingsOpen] = useState(false);
      const [remoteOpen, setRemoteOpen] = useState(false);
      const [focusDialogOpen, setFocusDialogOpen] = useState(false);
      const [searchOpen, setSearchOpen] = useState(false);
      const [query, setQuery] = useState('');
      const [canvasTab, setCanvasTab] = useState('literature');
      const [projectOpen, setProjectOpen] = useState(false);
      const [projectPending, setProjectPending] = useState(false);
      const searchItems = Array.from({length: 24}, (_, index) => ({
        id: 'result-' + (index + 1), title: 'result-' + (index + 1),
        subtitle: '研究项目',
        onOpen: () => window.searchOpened.push(index + 1)
      })).filter(item => !query.trim() || item.title.includes(query.trim()));
      const remoteClient = {api: {settings: {listRemoteModels: async () => {
        window.remoteFetches++;
        return {ok: true, data: {models: [{id: 'test-model', ownedBy: null}]}};
      }}}};
      window.setDrawerOpen = setDrawerOpen;
      window.setRunning = setRunning;
      window.setSending = setSending;
      window.setComposerDraft = setDraft;
      window.setComposerThread = setComposerThread;
      window.setComposerSeed = setSeed;
      window.composerDraft = draft;
      window.setModelChoices = setModelChoices;
      window.setModelKey = setModelKey;
      window.setModelPending = setModelPending;
      window.setModelError = setModelError;
      window.setSkills = setSkills;
      window.setDivider = setDivider;
      window.setSettingsOpen = setSettingsOpen;
      window.focusDialogInitialElement = focusDialogInitialElement;
      window.setSearchOpen = setSearchOpen;
      window.setSearchQuery = setQuery;
      window.setProjectOpen = setProjectOpen;
      window.setProjectPending = setProjectPending;
      return <main style={{padding: 32}}>
        <h2 data-testid="heading" className="text-[length:var(--font-h2-size)] font-semibold">研究项目</h2>
        <p data-testid="meta" className="text-[length:var(--font-micro-size)] font-medium">项目概览</p>
        <div style={{display: 'flex', height: 72}}>
          <div style={{width}} />
          {divider && <ResizableDivider ariaLabel="调整侧栏" testId="divider" value={width} min={180} max={360}
            onResize={next => {window.resizeCalls++; setWidth(Math.min(360, Math.max(180, next)));}}
            onReset={() => setWidth(240)} onDragChange={active => {window.dragging = active;}} />}
        </div>
        <div style={{width: 360, marginTop: 180}}>
          <AssistantComposer mode={mode} onModeChange={setMode} draft={draft} onDraftChange={updateDraft}
            skills={skills} imageInputSupported={true} sending={sending} running={running} replyMode={false}
            seed={seed} onSeedConsumed={() => setSeed(null)}
            onSend={async payload => {
              window.sent.push(payload);
              if (window.sendFailure) throw new Error(window.sendFailure);
              if (window.deferSend) return await new Promise(resolve => {window.finishSend = resolve;});
              return true;
            }} onStop={() => setRunning(false)}
            model={{choices: modelChoices, currentKey: modelKey, label: '选择模型', pending: modelPending, error: modelError,
              onSelect: key => {window.modelSelectCalls.push(key); setModelPending(true);},
              onOpenSettings: () => {}}} />
        </div>
        <ModalShell open={drawerOpen} onClose={() => setDrawerOpen(false)} kind="drawer" title="助手" testId="interaction-drawer">
          <ModelPicker choices={[]} currentKey={null} label="模型未配置" pending={false} error={null}
            onSelect={() => {}} onOpenSettings={() => {}} />
        </ModalShell>
        <RadixSettingsDialogShell open={settingsOpen} onClose={() => setSettingsOpen(false)} title="设置" testId="nested-settings"
          widthClassName="w-[760px] h-[600px]" closeOnBackdrop={false}>
          <input data-testid="parent-draft" aria-label="设置草稿" defaultValue="保留草稿" />
          <button data-testid="open-remote" onClick={() => setRemoteOpen(true)}>拉取模型</button>
          <RemoteModelPicker open={remoteOpen} client={remoteClient} endpoint="http://localhost/v1" testId="nested-remote"
            onClose={() => setRemoteOpen(false)} onConfirm={() => setRemoteOpen(false)} />
        </RadixSettingsDialogShell>
        <div data-testid="opener-scroll" style={{height: 80, overflowY: 'auto', marginTop: 12}}>
          <div style={{height: 160}} />
          <button data-testid="open-focus-dialog" onClick={() => setFocusDialogOpen(true)}>打开高级编辑</button>
        </div>
        <ModalShell open={focusDialogOpen} onClose={() => setFocusDialogOpen(false)} title="高级编辑" testId="focus-dialog">
          <button data-testid="focus-first">编辑内容</button>
          <details>
            <summary data-testid="focus-summary">高级选项</summary>
            <button>折叠内容</button>
          </details>
          <div contentEditable suppressContentEditableWarning role="textbox" aria-label="编辑草稿" data-testid="focus-editor">草稿</div>
          <div inert><button>不可交互的内容</button></div>
          <div style={{visibility: 'hidden'}}><button>隐藏内容</button></div>
          <fieldset disabled><button>停用内容</button></fieldset>
        </ModalShell>
        <SearchPaletteModal open={searchOpen} query={query} onQueryChange={setQuery}
          onClose={() => setSearchOpen(false)}
          groups={[{id: 'projects', label: '项目', status: 'ready', items: searchItems}]} />
        <div style={{height: 100, marginTop: 12}}>
          <WorkspaceCanvas activeTab={canvasTab} onTabChange={setCanvasTab}
            actions={<button data-testid="canvas-action">工作模式</button>}>
            <p>画布内容</p>
          </WorkspaceCanvas>
        </div>
        <ProjectFormDialog open={projectOpen} mode="create" pending={projectPending} submitError={null}
          onCancel={() => {window.projectCancels++; setProjectOpen(false);}}
          onSubmit={values => {window.projectSubmissions.push(values); setProjectPending(true);}}
          onPickWorkspace={async () => {
            if (window.deferWorkspacePick) {
              return await new Promise(resolve => {window.finishWorkspacePick = resolve;});
            }
            return {status: 'picked', path: '/research/workspace'};
          }} />
      </main>;
    }
    const root = createRoot(document.getElementById('root'));
    window.mount = () => {
      window.sent = []; window.resizeCalls = 0; window.dragging = false; window.remoteFetches = 0;
      window.searchOpened = []; window.projectSubmissions = []; window.projectCancels = 0; window.deferWorkspacePick = false;
      window.deferSend = false; window.sendFailure = null; window.modelSelectCalls = [];
      flushSync(() => root.render(<MotionConfig reducedMotion="always"><LazyMotion features={domMax} strict><Harness /></LazyMotion></MotionConfig>));
    };
    window.mount();
  `});
  await writeFile(join(directory, 'main.cjs'), `
    const {app, BrowserWindow} = require('electron');
    app.setPath('userData', ${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(() => {
      const window = new BrowserWindow({show: false, width: 900, height: 900});
      window.loadFile(${JSON.stringify(join(directory, 'index.html'))});
    });
  `);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('assistant-composer-input').waitFor();
});
after(async () => {
  try {await app?.close();} finally {
    if (directory) await rm(directory, {recursive: true, force: true});
  }
  assert.deepEqual(errors, []);
});

async function resetComposer() {
  await page.evaluate(() => {
    window.sent = []; window.deferSend = false; window.sendFailure = null;
    setRunning(false); setSending(false); setSkills([]);
    setComposerDraft({text: '', attachments: []});
    setModelChoices([]); setModelKey(null); setModelPending(false); setModelError(null);
    window.modelSelectCalls = [];
  });
}

test('composer waits for an attachment read before sending its complete draft', async () => {
  await resetComposer();
  await page.getByTestId('assistant-composer-input').fill('查看这张图');
  const beforeRead = await page.evaluate(() => {
    const original = Blob.prototype.arrayBuffer;
    window.finishImageRead = null;
    Blob.prototype.arrayBuffer = () => new Promise(resolve => {
      window.finishImageRead = () => resolve(new Uint8Array([1, 2, 3]).buffer);
    });
    const transfer = new DataTransfer();
    transfer.items.add(new File(['png'], 'figure.png', {type: 'image/png'}));
    const input = document.querySelector('[data-testid="assistant-composer-input"]');
    input.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: transfer}));
    document.querySelector('[data-testid="assistant-composer-send"]').click();
    Blob.prototype.arrayBuffer = original;
    return sent.length;
  });
  await page.evaluate(() => finishImageRead());
  await page.waitForFunction(() => composerDraft.attachments.length === 1);
  await page.getByTestId('assistant-composer-send').click();
  await page.waitForFunction(() => composerDraft.text === '');
  assert.equal(beforeRead, 0, 'reading an image must synchronously block submission');
  assert.equal(await page.evaluate(() => sent.at(-1).attachments.length), 1);
  await resetComposer();
});

test('composer requires text for an image attachment, matching the run contract', async () => {
  await resetComposer();
  await page.evaluate(() => setComposerDraft({text: '', attachments: [{
    kind: 'image', source: 'drop', name: 'figure.png', mediaType: 'image/png', sizeBytes: 3, data: 'cG5n', previewUrl: null
  }]}));
  await expect(page.getByTestId('assistant-composer-send')).toBeDisabled();
  await resetComposer();
});

test('composer serializes overlapping image reads', async () => {
  await resetComposer();
  await page.evaluate(() => {
    window.imageReads = [];
    const original = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = () => new Promise(resolve => imageReads.push(() => resolve(new Uint8Array([1]).buffer)));
    const drop = count => {
      const transfer = new DataTransfer();
      for (let i = 0; i < count; i++) transfer.items.add(new File(['png'], 'image-' + i + '.png', {type: 'image/png'}));
      document.querySelector('[data-testid="assistant-composer-input"]').dispatchEvent(
        new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: transfer})
      );
    };
    drop(3); drop(2);
    window.initialReadCount = imageReads.length;
    Blob.prototype.arrayBuffer = original;
    // The first read was deferred. Later files use the restored real reader.
    for (const finish of imageReads) finish();
  });
  await page.waitForFunction(() => composerDraft.attachments.length >= 3);
  assert.equal(await page.evaluate(() => initialReadCount), 1);
  assert.equal(await page.evaluate(() => composerDraft.attachments.length), 3);
  await resetComposer();
});

test('composer checks the current attachment limit after the file read', async () => {
  await resetComposer();
  await page.evaluate(() => {
    const original = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = () => new Promise(resolve => {
      window.finishImageRead = () => resolve(new Uint8Array([1]).buffer);
    });
    const transfer = new DataTransfer();
    transfer.items.add(new File(['png'], 'new-1.png', {type: 'image/png'}));
    transfer.items.add(new File(['png'], 'new-2.png', {type: 'image/png'}));
    document.querySelector('[data-testid="assistant-composer-input"]').dispatchEvent(
      new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: transfer})
    );
    Blob.prototype.arrayBuffer = original;
    setComposerDraft({text: '读取期间的新文字', attachments: Array.from({length: 3}, (_, i) => ({
      kind: 'image', source: 'drop', name: 'existing-' + i + '.png', mediaType: 'image/png',
      sizeBytes: 3, data: 'cG5n', previewUrl: null
    }))});
    finishImageRead();
  });
  await page.waitForFunction(() => composerDraft.attachments.length === 5 ||
    document.querySelector('[data-testid="assistant-composer"] [role="alert"]'));
  assert.equal(await page.evaluate(() => composerDraft.attachments.length), 3);
  assert.equal(await page.getByTestId('assistant-composer-input').inputValue(), '读取期间的新文字');
  await resetComposer();
});

test('composer sends once per event before the parent pending state updates', async () => {
  await resetComposer();
  await page.getByTestId('assistant-composer-input').fill('第一份草稿');
  await page.evaluate(() => {
    window.deferSend = true;
    const send = document.querySelector('[data-testid="assistant-composer-send"]');
    send.click(); send.click();
  });
  const submittedCount = await page.evaluate(() => sent.length);
  await page.evaluate(() => finishSend(true));
  await page.waitForFunction(() => !document.querySelector('[data-testid="assistant-composer-input"]').disabled);
  assert.equal(submittedCount, 1);
  await resetComposer();
});

test('composer preserves a new handoff while the send is pending', async () => {
  await resetComposer();
  await page.getByTestId('assistant-composer-input').fill('第一份草稿');
  await page.evaluate(() => {window.deferSend = true;});
  await page.getByTestId('assistant-composer-send').click();
  await page.evaluate(() => setComposerSeed({text: '下一份待整理内容', nonce: 1001}));
  await expect(page.getByTestId('assistant-composer-input')).toHaveValue('下一份待整理内容');
  await page.evaluate(() => finishSend(true));
  await page.waitForFunction(() => !document.querySelector('[data-testid="assistant-composer-input"]').disabled);
  assert.equal(await page.getByTestId('assistant-composer-input').inputValue(), '下一份待整理内容');
  await resetComposer();
});

test('composer catches a thrown send and preserves the draft for retry', async () => {
  await resetComposer();
  await page.getByTestId('assistant-composer-input').fill('可重试的草稿');
  await page.evaluate(() => {window.sendFailure = '发送连接失败';});
  await page.getByTestId('assistant-composer-send').click();
  await expect(page.getByTestId('assistant-composer').getByRole('alert')).toContainText('发送连接失败');
  await expect(page.getByTestId('assistant-composer-input')).toHaveValue('可重试的草稿');
  await page.evaluate(() => {window.sendFailure = null;});
  await page.getByTestId('assistant-composer-send').click();
  await page.waitForFunction(() => composerDraft.text === '');
  assert.equal(await page.evaluate(() => sent.length), 2);
  await resetComposer();
});

test('composer discards a late attachment read after switching draft scopes', async () => {
  await resetComposer();
  await page.evaluate(() => {
    const original = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = () => new Promise(resolve => {
      window.finishImageRead = () => resolve(new Uint8Array([1]).buffer);
    });
    const transfer = new DataTransfer();
    transfer.items.add(new File(['png'], 'old-thread.png', {type: 'image/png'}));
    document.querySelector('[data-testid="assistant-composer-input"]').dispatchEvent(
      new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: transfer}));
    Blob.prototype.arrayBuffer = original;
    setComposerThread('different-thread');
  });
  await page.getByTestId('assistant-composer-input').fill('新线程内容');
  await page.evaluate(async () => {
    finishImageRead();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  assert.deepEqual(await page.evaluate(() => ({text: composerDraft.text, attachments: composerDraft.attachments})), {
    text: '新线程内容', attachments: []
  });
  await page.evaluate(() => setComposerThread('composer-thread'));
  await resetComposer();
});

test('model picker focuses an enabled choice when the current model is disabled', async () => {
  await resetComposer();
  await page.evaluate(() => {
    const make = (key, enabled) => ({key, label: key, providerId: 'p', providerLabel: '端点', enabled});
    setModelChoices([make('p:disabled', false), make('p:a', true), make('p:b', true)]);
    setModelKey('p:disabled');
  });
  const composer = page.getByTestId('assistant-composer-input').locator('xpath=ancestor::div[@data-testid="assistant-composer"]');
  await composer.getByTestId('assistant-model-settings').click();
  const enabledChoice = composer.getByTestId('assistant-model-picker-option-p:a');
  const initiallyFocused = await enabledChoice.evaluate(element => element === document.activeElement);
  await enabledChoice.press('Escape');
  assert.equal(initiallyFocused, true);
  await resetComposer();
});

test('model picker permits one pending change with retry', async () => {
  await resetComposer();
  await page.evaluate(() => {
    const make = key => ({key, label: key, providerId: 'p', providerLabel: '端点', enabled: true});
    setModelChoices([make('p:a'), make('p:b')]);
  });
  const composer = page.getByTestId('assistant-composer');
  await composer.getByTestId('assistant-model-settings').click();
  const enabledChoice = composer.getByTestId('assistant-model-picker-option-p:a');
  await page.evaluate(() => {
    document.querySelector('[data-testid="assistant-model-picker-option-p:a"]').click();
    document.querySelector('[data-testid="assistant-model-picker-option-p:b"]').click();
  });
  const pendingCount = await page.evaluate(() => modelSelectCalls.length);
  await expect(enabledChoice).toHaveAttribute('aria-disabled', 'true');
  await enabledChoice.focus();
  await page.evaluate(() => {setModelError('切换失败'); setModelPending(false);});
  await composer.getByTestId('assistant-model-picker-error').waitFor();
  await enabledChoice.click();
  const retryCount = await page.evaluate(() => modelSelectCalls.length);
  await page.evaluate(() => {setModelKey('p:a'); setModelError(null); setModelPending(false);});
  await composer.getByTestId('assistant-model-picker').waitFor({state: 'detached'});
  assert.equal(pendingCount, 1);
  assert.equal(retryCount, 2);
  await resetComposer();
});

test('built typography uses size tokens and compensates dark weight', async () => {
  const metrics = () => page.evaluate(() => ['heading', 'meta', 'assistant-composer-input'].map(id => {
    const style = getComputedStyle(document.querySelector('[data-testid="' + id + '"]'));
    return {size: style.fontSize, weight: style.fontWeight};
  }));
  assert.deepEqual(await metrics(), [
    {size: '18px', weight: '600'}, {size: '12px', weight: '500'}, {size: '13px', weight: '400'}
  ]);
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  assert.deepEqual(await metrics(), [
    {size: '18px', weight: '500'}, {size: '12px', weight: '400'}, {size: '13px', weight: '400'}
  ]);
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
});

test('IME confirmation never sends; next Enter sends, Shift+Enter retains a newline', async () => {
  const input = page.getByTestId('assistant-composer-input');
  await input.fill('中文候选词');
  await input.evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}));
    element.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', isComposing: true, bubbles: true}));
    element.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true, data: '词'}));
    element.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
  });
  assert.deepEqual(await page.evaluate(() => window.sent), []);
  assert.equal(await input.inputValue(), '中文候选词');
  await input.press('Enter');
  await page.waitForFunction(() => window.sent.length === 1);
  assert.equal(await page.evaluate(() => window.sent[0].text), '中文候选词');
  await input.fill('第一行');
  await input.press('Shift+Enter');
  await input.press('a');
  assert.equal(await input.inputValue(), '第一行\na');
  assert.equal(await page.evaluate(() => window.sent.length), 1);
  await input.fill(Array.from({length: 30}, (_, i) => '长内容第 ' + i + ' 行').join('\n'));
  const dimensions = await input.evaluate(element => ({height: element.clientHeight, scroll: element.scrollHeight}));
  assert.ok(dimensions.height <= 200 && dimensions.scroll > dimensions.height, JSON.stringify(dimensions));
  await input.fill('');
});

test('locked and sending states disable mode and attachment mutations', async () => {
  await page.evaluate(() => window.setRunning(true));
  await expect(page.getByTestId('assistant-composer-input')).toBeDisabled();
  assert.equal(await page.getByRole('button', {name: '添加图片', exact: true}).isDisabled(), true);
  await expect(page.getByTestId('assistant-composer-mode-task')).toBeDisabled();
  await page.evaluate(() => {window.setRunning(false); window.setSending(true);});
  await expect(page.getByTestId('assistant-composer-input')).toBeDisabled();
  await expect(page.getByTestId('assistant-composer-mode-task')).toBeDisabled();
  await page.evaluate(() => window.setSending(false));
  await expect(page.getByTestId('assistant-composer-mode-chat')).toBeEnabled();
  await page.getByTestId('assistant-composer-mode-chat').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByTestId('assistant-composer-mode-task').getAttribute('aria-checked'), 'true');
  assert.equal(await page.getByTestId('assistant-composer-mode-task').evaluate(el => el === document.activeElement), true);
});

test('slash skill navigation reaches and reveals every result beyond the first six', async () => {
  const skills = Array.from({length: 12}, (_, index) => ({id: `review-${index + 1}`, name: `Review ${index + 1}`}));
  const input = page.getByTestId('assistant-composer-input');
  const list = page.getByRole('listbox', {name: '可用技能'});
  const selected = list.getByRole('option', {selected: true});
  const expectSelectedVisible = async id => {
    await expect(selected).toHaveAttribute('data-testid', `assistant-skill-suggestion-${id}`);
    const bounds = await selected.evaluate(element => {
      const row = element.getBoundingClientRect();
      const list = element.closest('[role="listbox"]');
      const box = list.getBoundingClientRect();
      return {rowTop: row.top, rowBottom: row.bottom, listTop: box.top, listBottom: box.bottom,
        scrollTop: list.scrollTop, clientHeight: list.clientHeight, clientTop: list.clientTop};
    });
    assert.ok(bounds.rowTop >= bounds.listTop && bounds.rowBottom <= bounds.listBottom,
      `${id} must scroll fully into the skill list viewport: ${JSON.stringify(bounds)}`);
    await expect(input).toBeFocused();
  };
  try {
    await page.evaluate(skills => window.setSkills(skills), skills);
    await input.fill('/');
    await expectSelectedVisible('review-1');
    for (let index = 0; index < 6; index++) await input.press('ArrowDown');
    await expectSelectedVisible('review-7');
    await expect(list.getByRole('option')).toHaveCount(12);
    assert.ok(await list.evaluate(element => element.scrollHeight > element.clientHeight), 'list must scroll without growing to fit every skill');
    assert.ok(await list.evaluate(element => element.scrollTop > 0), 'keyboard selection must scroll the list');
    for (let index = 0; index < 5; index++) await input.press('ArrowDown');
    await expectSelectedVisible('review-12');
    await input.press('ArrowDown');
    await expectSelectedVisible('review-1');
    await input.press('ArrowUp');
    await expectSelectedVisible('review-12');
    await input.press('ArrowUp');
    await expectSelectedVisible('review-11');
    await input.press('ArrowDown');
    await input.press('Enter');
    await expect(input).toHaveValue('/review-12 ');
    await expect(list).toHaveCount(0);
    const sentBefore = await page.evaluate(() => window.sent.length);
    await input.pressSequentially('Check this draft');
    await input.press('Enter');
    await expect.poll(() => page.evaluate(() => window.sent.length)).toBe(sentBefore + 1);
    assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), {
      text: 'Check this draft', attachments: [], explicitSkillIds: ['review-12']
    });
  } finally {
    await page.evaluate(() => window.setSkills([]));
    await input.fill('');
  }
});

test('slash skill filtering resets selection and scrolling, with dismissal and mouse access', async () => {
  const skills = Array.from({length: 12}, (_, index) => ({id: `review-${index + 1}`, name: `Review ${index + 1}`}));
  const input = page.getByTestId('assistant-composer-input');
  const list = page.getByRole('listbox', {name: '可用技能'});
  try {
    await page.evaluate(skills => window.setSkills(skills), skills);
    await input.fill('/');
    await input.press('ArrowUp');
    await expect(list.getByRole('option', {selected: true})).toContainText('/review-12');
    await input.pressSequentially('review-1');
    await expect(list.getByRole('option')).toHaveCount(4);
    await expect(list.getByRole('option', {selected: true})).toHaveAttribute('data-testid', 'assistant-skill-suggestion-review-1');
    assert.equal(await list.evaluate(element => element.scrollTop), 0);
    await input.fill('/missing');
    await expect(list).toHaveCount(0);
    await expect(input).toHaveAttribute('aria-expanded', 'false');
    await input.fill('/');
    await expect(list.getByRole('option')).toHaveCount(12);
    await input.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(input).toHaveValue('/');
    await input.pressSequentially('review-');
    await expect(list.getByRole('option')).toHaveCount(12);
    await list.hover();
    await page.mouse.wheel(0, 600);
    await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await page.getByTestId('assistant-skill-suggestion-review-12').click();
    await expect(input).toHaveValue('/review-12 ');
    await expect(input).toBeFocused();
  } finally {
    await page.evaluate(() => window.setSkills([]));
    await input.fill('');
  }
});

test('resize cancels clamped overshoot, handles pointer cancellation, keyboard and unmount', async () => {
  const divider = page.getByTestId('divider');
  const drag = async () => {
    const box = await divider.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 350, box.y + box.height / 2);
    await page.waitForFunction(() => window.dragging === true);
  };
  await drag();
  assert.equal(await divider.getAttribute('aria-valuenow'), '360');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.equal(await divider.getAttribute('aria-valuenow'), '240', 'cancel restores original width, not clamped delta');
  await drag();
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', {pointerId: 1})));
  await page.mouse.up();
  assert.equal(await divider.getAttribute('aria-valuenow'), '240');
  await divider.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await divider.getAttribute('aria-valuenow'), '248');
  await page.keyboard.press('Shift+ArrowLeft');
  assert.equal(await divider.getAttribute('aria-valuenow'), '216');
  await page.keyboard.press('Home');
  assert.equal(await divider.getAttribute('aria-valuenow'), '240');
  await drag();
  await page.evaluate(() => window.setDivider(false));
  await divider.waitFor({state: 'detached'});
  const calls = await page.evaluate(() => window.resizeCalls);
  await page.mouse.move(700, 120);
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.resizeCalls), calls, 'unmounted divider removes global listeners');
  assert.equal(await page.evaluate(() => window.dragging), false);
});

test('Escape closes the model popover before its enclosing drawer, including an empty list', async () => {
  await page.evaluate(() => window.setDrawerOpen(true));
  const drawer = page.getByTestId('interaction-drawer-panel');
  await drawer.waitFor();
  const trigger = drawer.getByTestId('assistant-model-settings');
  await trigger.click();
  await drawer.getByTestId('assistant-model-picker').waitFor();
  await page.keyboard.press('Escape');
  await drawer.getByTestId('assistant-model-picker').waitFor({state: 'detached'});
  await expect(drawer).toBeVisible();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Escape');
  await drawer.waitFor({state: 'detached'});
});

test('remote model dialog above settings receives pointer, focus and Escape without losing the parent draft', async () => {
  await page.evaluate(() => window.setSettingsOpen(true));
  const settings = page.getByTestId('nested-settings-panel');
  await settings.waitFor();
  await page.getByTestId('open-remote').click();
  const remote = page.getByTestId('nested-remote-panel');
  await remote.waitFor();
  await page.getByTestId('nested-remote-fetch').click();
  await page.getByTestId('nested-remote-option-test-model').waitFor();
  assert.equal(await page.evaluate(() => window.remoteFetches), 1);
  await page.getByTestId('nested-remote-option-test-model').click();
  await expect(page.getByTestId('nested-remote-confirm')).toBeEnabled();
  await page.getByTestId('nested-remote-confirm').focus();
  await page.keyboard.press('Tab');
  assert.equal(await remote.evaluate(el => el.contains(document.activeElement)), true);
  await page.keyboard.press('Escape');
  await remote.waitFor({state: 'detached'});
  await expect(settings).toBeVisible();
  await expect(page.getByTestId('open-remote')).toBeFocused();
  assert.equal(await page.getByTestId('parent-draft').inputValue(), '保留草稿');
  await page.keyboard.press('Escape');
  await settings.waitFor({state: 'detached'});
});

test('model popover stays inside the minimum assistant column', async () => {
  const composer = page.getByTestId('assistant-composer');
  await composer.evaluate(element => {element.parentElement.style.width = '280px';});
  try {
    await composer.getByTestId('assistant-model-settings').click();
    const menu = composer.getByTestId('assistant-model-picker');
    await menu.waitFor();
    const columnBounds = await composer.boundingBox();
    const menuBounds = await menu.boundingBox();
    assert.ok(menuBounds.x >= columnBounds.x && menuBounds.x + menuBounds.width <= columnBounds.x + columnBounds.width,
      `model menu ${JSON.stringify(menuBounds)} exceeds assistant column ${JSON.stringify(columnBounds)}`);
  } finally {
    await page.keyboard.press('Escape');
    await composer.evaluate(element => {element.parentElement.style.width = '360px';});
  }
});

test('modal keyboard navigation includes native disclosure and editing controls and skips unavailable controls', async () => {
  await page.getByTestId('open-focus-dialog').click();
  const panel = page.getByTestId('focus-dialog-panel');
  const close = page.getByTestId('focus-dialog-close');
  try {
    await panel.waitFor();
    await expect(close).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('focus-first')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('focus-summary')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('focus-editor')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByTestId('focus-editor')).toBeFocused();
  } finally {
    await page.keyboard.press('Escape');
    await panel.waitFor({state: 'detached'});
  }
});

test('modal initial focus stays in its panel when the preferred element belongs to the background', async () => {
  const opener = page.getByTestId('open-focus-dialog');
  await opener.click();
  const panel = page.getByTestId('focus-dialog-panel');
  try {
    await panel.waitFor();
    await panel.evaluate(element => window.focusDialogInitialElement(element, document.querySelector('[data-testid="open-focus-dialog"]')));
    assert.equal(await panel.evaluate(element => element.contains(document.activeElement)), true,
      'an out-of-panel preferred element cannot take initial focus');
  } finally {
    await page.keyboard.press('Escape');
    await panel.waitFor({state: 'detached'});
  }
});

test('modal closing preserves the opener list scroll position', async () => {
  const opener = page.getByTestId('open-focus-dialog');
  await opener.click();
  const panel = page.getByTestId('focus-dialog-panel');
  await panel.waitFor();
  await page.getByTestId('opener-scroll').evaluate(element => {element.scrollTop = 0;});
  await page.keyboard.press('Escape');
  await panel.waitFor({state: 'detached'});
  await expect(opener).toBeFocused();
  assert.equal(await page.getByTestId('opener-scroll').evaluate(element => element.scrollTop), 0,
    'returning focus does not scroll the underlying list');
});

test('search clear button keeps native Enter behavior without opening a result', async () => {
  await page.evaluate(() => {window.searchOpened = []; window.setSearchQuery('result'); window.setSearchOpen(true);});
  const panel = page.getByTestId('search-palette-panel');
  try {
    await panel.getByRole('button', {name: '清空', exact: true}).focus();
    await page.keyboard.press('Enter');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('search-palette-input')).toHaveValue('');
    assert.deepEqual(await page.evaluate(() => window.searchOpened), []);
  } finally {
    await page.evaluate(() => window.setSearchOpen(false));
    await panel.waitFor({state: 'detached'});
  }
});

test('search ignores CJK confirmation and never activates hidden results for an empty query', async () => {
  await page.evaluate(() => {window.searchOpened = []; window.setSearchQuery('result'); window.setSearchOpen(true);});
  const panel = page.getByTestId('search-palette-panel');
  const input = page.getByTestId('search-palette-input');
  try {
    await input.evaluate(element => {
      element.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}));
      element.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', isComposing: true, bubbles: true}));
      element.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true, data: '词'}));
      element.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
    });
    assert.deepEqual(await page.evaluate(() => window.searchOpened), []);
    await expect(panel).toBeVisible();
    await input.fill('  ');
    await input.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.searchOpened), []);
    await expect(panel).toBeVisible();
    await input.fill('result');
    await input.press('Enter');
    await expect.poll(() => page.evaluate(() => window.searchOpened)).toEqual([1]);
    await panel.waitFor({state: 'detached'});
  } finally {
    await page.evaluate(() => window.setSearchOpen(false));
    await panel.waitFor({state: 'detached'});
  }
});

test('search keyboard selection scrolls into view, resets after filtering and retains input focus', async () => {
  await page.evaluate(() => {window.searchOpened = []; window.setSearchQuery('result'); window.setSearchOpen(true);});
  const panel = page.getByTestId('search-palette-panel');
  const input = page.getByTestId('search-palette-input');
  try {
    for (let index = 0; index < 16; index++) await input.press('ArrowDown');
    const selected = panel.getByRole('option', {selected: true});
    await expect(selected).toHaveAttribute('data-testid', 'search-item-result-17');
    const bounds = await selected.evaluate(element => {
      const row = element.getBoundingClientRect();
      const list = element.closest('[role="listbox"]').getBoundingClientRect();
      return {top: row.top, bottom: row.bottom, listTop: list.top, listBottom: list.bottom};
    });
    assert.ok(bounds.top >= bounds.listTop && bounds.bottom <= bounds.listBottom, JSON.stringify(bounds));
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute('aria-activedescendant', await selected.getAttribute('id'));
    await input.fill('result-2');
    await expect(selected).toHaveAttribute('data-testid', 'search-item-result-2');
    await input.press('ArrowUp');
    await expect(selected).toHaveAttribute('data-testid', 'search-item-result-24');
    await input.press('ArrowDown');
    await expect(selected).toHaveAttribute('data-testid', 'search-item-result-2');
  } finally {
    await page.evaluate(() => window.setSearchOpen(false));
    await panel.waitFor({state: 'detached'});
  }
});

test('canvas tabs move physical focus with arrows, Home and End without handling action-button keys', async () => {
  const literature = page.getByTestId('canvas-tab-literature');
  const latex = page.getByTestId('canvas-tab-latex');
  const terminal = page.getByTestId('canvas-tab-terminal');
  await literature.focus();
  await page.keyboard.press('ArrowRight');
  await expect(latex).toBeFocused();
  await expect(latex).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(terminal).toBeFocused();
  await page.keyboard.press('Home');
  await expect(literature).toBeFocused();
  await page.getByTestId('canvas-action').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('canvas-action')).toBeFocused();
  await expect(literature).toHaveAttribute('aria-selected', 'true');
});

test('project save freezes submitted fields and closing until the request settles', async () => {
  await page.evaluate(() => {
    window.projectSubmissions = []; window.projectCancels = 0;
    window.setProjectPending(false); window.setProjectOpen(true);
  });
  const panel = page.getByTestId('portal-create-dialog-panel');
  try {
    await page.getByTestId('project-form-title').fill('研究项目');
    await page.getByTestId('project-form-description').fill('研究目标');
    await page.getByTestId('project-form-pick-workspace').click();
    await expect(page.getByTestId('project-form-workspace')).toHaveAttribute('title', '/research/workspace');
    await page.getByTestId('project-form-submit').click();
    await expect(page.getByTestId('project-form-title')).toBeDisabled();
    await expect(page.getByTestId('project-form-description')).toBeDisabled();
    await expect(page.getByTestId('project-form-language-en')).toBeDisabled();
    await expect(page.getByTestId('project-form-pick-workspace')).toBeDisabled();
    await expect(page.getByTestId('project-form-cancel')).toBeDisabled();
    await panel.locator('form').evaluate(form => form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
    assert.equal(await page.evaluate(() => window.projectSubmissions.length), 1);
    await page.getByTestId('portal-create-dialog-close').click();
    await page.keyboard.press('Escape');
    await expect(panel).toBeVisible();
    assert.equal(await page.evaluate(() => window.projectCancels), 0);
    await page.evaluate(() => window.setProjectPending(false));
    await expect(page.getByTestId('project-form-title')).toBeEnabled();
    await page.keyboard.press('Escape');
    await panel.waitFor({state: 'detached'});
    assert.equal(await page.evaluate(() => window.projectCancels), 1);
  } finally {
    await page.evaluate(() => {window.setProjectPending(false); window.setProjectOpen(false);});
    await panel.waitFor({state: 'detached'});
  }
});

test('project language uses radio keyboard navigation and a stale native selection cannot enter a new draft', async () => {
  await page.evaluate(() => {window.setProjectPending(false); window.setProjectOpen(true); window.deferWorkspacePick = true;});
  const panel = page.getByTestId('portal-create-dialog-panel');
  try {
    await page.getByTestId('project-form-language-zh').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('project-form-language-en')).toBeFocused();
    await expect(page.getByTestId('project-form-language-en')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('project-form-pick-workspace').click();
    await expect.poll(() => page.evaluate(() => typeof window.finishWorkspacePick)).toBe('function');
    // A project navigation can unmount/close the owner even while a native panel is pending.
    await page.evaluate(() => window.setProjectOpen(false));
    await panel.waitFor({state: 'detached'});
    await page.evaluate(() => window.setProjectOpen(true));
    await panel.waitFor();
    await page.evaluate(() => {window.finishWorkspacePick({status: 'picked', path: '/stale/workspace'});});
    await expect(page.getByTestId('project-form-workspace')).toHaveAttribute('title', '');
    await expect(page.getByTestId('project-form-pick-workspace')).toBeEnabled();
  } finally {
    await page.evaluate(() => {window.deferWorkspacePick = false; window.setProjectOpen(false);});
    await panel.waitFor({state: 'detached'});
  }
});
