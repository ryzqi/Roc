import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { createSmokePaths, seedSmokeWorkspace } from '../tests/smoke/lib/fixtures.mjs';
import { resolveSmokeTarget } from '../tests/smoke/lib/smoke-target.mjs';
import { navigate } from './lib/gate-harness.mjs';

// Deterministic model + academic responses; real Electron, IPC, agent harness,
// bibliography normalization, SQLite, keyword index and live renderer refresh.
const paths = await createSmokePaths();
seedSmokeWorkspace(paths.workspaceRoot, paths.remoteRoot);
const artifactDir = resolve('.artifacts/agent-literature-import');
mkdirSync(artifactDir, { recursive: true });
const checks = [];
let providerError;
const server = createServer(async (request, response) => {
  try {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const messages = payload.messages ?? [];
    const shouldAdd = JSON.stringify(messages).includes('检索并加入一篇相关文献');
    const lastTool = [...messages].reverse().find((message) => message.role === 'tool');
    const toolContent = lastTool?.content;
    let name;
    let args;
    if (!lastTool) {
      name = 'research_search_literature';
      args = { query: 'ROC-AGENT-IMPORT-FIXTURE', sources: ['crossref'], limit: 1 };
    } else if (shouldAdd && !JSON.stringify(toolContent).includes('operationId')) {
      const content = typeof toolContent === 'string' ? toolContent : toolContent.map((part) => part.text ?? '').join('');
      const result = JSON.parse(content);
      name = 'research_add_literature';
      args = { requestId: 'agent-fixture-import', entries: [{ kind: 'candidate', searchId: result.searchId, candidateId: result.candidates[0].candidateId }] };
    }
    if (name) assert(payload.tools?.some((entry) => entry.function?.name === name), `tool missing from model manifest: ${name}`);
    const base = { id: `fixture-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fixture-model' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = name ? { role: 'assistant', tool_calls: [{ index: 0, id: `fixture-call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
      : { role: 'assistant', content: shouldAdd ? 'IMPORT-DONE 元数据已加入；未下载PDF。' : 'SEARCH-DONE 仅返回候选。' };
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: name ? 'tool_calls' : 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  } catch (error) {
    providerError = error;
    response.writeHead(500); response.end(String(error));
  }
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
let app;
function unwrap(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; }
async function check(name, action) { await action(); checks.push(name); console.log(`PASS ${name}`); }
try {
  const target = resolveSmokeTarget({ env: { ...process.env, ROC_SMOKE_TARGET: 'dist' } });
  app = await electron.launch({ executablePath: target.executablePath, args: target.launchArgs,
    env: { ...process.env, ROC_SMOKE: '1', ROC_DATA_ROOT: paths.dataRoot, ROC_SMOKE_API_KEY: 'smoke-test-key' } });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="roc-app"]');
  await app.evaluate(() => {
    const original = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = String(input);
      if (url.startsWith('https://api.crossref.org/')) return Promise.resolve(Response.json({ message: { items: [{
        DOI: '10.1234/roc-agent-fixture', title: ['ROC-AGENT-IMPORT-FIXTURE'], author: [{ given: 'Alice', family: 'Smith' }],
        published: { 'date-parts': [[2024]] }, abstract: 'Fixture metadata only.'
      }] } }));
      if (url.startsWith('https://api.openalex.org/')) return Promise.resolve(Response.json({ results: [] }));
      if (url.startsWith('https://export.arxiv.org/')) return Promise.resolve(new Response('<feed></feed>'));
      if (url.startsWith('https://api.semanticscholar.org/')) return Promise.resolve(Response.json({ data: [] }));
      if (url.startsWith('https://www.ebi.ac.uk/')) return Promise.resolve(Response.json({ resultList: { result: [] } }));
      return original(input, init);
    };
  });
  const project = unwrap(await page.evaluate((workspacePath) => window.roc.research.createProject({ title: 'Agent import fixture', description: 'Metadata import acceptance fixture', workspacePath }), paths.workspaceRoot));
  unwrap(await page.evaluate(async (endpoint) => {
    const current = await window.roc.settings.get();
    if (!current.ok) return current;
    const saved = await window.roc.settings.save({ settings: current.data.settings, providers: [{ id: 'import-fixture', name: 'Import fixture', type: 'openai_compatible', endpoint,
      credentialRef: 'secret:import-fixture', enabled: true, models: [{ id: 'fixture-model', displayName: 'Fixture model', enabled: true, supportsStreaming: true, supportsToolCalls: true, supportsImages: false }] }],
      defaultModelId: 'import-fixture:fixture-model', permissions: { ...current.data.permissions, mode: 'default' } });
    if (!saved.ok) return saved;
    return window.roc.settings.setProviderSecret({ providerId: 'import-fixture', plaintext: 'fixture-only' });
  }, endpoint));
  await navigate(page, `page=research&project=${project.id}&view=literature&assistant=1`);
  await page.waitForSelector('[data-testid="literature-hub"]');
  await page.evaluate(() => { window.__importEvents = []; window.roc.chat.onRunEvent((raw) => { const event = raw.event ?? raw; window.__importEvents.push(event); }); });
  const list = async () => unwrap(await page.evaluate((projectId) => window.roc.research.listLibrary({ projectId, query: '', limit: 100, includeArchived: false }), project.id));
  async function run(input, suffix) {
    const started = unwrap(await page.evaluate(({ input, projectId, workspacePath }) => window.roc.chat.startRun({ input, mode: 'chat', threadId: `thread-import-${input.includes('IMPORT-FIXTURE') ? 'add' : 'search'}`,
      researchProjectId: projectId, workspacePath, enabledCapabilities: { mcpServers: [], skills: [] } }), { input, projectId: project.id, workspacePath: paths.workspaceRoot }));
    await page.waitForFunction((runId) => window.__importEvents.some((event) => event.runId === runId && ['run_completed', 'run_failed', 'run_cancelled'].includes(event.type)), started.runId, { timeout: 60_000 });
    const events = await page.evaluate((runId) => window.__importEvents.filter((event) => event.runId === runId), started.runId);
    writeFileSync(resolve(artifactDir, `${suffix}-events.json`), JSON.stringify(events, null, 2));
    assert.equal(events.at(-1).type, 'run_completed', JSON.stringify(events.at(-1)));
    if (providerError) throw providerError;
    return events;
  }
  await check('agent pure search leaves project library empty', async () => {
    await run('只检索相关文献，不要加入文献库。SEARCH-ONLY-FIXTURE', 'search');
    assert.equal((await list()).length, 0);
  });
  await check('agent search and add commits metadata and refreshes mounted library', async () => {
    await run('检索并加入一篇相关文献到当前项目文献库。IMPORT-FIXTURE', 'add');
    const items = await list();
    assert.equal(items.length, 1);
    assert.match(items[0].id, /^paper_/);
    assert(items[0].projectIds.includes(project.id));
    // At narrow canvas widths the mounted list is hidden in favor of a picker.
    // Both surfaces must receive the event-driven update without navigation.
    await page.locator(`[data-testid="literature-hub"] [data-testid="literature-row-${items[0].id}"]`).waitFor({ state: 'attached' });
    await page.locator(`[data-testid="literature-hub"] select[aria-label="选择当前文献"] option[value="${items[0].id}"]`).waitFor({ state: 'attached' });
    assert.equal(unwrap(await page.evaluate((libraryItemId) => window.roc.research.listDocuments({ libraryItemId }), items[0].id)).length, 0);
  });
  await check('dialog pure search and repeated add reuse library identity', async () => {
    await page.click('[data-testid="literature-hub-import"]');
    await page.click('[data-testid="literature-import-tab-search"]');
    await page.fill('[data-testid="literature-import-search"]', 'ROC-AGENT-IMPORT-FIXTURE');
    await page.click('[data-testid="literature-import-search-submit"]');
    const hit = page.locator('[data-testid^="literature-import-hit-"]').first();
    await hit.waitFor();
    assert.equal((await list()).length, 1);
    await hit.click();
    await page.waitForFunction(() => document.querySelector('[data-testid="literature-import-message"]')?.textContent?.includes('已存在'));
    assert.equal((await list()).length, 1);
  });
  await page.screenshot({ path: resolve(artifactDir, 'dialog.png') });
  writeFileSync(resolve(artifactDir, 'report.json'), JSON.stringify({ status: 'passed', checks, provider: 'fixture', normalization: 'real toolchain' }, null, 2));
} catch (error) {
  writeFileSync(resolve(artifactDir, 'report.json'), JSON.stringify({ status: 'failed', checks, error: String(error) }, null, 2));
  throw error;
} finally {
  await app?.close();
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
  for (const path of Object.values(paths)) rmSync(path, { recursive: true, force: true });
}
