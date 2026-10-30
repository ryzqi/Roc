import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const directory = mkdtempSync(join(tmpdir(), 'roc-run-budget-policy-'));
const outfile = join(directory, 'policy.mjs');
await build({ entryPoints: ['src/shared/run-budget-policy.ts'], outfile, bundle: true, format: 'esm', platform: 'node' });
const policy = await import(outfile);

test('model output and reservation limits use the frozen provider cap plus safety margin', () => {
  assert.equal(policy.resolveRunModelOutputTokens(100_000), 16_384);
  assert.equal(policy.resolveRunModelOutputTokens(100_000, 8_000), 8_000);
  assert.equal(policy.resolveRunModelOutputTokens(20_000), 5_000);
  assert.equal(policy.deriveModelCallTokenReservation(100_000, 16_384), 121_384);
  assert.equal(policy.deriveModelCallTokenReservation(1_000, 250), 1_378);
  assert.throws(() => policy.resolveRunModelOutputTokens(0), /run_budget_output_limit_invalid/);
});

test('microdollar pricing rounds up and accounts for input, output and cache rates', () => {
  const price = {
    providerId: 'fixture-provider',
    modelId: 'fixture-model',
    effectiveFrom: '2026-10-29',
    effectiveUntil: null,
    inputMicrousdPerMillionTokens: 2_000_000,
    outputMicrousdPerMillionTokens: 10_000_000,
    cacheReadMicrousdPerMillionTokens: 500_000,
    cacheWriteMicrousdPerMillionTokens: 3_000_000,
    source: 'fixture'
  };

  assert.equal(policy.calculateModelCostMicrousd({
    inputTokens: 2_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 500_000,
    cacheWriteTokens: 250_000,
    price
  }), 13_500_000);
  assert.equal(policy.estimateModelReservationMicrousd({ inputTokens: 1_000_000, outputTokens: 1_000_000, price }), 13_000_000);
  assert.equal(policy.calculateModelCostMicrousd({ inputTokens: 1, outputTokens: 0, price: { ...price, inputMicrousdPerMillionTokens: 1 } }), 1);
  assert.equal(policy.calculateModelCostMicrousd({ inputTokens: 10, outputTokens: 0, cacheReadTokens: 8, cacheWriteTokens: 3, price }), null);
  assert.equal(policy.calculateModelCostMicrousd({ inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 0, price }), null);
});

test('empty verified-price catalog stays unknown for aliases and custom models', () => {
  assert.equal(policy.RUN_MODEL_PRICING_CATALOG.entries.length, 0);
  assert.equal(policy.resolveModelPricing({
    catalogVersion: policy.RUN_MODEL_PRICING_CATALOG.version,
    providerId: 'provider',
    modelId: 'mutable-alias',
    asOf: '2026-10-30T00:00:00.000Z'
  }), null);
});

test.after(() => rmSync(directory, { recursive: true, force: true }));
