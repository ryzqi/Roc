import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const { withResearchProcessGuard, researchProcessGuardHash } = await importTypeScriptModule(
  'src/main/plugins/research/process-guard.ts', { platform: 'node' });

test('parallel native launches retain output and actual exit status while establishing the computation group',
  { timeout: 180_000 }, async () => {
    assert.equal(process.platform, 'darwin');
    const iterations = 2048, concurrency = 32;
    const results = [];
    const launch = iteration => withResearchProcessGuard((executable, remove) => new Promise((resolve, reject) => {
      const child = spawn(executable, [String(process.pid), '/usr/bin/sandbox-exec', '-p',
        '(version 1) (allow default)', '/bin/sh', '-c',
        'printf "EARLIER_ACTUAL_OUTPUT\\n"; printf "EXPECTED_FAILURE\\n" >&2; exit 1'],
      { detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', control = '', removal;
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.stdio[3].on('data', chunk => {
        control += chunk;
        if (removal === undefined && control.includes('\n')) removal = remove();
      });
      child.on('error', reject);
      child.on('close', (exitCode, signal) => {
        void Promise.resolve(removal).then(() => resolve({ iteration, exitCode, signal, stdout, stderr, control }), reject);
      });
      child.stdin.end();
    }));
    for (let start = 0; start < iterations; start += concurrency) {
      results.push(...await Promise.all(Array.from({ length: concurrency }, (_, offset) => launch(start + offset))));
    }
    const failures = results.filter(result => result.exitCode !== 0 || result.signal !== null
      || !/^[1-9]\d*\nexit 1\n$/u.test(result.control)
      || result.stdout !== 'EARLIER_ACTUAL_OUTPUT\n' || result.stderr !== 'EXPECTED_FAILURE\n');
    const directory = '.artifacts/research-toolchain-p2';
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/native-guard-startup-${researchProcessGuardHash()}.json`,
      `${JSON.stringify({ guardHash: researchProcessGuardHash(), iterations, concurrency, failures }, null, 2)}\n`);
    assert.deepEqual(failures, []);
  });
