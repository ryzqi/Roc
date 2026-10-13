export async function clickSmokeControl(page, selector) {
  const target = page.locator(selector);
  await target.waitFor({ state: 'attached', timeout: 5000 });
  await target.evaluate((element) => {
    element.click();
  });
}

/**
 * 项目服务视图（tasks-board、git、terminal 等）不渲染 research 壳，而且视图会写进 URL 跨 reload 保留。
 * 停在服务视图时先回 research，否则等壳或找助手入口都会落空。
 */
async function ensureResearchView(page) {
  if ((await page.locator('[data-testid="research-app-shell"]').count()) === 0) {
    await page.evaluate(async () => {
      const result = await window.roc.app.openMainPage('research');
      if (!result.ok) {
        throw new Error(result.error.message);
      }
    });
  }
}

/**
 * 'chat' 等项目服务视图在没有选中项目时会被解析回 research，所以先确保进入项目态。
 */
async function ensureProjectState(page) {
  await ensureResearchView(page);
  await page.waitForSelector('[data-testid="research-app-shell"]', { timeout: 5000 });
  const shellState = await page.locator('[data-testid="research-app-shell"]').getAttribute('data-shell-state');
  if (shellState !== 'project') {
    const projectCard = page.locator('.research-project-card').first();
    await projectCard.waitFor({ state: 'visible', timeout: 5000 });
    await projectCard.click();
  }
  await page.locator('[data-testid="research-app-shell"][data-shell-state="project"]').waitFor({ state: 'visible', timeout: 5000 });
}

export async function openChatView(page) {
  // 要的是 chat 主视图，不是 research 上的助手叠层：工作台导轨（.rail-button）只在 activeView === 'chat' 时渲染。
  await ensureProjectState(page);
  await page.evaluate(async () => {
    const result = await window.roc.app.openMainPage('chat');
    if (!result.ok) {
      throw new Error(result.error.message);
    }
  });
  await page.waitForSelector('[data-testid="chat-view"]', { timeout: 5000 });
}

export async function openResearchService(page, serviceId) {
  await ensureProjectState(page);
  await page.evaluate(async (targetServiceId) => {
    const result = await window.roc.app.openMainPage(targetServiceId === 'tasks' ? 'tasks-board' : targetServiceId);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
  }, serviceId);
}

export async function clickComposerPopoverChoice(page, triggerSelector, choiceSelector) {
  await page.hover(triggerSelector);
  await page.waitForSelector(choiceSelector, { timeout: 5000 });
  await clickSmokeControl(page, choiceSelector);
}

export async function hoverComposerPopoverContent(page, triggerSelector, popoverSelector) {
  await page.hover(triggerSelector);
  await page.waitForSelector(popoverSelector, { timeout: 5000 });
  const popover = page.locator(popoverSelector);
  const box = await popover.boundingBox();
  if (box === null) {
    throw new Error(`Smoke could not measure popover: ${popoverSelector}`);
  }
  await page.mouse.move(box.x + Math.min(28, box.width / 2), box.y + Math.min(28, box.height / 2), { steps: 12 });
  await popover.waitFor({ state: 'visible', timeout: 5000 });
}
