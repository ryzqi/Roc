import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

export async function auditReviewInspector(page, artifacts, label) {
  await page.waitForFunction(() => {
    const panel = document.querySelector('[data-testid="artifact-inspector-panel"]');
    return panel && getComputedStyle(panel).opacity === '1' && getComputedStyle(panel).transform === 'none';
  });
  const source = readFileSync(join(process.cwd(), '.agents/skills/desktop-agent-ui/scripts/clip-audit.js'), 'utf8');
  const result = await page.evaluate(`(${source})({root:'body',viewport:true})`);
  assert.equal(result.cut, 0);
  writeFileSync(join(artifacts, `${label}-audit.json`), JSON.stringify(result, null, 2));
  await page.screenshot({path: join(artifacts, `${label}.png`)});
}
