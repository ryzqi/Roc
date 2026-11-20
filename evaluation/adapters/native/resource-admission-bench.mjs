import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { importTypeScriptModule } from '../../../scripts/lib/bundle-ts.mjs';

const { ToolExecutionGate } = await importTypeScriptModule(
  'src/main/services/deep-agent/tool-execution-gate.ts',
  { platform: 'node' }
);
const { ToolResourceCoordinator } = await importTypeScriptModule(
  'src/main/services/deep-agent/tool-resource-coordinator.ts',
  { platform: 'node' }
);

const REQUEST_COUNT = 192;
const CONCURRENCY_LIMIT = 8;
const SERVICE_TIME_MS = 4;
const REPETITIONS = 5;
const REPORT_PATH = 'evaluation/local/native/resource-admission-benchmark.json';

function createWorkload() {
  return Array.from({ length: REQUEST_COUNT }, (_, index) => {
    const slot = index % 8;
    if (slot < 5) {
      const workspace = index % 4;
      return {
        kind: 'workspace',
        access: 'write',
        claims: [{
          kind: 'workspace',
          key: `workspace-${workspace}`,
          path: `/benchmark/workspace-${workspace}`,
          access: 'write'
        }]
      };
    }
    if (slot === 5) {
      return {
        kind: 'memory',
        access: 'write',
        claims: [
          { kind: 'memory', key: 'global', access: 'write' },
          { kind: 'memory', key: `workspace:${index % 4}`, access: 'write' }
        ]
      };
    }
    return {
      kind: 'network',
      access: 'read',
      claims: [{ kind: 'network', key: 'shared', access: 'read' }]
    };
  });
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function median(values) {
  return percentile(values, 0.5);
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function runIteration(strategy) {
  const capacityGate = new ToolExecutionGate();
  const legacyGlobalGate = strategy === 'global_rw' ? new ToolExecutionGate() : null;
  const resourceCoordinator = strategy === 'resource_sets' ? new ToolResourceCoordinator() : null;
  const waitSamples = [];
  const workload = createWorkload();
  const startedAt = performance.now();

  async function runOperation(operation) {
    const releaseSlot = await capacityGate.acquire(false, undefined, CONCURRENCY_LIMIT);
    let releaseResource;
    try {
      const resourceRequestedAt = performance.now();
      if (legacyGlobalGate !== null) {
        releaseResource = await legacyGlobalGate.acquire(operation.access === 'write');
      } else if (resourceCoordinator !== null) {
        releaseResource = await resourceCoordinator.acquire(operation.claims);
      }
      waitSamples.push(performance.now() - resourceRequestedAt);
      await sleep(SERVICE_TIME_MS);
    } finally {
      releaseResource?.();
      releaseSlot();
    }
  }

  const requests = [];
  for (const operation of workload) {
    requests.push(runOperation(operation));
  }
  await Promise.all(requests);

  const durationMs = performance.now() - startedAt;
  return {
    durationMs: Math.round(durationMs * 100) / 100,
    p95AdmissionWaitMs: Math.round(percentile(waitSamples, 0.95) * 100) / 100,
    throughputOpsPerSecond: Math.round(REQUEST_COUNT / (durationMs / 1000) * 100) / 100
  };
}

async function runStrategy(strategy) {
  const iterations = [];
  for (let index = 0; index < REPETITIONS; index += 1) {
    iterations.push(await runIteration(strategy));
  }
  return {
    iterations,
    medianDurationMs: Math.round(median(iterations.map((item) => item.durationMs)) * 100) / 100,
    medianP95AdmissionWaitMs: Math.round(median(iterations.map((item) => item.p95AdmissionWaitMs)) * 100) / 100,
    medianThroughputOpsPerSecond: Math.round(median(iterations.map((item) => item.throughputOpsPerSecond)) * 100) / 100
  };
}

const baseline = await runStrategy('global_rw');
const candidate = await runStrategy('resource_sets');
const report = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  providerCalls: 0,
  workload: {
    requestCount: REQUEST_COUNT,
    concurrencyLimit: CONCURRENCY_LIMIT,
    serviceTimeMs: SERVICE_TIME_MS,
    repetitions: REPETITIONS,
    distribution: {
      workspaceWrites: 120,
      globalAndWorkspaceMemoryWrites: 24,
      sharedNetworkReads: 48
    }
  },
  methodology: {
    baseline: 'same per-run capacity gate plus one fair process-wide reader/writer resource gate',
    candidate: 'same per-run capacity gate plus atomic fair resource-set coordinator',
    wait: 'time spent waiting on the resource gate after the per-run capacity slot is acquired',
    workload: 'fixed synthetic load; no filesystem, model, provider, or network calls'
  },
  baseline,
  candidate,
  comparison: {
    p95WaitChangePercent: Math.round((candidate.medianP95AdmissionWaitMs / baseline.medianP95AdmissionWaitMs - 1) * 10000) / 100,
    throughputChangePercent: Math.round((candidate.medianThroughputOpsPerSecond / baseline.medianThroughputOpsPerSecond - 1) * 10000) / 100
  }
};

const reportPath = resolve(REPORT_PATH);
await mkdir(resolve('evaluation/local/native'), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
