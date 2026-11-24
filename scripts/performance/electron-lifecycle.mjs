import {once} from 'node:events';

export const electronLifecycleTimeouts = {startupMs: 30_000, closeMs: 15_000};
const closingApplications = new WeakMap();

function hasExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

/** Bound host waits without moving the caller's measurement start/end points. */
export async function withBenchmarkTimeout(phase, operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`benchmark_${phase}_timeout:${timeoutMs}ms`)), Math.max(1, timeoutMs));
    })]);
  } catch (error) {
    if (error instanceof Error && error.benchmarkPhase === undefined) error.benchmarkPhase = phase;
    throw error;
  } finally {clearTimeout(timer);}
}

async function killOwnedProcess(child) {
  if (hasExited(child)) return;
  // Never enumerate global Electron processes or kill a process group. This
  // ChildProcess is the exact process returned by our own Playwright launch.
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await withBenchmarkTimeout('kill', () => exited, 5_000);
}

export async function closeBenchmarkElectron(app, timeoutMs = electronLifecycleTimeouts.closeMs) {
  if (!closingApplications.has(app)) closingApplications.set(app, (async () => {
    const child = app.process();
    try {
      await withBenchmarkTimeout('close', async () => {
        await app.close();
        if (!hasExited(child)) await once(child, 'exit');
      }, timeoutMs);
    }
    catch (error) {
      try {await killOwnedProcess(child);}
      catch (cleanupError) {error.cleanupError = String(cleanupError);}
      throw error;
    }
  })());
  return await closingApplications.get(app);
}

export async function launchBenchmarkElectron(electron, options, initialize,
  timeoutMs = electronLifecycleTimeouts.startupMs) {
  const startedAt = performance.now();
  let app;
  try {
    // Playwright owns the process before launch resolves and kills it if this
    // deadline expires. Once acquired, the same budget covers firstWindow,
    // Main evaluation and renderer readiness (including native modal stalls).
    app = await electron.launch({...options, timeout: timeoutMs});
    const value = await withBenchmarkTimeout('startup', () => initialize(app), timeoutMs - (performance.now() - startedAt));
    return {app, value};
  } catch (error) {
    if (error instanceof Error && error.benchmarkPhase === undefined) error.benchmarkPhase = 'startup';
    if (app) {
      try {await closeBenchmarkElectron(app);}
      catch (cleanupError) {error.cleanupError = String(cleanupError);}
    }
    throw error;
  }
}

export function recordBenchmarkFailure(report, error, scenario) {
  report.status = 'failed';
  const failure = {scenario, phase: error?.benchmarkPhase ?? 'workload', error: String(error),
    ...(error?.cleanupError === undefined ? {} : {cleanupError: error.cleanupError})};
  if (report.failure === undefined) report.failure = failure;
  else if (report.failure.error === failure.error && report.failure.phase === failure.phase) return;
  else (report.cleanupFailures ??= []).push(failure);
}
