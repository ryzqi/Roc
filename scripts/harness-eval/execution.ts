import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ChatOpenAI } from '@langchain/openai';
import { tool } from '@langchain/core/tools';
import { createDeepAgent } from 'deepagents';
import { createMiddleware } from 'langchain';
import { z } from 'zod';
import type { RunCapabilityManifestV1 } from '../../src/shared/types';
import { createPreparedToolEffectMiddleware, createFinalToolGuardMiddleware, createToolAdmissionMiddleware } from '../../src/main/services/deep-agent/prepared-tool-effect';

export async function runExecutionScenario(name: string, directory: string, endpoint: string): Promise<unknown> {
  const controller = new AbortController();
  const counter = join(directory, 'counter.txt');
  writeFileSync(counter, '0');
  let active = 0, peak = 0, starts = 0;
  const action = tool(async (_args, config) => {
    starts++;
    peak = Math.max(peak, ++active);
    try {
      const before = Number(readFileSync(counter, 'utf8'));
      if (name === 'execution-cancel') controller.abort(new Error('fixture_cancel'));
      await delay(30);
      config.signal?.throwIfAborted();
      if (name === 'execution-resource') writeFileSync(counter, String(before + 1));
      return 'evidence';
    } finally { active--; }
  }, { name: 'pilot_action', description: 'Synthetic action with local receipt', schema: z.object({ index: z.number() }).strict() });
  const manifest = { tools: [{ modelVisibleName: 'pilot_action', executionScopes: ['main', 'subagent'],
    effectClass: name === 'execution-admission' || name === 'execution-cancel' || name === 'execution-child' ? 'network_read' : 'workspace_mutation' }, { modelVisibleName: 'task', executionScopes: ['main'], effectClass: 'none' }] } as RunCapabilityManifestV1;
  const mutate = createMiddleware({ name: 'FixtureRewrite', wrapToolCall: (request, handler) => handler({ ...request,
    ...(name === 'execution-signal' ? { runtime: { ...request.runtime, signal: new AbortController().signal } } : {}),
    ...(name === 'execution-mutation' ? { toolCall: { ...request.toolCall, args: { index: 999 } } } : {})
  }) });
  const stack = (runId: string, scope: 'main' | 'subagent') => [
    createPreparedToolEffectMiddleware(), mutate,
    createToolAdmissionMiddleware(runId, name === 'execution-cancel' ? 1 : name === 'execution-admission' || name === 'execution-child' ? 2 : 4, manifest),
    createFinalToolGuardMiddleware({ manifest, scope, boundToolNames: ['pilot_action', 'task'] })
  ];
  const createAgent = (runId: string) => createDeepAgent({ model: new ChatOpenAI({ model: 'roc-pilot', apiKey: 'synthetic', maxRetries: 0,
    configuration: { baseURL: endpoint }, timeout: 10000 }), tools: [action], middleware: stack(runId, 'main'),
    ...(name === 'execution-child' ? { subagents: [{ name: 'pilot-child', description: 'Concurrency child', systemPrompt: 'Call actions.', tools: [action], middleware: stack(runId, 'subagent') }] } : {})
  });
  const execute = () => name === 'execution-resource'
    ? Promise.all(['a', 'b'].map(run => createAgent(`${name}/${run}`).invoke({ messages: [{ role: 'user', content: `${name}/${run}` }] }, { signal: controller.signal, recursionLimit: 6 })))
    : createAgent(name).invoke({ messages: [{ role: 'user', content: name }] }, { signal: controller.signal, recursionLimit: 6 });
  if (name === 'execution-mutation' || name === 'execution-signal') {
    await assert.rejects(execute(), name === 'execution-signal' ? /identity_changed/ : /input_changed/);
    assert.equal(starts, 0);
  } else if (name === 'execution-cancel') {
    await assert.rejects(execute());
    await delay(60);
    assert.equal(starts, 1);
  } else {
    await execute();
    assert.equal(starts, name === 'execution-resource' ? 8 : name === 'execution-child' ? 5 : 4);
    assert.equal(peak, name === 'execution-resource' ? 1 : 2);
    if (name === 'execution-resource') assert.equal(readFileSync(counter, 'utf8'), '8');
  }
  const evidence = { name, starts, peak, finalCounter: readFileSync(counter, 'utf8') };
  writeFileSync(join(directory, 'execution.json'), JSON.stringify(evidence, null, 2));
  return evidence;
}

export async function runIsolationScenario(directory: string): Promise<unknown> {
  const { MacOsIsolatedEnvironment } = await import('../../src/main/services/execution-environment');
  const { mkdirSync, symlinkSync, existsSync } = await import('node:fs');
  const { createServer } = await import('node:http');
  const root = join(directory, 'isolated');
  mkdirSync(root);
  const outside = join(directory, 'outside.txt');
  writeFileSync(outside, 'synthetic outside value');
  const environment = new MacOsIsolatedEnvironment(root);
  await environment.writeFile('result.txt', '42');
  assert.equal(await environment.readFile('result.txt'), '42');
  await assert.rejects(environment.readFile('../outside.txt'), /path_outside/);
  assert.notEqual((await environment.execute({ file: '/bin/cat', args: [outside] })).exitCode, 0);
  symlinkSync(outside, join(root, 'external.txt'));
  await assert.rejects(environment.readFile('external.txt'), /read_failed/);
  const denied = await environment.execute({ file: '/bin/sh', args: ['-c', 'echo forbidden > "$1"', 'probe', outside] });
  assert.notEqual(denied.exitCode, 0);
  assert.equal(readFileSync(outside, 'utf8'), 'synthetic outside value');
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end('forbidden'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string');
    const network = await environment.execute({ file: '/usr/bin/curl', args: ['--max-time', '1', `http://127.0.0.1:${address.port}/`] });
    assert.notEqual(network.exitCode, 0);
    assert.equal(requests, 0);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  await assert.rejects(environment.execute({ file: '/usr/bin/yes', args: [] }), /output_limit/);
  await assert.rejects(environment.execute({ file: '/bin/sleep', args: ['1'], timeoutMs: 30 }), /deadline/);
  const controller = new AbortController();
  const pending = environment.execute({ file: '/bin/sh', args: ['-c', '(sleep 0.3; echo forbidden > after-cancel.txt) & wait'], signal: controller.signal });
  const cancelled = assert.rejects(pending, /aborted/);
  setTimeout(() => controller.abort(), 60);
  await cancelled;
  await environment.execute({ file: '/bin/sh', args: ['-c', '(sleep 0.3; echo forbidden > after-exit.txt) & exit 0'] });
  await environment.execute({ file: '/usr/bin/perl', args: ['-MPOSIX=setsid', '-e', `my $pid=fork();exit 0 if $pid;setsid() >= 0 or exit 9;close STDIN;close STDOUT;close STDERR;select(undef,undef,undef,0.3);open my $f, ">", 'after-setsid.txt' or die $!;print $f 'forbidden';`] });
  await delay(400);
  assert.equal(existsSync(join(root, 'after-setsid.txt')), false);
  assert.equal(existsSync(join(root, 'after-cancel.txt')), false);
  assert.equal(existsSync(join(root, 'after-exit.txt')), false);
  const evidence = { profile: environment.profile, outsideReadWrite: 'denied', symlink: 'denied', requests, output: 'bounded', deadline: 'enforced', backgroundEffects: 0 };
  writeFileSync(join(directory, 'isolation.json'), JSON.stringify(evidence, null, 2));
  return evidence;
}
