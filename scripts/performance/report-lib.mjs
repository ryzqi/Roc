import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, hostname, release, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const protocolPath = fileURLToPath(new URL('./protocol.json', import.meta.url));
export const protocolBytes = readFileSync(protocolPath);
export const protocol = JSON.parse(protocolBytes);
export const sha256 = value => createHash('sha256').update(value).digest('hex');

export function commandText(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function summarize(values) {
  assert.ok(values.length > 0 && values.every(Number.isFinite), 'performance_samples_invalid');
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = fraction => sorted[Math.ceil(sorted.length * fraction) - 1];
  return { count: values.length, min: sorted[0], p50: percentile(.5), p95: percentile(.95), max: sorted.at(-1) };
}

export function summarizeRows(samples) {
  const names = new Set(samples.flatMap(sample => Object.keys(sample)));
  return Object.fromEntries([...names].filter(name => samples.every(sample => typeof sample[name] === 'number'))
    .map(name => [name, summarize(samples.map(sample => sample[name]))]));
}

export function makeReport(kind, fixture, sourceFiles = []) {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const sourceHashes = Object.fromEntries(sourceFiles.map(path => [path, sha256(readFileSync(path))]));
  return {
    schemaVersion: 1, kind, measuredAt: new Date().toISOString(),
    protocolSha256: sha256(protocolBytes), fixtureSha256: sha256(JSON.stringify(fixture)), fixture,
    source: { gitSha: commandText('git', ['rev-parse', 'HEAD']), trackedDirty: commandText('git', ['diff', '--name-only']) !== '',
      sourceHashes, sourceSha256: sha256(JSON.stringify(sourceHashes)), lockSha256: sha256(readFileSync('pnpm-lock.yaml')) },
    host: { identitySha256: sha256(hostname()), platform: process.platform, arch: process.arch,
      osRelease: release(), macOS: commandText('/usr/bin/sw_vers', ['-productVersion']),
      chip: cpus()[0]?.model ?? null, logicalCpus: cpus().length, totalMemoryBytes: totalmem(),
      node: process.version, electron: pkg.devDependencies.electron, sqlite: null, display: null,
      power: commandText('/usr/bin/pmset', ['-g', 'custom']) },
    measurement: protocol.measurement, scenarios: [], limitations: []
  };
}

export function saveReport(path, report) {
  const output = resolve(path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  const rows = report.scenarios.flatMap(scene => Object.entries(scene.summary ?? {}).map(([metric, summary]) =>
    `| ${scene.id} | ${metric} | ${summary.count} | ${summary.p50.toFixed(3)} | ${summary.p95.toFixed(3)} | ${summary.max.toFixed(3)} |`));
  const markdown = [
    `# ${report.kind}`, '', `Source: ${report.source.gitSha}. Fixture: ${report.fixtureSha256}.`,
    `Host: ${report.host.chip}, ${report.host.totalMemoryBytes} bytes, macOS ${report.host.macOS}, Node ${report.host.node}.`, '',
    '| Scenario | Metric | Samples | P50 | P95 | Maximum |', '| --- | --- | ---: | ---: | ---: | ---: |',
    ...rows, '', ...report.limitations.map(value => `- ${value}`), ''
  ].join('\n');
  writeFileSync(output.replace(/\.json$/u, '') + '.md', markdown);
  return output;
}

export function readArguments(defaultPath) {
  const args = process.argv.slice(2);
  const outputPath = args[0]?.startsWith('--') === false ? args.shift() : defaultPath;
  const options = { outputPath, samples: protocol.samples, idleMinutes: 0 };
  while (args.length > 0) {
    const name = args.shift(), value = Number(args.shift());
    assert.ok(Number.isSafeInteger(value) && value >= 0, `performance_option_invalid:${name}`);
    if (name === '--samples') {
      assert.ok(value > 0, 'performance_samples_required');
      options.samples = value;
    } else if (name === '--idle-minutes') options.idleMinutes = value;
    else throw new Error(`performance_option_unknown:${name}`);
  }
  return options;
}
