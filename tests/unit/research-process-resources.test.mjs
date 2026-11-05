import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const { assertResearchProcessResourceLimits, parseResearchProcessSamples, ResearchProcessResourceMonitor } =
  await importTypeScriptModule('src/main/plugins/research/process-resources.ts', { platform: 'node' });

const row = (pid, cpu, rss, start = 'Thu Nov 5 10:00:00 2026') => `${pid} 42 ${cpu} ${rss} ${start}\n`;

test('Darwin samples convert accumulated time and RSS without reading command lines or environments', () => {
  assert.deepEqual(parseResearchProcessSamples(row(43, '0:01.12', 100), 42), [
    { identity: '43:Thu Nov 5 10:00:00 2026', cpuTimeMs: 1120, residentBytes: 102400 }
  ]);
  assert.equal(parseResearchProcessSamples(row(43, '2-03:04:05.00', 100), 42)[0].cpuTimeMs, 183845000);
  assert.equal(parseResearchProcessSamples(row(43, '123:04.00', 100), 42)[0].cpuTimeMs, 7384000);
});

test('sampled group CPU retains departed members, separates reused PIDs, and reports unknown until observed', () => {
  const monitor = new ResearchProcessResourceMonitor();
  assert.deepEqual(monitor.usage(), {
    mode: 'monitored', sampleIntervalMs: 100, samples: 0, observedCpuTimeMs: null, peakResidentBytes: null
  });
  monitor.record(row(42, '0:00.50', 10) + row(43, '0:01.00', 100), 42);
  monitor.record(row(42, '0:00.70', 20), 42);
  monitor.record(row(43, '0:00.10', 50, 'Thu Nov 5 10:01:00 2026'), 42);
  assert.deepEqual(monitor.usage(), {
    mode: 'monitored', sampleIntervalMs: 100, samples: 3, observedCpuTimeMs: 1800, peakResidentBytes: 110 * 1024
  });
});

test('malformed or foreign group samples fail and hard limits are explicitly unsupported', () => {
  for (const output of ['garbage', '1 5 0:00.00 5 start', row(43, '0:61.00', 100), row(43, '0:00.00', 'x')]) {
    assert.throws(() => parseResearchProcessSamples(output, 42), /research_process_resource_sample_invalid/);
  }
  assert.throws(() => assertResearchProcessResourceLimits({ mode: 'hard', cpuTimeMs: 100, maxResidentBytes: 100 }), /hard_limits_unsupported/);
  for (const value of [0, -1, NaN, Infinity]) {
    assert.throws(() => assertResearchProcessResourceLimits({ mode: 'monitored', cpuTimeMs: value, maxResidentBytes: 100 }), /resource_limits_invalid/);
  }
});
