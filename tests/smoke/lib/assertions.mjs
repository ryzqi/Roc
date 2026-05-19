import { writeFatalArtifact } from './artifacts.mjs';

export async function waitForWindowWithSelector(app, selector) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    for (const candidate of app.windows()) {
      if (await candidate.locator(selector).isVisible().catch(() => false)) {
        return candidate;
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Smoke timed out waiting for window selector: ${selector}`);
}

export async function waitForAppReady(page, label, artifactDir) {
  await page.waitForSelector('[data-testid="roc-app"], .fatal, .boot', { timeout: 15000 });
  if ((await page.locator('.fatal').count()) > 0) {
    const text = await page.textContent('.fatal');
    writeFatalArtifact(artifactDir, label, text);
    throw new Error(`Roc renderer fatal during ${label}: ${text}`);
  }
  if ((await page.locator('[data-testid="roc-app"]').count()) === 0) {
    await page.waitForSelector('[data-testid="roc-app"]', { timeout: 15000 });
  }
}

export async function waitForTerminalSessionReady(page) {
  await page.waitForFunction(
    () => {
      const host = document.querySelector('[data-testid="terminal-xterm"]');
      return host !== null;
    },
    undefined,
    { timeout: 10000 }
  );
}

export async function waitForCapabilitySelection(
  page,
  { mcpCount, skillCount, expectedMcpIds = [], expectedSkillIds = [] }
) {
  try {
    await page.waitForFunction(
      ({ mcpCount: expectedMcpCount, skillCount: expectedSkillCount }) => {
        const toolTrigger = document.querySelector('[data-testid="chat-tool-trigger"]');
        const skillTrigger = document.querySelector('[data-testid="chat-skill-trigger"]');
        const toolActive = toolTrigger instanceof HTMLElement && toolTrigger.classList.contains('active');
        const skillActive = skillTrigger instanceof HTMLElement && skillTrigger.classList.contains('active');
        return toolActive === (expectedMcpCount > 0) && skillActive === (expectedSkillCount > 0);
      },
      { mcpCount, skillCount },
      { timeout: 5000 }
    );
  } catch (error) {
    const triggerEvidence = await page.evaluate(() => ({
      toolTriggerText: document.querySelector('[data-testid="chat-tool-trigger"]')?.textContent ?? '',
      skillTriggerText: document.querySelector('[data-testid="chat-skill-trigger"]')?.textContent ?? '',
      toolTriggerClass: document.querySelector('[data-testid="chat-tool-trigger"]')?.className ?? '',
      skillTriggerClass: document.querySelector('[data-testid="chat-skill-trigger"]')?.className ?? ''
    }));
    throw new Error(
      `Capability selection wait failed for mcp=${mcpCount}, skill=${skillCount}: ${JSON.stringify(triggerEvidence)}`,
      { cause: error }
    );
  }

  if (expectedMcpIds.length > 0) {
    await page.hover('[data-testid="chat-tool-trigger"]');
    await page.waitForFunction(
      ({ ids }) =>
        ids.every((id) => {
          const node = document.querySelector(`[data-testid="turn-mcp-${id}"]`);
          return node instanceof HTMLElement && node.classList.contains('active');
        }),
      { ids: expectedMcpIds },
      { timeout: 5000 }
    );
  }

  if (expectedSkillIds.length > 0) {
    await page.hover('[data-testid="chat-skill-trigger"]');
    await page.waitForFunction(
      ({ ids }) =>
        ids.every((id) => {
          const node = document.querySelector(`[data-testid="turn-skill-${id}"]`);
          return node instanceof HTMLElement && node.classList.contains('active');
        }),
      { ids: expectedSkillIds },
      { timeout: 5000 }
    );
  }

  const triggerEvidence = await page.evaluate(() => {
    return {
      toolTriggerText: document.querySelector('[data-testid="chat-tool-trigger"]')?.textContent ?? '',
      skillTriggerText: document.querySelector('[data-testid="chat-skill-trigger"]')?.textContent ?? '',
      toolTriggerClass: document.querySelector('[data-testid="chat-tool-trigger"]')?.className ?? '',
      skillTriggerClass: document.querySelector('[data-testid="chat-skill-trigger"]')?.className ?? ''
    };
  });
  return {
    ...triggerEvidence,
    mcpActiveIds: expectedMcpIds,
    skillActiveIds: expectedSkillIds
  };
}

export async function waitForTextContent(page, selector, expectedText, timeout = 5000) {
  try {
    await page.waitForFunction(
      ({ selector: targetSelector, expectedText: targetText }) => {
        const text = document.querySelector(targetSelector)?.textContent ?? '';
        return text.includes(targetText);
      },
      { selector, expectedText },
      { timeout }
    );
  } catch (error) {
    const currentText = await page.evaluate((targetSelector) => {
      return document.querySelector(targetSelector)?.textContent ?? '';
    }, selector);
    throw new Error(
      `Timed out waiting for text "${expectedText}" in ${selector}. Current text: ${JSON.stringify(currentText)}`,
      { cause: error }
    );
  }
}

export function assertNoRuntimeMockText(sections) {
  const forbidden = [
    { label: '示例数据标签', pattern: /条示例|示例任务|示例数据/u },
    { label: '硬编码预览流程', pattern: /步骤 3\/5|截图工具未找到浏览器入口|生成页面预览并截图/u },
    { label: '演示 Provider 地址', pattern: /api\.example\.local/u },
    { label: '预览工作区故事', pattern: /重构静态页面布局|导出截图|把每个页面都导出为 PNG/u },
    { label: '英文占位语义', pattern: /\bmock\b|\bdemo\b|\bfake\b|\bplaceholder\b|No preview loaded\./iu }
  ];

  const leaks = [];
  for (const section of sections) {
    for (const rule of forbidden) {
      const match = section.text.match(rule.pattern);
      if (match !== null) {
        leaks.push({ section: section.name, rule: rule.label, text: match[0] });
      }
    }
  }

  if (leaks.length > 0) {
    throw new Error(`Runtime mock/demo text leaked: ${JSON.stringify(leaks, null, 2)}`);
  }
}
