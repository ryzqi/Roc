import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import electronPath from 'electron';
import { _electron, expect } from '@playwright/test';
import { buildViteRenderer } from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
const errors = [];
const artifacts = join(process.cwd(), '.artifacts/desktop-action-guards');
const clipSource = await readFile('.agents/skills/desktop-agent-ui/scripts/clip-audit.js', 'utf8');
const receipts = [];

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-desktop-action-guards-'));
  await mkdir(artifacts, { recursive: true });
  await buildViteRenderer({directory, style: 'html,body,#root{height:100%;margin:0}', script: `
    import React, {useRef, useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion, domMax, MotionConfig} from 'motion/react';
    import {GitBranchSwitcher} from './src/renderer/canvas/git/GitBranchSwitcher';
    import {RagStudio} from './src/renderer/literature/RagStudio';
    import {WorkspaceScopeProvider} from './src/renderer/app/workspace-scope';
    import {ChatApprovalCard, TaskApprovalCard} from './src/renderer/assistant/blocks/approval-cards';
    import {ChatTranscriptPanel} from './src/renderer/assistant/transcript-panel';
    const ok = data => ({ok: true, data});
    const client = {api: {
      shell: {confirm: request => {
        window.confirmRequests.push(request);
        if (window.throwConfirm) throw new Error('Native dialog unavailable');
        return new Promise(resolve => {window.finishConfirm = resolve;});
      }},
      research: {
        getIndexStatus: async () => ({ok: false, error: {message: 'Index not configured'}}),
        listIndexedFiles: async () => ok([]), listIndexJobs: async () => ok([]),
        knowledgeJobs: async () => ok([]),
        searchKnowledge: request => {
          window.searchRequests.push(request);
          if (window.throwSearch) throw new Error('Search bridge disconnected');
          return new Promise(resolve => {window.finishSearch = resolve;});
        }
      }
    }};
    const literature = {client, projectId: 'project-a', status: 'ready', items: [],
      action: {error: null, pending: false}, clearActionError: () => {}};
    const scope = {client, projectId: 'project-a', writable: true, openSettings: () => {}};
    function BranchHarness() {
      const [workspacePath, setWorkspacePath] = useState('/research');
      window.setBranchWorkspace = setWorkspacePath;
      return <GitBranchSwitcher client={client} workspacePath={workspacePath} currentBranch="main"
        branchInfo={{branches: [{name: 'main', current: true}, {name: 'feature', current: false}]}}
        writable busy={false} onClose={() => {window.branchClosed++;}}
        onCheckoutBranch={async name => {window.branchMutations.push({name}); return true;}}
        onCreateBranch={async (name, checkout) => {window.branchMutations.push({name, checkout}); return true;}} />;
    }
    function RagHarness() {
      const [projectId, setProjectId] = useState('project-a');
      window.setRagProject = setProjectId;
      return <WorkspaceScopeProvider value={{...scope, projectId}}>
        <RagStudio literature={{...literature, projectId}} openInFilesView={() => {}} onOpenInReader={() => {}} />
      </WorkspaceScopeProvider>;
    }
    function ApprovalHarness() {
      const [active, setActive] = useState(false);
      window.setApprovalActive = setActive;
      const approval = name => ({kind: 'approval', interruptId: name, actionRequests: [{name, args: {goal: 'Review draft'}}],
        reviewConfigs: [{actionName: name, allowedDecisions: ['approve', 'reject', 'edit']}]});
      const decide = active ? (id, decisions) => window.decisions.push({id, decisions}) : undefined;
      return <div style={{width: 340}}>
        <ChatApprovalCard approval={approval('write_file')} onApprovalDecision={decide} />
        <TaskApprovalCard approval={approval('update_background_task')} onApprovalDecision={decide} />
      </div>;
    }
    const messages = Array.from({length: 120}, (_, index) => ({key: 'message-' + index, source: 'persisted', role: 'user',
      content: 'Research note ' + index, reasoning: null, blocks: [], interrupts: [], isStreaming: false}));
    function TranscriptHarness() {
      const scrollRef = useRef(null);
      return <div style={{height: 360, width: 420, overflow: 'hidden', position: 'relative'}}>
        <div data-testid="scroll-parent" ref={scrollRef}
          style={{height: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column', position: 'relative'}}>
          <ChatTranscriptPanel threadId="thread-a" messages={messages} prependRevision={0} trimRevision={0}
            windowEpoch={0} tailTrimmed={false} hasMoreBefore={false} loadingOlder={false}
            loadOlder={async () => {}} onJumpToLatest={async () => {}} scrollContainerRef={scrollRef}
            onOpenArtifact={() => {}} onReadGateContext={async () => ({ok: false, error: {message: 'Unavailable'}})} />
        </div>
      </div>;
    }
    const root = createRoot(document.getElementById('root'));
    window.mount = mode => {
      window.confirmRequests = []; window.branchMutations = []; window.branchClosed = 0;
      window.searchRequests = []; window.decisions = []; window.throwConfirm = false; window.throwSearch = false;
      const child = mode === 'branch' ? <BranchHarness /> : mode === 'approval' ? <ApprovalHarness /> :
        mode === 'rag' ? <RagHarness /> : <TranscriptHarness />;
      flushSync(() => root.render(<MotionConfig reducedMotion="always"><LazyMotion features={domMax} strict>
        <main key={mode} style={{padding: 64, height: '100%', boxSizing: 'border-box'}}>{child}</main>
      </LazyMotion></MotionConfig>));
    };
    window.mount('branch');
  `});
  await writeFile(join(directory, 'main.cjs'), `
    const {app, BrowserWindow} = require('electron');
    app.setPath('userData', ${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(() => new BrowserWindow({show: false, width: 1000, height: 800})
      .loadFile(${JSON.stringify(join(directory, 'index.html'))}));
  `);
  app = await _electron.launch({ executablePath: electronPath, args: [join(directory, 'main.cjs')] });
  page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('git-branch-controls').waitFor();
});

after(async () => {
  await writeFile(join(artifacts, 'clip-receipts.json'), JSON.stringify(receipts, null, 2));
  try { await app?.close(); } finally { if (directory) await rm(directory, {recursive: true, force: true}); }
  assert.deepEqual(errors, []);
});

async function composedEnter(testId) {
  return page.getByTestId(testId).evaluate(input => {
    input.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}));
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', isComposing: true, bubbles: true, cancelable: true}));
    input.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true}));
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
  });
}

test('Git branch creation ignores IME confirmation and freezes the confirmed draft until the native decision', async () => {
  await page.evaluate(() => window.mount('branch'));
  const input = page.getByTestId('git-branch-create-input');
  await input.fill('研究分支');
  await composedEnter('git-branch-create-input');
  assert.equal(await page.evaluate(() => window.confirmRequests.length), 0);
  await input.press('Enter');
  await expect(input).toBeDisabled();
  await expect(page.getByTestId('git-branch-create-checkout')).toBeDisabled();
  await expect(page.getByTestId('git-branch-close')).toBeDisabled();
  await page.evaluate(() => window.finishConfirm({ok: true, data: {confirmed: true}}));
  await page.waitForFunction(() => window.branchClosed === 1);
  assert.deepEqual(await page.evaluate(() => window.branchMutations), [{name: '研究分支', checkout: true}]);
});

test('native branch confirmation failures remain visible and allow another decision', async () => {
  await page.evaluate(() => {window.mount('branch'); window.throwConfirm = true;});
  await page.getByTestId('git-branch-option-feature').click();
  await expect(page.getByRole('alert')).toContainText('Native dialog unavailable');
  await expect(page.getByTestId('git-branch-option-feature')).toBeEnabled();
  assert.deepEqual(await page.evaluate(() => window.branchMutations), []);
  await page.evaluate(() => {window.throwConfirm = false;});
  await page.getByTestId('git-branch-option-feature').click();
  await page.evaluate(() => window.finishConfirm({ok: false, error: {message: 'Native bridge disconnected'}}));
  await expect(page.getByRole('alert')).toContainText('Native bridge disconnected');
  await page.getByTestId('git-branch-option-feature').click();
  await page.evaluate(() => window.finishConfirm({ok: true, data: {confirmed: false}}));
  await expect(page.getByTestId('git-branch-option-feature')).toBeEnabled();
  assert.deepEqual(await page.evaluate(() => window.branchMutations), []);
  assert.equal(await page.evaluate(() => window.branchClosed), 0);
});

test('a native decision from the previous workspace cannot mutate the new workspace', async () => {
  await page.evaluate(() => window.mount('branch'));
  await page.getByTestId('git-branch-create-input').fill('old-workspace-branch');
  await page.getByTestId('git-branch-create').click();
  await expect(page.getByTestId('git-branch-create-input')).toBeDisabled();
  await page.evaluate(() => window.setBranchWorkspace('/different-research'));
  await expect(page.getByTestId('git-branch-create-input')).toHaveValue('');
  await page.evaluate(async () => {
    window.finishConfirm({ok: true, data: {confirmed: true}});
    await new Promise(resolve => requestAnimationFrame(resolve));
  });
  assert.deepEqual(await page.evaluate(() => window.branchMutations), []);
  assert.equal(await page.evaluate(() => window.branchClosed), 0);
});

test('historical and resuming approvals disable decisions and retain neutral approve/reject emphasis', async () => {
  await page.evaluate(() => window.mount('approval'));
  const ids = ['assistant-approval-approve', 'assistant-approval-reject', 'assistant-approval-edit',
    'assistant-task-approval-approve', 'assistant-task-approval-reject'];
  for (const id of ids) await expect(page.getByTestId(id)).toBeDisabled();
  await page.evaluate(() => window.setApprovalActive(true));
  await page.getByTestId('assistant-approval-approve').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.decisions.length), 1);
  await page.evaluate(() => window.setApprovalActive(false));
  for (const id of ids) await expect(page.getByTestId(id)).toBeDisabled();
  assert.equal(await page.getByTestId(ids[0]).getAttribute('class'), await page.getByTestId(ids[1]).getAttribute('class'));
});

test('RAG search ignores IME confirmation and refuses duplicate Enter while the request is pending', async () => {
  await page.evaluate(() => window.mount('rag'));
  const input = page.getByTestId('rag-query');
  await input.fill('实验结果');
  await composedEnter('rag-query');
  assert.equal(await page.evaluate(() => window.searchRequests.length), 0);
  await input.press('Enter');
  await expect(page.getByTestId('rag-search')).toBeDisabled();
  await input.press('Enter');
  assert.equal(await page.evaluate(() => window.searchRequests.length), 1);
  await page.evaluate(() => window.finishSearch({ok: false, error: {message: 'Search service unavailable'}}));
  await expect(page.getByRole('alert').filter({hasText: 'Search service unavailable'})).toBeVisible();
  await expect(page.getByTestId('rag-search')).toBeEnabled();
  await page.evaluate(() => {window.throwSearch = true;});
  await input.press('Enter');
  await expect(page.getByTestId('rag-search-error')).toContainText('Search bridge disconnected');
  await expect(page.getByTestId('rag-search')).toBeEnabled();
});

test('a RAG response from the previous project cannot display errors in the new project', async () => {
  await page.evaluate(() => window.mount('rag'));
  await page.getByTestId('rag-query').fill('Project A only');
  await page.getByTestId('rag-search').click();
  await expect(page.getByTestId('rag-search')).toBeDisabled();
  await page.evaluate(() => window.setRagProject('project-b'));
  await expect(page.getByTestId('rag-query')).toHaveValue('');
  await page.evaluate(async () => {
    window.finishSearch({ok: false, error: {message: 'Old project request failed'}});
    await new Promise(resolve => requestAnimationFrame(resolve));
  });
  await expect(page.getByTestId('rag-search-error')).toHaveCount(0);
  await expect(page.getByTestId('rag-search')).toBeDisabled();
});

test('the transcript latest button has complete shadows after a real wheel scroll in both themes', async () => {
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => {document.documentElement.dataset.theme = theme; window.mount('transcript');}, theme);
    const scroll = page.getByTestId('scroll-parent');
    await page.waitForFunction(() => document.querySelector('[data-testid="scroll-parent"]').scrollTop > 0);
    await scroll.hover();
    await page.mouse.wheel(0, -900);
    await page.getByTestId('assistant-scroll-bottom').waitFor();
    await page.getByTestId('assistant-scroll-bottom').hover();
    const result = await page.evaluate(`(${clipSource})({viewport:true})`);
    receipts.push({theme, ...result});
    assert.equal(result.cut, 0, JSON.stringify(result.issues));
    await page.screenshot({path: join(artifacts, `${theme}-latest-button.png`)});
    await page.getByTestId('assistant-scroll-bottom').click();
    await expect(page.getByTestId('assistant-scroll-bottom')).toHaveCount(0);
  }
});
