import { spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { build } from 'esbuild';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';
import { ROOT, contained, fail, hash, sha256, writeJson } from './common.mjs';

export async function prepareApplication(directory) {
  const path = join(directory, 'application-worker.mjs');
  const compiled = await build({ entryPoints: [join(ROOT, 'evaluation/runtime/application-worker.ts')],
    outfile: path, bundle: true, packages: 'external', platform: 'node', format: 'esm', metafile: true,
    loader: { '.md': 'text' }, logLevel: 'silent' });
  if (Object.keys(compiled.metafile.inputs).some(name => /fixtures|evaluation\/lib\/(?:qasper|science|runner|report)|quality-evaluation\/(?:dataset|validators|statistics|protocol|runner)\.ts/u.test(name))) fail('policy', 'evaluator_in_worker_graph');
  const packages = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const { benchmarkManifest } = await importTypeScriptModule(join(ROOT, 'evaluation/runtime/benchmark-runtime.ts'), {
    platform: 'node', external: [...Object.keys(packages.dependencies), ...Object.keys(packages.devDependencies)], tempDir: join(ROOT, 'evaluation/.runtime/imports') });
  const artifact = { path, sha256: sha256(readFileSync(path)), manifests: Object.fromEntries(['qasper', 'scienceagentbench'].map(kind => [kind, benchmarkManifest(kind)])),
    nodeModulesPath: realpathSync(join(ROOT, 'node_modules')) };
  writeJson(join(directory, 'worker.json'), artifact);
  return artifact;
}

export async function executeApplication({ artifact, input, directory, config, complete, record, signal, execute, stage, protectedPaths = [join(dirname(artifact.path), 'worker.json')] }) {
  if (process.platform !== 'darwin') fail('environment', 'macos_sandbox_required');
  if (sha256(readFileSync(artifact.path)) !== artifact.sha256) fail('state', 'worker_changed');
  const root = join(directory, 'worker'), workspace = join(root, 'workspace');
  mkdirSync(root, { mode: 0o700 }); mkdirSync(workspace, { mode: 0o700 });
  for (const [name, bytes] of Object.entries(input.files)) {
    const target = contained(workspace, name);
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  }
  await stage?.(workspace);
  copyFileSync(artifact.path, join(root, 'application-worker.mjs'));
  symlinkSync(artifact.nodeModulesPath, join(root, 'node_modules'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  const node = realpathSync(process.execPath), quote = value => JSON.stringify(realpathSync(value));
  const policy = `(version 1)(deny default)(import "system.sb")
    (allow process-fork)(allow process-exec (literal ${quote(node)}))
    (allow sysctl-read file-read-metadata)
    (deny syscall-unix (syscall-number SYS_setsid) (syscall-number SYS_setpgid))
    (allow file-read* file-map-executable (subpath "/usr/lib") (subpath "/usr/share") (subpath "/System/Library")
      (subpath "/opt/homebrew/opt") (subpath "/opt/homebrew/Cellar") (subpath ${quote(artifact.nodeModulesPath)}))
    (allow file-read* file-write* file-map-executable (subpath ${quote(root)}))
    ${input.kind === 'qasper' ? `(deny file-write* (subpath ${quote(workspace)}))` : ''}
    (allow file-read* file-write-data (literal "/dev/null") (literal "/dev/urandom"))
    (allow signal (target self))`;
  writeFileSync(join(directory, 'sandbox.sb'), policy, { mode: 0o600 });
  const child = spawn('/usr/bin/sandbox-exec', ['-p', policy, node, join(root, 'application-worker.mjs')], {
    cwd: root, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, LANG: 'en_US.UTF-8', OPENSSL_CONF: '/dev/null',
      LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false' }
  });
  const { terminateProcessTreeWithRetry } = await importTypeScriptModule(join(ROOT, 'src/main/services/process-tree.ts'), { platform: 'node' });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, exitSignal) => {
    writeJson(join(directory, 'process.json'), { code, signal: exitSignal }); resolve(code);
  }); });
  void closed.catch(() => {});
  let cleanup;
  const stop = () => { cleanup ??= terminateProcessTreeWithRetry(child); void cleanup.catch(() => {}); return cleanup; };
  const controller = new AbortController();
  const taskSignal = AbortSignal.any([signal, controller.signal]);
  const abort = () => { void stop(); };
  taskSignal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('task_deadline')), config.taskTimeoutMs);
  let bytes = 0, requests = 0, result = null, truncated = false, isolationVerified = false, toolSchemaHash = null;
  function retain(name, text) {
    bytes += Buffer.byteLength(text);
    if (bytes > 32 * 1024 * 1024) { truncated = true; controller.abort(new Error('evidence_limit')); return; }
    appendFileSync(join(directory, name), text, { mode: 0o600 });
  }
  child.stderr.on('data', chunk => retain('stderr.log', chunk));
  child.stdin.on('error', () => controller.abort(new Error('worker_stdin_closed')));
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  const lines = createInterface({ input: child.stdout });
  // Detect a huge unterminated line before readline can allocate an unbounded transcript.
  let stdoutBytes = 0;
  child.stdout.on('data', chunk => { stdoutBytes += chunk.length; if (stdoutBytes > 32 * 1024 * 1024) { truncated = true; controller.abort(); } });
  try {
    taskSignal.throwIfAborted();
    send({ view: { id: 'benchmark-task', family: input.kind === 'qasper' ? 'literature-verification' : 'experiment-script', difficulty: 'hard', prompt: input.prompt, outputFormat: 'json' },
      benchmark: input.kind, providerId: 'evaluation-host', modelId: config.model, temperature: config.temperature, contextWindowTokens: config.contextWindowTokens ?? 65536,
      isolationProbePaths: protectedPaths, isolationProbePort: null });
    for await (const line of lines) {
      retain('transcript.jsonl', line + '\n');
      taskSignal.throwIfAborted();
      const message = JSON.parse(line);
      if (message.type === 'request') {
        requests++;
        if (result !== null || message.requestHash !== hash(message.body)) fail('policy', 'worker_request_invalid');
        const tools = message.body.tools;
        // Public benchmarks have one fixed main-agent tool set; no dynamic tools or subagents.
        const expected = artifact.manifests[input.kind].tools.filter(t => t.executionScopes.includes('main')).map(t => t.modelVisibleName).sort();
        if (!Array.isArray(tools) || tools.some(t => t?.type !== 'function' || typeof t.function?.name !== 'string'
          || !t.function.parameters || typeof t.function.parameters !== 'object' || Array.isArray(t.function.parameters))
          || hash(tools.map(t => t.function.name).sort()) !== hash(expected)) fail('harness', 'worker_tool_manifest_mismatch');
        const observed = hash(tools);
        if (toolSchemaHash !== null && toolSchemaHash !== observed) fail('harness', 'worker_tool_schema_changed');
        if (toolSchemaHash === null) {
          toolSchemaHash = observed;
          writeJson(join(directory, 'tool-schema.json'), { schemaVersion: 1, toolSchemaHash, tools });
        }
        record({ type: 'model_request', requestHash: message.requestHash, request: requests, toolSchemaHash });
        const body = await complete(message.body, taskSignal);
        retain('responses.jsonl', JSON.stringify({ request: requests, body }) + '\n');
        taskSignal.throwIfAborted(); send({ type: 'response', body });
      } else if (message.type === 'execute') {
        if (input.kind !== 'scienceagentbench' || message.command !== 'python solution.py' || !execute) fail('policy', 'worker_execution_denied');
        if (!Number.isInteger(message.maxDurationMs) || message.maxDurationMs <= 0 || message.maxDurationMs > 120000
          || !Number.isInteger(message.maxOutputBytes) || message.maxOutputBytes <= 0 || message.maxOutputBytes > 1048576) fail('policy', 'worker_execution_limits_invalid');
        record({ type: 'execution_requested', grantId: message.grantId });
        const executionResult = await execute(workspace, taskSignal, { timeoutMs: message.maxDurationMs, maxBytes: message.maxOutputBytes });
        retain('executions.jsonl', JSON.stringify(executionResult) + '\n');
        send({ type: 'executed', result: executionResult });
      } else if (message.type === 'result') {
        if (result !== null || message.manifestHash !== artifact.manifests[input.kind].manifestHash || typeof message.output !== 'string') fail('state', 'worker_result_invalid');
        if (Buffer.byteLength(message.output) > 65536) fail('agent', 'output_too_large');
        result = message;
      } else if (message.type === 'isolation') {
        if (message.filesDenied !== true || message.childDenied !== true) fail('policy', 'worker_isolation_failed');
        isolationVerified = true;
      } else if (message.type !== 'event') fail('infrastructure', 'worker_protocol_invalid');
    }
    const code = await closed;
    if (truncated) fail('infrastructure', 'evidence_limit');
    if (signal.aborted) fail('operator', 'run_cancelled');
    if (taskSignal.aborted) fail(controller.signal.reason?.message === 'task_deadline' ? 'agent' : 'infrastructure', controller.signal.reason?.message ?? 'worker_aborted');
    if (code !== 0 || !result || !isolationVerified) fail('harness', 'application_worker_failed');
    writeJson(join(directory, 'output.json'), result);
    return { output: result.output, workspace, requests, toolSchemaHash, evidenceComplete: true };
  } catch (error) {
    if (truncated) fail('infrastructure', 'evidence_limit');
    if (signal.aborted) fail('operator', 'run_cancelled');
    if (taskSignal.aborted && !error.failureClass) fail(controller.signal.reason?.message === 'task_deadline' ? 'agent' : 'infrastructure', controller.signal.reason?.message ?? 'worker_aborted');
    throw error;
  } finally {
    clearTimeout(timer); taskSignal.removeEventListener('abort', abort); lines.close(); child.stdin.end();
    try { await stop(); unlinkSync(join(root, 'node_modules')); writeJson(join(directory, 'cleanup.json'), { processGroupGone: true, dependencyLinkRemoved: true }); }
    catch { writeJson(join(directory, 'cleanup.json'), { processGroupGone: false }); fail('infrastructure', 'worker_cleanup_unconfirmed'); }
  }
}
