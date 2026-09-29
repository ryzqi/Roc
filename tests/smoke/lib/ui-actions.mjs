export async function clickSmokeControl(page, selector) {
  const target = page.locator(selector);
  await target.waitFor({ state: 'attached', timeout: 5000 });
  await target.evaluate((element) => {
    element.click();
  });
}

export async function openChatView(page) {
  const assistant = page.locator('[data-testid="research-shell-assistant"]');
  if ((await assistant.count()) > 0) {
    await clickSmokeControl(page, '[data-testid="research-shell-assistant"]');
  } else {
    const card = page.locator('[data-testid^="research-shell-project-"]').first();
    if ((await card.count()) > 0) {
      await card.click();
      await page.waitForSelector('[data-testid="research-shell-assistant"]', { timeout: 5000 });
      await clickSmokeControl(page, '[data-testid="research-shell-assistant"]');
    } else {
      await clickSmokeControl(page, '[data-testid="chat-new-conversation"]');
    }
  }
  await page.waitForSelector('[data-testid="chat-view"]', { timeout: 5000 });
}

export async function openResearchService(page, serviceId) {
  await page.waitForSelector('[data-testid="research-app-shell"]', { timeout: 5000 });
  const shellState = await page.locator('[data-testid="research-app-shell"]').getAttribute('data-shell-state');
  if (shellState !== 'project') {
    const projectCard = page.locator('.research-project-card').first();
    await projectCard.waitFor({ state: 'visible', timeout: 5000 });
    await projectCard.click();
  }
  await page.locator('[data-testid="research-app-shell"][data-shell-state="project"]').waitFor({ state: 'visible', timeout: 5000 });
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
