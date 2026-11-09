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
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {AssistantComposer} from './src/renderer/assistant/composer';
    import {ResizableDivider} from './src/renderer/shell/ResizableDivider';
    import {ModalShell} from './src/renderer/shell/ModalShell';
    import {ModelPicker} from './src/renderer/assistant/model-picker';
    import {RemoteModelPicker} from './src/renderer/settings/RemoteModelPicker';
    import {RadixSettingsDialogShell} from './src/renderer/settings/radix-dialog-pilot';
    import {LazyMotion, domMax, MotionConfig} from 'motion/react';
    function Harness() {
      const [draft, setDraft] = useState({text: '', attachments: []});
      const [mode, setMode] = useState('chat');
      const [running, setRunning] = useState(false);
      const [sending, setSending] = useState(false);
      const [skills, setSkills] = useState([]);
      const [width, setWidth] = useState(240);
      const [divider, setDivider] = useState(true);
      const [drawerOpen, setDrawerOpen] = useState(false);
      const [settingsOpen, setSettingsOpen] = useState(false);
      const [remoteOpen, setRemoteOpen] = useState(false);
      const remoteClient = {api: {settings: {listRemoteModels: async () => {
        window.remoteFetches++;
        return {ok: true, data: {models: [{id: 'test-model', ownedBy: null}]}};
      }}}};
      window.setDrawerOpen = setDrawerOpen;
      window.setRunning = setRunning;
      window.setSending = setSending;
      window.setSkills = setSkills;
      window.setDivider = setDivider;
      window.setSettingsOpen = setSettingsOpen;
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
          <AssistantComposer mode={mode} onModeChange={setMode} draft={draft} onDraftChange={setDraft}
            skills={skills} imageInputSupported={true} sending={sending} running={running} replyMode={false}
            onSend={async payload => {window.sent.push(payload); return true;}} onStop={() => setRunning(false)}
            model={{choices: [], currentKey: null, label: '选择模型', pending: false, error: null,
              onSelect: () => {}, onOpenSettings: () => {}}} />
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
      </main>;
    }
    const root = createRoot(document.getElementById('root'));
    window.mount = () => {
      window.sent = []; window.resizeCalls = 0; window.dragging = false; window.remoteFetches = 0;
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
