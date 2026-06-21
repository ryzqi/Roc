import { waitForTextContent } from './assertions.mjs';

export async function runSmokeCapabilityViews(ctx) {
  const { page } = ctx;
  await page.click('[data-testid="nav-mcp"]');
  await page.waitForSelector('[data-testid="mcp-view"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="mcp-management"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="mcp-test-smoke-mcp"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="mcp-toggle-smoke-mcp"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="mcp-delete-smoke-mcp"]', { timeout: 5000 });
  await page.click('[data-testid="mcp-test-smoke-mcp"]');
  await waitForTextContent(page, '[data-testid="mcp-management"]', 'smoke-mcp:ready');
  const mcpText = await page.textContent('[data-testid="mcp-view"]');
  if (mcpText === null) {
    throw new Error('Smoke could not read MCP view text.');
  }
  await page.click('[data-testid="nav-skills"]');
  await page.waitForSelector('[data-testid="skills-view"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="skill-management"]', { timeout: 5000 });
  await page.click('[data-testid="skills-filter-enabled"]');
  await page.waitForSelector('[data-testid="skill-row-smoke-skill"]', { timeout: 5000 });
  await waitForTextContent(page, '[data-testid="skill-row-smoke-skill"]', 'smoke-skill');
  const skillLayoutEvidence = await page.evaluate(() => {
    const view = document.querySelector('[data-testid="skills-view"]');
    const filterStrip = document.querySelector('.skills-filter-strip');
    const firstRow = document.querySelector('[data-testid="skill-row-smoke-skill"]');
    const filterButtons = Array.from(document.querySelectorAll('[data-testid^="skills-filter-"]')).filter(
      (element) => element instanceof HTMLElement
    );
    if (
      !(view instanceof HTMLElement) ||
      !(filterStrip instanceof HTMLElement) ||
      !(firstRow instanceof HTMLElement) ||
      filterButtons.length === 0
    ) {
      return {
        exists: false,
        viewHeight: null,
        filterStripHeight: null,
        chipHeights: [],
        chipMaxHeight: null,
        gapToFirstRow: null,
        stripAlignItems: null,
        stripAlignContent: null
      };
    }
    const viewRect = view.getBoundingClientRect();
    const stripRect = filterStrip.getBoundingClientRect();
    const rowRect = firstRow.getBoundingClientRect();
    const chipHeights = filterButtons.map((element) => Number(element.getBoundingClientRect().height.toFixed(2)));
    return {
      exists: true,
      viewHeight: Number(viewRect.height.toFixed(2)),
      viewDisplay: getComputedStyle(view).display,
      viewJustifyContent: getComputedStyle(view).justifyContent,
      viewAlignItems: getComputedStyle(view).alignItems,
      filterStripHeight: Number(stripRect.height.toFixed(2)),
      filterStripTop: Number(stripRect.top.toFixed(2)),
      chipHeights,
      chipMaxHeight: chipHeights.length === 0 ? null : Math.max(...chipHeights),
      gapToRowList:
        firstRow.parentElement instanceof HTMLElement
          ? Number((firstRow.parentElement.getBoundingClientRect().top - stripRect.bottom).toFixed(2))
          : null,
      gapToFirstRow: Number((rowRect.top - stripRect.bottom).toFixed(2)),
      rowListTop: Number(
        (
          (firstRow.parentElement instanceof HTMLElement
            ? firstRow.parentElement.getBoundingClientRect().top
            : Number.NaN)
        ).toFixed(2)
      ),
      rowListHeight:
        firstRow.parentElement instanceof HTMLElement
          ? Number(firstRow.parentElement.getBoundingClientRect().height.toFixed(2))
          : null,
      rowListDisplay:
        firstRow.parentElement instanceof HTMLElement ? getComputedStyle(firstRow.parentElement).display : null,
      rowListJustifyContent:
        firstRow.parentElement instanceof HTMLElement ? getComputedStyle(firstRow.parentElement).justifyContent : null,
      rowListPaddingTop:
        firstRow.parentElement instanceof HTMLElement ? getComputedStyle(firstRow.parentElement).paddingTop : null,
      rowListMarginTop:
        firstRow.parentElement instanceof HTMLElement ? getComputedStyle(firstRow.parentElement).marginTop : null,
      firstRowTop: Number(rowRect.top.toFixed(2)),
      stripAlignItems: getComputedStyle(filterStrip).alignItems,
      stripAlignContent: getComputedStyle(filterStrip).alignContent
    };
  });
  await page.click('[data-testid="skill-row-smoke-skill"]');
  await page.waitForSelector('[data-testid="skill-drawer"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="skill-drawer-toggle"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="skill-drawer-delete"]', { timeout: 5000 });
  await waitForTextContent(page, '[data-testid="skill-drawer"]', 'Skill · ready');
  await page.click('[data-testid="skill-drawer-toggle"]');
  await page.waitForFunction(async () => {
    const result = await window.roc.skills.list();
    if (!result.ok) {
      return false;
    }
    const skill = result.data.find((entry) => entry.id === 'smoke-skill');
    return skill?.enabled === false;
  }, undefined, { timeout: 5000 });
  await page.click('[data-testid="skills-filter-disabled"]');
  await page.waitForSelector('[data-testid="skill-row-smoke-skill"]', { timeout: 5000 });
  await waitForTextContent(page, '[data-testid="skill-row-smoke-skill"]', 'disabled');
  const disabledSkillText = await page.textContent('[data-testid="skill-row-smoke-skill"]');
  await page.waitForSelector('[data-testid="skill-drawer"]', { timeout: 5000 });
  await waitForTextContent(page, '[data-testid="skill-drawer"]', 'Skill · disabled');
  await page.click('[data-testid="skill-drawer-toggle"]');
  await page.waitForFunction(async () => {
    const result = await window.roc.skills.list();
    if (!result.ok) {
      return false;
    }
    const skill = result.data.find((entry) => entry.id === 'smoke-skill');
    return skill?.enabled === true;
  }, undefined, { timeout: 5000 });
  await page.click('[data-testid="skills-filter-enabled"]');
  await page.waitForSelector('[data-testid="skill-row-smoke-skill"]', { timeout: 5000 });
  const skillText = await page.textContent('[data-testid="skills-view"]');
  if (skillText === null) {
    throw new Error('Smoke could not read Skill view text.');
  }

  Object.assign(ctx, {
    mcpText,
    skillLayoutEvidence,
    disabledSkillText,
    skillText
  });
}
