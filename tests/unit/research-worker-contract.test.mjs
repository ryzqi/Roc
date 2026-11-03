import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => { api = await loadResearchTestApi(); });
after(() => api.dispose());

test('missing production worker refuses metadata processing instead of executing in the main process', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'roc-worker-contract-'));
  try {
    const root = await realpath(temporary);
    await writeFile(join(root, 'input.json'), '[]');
    const tools = new api.ResearchToolchain(null);
    await assert.rejects(tools.normalizeBibliography({
      projectRoot: root, sourcePath: join(root, 'input.json'), outputDir: join(root, 'output'), jobDir: root
    }), /research_worker_unavailable/u);
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
});
