import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { CapabilityRegistry } from '../../src/main/kernel/capability-registry';
import { EventBus } from '../../src/main/kernel/event-bus';
import { PluginLoader } from '../../src/main/kernel/plugin-loader';
import type { RocPlugin, RocPluginContext } from '../../src/main/kernel/types';
import { AtomicFilesystemBackend } from '../../src/main/services/deep-agent/atomic-filesystem-backend';
import { createMcpClientAdapter } from '../../src/main/plugins/mcp/mcp-client-adapter';
import { terminateProcessTree } from '../../src/main/services/process-tree';

export async function verifyExtensions(name: string, directory: string): Promise<unknown> {
  if (name === 'execution-atomic') {
    const backend = new AtomicFilesystemBackend({ rootDir: directory, virtualMode: true });
    const target = join(directory, 'data.json');
    const old = JSON.stringify({ value: 'old', padding: 'a'.repeat(1024 * 1024) });
    const next = old.replace('old', 'new');
    writeFileSync(target, old);
    await chmod(target, 0o600);
    let writing = true, samples = 0;
    const observe = (async () => {
      while (writing) {
        const content = readFileSync(target, 'utf8');
        assert.ok(content === old || content === next, 'atomic readers see only complete old or new bytes');
        samples++;
        await delay(0);
      }
    })();
    try { assert.equal((await backend.write('/data.json', next)).error, undefined); }
    finally { writing = false; await observe; }
    assert.equal((await backend.edit('/data.json', 'new', 'verified')).error, undefined);
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).value, 'verified');
    assert.equal((await backend.write('/../outside.txt', 'forbidden')).error === undefined, false);
    assert.ok(!(await readdir(directory)).some(file => file.startsWith('.roc-')));
    return { samples, result: 'atomic write/edit complete', temporaryFiles: 0 };
  }
  if (name === 'execution-plugin-cleanup') {
    const registry = new CapabilityRegistry();
    const events = new EventBus({ error: () => {} });
    let calls = 0, healthyShutdown = false;
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const descriptor = { name: 'fixture.failed', version: '1', inputSchema: z.object({}), outputSchema: z.string() };
    const plugin: RocPlugin = { manifest: { id: 'fixture-failed', version: '1', displayName: 'Fixture', description: 'Fixture', loadPhase: 'critical', required: false, order: 0, dependencies: [], capabilities: [descriptor] },
      initialize: async context => {
        context.capabilities.register('fixture-failed', descriptor, async () => 'forbidden');
        context.eventBus.subscribe('fixture', () => { calls++; });
        throw new Error('fixture_partial_init');
      }, shutdown: async () => { terminateProcessTree(child); }, healthCheck: async () => ({ status: 'healthy' }) };
    const healthy: RocPlugin = { ...plugin, manifest: { ...plugin.manifest, id: 'fixture-healthy', order: 1, capabilities: [] },
      initialize: async () => {}, shutdown: async () => { healthyShutdown = true; } };
    const loader = new PluginLoader({ eventBus: events, capabilities: registry,
      createContext: (plugin, capabilities): RocPluginContext => ({ pluginId: plugin.manifest.id, capabilities, eventBus: events,
        database: { getConnection: () => { throw new Error('fixture_database_not_used'); } },
        config: { get: () => null, set: () => { throw new Error('fixture_config_not_used'); } },
        secrets: { get: () => null, set: () => { throw new Error('fixture_secrets_not_used'); }, clear: () => {} },
        logger: { info: () => {}, warn: () => {}, error: () => {} } }) });
    await loader.load([plugin, healthy]);
    await registry.invoke('fixture.failed', {}).then(() => assert.fail('failed plugin handler retained'), error => assert.match(String(error), /not_ready/));
    await events.publish({ type: 'fixture', source: 'fixture', payload: {}, createdAt: new Date().toISOString() });
    assert.equal(calls, 0);
    await new Promise<void>(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', () => resolve()));
    await loader.shutdown();
    assert.equal(healthyShutdown, true);
    return { failedProcess: child.pid, status: loader.getStatus(), subscriptionsInvoked: calls, healthyShutdown };
  }
  const script = join(directory, 'mcp-server.mjs');
  const receipts = join(directory, 'mcp-receipts.jsonl');
  writeFileSync(script, `import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
appendFileSync(process.argv[2],JSON.stringify({pid:process.pid})+'\\n');
const send=(id,result)=>console.log(JSON.stringify({jsonrpc:'2.0',id,result}));
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;
if(r.method==='initialize')return send(r.id,{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'roc-fixture',version:'1'}});
if(r.method==='tools/list')return send(r.id,{tools:[{name:'evidence',description:'Fixture evidence',inputSchema:{type:'object',properties:{large:{type:'boolean'}},additionalProperties:false}}]});
if(r.method==='tools/call'){appendFileSync(process.argv[2],JSON.stringify({call:r.params.name,pid:process.pid})+'\\n');return send(r.id,{content:[{type:'text',text:r.params.arguments.large?'x'.repeat(150000):'source:42'}]});}
if(r.method==='ping')return send(r.id,{});console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{code:-32601,message:'Unsupported fixture method'}}));});`);
  const adapter = createMcpClientAdapter();
  const server = { id: 'fixture', name: 'Fixture', enabled: true, transport: 'stdio' as const, command: `"${process.execPath}" "${script}" "${receipts}"`, preset: false, riskLevel: 'low' as const, allowedTools: ['evidence'] };
  const signal = new AbortController().signal;
  const first = await adapter.loadTools('run-a', [server], signal);
  const second = await adapter.loadTools('run-b', [server], signal);
  assert.equal(first.length, 1);
  const invoke = (value: unknown, input: object) => (value as { invoke(args: object): Promise<unknown> }).invoke(input);
  assert.ok(JSON.stringify(await invoke(first[0], {})).includes('source:42'));
  await adapter.release('run-b');
  assert.ok(JSON.stringify(await invoke(first[0], {})).includes('source:42'));
  await assert.rejects(invoke(first[0], { large: true }), /output_limit/);
  await assert.rejects(adapter.loadTools('run-a', [server], signal), /already_loaded/);
  await adapter.close();
  const pids = readFileSync(receipts, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.pid && !row.call).map(row => row.pid);
  for (const pid of pids) {
    let alive = true;
    for (let attempt = 0; attempt < 100 && alive; attempt++) {
      try { process.kill(pid, 0); await delay(10); } catch { alive = false; }
    }
    assert.equal(alive, false, 'released MCP process must exit');
  }
  assert.equal(existsSync(receipts), true);
  return { clients: pids.length, frozenConnections: true, independentRelease: true, outputBound: true, processesReleased: true, toolNames: second.map(value => Reflect.get(value as object, 'name')) };
}
