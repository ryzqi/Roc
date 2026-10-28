import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Tiktoken } from 'js-tiktoken/lite';

// Development-only: install gpt-tokenizer@4.1.0 under .runtime/phase6-tokenizer.
// Run with ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/benchmarks/phase-6-tokenizer/incompatibility.mjs
const inputs = [' \uFEFFa', ' \t\uFEFF', ' \uFEFFa'.repeat(1000)];
for (const name of ['cl100k_base', 'o200k_base']) {
  const ranks = await import(`js-tiktoken/ranks/${name}`);
  const baseline = new Tiktoken(ranks.default);
  const modulePath = resolve('.runtime/phase6-tokenizer/node_modules/gpt-tokenizer/esm/encoding', `${name}.js`);
  const candidate = await import(pathToFileURL(modulePath).href);
  candidate.setMergeCacheSize(0);
  const expected = [[3, 2], [2, 3], [3000, 2000]];
  for (let index = 0; index < inputs.length; index += 1) {
    const text = inputs[index];
    const actual = [baseline.encode(text, [], []).length,
      candidate.encode(text, { allowedSpecial: new Set(), disallowedSpecial: new Set() }).length];
    assert.deepEqual(actual, expected[index], `${name}: ${JSON.stringify(text.slice(0, 12))}`);
    console.log(JSON.stringify({ encoding: name, input: index === 2 ? '" \\uFEFFa" repeated 1000 times' : JSON.stringify(text), baseline: actual[0], candidate: actual[1] }));
  }
}
