export async function clickSmokeControl(page, selector) {
  const target = page.locator(selector);
  await target.waitFor({ state: 'attached', timeout: 5000 });
  await target.evaluate((element) => {
    element.click();
  });
}

export async function openChatView(page) {
  const sidebarEntry = page.locator('[data-testid="nav-chat"]');
  if ((await sidebarEntry.count()) > 0) {
    await clickSmokeControl(page, '[data-testid="nav-chat"]');
  } else {
    await clickSmokeControl(page, '[data-testid="chat-new-conversation"]');
  }
  await page.waitForSelector('[data-testid="chat-view"]', { timeout: 5000 });
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

