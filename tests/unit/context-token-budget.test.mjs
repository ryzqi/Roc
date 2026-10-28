import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import * as esbuild from 'esbuild';

const contextTokenBudgetSource = 'src/main/services/deep-agent/context/context-token-budget.ts';
const rankNames = ['gpt2', 'r50k_base', 'p50k_base', 'p50k_edit', 'cl100k_base', 'o200k_base'];
const exactSamples = {
  english: ['The quick brown fox jumps over the lazy dog. Token counting should preserve punctuation and whitespace.', 18],
  chinese: ['在正式的 OpenAI 端点上，token 计数应按模型加载对应的编码。', 22],
  code: ['function add(a: number, b: number): number { return a + b; }\nconsole.log(add(21, 21));', 27],
  toolJson: [JSON.stringify({
    name: 'search_docs',
    description: 'Search indexed research documents.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1 } },
      required: ['query'],
      additionalProperties: false
    }
  }), 49]
};

let directory;
let api;
let compiledSource;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-context-token-budget-'));
  symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
  const outfile = join(directory, 'context-token-budget.mjs');
  await esbuild.build({
    entryPoints: [contextTokenBudgetSource],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    packages: 'external',
    logLevel: 'silent'
  });
  compiledSource = readFileSync(outfile, 'utf8');
  api = await import(outfile);
});

after(() => rmSync(directory, { recursive: true, force: true }));

function counter(overrides = {}) {
  return api.createContextTokenCounter({
    modelId: 'gpt-4o',
    providerType: 'openai_compatible',
    baseUrl: 'https://api.openai.com/v1',
    ...overrides
  });
}

test('compiled tokenizer imports lite code and exposes each rank as a separate dynamic import', () => {
  assert.match(compiledSource, /import\(["']js-tiktoken\/lite["']\)/u);
  assert.doesNotMatch(compiledSource, /import\(["']js-tiktoken["']\)/u);
  for (const rank of rankNames) {
    assert.match(compiledSource, new RegExp(`import\\(["']js-tiktoken/ranks/${rank}["']\\)`, 'u'));
  }
});

test('cold gpt-4o counting resolves only the model-selected ranks module', () => {
  const loaderPath = join(directory, 'trace-rank-imports.mjs');
  const runnerPath = join(directory, 'trace-rank-selection.mjs');
  const tracePath = join(directory, 'rank-imports.txt');
  writeFileSync(loaderPath, `
    import { appendFileSync } from 'node:fs';
    export async function resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('js-tiktoken/ranks/')) appendFileSync(process.env.ROC_TOKENIZER_RANK_TRACE, specifier + '\\n');
      return nextResolve(specifier, context);
    }
  `);
  writeFileSync(runnerPath, `
    import assert from 'node:assert/strict';
    import { createContextTokenCounter } from './context-token-budget.mjs';
    const counter = createContextTokenCounter({ modelId: 'gpt-4o', providerType: 'openai_compatible', baseUrl: 'https://api.openai.com/v1' });
    const result = await counter.countText('first exact count');
    assert.equal(result.estimated, false);
  `);
  const result = spawnSync(process.execPath, ['--experimental-loader', loaderPath, runnerPath], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, ROC_TOKENIZER_RANK_TRACE: tracePath }
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(readFileSync(tracePath, 'utf8').trim().split('\n'), ['js-tiktoken/ranks/o200k_base']);
});

test('concurrent first counts across counters return exact cl100k text counts', async () => {
  const counters = Array.from({ length: 8 }, () => counter({ modelId: 'gpt-3.5-turbo' }));
  const results = await Promise.all(counters.map((instance) => instance.countText('Parallel tokenizer initialization should be exact.')));
  assert.deepEqual(results.map((result) => result.estimated), Array(8).fill(false));
  assert.equal(new Set(results.map((result) => result.tokens)).size, 1);
});

test('official counters preserve whitespace-sensitive exact counts', async () => {
  for (const modelId of ['gpt-3.5-turbo', 'gpt-4o']) {
    const instance = counter({ modelId });
    assert.deepEqual(await instance.countText(' \uFEFFa'), { estimated: false, tokens: 3 });
    assert.deepEqual(await instance.countText(' \t\uFEFF'), { estimated: false, tokens: 2 });
    assert.deepEqual(await instance.countText(' \uFEFFa'.repeat(1000)), { estimated: false, tokens: 3000 });
  }
});

test('a failed lazy ranks import can be retried with the same counter', () => {
  const loaderPath = join(directory, 'fail-one-rank-load.mjs');
  const runnerPath = join(directory, 'retry-rank-load.mjs');
  writeFileSync(loaderPath, `
    let failNextRankLoad = true;
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === 'js-tiktoken/ranks/p50k_base' && failNextRankLoad) {
        failNextRankLoad = false;
        throw new Error('transient_rank_import_failure');
      }
      return nextResolve(specifier, context);
    }
  `);
  writeFileSync(runnerPath, `
    import assert from 'node:assert/strict';
    import { createContextTokenCounter } from './context-token-budget.mjs';
    const counter = createContextTokenCounter({ modelId: 'text-davinci-003', providerType: 'openai_compatible', baseUrl: 'https://api.openai.com/v1' });
    await assert.rejects(counter.countText('first rank load'), /transient_rank_import_failure/u);
    const result = await counter.countText('retry rank load');
    assert.equal(result.estimated, false);
    assert.ok(result.tokens > 0);
  `);
  const result = spawnSync(process.execPath, ['--experimental-loader', loaderPath, runnerPath], {
    cwd: directory,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('official gpt-4o counts English, Chinese, code and tool JSON exactly', async () => {
  const instance = counter();
  for (const [text, tokens] of Object.values(exactSamples)) {
    assert.deepEqual(await instance.countText(text), { estimated: false, tokens });
  }
  assert.equal(instance.wasEstimated(), false);
});

test('cached text counts stay exact while message framing remains estimated', async () => {
  const instance = counter();
  const first = await instance.countText(exactSamples.english[0]);
  assert.strictEqual(await instance.countText(exactSamples.english[0]), first);
  assert.equal(instance.wasEstimated(), false);

  const messageCount = await instance.countMessages([new HumanMessage('Summarize the attached result.')]);
  assert.equal(messageCount.estimated, true);
  assert.ok(messageCount.tokens > 8);
  assert.equal(instance.wasEstimated(), true);
});

test('unknown models and non-official providers use conservative byte estimates', async () => {
  const unknownModel = counter({ modelId: 'unmapped-openai-model' });
  assert.deepEqual(await unknownModel.countText('unknown model'), {
    estimated: true,
    tokens: Buffer.byteLength('unknown model', 'utf8')
  });

  for (const providerInput of [
    { providerType: 'anthropic', baseUrl: null },
    { providerType: 'openai_compatible', baseUrl: 'https://gateway.example/v1' }
  ]) {
    const otherProvider = counter(providerInput);
    assert.deepEqual(await otherProvider.countText('abc'), { estimated: true, tokens: 3 });
    assert.equal(otherProvider.wasEstimated(), true);
  }
});
