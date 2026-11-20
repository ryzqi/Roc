import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const directory = mkdtempSync(join(tmpdir(), 'roc-model-context-'));
const outfile = join(directory, 'policy.mjs');
await build({ entryPoints: ['src/shared/model-context.ts'], outfile, bundle: true, format: 'esm', platform: 'node' });
const policy = await import(outfile);

test('model output settings fit the provider context window', () => {
  assert.equal(policy.resolveRunModelOutputTokens(100_000), 16_384);
  assert.equal(policy.resolveRunModelOutputTokens(100_000, 8_000), 8_000);
  assert.equal(policy.resolveRunModelOutputTokens(20_000), 5_000);
  assert.throws(() => policy.resolveRunModelOutputTokens(0), /model_output_limit_invalid/);
});

test.after(() => rmSync(directory, { recursive: true, force: true }));
