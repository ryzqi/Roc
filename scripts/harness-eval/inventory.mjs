import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const hash = (value) => createHash('sha256').update(value).digest('hex');

// Only versioned repository bytes. Never inspect a user's provider config, environment or DB.
export function createInventory({ readComponent = readFileSync, sourceInputs = [] } = {}) {
  const paths = execFileSync('git', ['ls-files', '-z', '--',
    'src/main/services/deep-agent', 'src/main/services/forge-guardrails',
    'src/main/plugins/agent', 'src/main/services/agent',
    'src/shared/schemas/agent.ts', 'resources', 'skills', 'package.json', 'pnpm-lock.yaml'
  ], { encoding: 'utf8' }).split('\0').filter(Boolean).sort();
  const fixturePaths = ['scripts/harness-eval/inventory.mjs', 'scripts/harness-eval/scenarios.mjs',
    'scripts/harness-eval/runtime.ts', 'scripts/harness-eval/run.mjs'];
  const components = [...new Set([...paths, ...fixturePaths, ...sourceInputs])].sort()
    .map((path) => ({ path, hash: hash(readComponent(path)) }));
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const revision = {
    schemaVersion: 1,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    dependencies: pkg.dependencies,
    provider: { kind: 'loopback-fixture', model: 'roc-pilot', credentials: 'synthetic' },
    components
  };
  return { ...revision, hash: hash(JSON.stringify(revision)) };
}
