import { waitForTextContent } from './assertions.mjs';
import { readMainPageText } from './ipc.mjs';

export async function runSmokeWorkspaceMemoryChecks(ctx) {
  const { page } = ctx;
  let workspaceText = await readMainPageText(page, {
    label: 'workspace',
    pageId: 'workspace',
    viewSelector: '[data-testid="workspace-view"]'
  });
  try {
    await waitForTextContent(page, '[data-testid="workspace-view"]', '文件操作预览', 15000);
  } catch (error) {
    const workspaceProbe = await page.evaluate(async () => {
      async function probe(label, operation) {
        const startedAt = Date.now();
        try {
          const result = await Promise.race([
            operation(),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), 3000))
          ]);
          return {
            label,
            status: 'resolved',
            elapsedMs: Date.now() - startedAt,
            result
          };
        } catch (probeError) {
          return {
            label,
            status: 'rejected',
            elapsedMs: Date.now() - startedAt,
            error: probeError instanceof Error ? probeError.message : String(probeError)
          };
        }
      }

      const tree = await probe('files.listTree', () => window.roc.files.listTree({ relativePath: '' }));
      const previewTarget =
        tree.status === 'resolved' &&
        tree.result.ok &&
        tree.result.data.entries.find((entry) => entry.type === 'file')?.relativePath;
      const preview =
        previewTarget === undefined
          ? { label: 'files.preview', status: 'skipped', reason: 'no file entry' }
          : await probe('files.preview', () => window.roc.files.preview({ relativePath: previewTarget }));
      const gitStatus = await probe('git.status', () => window.roc.git.status());
      const gitBranches = await probe('git.listBranches', () => window.roc.git.listBranches());

      return {
        tree,
        preview,
        gitStatus,
        gitBranches
      };
    });
    throw new Error(`Workspace lazy load probe: ${JSON.stringify(workspaceProbe, null, 2)}`, { cause: error });
  }
  await page.waitForSelector('[data-testid="file-tree"]', { timeout: 15000 });
  await page.waitForSelector('[data-testid="rtk-panel"]', { timeout: 15000 });
  workspaceText = await page.textContent('[data-testid="workspace-view"]');
  if (workspaceText === null) {
    throw new Error('Smoke could not read workspace view text after lazy load.');
  }
  const rtkPanelText = await page.textContent('[data-testid="rtk-panel"]');
  if (rtkPanelText === null) {
    throw new Error('Smoke could not read RTK panel text.');
  }
  const workspaceApiEvidence = await page.evaluate(async () => {
    const search = await window.roc.files.search({ query: 'phase three', maxResults: 8 });
    const rtk = await window.roc.rtk.status();
    if (!search.ok) {
      throw new Error(search.error.message);
    }
    if (!rtk.ok) {
      throw new Error(rtk.error.message);
    }
    return {
      search: search.data,
      rtk: rtk.data
    };
  });
  await page.click('[data-testid="nav-memory"]');
  await page.waitForSelector('[data-testid="memory-view"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="memory-tab-files"]', { timeout: 5000 });
  await waitForTextContent(page, '[data-testid="memory-view"]', 'USER.md');
  await waitForTextContent(page, '[data-testid="memory-view"]', '会话回顾');
  const memoryText = await page.textContent('[data-testid="memory-view"]');
  if (memoryText === null) {
    throw new Error('Smoke could not read memory view text.');
  }
  const memoryStatusApiEvidence = await page.evaluate(async () => {
    const status = await window.roc.memory.status();
    if (!status.ok) {
      throw new Error(status.error.message);
    }
    return status.data;
  });
  const gitText = await readMainPageText(page, {
    label: 'git',
    pageId: 'git',
    viewSelector: '[data-testid="git-view"]'
  });
  await waitForTextContent(page, '[data-testid="git-view"]', 'phase-three-notes.txt');

  Object.assign(ctx, {
    workspaceText,
    rtkPanelText,
    workspaceApiEvidence,
    memoryText,
    memoryStatusApiEvidence,
    gitText
  });
}
