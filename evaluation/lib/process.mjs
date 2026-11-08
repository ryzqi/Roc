import { spawn } from 'node:child_process';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';
import { ROOT, fail } from './common.mjs';
import { join } from 'node:path';

let processTools;
export async function command(executable, args, { cwd, signal, timeoutMs = 60000, maxBytes = 16 * 1024 * 1024, env } = {}) {
  processTools ??= importTypeScriptModule(join(ROOT, 'src/main/services/process-tree.ts'), { platform: 'node' });
  const { terminateProcessTreeWithRetry } = await processTools;
  const child = spawn(executable, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: env ?? { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'en_US.UTF-8', LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false' } });
  const start = Date.now(), chunks = { stdout: [], stderr: [] };
  let size = 0, oversized = false, timedOut = false, cleanup;
  const stop = () => { cleanup ??= terminateProcessTreeWithRetry(child); void cleanup.catch(() => {}); };
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  signal?.addEventListener('abort', stop, { once: true });
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', bytes => {
    size += bytes.length;
    if (size > maxBytes) { oversized = true; stop(); } else chunks[stream].push(bytes);
  });
  try {
    if (signal?.aborted) stop();
    const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    if (cleanup) await cleanup;
    if (oversized) fail('infrastructure', 'process_evidence_limit');
    if (signal?.aborted) fail('operator', 'run_cancelled');
    if (timedOut) fail('environment', 'process_timeout');
    return { exitCode, durationMs: Date.now() - start, stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8') };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', stop);
    // Also reap descendants of a normally exiting parent.
    await terminateProcessTreeWithRetry(child);
  }
}
