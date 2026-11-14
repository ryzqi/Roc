import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { build } from 'esbuild';
import electron from 'electron';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';
import { directory, EVAL_ROOT, ROOT, fail } from './common.mjs';

const applicationPackage = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const applicationName = applicationPackage.productName ?? applicationPackage.name;

export async function openRocModel({ rocRoot = process.env.ROC_DATA_ROOT ?? join(homedir(), '.roc'), providerId, modelId, appName = applicationName } = {}) {
  if (Boolean(providerId) !== Boolean(modelId)) fail('policy', 'provider_id_and_model_id_required_together');
  if (typeof appName !== 'string' || !appName.trim() || appName.length > 80) fail('policy', 'app_name_invalid');
  const root = directory(join(EVAL_ROOT, '.runtime/model-hosts'), 'host'), path = join(root, 'host.mjs');
  try {
    await build({ entryPoints: [join(EVAL_ROOT, 'runtime/model-host.ts')], outfile: path,
      bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' });
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
  const { terminateProcessTreeWithRetry } = await importTypeScriptModule(join(ROOT, 'src/main/services/process-tree.ts'), { platform: 'node' });
  const child = spawn(electron, [path, root, appName], { cwd: root, detached: true, stdio: ['pipe', 'pipe', 'ignore'],
    env: { PATH: '/usr/bin:/bin', HOME: homedir(), TMPDIR: root, LANG: 'en_US.UTF-8',
      LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false' } });
  let pending = null, closed = false, closing, stage = 'startup', queue = Promise.resolve();
  const close = () => closing ??= (async () => {
    child.stdin.end(); await terminateProcessTreeWithRetry(child); lines.close();
    rmSync(root, { recursive: true, force: true });
  })();
  const reject = (code = `roc_model_host_unavailable_${stage}`) => { closed = true; pending?.reject(new Error(code)); pending = null; };
  child.once('error', () => reject()); child.once('close', () => reject()); child.stdin.on('error', () => reject());
  const lines = createInterface({ input: child.stdout });
  let received = 0;
  child.stdout.on('data', bytes => { received += bytes.length; if (received > 8 * 1024 * 1024) { reject(); void close(); } });
  lines.on('line', line => {
    try {
      const message = JSON.parse(line);
      if (message.type === 'stage' && ['startup', 'ready', 'configuration', 'credential_availability', 'credential_decryption', 'inference'].includes(message.stage)) {
        stage = message.stage; return;
      }
      if (message.type === 'error' && pending) {
        pending.reject(new Error(/^[a-z_]+$/.test(message.code) ? message.code : 'roc_model_host_failed'));
        pending = null; closed = true; return;
      }
      if (!pending || message.requestId !== pending.requestId) { reject(); return; }
      pending.resolve(message); pending = null;
    } catch { reject(); }
  });
  async function requestOnce(value, signal, requestId) {
    if (closed || pending) fail('provider', 'roc_model_host_unavailable');
    received = 0;
    const abort = () => { reject(`roc_model_host_${signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled'}_${stage}`); void close(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      return await new Promise((resolve, reject) => { pending = { resolve, reject, requestId }; child.stdin.write(JSON.stringify({ ...value, requestId }) + '\n'); });
    } finally { signal.removeEventListener('abort', abort); }
  }
  function request(value, signal, requestId = randomUUID()) {
    const result = queue.then(() => requestOnce(value, signal, requestId));
    queue = result.catch(() => {});
    return result;
  }
  try {
    const response = await request({ type: 'init', rocRoot: resolve(rocRoot), selection: providerId ? { providerId, modelId } : undefined }, AbortSignal.timeout(30000));
    if (response.type !== 'ready') fail('environment', 'roc_model_not_ready');
    return { identity: response.identity, close, complete: async (body, signal, correlation) => {
      const result = await request({ type: 'complete', body }, signal, correlation?.requestId);
      if (result.type !== 'response') fail('provider', 'roc_model_response_invalid');
      return result.body;
    } };
  } catch (error) { await close(); fail('environment', error.message); }
}
