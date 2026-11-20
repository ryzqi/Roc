import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

const {createMcpClientAdapter} = await importTypeScriptModule('src/main/plugins/mcp/mcp-client-adapter.ts', {
  platform: 'node', external: ['@langchain/*', '@modelcontextprotocol/*', 'zod'], tempDir: resolve('.runtime/tmp')
});

test('connected MCP tools outlive initialization timeout but still obey run cancellation', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'roc-mcp-lifetime-'));
  const adapter = createMcpClientAdapter();
  const run = new AbortController();
  const initialization = new AbortController();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', ms => ms === 15_000 ? initialization.signal : timeout(ms));
  try {
    const receiptPath = join(dir, 'receipts.jsonl');
    const tools = await adapter.loadTools('run', [{id: 'receipt', name: 'Local fixture', enabled: true,
      transport: 'stdio', preset: false, riskLevel: 'medium',
      command: `"${process.execPath}" "${resolve('tests/fixtures/mcp/receipt-server.mjs')}" "${receiptPath}"`,
      allowedTools: ['query'], status: 'ready', tools: 1}], run.signal);
    const query = tools.find(tool => tool.name === 'receipt_query');
    assert.ok(query);
    await query.invoke({requestId: 'before'});
    initialization.abort(new DOMException('Initialization deadline', 'TimeoutError'));
    await query.invoke({requestId: 'after'});
    run.abort(new Error('run_cancelled'));
    await assert.rejects(query.invoke({requestId: 'cancelled'}), /run_cancelled/);
    const receipts = readFileSync(receiptPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(receipts.filter(r => r.event === 'query').map(r => r.requestId), ['before', 'after']);
  } finally {
    await adapter.close();
    rmSync(dir, {recursive: true, force: true});
  }
});
