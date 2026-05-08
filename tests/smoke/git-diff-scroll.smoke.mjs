import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';

const artifactDir = resolve('.artifacts/git-diff-scroll');
mkdirSync(artifactDir, { recursive: true });

const packagedExe = resolve('release/win-unpacked/Roc.exe');
const preferredSmokeTarget = process.env.ROC_SMOKE_TARGET === 'packaged' ? 'packaged' : 'dist';
const distMainPath = resolve('dist/main/index.js');
const smokeTarget =
  preferredSmokeTarget === 'packaged'
    ? existsSync(packagedExe)
      ? {
          executablePath: packagedExe,
          launchArgs: []
        }
      : (() => {
          throw new Error(`Packaged smoke target is unavailable: ${packagedExe}`);
        })()
    : {
        executablePath: undefined,
        launchArgs: [distMainPath]
      };

const dataRoot = await mkdtemp(join(tmpdir(), 'roc-git-diff-smoke-'));
const workspaceRoot = await mkdtemp(join(tmpdir(), 'roc-git-diff-workspace-'));

function runWorkspaceGit(args) {
  const result = spawnSync('git', args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

function buildLongFileContent(prefix, count) {
  return Array.from({ length: count }, (_, index) => `${prefix} line ${String(index + 1).padStart(3, '0')}`).join('\n') + '\n';
}

writeFileSync(join(workspaceRoot, 'long-diff.txt'), buildLongFileContent('before', 220), 'utf8');
runWorkspaceGit(['init']);
runWorkspaceGit(['config', 'user.email', 'roc-smoke@example.test']);
runWorkspaceGit(['config', 'user.name', 'Roc Smoke']);
runWorkspaceGit(['add', 'long-diff.txt']);
runWorkspaceGit(['commit', '-m', 'initial long diff file']);
writeFileSync(join(workspaceRoot, 'long-diff.txt'), buildLongFileContent('after', 260), 'utf8');

async function waitForAppReady(page, label) {
  await page.waitForSelector('[data-testid="roc-app"], .fatal, .boot', { timeout: 15000 });
  if ((await page.locator('.fatal').count()) > 0) {
    const text = await page.textContent('.fatal');
    writeFileSync(join(artifactDir, `fatal-${label}.txt`), text ?? '', 'utf8');
    throw new Error(`Roc renderer fatal during ${label}: ${text}`);
  }
  if ((await page.locator('[data-testid="roc-app"]').count()) === 0) {
    await page.waitForSelector('[data-testid="roc-app"]', { timeout: 15000 });
  }
}

async function selectWorkspace(page, workspacePath) {
  const selectedWorkspace = await page.evaluate(async (targetPath) => {
    const result = await window.roc.workspace.select({ path: targetPath });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.data.path;
  }, workspacePath);
  if (selectedWorkspace !== workspacePath) {
    throw new Error(`Workspace selection mismatch: ${selectedWorkspace}`);
  }
}

let app;
try {
  app = await electron.launch({
    executablePath: smokeTarget.executablePath,
    args: smokeTarget.launchArgs,
    env: {
      ...process.env,
      ROC_SMOKE: '1',
      ROC_DATA_ROOT: dataRoot
    }
  });

  const page = await app.firstWindow();
  await waitForAppReady(page, 'initial');
  await selectWorkspace(page, workspaceRoot);
  await page.reload();
  await waitForAppReady(page, 'after-workspace-select');

  await page.locator('button[data-tool-button="git"]').first().click();
  await page.waitForSelector('[data-testid="workbench-git-changes"]', { timeout: 5000 });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="workbench-git-selection-path"]')?.textContent?.includes('long-diff.txt') === true,
    { timeout: 5000 }
  );
  await page.click('[data-testid="git-select-long-diff.txt"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="workbench-git-selection-path"]')?.textContent?.includes('long-diff.txt') === true);

  const diffLayoutEvidence = await page.evaluate(() => {
    const detailPane = document.querySelector('.git-detail-pane');
    const slot = document.querySelector('.git-selection-slot');
    const panel = document.querySelector('.git-diff-panel');
    const body = document.querySelector('.git-diff-body');
    const scroll = document.querySelector('.git-diff-scroll');
    const diff = document.querySelector('.git-diff-scroll .diff');

    if (
      !(detailPane instanceof HTMLElement) ||
      !(slot instanceof HTMLElement) ||
      !(panel instanceof HTMLElement) ||
      !(body instanceof HTMLElement) ||
      !(scroll instanceof HTMLElement) ||
      !(diff instanceof HTMLElement)
    ) {
      return {
        missing: true
      };
    }

    scroll.scrollTop = scroll.scrollHeight;
    const bodyBox = body.getBoundingClientRect();
    const scrollBox = scroll.getBoundingClientRect();
    const diffBox = diff.getBoundingClientRect();

    return {
      missing: false,
      detailPaneClientHeight: detailPane.clientHeight,
      slotClientHeight: slot.clientHeight,
      slotScrollHeight: slot.scrollHeight,
      panelClientHeight: panel.clientHeight,
      panelScrollHeight: panel.scrollHeight,
      bodyClientHeight: body.clientHeight,
      bodyScrollHeight: body.scrollHeight,
      scrollClientHeight: scroll.clientHeight,
      scrollScrollHeight: scroll.scrollHeight,
      scrollTop: scroll.scrollTop,
      diffBottomVsScrollBottom: Math.round(diffBox.bottom - scrollBox.bottom),
      detailPaneOverflowY: getComputedStyle(detailPane).overflowY,
      slotOverflowY: getComputedStyle(slot).overflowY,
      panelOverflowY: getComputedStyle(panel).overflowY,
      bodyOverflowY: getComputedStyle(body).overflowY,
      scrollOverflowY: getComputedStyle(scroll).overflowY
    };
  });

  writeFileSync(join(artifactDir, 'git-diff-layout-evidence.json'), JSON.stringify(diffLayoutEvidence, null, 2), 'utf8');

  if (diffLayoutEvidence.missing) {
    throw new Error('Git diff layout smoke could not locate required elements.');
  }

  if (diffLayoutEvidence.scrollScrollHeight <= diffLayoutEvidence.scrollClientHeight) {
    throw new Error(`Expected Git diff to overflow vertically, got ${JSON.stringify(diffLayoutEvidence)}`);
  }

  if (diffLayoutEvidence.bodyScrollHeight > diffLayoutEvidence.bodyClientHeight + 2) {
    throw new Error(`Git diff body should not keep its own vertical scroll after fix: ${JSON.stringify(diffLayoutEvidence)}`);
  }

  if (diffLayoutEvidence.diffBottomVsScrollBottom > 3) {
    throw new Error(`Git diff bottom is not reachable by scrolling: ${JSON.stringify(diffLayoutEvidence)}`);
  }
} finally {
  if (app !== undefined) {
    await app.close();
  }
  await rm(dataRoot, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
}
