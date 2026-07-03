import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitForTerminalSessionReady } from './assertions.mjs';
import { readMainPageText } from './ipc.mjs';

export async function runSmokeWorkbenchGitTerminalChecks(ctx) {
  const { page, workspaceRoot } = ctx;
  await page.click('.workbench-tab[data-tool-button="git"]');
  await page.waitForSelector('[data-testid="workbench-git-changes"]', { timeout: 5000 });
  const workbenchGitText = await page.textContent('[data-testid="workbench-git-changes"]');
  const gitCommitButtonCount = await page.locator('[data-testid="workbench-git-commit"]').count();
  const gitCommitMessageCount = await page.locator('[data-testid="workbench-git-commit-message"]').count();
  const gitRefreshPrimaryCount = await page.locator('[aria-label="刷新 Git 状态"]').count();
  const gitBatchStageCount = await page.locator('[data-testid="git-stage-selected"]').count();
  const gitSplitCount = await page.locator('.workbench-git--split').count();
  const gitSidebarCount = await page.locator('.git-sidebar').count();
  const gitDetailPaneCount = await page.locator('.git-detail-pane').count();
  const gitChangeActionCount = await page.locator('.git-change-actions button').count();
  const gitCommitInitialState = await page.evaluate(() => {
    const button = document.querySelector('[data-testid="workbench-git-commit"]');
    const message = document.querySelector('[data-testid="workbench-git-commit-message"]');
    if (!(button instanceof HTMLButtonElement) || !(message instanceof HTMLTextAreaElement)) {
      return null;
    }
    return {
      className: button.className,
      disabled: button.disabled,
      value: message.value
    };
  });
  const initialGitBranch = await page.textContent('[data-testid="git-current-branch"]');
  const gitHeaderEvidence = await page.evaluate(() => ({
    splitColumns: document.querySelector('.workbench-git--split') instanceof HTMLElement ? getComputedStyle(document.querySelector('.workbench-git--split')).gridTemplateColumns : ''
  }));
  await page.click('[data-testid="git-select-phase-three-notes.txt"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="workbench-git-selection-path"]')?.textContent?.includes('phase-three-notes.txt') === true,
    { timeout: 5000 }
  );
  await page.waitForFunction(() => document.querySelector('[data-testid="git-select-phase-three-notes.txt"]')?.getAttribute('aria-pressed') === 'true');
  const workbenchGitSelectionText = await page.textContent('[data-testid="workbench-git-selection"]');
  const workbenchGitSelectionPath = await page.textContent('[data-testid="workbench-git-selection-path"]');
  const workbenchGitSelectionActionCountBeforeStage = await page.locator('[data-testid="workbench-git-selection"] button').count();
  const gitDiffScrollEvidenceBefore = await page.evaluate(() => {
    const scroll = document.querySelector('.git-diff-scroll');
    const toolbar = document.querySelector('.git-diff-toolbar');
    if (!(scroll instanceof HTMLElement)) {
      return {
        exists: false,
        clientHeight: null,
        scrollHeight: null,
        scrollTop: null,
        overflowX: null,
        overflowY: null,
        toolbarText: toolbar?.textContent ?? ''
      };
    }
    const style = getComputedStyle(scroll);
    return {
      exists: true,
      clientHeight: scroll.clientHeight,
      scrollHeight: scroll.scrollHeight,
      scrollTop: scroll.scrollTop,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      toolbarText: toolbar?.textContent ?? ''
    };
  });
  await page.evaluate(() => {
    const scroll = document.querySelector('.git-diff-scroll');
    if (scroll instanceof HTMLElement) {
      scroll.scrollTop = Math.min(scroll.scrollHeight - scroll.clientHeight, 160);
    }
  });
  const gitDiffScrollEvidenceAfter = await page.evaluate(() => {
    const scroll = document.querySelector('.git-diff-scroll');
    if (!(scroll instanceof HTMLElement)) {
      return {
        exists: false,
        clientHeight: null,
        scrollHeight: null,
        scrollTop: null
      };
    }
    return {
      exists: true,
      clientHeight: scroll.clientHeight,
      scrollHeight: scroll.scrollHeight,
      scrollTop: scroll.scrollTop
    };
  });
  await page.click('[data-testid="git-select-toggle-phase-three-notes.txt"]');
  await page.click('[data-testid="git-select-toggle-batch-stage.txt"]');
  await page.waitForFunction(() => {
    const text = document.querySelector('[data-testid="git-selected-count"]')?.textContent ?? '';
    return text.includes('2 selected');
  });
  const workbenchGitSelectedCountAfterManual = await page.textContent('[data-testid="git-selected-count"]');
  const workbenchGitSelectionActionCountAfterManual = await page.locator('[data-testid="workbench-git-selection"] button').count();
  await page.click('[data-testid="git-clear-selection"]');
  await page.waitForFunction(() => {
    const selectedCount = document.querySelector('[data-testid="git-selected-count"]')?.textContent ?? '';
    return selectedCount.includes('0 selected');
  });
  await page.click('[data-testid="git-select-all"]');
  await page.waitForFunction(() => {
    const noteToggle = document.querySelector('[data-testid="git-select-toggle-phase-three-notes.txt"]');
    const batchToggle = document.querySelector('[data-testid="git-select-toggle-batch-stage.txt"]');
    const selectedCount = document.querySelector('[data-testid="git-selected-count"]')?.textContent ?? '';
    return (
      noteToggle instanceof HTMLInputElement &&
      batchToggle instanceof HTMLInputElement &&
      noteToggle.checked &&
      batchToggle.checked &&
      selectedCount.includes('2 selected')
    );
  });
  const workbenchGitSelectedCountAfterAll = await page.textContent('[data-testid="git-selected-count"]');
  await page.click('[data-testid="git-stage-selected"]');
  try {
    await page.waitForFunction(() => {
      const changes = document.querySelector('[data-testid="workbench-git-changes"]')?.textContent ?? '';
      const detail = document.querySelector('[data-testid="workbench-git-selection"]')?.textContent ?? '';
      const selectedCount = document.querySelector('[data-testid="git-selected-count"]')?.textContent ?? '';
      return (
        changes.includes('待提交变更2') &&
        changes.includes('batch-stage.txt已暂存') &&
        changes.includes('phase-three-notes.txt已暂存') &&
        changes.includes('工作区变更0') &&
        detail.includes('已暂存') &&
        selectedCount.includes('2 selected')
      );
    });
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      changes: document.querySelector('[data-testid="workbench-git-changes"]')?.textContent ?? '',
      detail: document.querySelector('[data-testid="workbench-git-selection"]')?.textContent ?? '',
      selectedCount: document.querySelector('[data-testid="git-selected-count"]')?.textContent ?? ''
    }));
    throw new Error(`Git batch stage wait failed: ${JSON.stringify(diagnostic)}`, { cause: error });
  }
  const workbenchGitAfterBatchStage = await page.textContent('[data-testid="workbench-git-changes"]');
  const workbenchGitSelectionAfterStage = await page.textContent('[data-testid="workbench-git-selection"]');
  const workbenchGitSelectionActionCountAfterStage = await page.locator('[data-testid="workbench-git-selection"] button').count();
  await page.click('[data-testid="git-current-branch"]');
  await page.waitForSelector('[data-testid="git-branch-controls"]', { timeout: 5000 });
  const gitBranchSelectCount = await page.locator('[data-testid="git-branch-select"]').count();
  await page.fill('[data-testid="git-branch-create-input"]', 'feature/smoke-branch');
  await page.click('[data-testid="git-branch-create"]');
  await page.waitForFunction(() => {
    const branch = document.querySelector('[data-testid="git-current-branch"]')?.textContent ?? '';
    return branch.includes('feature/smoke-branch');
  });
  const gitCurrentBranchAfterCreate = await page.textContent('[data-testid="git-current-branch"]');
  await page.fill('[data-testid="git-branch-select"]', initialGitBranch?.trim() ?? 'master');
  await page.locator('.git-branch-option', { hasText: initialGitBranch?.trim() ?? 'master' }).click();
  await page.waitForFunction(
    (expectedBranch) => {
      const branch = document.querySelector('[data-testid="git-current-branch"]')?.textContent ?? '';
      return branch.includes(expectedBranch);
    },
    initialGitBranch?.trim() ?? 'master'
  );
  const gitCurrentBranchAfterCheckout = await page.textContent('[data-testid="git-current-branch"]');
  const confirmMessages = await page.evaluate(() => globalThis.__rocConfirmMessages ?? []);
  writeFileSync(join(workspaceRoot, 'phase-three-notes.txt'), 'phase three smoke workspace\nchanged after commit\n', 'utf8');
  await page.click('[aria-label="刷新 Git 状态"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="workbench-git-changes"]')?.textContent?.includes('phase-three-notes.txt') === true);
  await page.click('[data-testid="git-select-phase-three-notes.txt"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="git-select-phase-three-notes.txt"]')?.getAttribute('aria-pressed') === 'true');
  await page.click('[data-testid="git-stage-selected"]');
  await page.waitForFunction(() => {
    const changes = document.querySelector('[data-testid="workbench-git-changes"]')?.textContent ?? '';
    const selectedCount = document.querySelector('[data-testid="git-selected-count"]')?.textContent ?? '';
    return changes.includes('phase-three-notes.txt') && selectedCount.includes('2 selected');
  });
  await page.fill('[data-testid="workbench-git-commit-message"]', 'smoke commit');
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="workbench-git-commit"]');
    if (!(button instanceof HTMLButtonElement)) {
      return false;
    }
    return button.disabled === false && button.classList.contains('git-commit-button--ready');
  });
  const gitCommitReadyState = await page.evaluate(() => {
    const button = document.querySelector('[data-testid="workbench-git-commit"]');
    if (!(button instanceof HTMLButtonElement)) {
      return null;
    }
    return {
      className: button.className,
      disabled: button.disabled
    };
  });
  await page.click('[data-testid="workbench-git-commit"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="workbench-git-changes"]')?.textContent?.includes('工作区干净。') === true);
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="workbench-git-commit"]');
    const message = document.querySelector('[data-testid="workbench-git-commit-message"]');
    if (!(button instanceof HTMLButtonElement) || !(message instanceof HTMLTextAreaElement)) {
      return false;
    }
    return button.disabled === true && !button.classList.contains('git-commit-button--ready') && message.value === '';
  });
  const gitLastCommitText = await page.textContent('.git-last-result');
  const gitCommitResetState = await page.evaluate(() => {
    const button = document.querySelector('[data-testid="workbench-git-commit"]');
    const message = document.querySelector('[data-testid="workbench-git-commit-message"]');
    if (!(button instanceof HTMLButtonElement) || !(message instanceof HTMLTextAreaElement)) {
      return null;
    }
    return {
      className: button.className,
      disabled: button.disabled,
      value: message.value
    };
  });
  writeFileSync(join(workspaceRoot, 'phase-three-notes.txt'), 'phase three smoke workspace\nchanged before push\n', 'utf8');
  await page.click('[aria-label="刷新 Git 状态"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="workbench-git-changes"]')?.textContent?.includes('phase-three-notes.txt') === true);
  await page.click('[data-testid="git-select-phase-three-notes.txt"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="git-select-phase-three-notes.txt"]')?.getAttribute('aria-pressed') === 'true');
  await page.click('[data-testid="git-select-toggle-phase-three-notes.txt"]');
  await page.click('[data-testid="git-stage-selected"]');
  await page.waitForFunction(() => {
    const changes = document.querySelector('[data-testid="workbench-git-changes"]')?.textContent ?? '';
    const selectedCount = document.querySelector('[data-testid="git-selected-count"]')?.textContent ?? '';
    return changes.includes('phase-three-notes.txt') && selectedCount.includes('1 selected');
  });
  await page.fill('[data-testid="workbench-git-commit-message"]', 'smoke push commit');
  await page.click('[data-testid="workbench-git-commit"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="workbench-git-changes"]')?.textContent?.includes('工作区干净。') === true);
  const gitLastPushText = await page.textContent('.git-last-result');
  const workbenchNativeConfirmIpcSamples = await page.evaluate(async () => {
    const sample = await window.roc.diagnostics.samplePerformance({
      mode: 'smoke',
      memoryBudgetMb: 300
    });
    if (!sample.ok) {
      throw new Error(sample.error.message);
    }
    return sample.data.timing.samples.filter(
      (item) =>
        item.phase === 'ipc_call' &&
        item.label === 'roc:shell:confirm' &&
        item.metadata?.channel === 'roc:shell:confirm' &&
        item.metadata.ok === true
    );
  });
  await page.evaluate(() => {
    globalThis.__rocSmokeTerminalEvents = [];
    if (typeof globalThis.__rocSmokeTerminalOutputDispose === 'function') {
      globalThis.__rocSmokeTerminalOutputDispose();
    }
    globalThis.__rocSmokeTerminalOutputDispose = window.roc.terminal.onOutput((event) => {
      globalThis.__rocSmokeTerminalEvents.push(event);
    });
  });
  await page.click('.workbench-tab[data-tool-button="terminal"]');
  await page.waitForSelector('[data-testid="terminal-xterm"]', { timeout: 10000 });
  const terminalWorkbenchStyleEvidence = await page.evaluate(() => {
    const frame = document.querySelector('.workbench-surface--terminal');
    const badges = Array.from(document.querySelectorAll('.terminal-badge')).map((element) => element.textContent ?? '');
    const scope = document.querySelector('[data-testid="terminal-session-scope"]')?.textContent ?? '';
    const terminalSubtitle = document.querySelector('.terminal-subtitle')?.textContent ?? '';
    const footerSegments = Array.from(document.querySelectorAll('.terminal-status-bar span')).map((element) => element.textContent?.trim() ?? '');
    const header = document.querySelector('.terminal-header');
    const xtermShell = document.querySelector('.terminal-xterm-host');
    const workbenchTerminal = document.querySelector('.workbench-terminal');
    if (!(frame instanceof HTMLElement)) {
      return {
        frameVisible: false,
        badgeCount: badges.length,
        scope,
        terminalSubtitle,
        footerSegments,
        headerExists: header !== null,
        xtermShellExists: xtermShell !== null,
        shellFillRatio: null,
        borderRadius: '',
        boxShadow: '',
        backgroundColor: ''
      };
    }
    const frameStyle = getComputedStyle(frame);
    const frameBox = frame.getBoundingClientRect();
    const shellBox = xtermShell instanceof HTMLElement ? xtermShell.getBoundingClientRect() : null;
    const workbenchBox = workbenchTerminal instanceof HTMLElement ? workbenchTerminal.getBoundingClientRect() : null;
    return {
      frameVisible: true,
      badgeCount: badges.length,
      scope,
      terminalSubtitle,
      footerSegments,
      headerExists: header !== null,
      xtermShellExists: xtermShell !== null,
      shellFillRatio:
        shellBox === null || workbenchBox === null || workbenchBox.height === 0
          ? null
          : Number(((frameBox.height / workbenchBox.height) * 100).toFixed(2)),
      borderRadius: frameStyle.borderRadius,
      boxShadow: frameStyle.boxShadow,
      backgroundColor: frameStyle.backgroundColor
    };
  });
  await waitForTerminalSessionReady(page);
  await page.waitForFunction(
    () => {
      const sessionId = document.querySelector('[data-testid="terminal-xterm"]')?.getAttribute('data-session-id') ?? '';
      return sessionId.length > 0;
    },
    undefined,
    { timeout: 10000 }
  );
  const terminalSessionId = await page.evaluate(
    () => document.querySelector('[data-testid="terminal-xterm"]')?.getAttribute('data-session-id') ?? null
  );
  if (typeof terminalSessionId !== 'string' || terminalSessionId.length === 0) {
    throw new Error('Smoke could not capture terminal session id from output events.');
  }
  await page.evaluate(async (sessionId) => {
    const result = await window.roc.terminal.writeInput({ sessionId, data: 'dir\rpwd\r' });
    if (!result.ok) {
      throw new Error(`terminal writeInput failed: ${result.error.message}`);
    }
  }, terminalSessionId);
  await page.waitForFunction(
    (workspacePath) => {
      const text = document.querySelector('[data-testid="terminal-xterm"]')?.textContent?.toLowerCase() ?? '';
      return text.includes('phase-three-notes.txt') && text.includes(workspacePath.toLowerCase());
    },
    workspaceRoot,
    { timeout: 10000 }
  );
  const terminalLiveOutput = await page.textContent('[data-testid="terminal-xterm"]');
  const terminalSecondOutput = await page.textContent('[data-testid="terminal-xterm"]');
  await page.evaluate(() => {
    if (typeof globalThis.__rocSmokeTerminalOutputDispose === 'function') {
      globalThis.__rocSmokeTerminalOutputDispose();
      globalThis.__rocSmokeTerminalOutputDispose = null;
    }
  });
  const terminalText = await readMainPageText(page, {
    label: 'terminal',
    pageId: 'terminal',
    viewSelector: '[data-testid="terminal-view"]'
  });
  const previewText = await readMainPageText(page, {
    label: 'preview',
    pageId: 'preview',
    viewSelector: '[data-testid="preview-view"]'
  });
  await page.waitForFunction(() => {
    const text = document.querySelector('[data-testid="preview-view"]')?.textContent ?? '';
    return text.includes('bytes') || text.includes('无可预览文件');
  }, undefined, { timeout: 5000 });
  const previewPageImageEvidence = await page.evaluate(() => {
    const image = document.querySelector('[data-testid="preview-view-image"]');
    return {
      exists: image !== null,
      src: image?.getAttribute('src') ?? ''
    };
  });

  Object.assign(ctx, {
    workbenchGitText,
    gitCommitButtonCount,
    gitCommitMessageCount,
    gitRefreshPrimaryCount,
    gitBatchStageCount,
    gitSplitCount,
    gitSidebarCount,
    gitDetailPaneCount,
    gitChangeActionCount,
    gitCommitInitialState,
    initialGitBranch,
    gitHeaderEvidence,
    workbenchGitSelectionText,
    workbenchGitSelectionPath,
    workbenchGitSelectionActionCountBeforeStage,
    gitDiffScrollEvidenceBefore,
    gitDiffScrollEvidenceAfter,
    workbenchGitSelectedCountAfterManual,
    workbenchGitSelectionActionCountAfterManual,
    workbenchGitSelectedCountAfterAll,
    workbenchGitAfterBatchStage,
    workbenchGitSelectionAfterStage,
    workbenchGitSelectionActionCountAfterStage,
    gitBranchSelectCount,
    gitCurrentBranchAfterCreate,
    gitCurrentBranchAfterCheckout,
    confirmMessages,
    gitCommitReadyState,
    gitLastCommitText,
    gitCommitResetState,
    gitLastPushText,
    workbenchNativeConfirmIpcSamples,
    terminalWorkbenchStyleEvidence,
    terminalLiveOutput,
    terminalSecondOutput,
    terminalText,
    previewText,
    previewPageImageEvidence
  });
}
