import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { cpus, platform, arch, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';

// Development-only comparison. Candidate modules live outside the production dependency graph.
// Run from repo root after installing gpt-tokenizer@4.1.0 in .runtime/phase6-tokenizer:
// ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/benchmarks/phase-6-tokenizer/compare.mjs
const root = process.cwd();
const script = fileURLToPath(import.meta.url);
const experiment = resolve(root, '.runtime/phase6-tokenizer');
const buildDir = resolve(experiment, 'build');
const candidateDir = resolve(experiment, 'node_modules/gpt-tokenizer/esm/encoding');
const sourcePath = resolve(root, 'src/main/services/deep-agent/context/context-token-budget.ts');
const baselineRef = process.env.ROC_TOKENIZER_BASELINE_REF ?? '5f80ed9cc81fc11c26bc536e5ec0a33289e49308';
function baselineFile(path) {
  const result = spawnSync('git', ['show', `${baselineRef}:${path}`], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`baseline_file_unavailable:${path}\n${result.stderr}`);
  return result.stdout;
}
const baselineSource = baselineFile('src/main/services/deep-agent/context/context-token-budget.ts');
const corpusPath = resolve(experiment, 'corpus.json');
const mergeCache = process.env.ROC_TOKENIZER_MERGE_CACHE ?? 'default';
const resultPath = resolve(root, `scripts/benchmarks/phase-6-tokenizer/results-${mergeCache === 'off' ? 'no-merge-cache' : 'default-cache'}.json`);
const sampleCount = Number(process.env.ROC_TOKENIZER_SAMPLES ?? 10);
const iterations = Number(process.env.ROC_TOKENIZER_ITERATIONS ?? 12);
const models = ['gpt2', 'davinci', 'text-davinci-003', 'text-davinci-edit-001', 'gpt-3.5-turbo', 'gpt-4o'];

function sha256(data) { return createHash('sha256').update(data).digest('hex'); }
function parseJson(text, label) {
  try { return JSON.parse(text); }
  catch (cause) { throw new Error(`invalid_json:${label}`, { cause }); }
}
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: Number(sorted[Math.floor((sorted.length - 1) * 0.5)].toFixed(3)),
    p95: Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(3))
  };
}
async function timed(fn) {
  const started = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - started };
}
async function timedWithEventLoop(fn) {
  const started = performance.now();
  const tick = new Promise((resolveTick) => setTimeout(() => resolveTick(performance.now() - started), 0));
  const result = await timed(fn);
  return { ...result, eventLoopDelayMs: await tick };
}
function messages(corpus, includeLong = true) {
  const result = [
    new HumanMessage({ id: 'human-1', content: corpus.paperEnglish }),
    new AIMessage({ id: 'assistant-1', content: corpus.chinese, tool_calls: [{ id: 'call-1', name: 'search_docs', args: { query: '结果与方法' }, type: 'tool_call' }] }),
    new ToolMessage({ id: 'tool-1', tool_call_id: 'call-1', name: 'search_docs', content: includeLong ? corpus.longToolOutput : corpus.toolOutput }),
    new HumanMessage({ id: 'human-2', content: corpus.unicode }),
    new AIMessage({ id: 'assistant-2', content: corpus.code })
  ];
  return result;
}
function tools(corpus) {
  return [{
    name: 'search_docs', description: 'Search indexed research documents and return source snippets.',
    schema: { type: 'object', properties: { query: { type: 'string', description: corpus.chinese.slice(0, 100) }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['query'], additionalProperties: false }
  }];
}
function counter(api, modelId, extra = {}) {
  return api.createContextTokenCounter({ modelId, providerType: 'openai_compatible', baseUrl: 'https://api.openai.com/v1', ...extra });
}
async function worker(mode, model, variant) {
  const corpus = parseJson(readFileSync(corpusPath, 'utf8'), corpusPath);
  const imported = await timed(() => import(pathToFileURL(resolve(buildDir, `${variant}.mjs`)).href));
  const api = imported.value;
  const c = counter(api, model);
  const first = await timed(() => c.countText(corpus.paperEnglish));
  const input = { contextWindowTokens: 128_000, counter: c, systemPrompt: corpus.systemPrompt, tools: tools(corpus) };
  const firstProfile = await timed(() => api.deriveContextBudgetProfile(input));
  const firstMessages = await timedWithEventLoop(() => c.countMessages(messages(corpus)));
  const small = messages(corpus, false);
  await c.countMessages(small);
  const cacheHit = [], uncachedMessages = [], uncachedText = [], longEventLoopDelay = [], profileCached = [];
  const runs = mode === 'semantic' ? 2 : iterations;
  for (let i = 0; i < runs; i += 1) {
    cacheHit.push((await timed(() => c.countMessages(small))).ms);
    uncachedMessages.push((await timed(() => counter(api, model).countMessages(small))).ms);
    const longRun = await timedWithEventLoop(() => c.countText(corpus.longToolOutput));
    uncachedText.push(longRun.ms);
    longEventLoopDelay.push(longRun.eventLoopDelayMs);
    profileCached.push((await timed(() => api.deriveContextBudgetProfile(input))).ms);
  }
  const counts = {};
  for (const [name, text] of Object.entries(corpus.samples)) counts[name] = await c.countText(text);
  const fuzzCounts = mode === 'semantic' ? await Promise.all(corpus.fuzz.map((text) => c.countText(text))) : [];
  const longCount = await c.countText(corpus.longToolOutput);
  const messageCount = await c.countMessages(messages(corpus, false));
  const otherProvider = await counter(api, model, { providerType: 'anthropic', baseUrl: null }).countText(corpus.unicode);
  const unknownModel = await counter(api, 'unknown-roc-test-model').countText(corpus.unicode);
  assert.equal(messageCount.estimated, true);
  assert.equal(otherProvider.estimated, true);
  assert.equal(unknownModel.estimated, true);
  assert.ok(Buffer.byteLength(corpus.longToolOutput, 'utf8') > 131072);
  return {
    variant, model, mode, importMs: imported.ms, coldFirstMs: first.ms, firstProfileMs: firstProfile.ms,
    firstMessagesMs: firstMessages.ms, firstMessagesEventLoopDelayMs: firstMessages.eventLoopDelayMs,
    cacheHitMs: stats(cacheHit), uncachedMessagesMs: stats(uncachedMessages),
    uncachedLongTextMs: stats(uncachedText), longEventLoopDelayMs: stats(longEventLoopDelay), profileCachedMs: stats(profileCached),
    peakRssKb: process.resourceUsage().maxRSS, rssBytes: process.memoryUsage().rss,
    counts, fuzzCounts, longCount, first: first.value, profile: firstProfile.value, messageCount, otherProvider, unknownModel
  };
}
async function makeCorpus() {
  // The existing PDF is a generated one-page English paper fixture, not private user content.
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({ data: new Uint8Array(readFileSync('tests/smoke/lib/assets/p5-paper.pdf')), disableFontFace: true });
  const doc = await loading.promise;
  const page = await doc.getPage(1);
  const paper = parseJson(readFileSync('tests/fixtures/architecture-repair/tokenizer-paper-excerpts.json', 'utf8'), 'tokenizer-paper-excerpts');
  const paperEnglish = `${paper.englishAbstract}\n${(await page.getTextContent()).items.map((item) => item.str ?? '').join(' ')}`;
  await loading.destroy();
  assert.ok(paperEnglish.length > 200);
  const chinese = paper.chineseAbstract;
  const code = baselineSource.slice(0, 4000);
  const toolOutput = JSON.stringify({ results: Array.from({ length: 8 }, (_, i) => ({ source: `paper-${i}`, snippet: paperEnglish.slice(i * 20, i * 20 + 150), citation: `文献 ${i}` })) });
  const longToolOutput = JSON.stringify({ results: Array.from({ length: 500 }, (_, i) => ({ source: `paper-${i}`, snippet: paperEnglish, annotation: `${chinese} item=${i}` })) });
  const unicode = 'Special literals <|endoftext|> <|fim_prefix|> <|fim_middle|> <|endofprompt|>; Unicode 中文 English é é Ελληνικά العربية 👩🏽‍🔬 🧪 🇨🇳\n\t';
  const jsonSchema = JSON.stringify(tools({ chinese })[0].schema);
  let seed = 0x5eed1234;
  const alphabet = ['a', 'Z', ' ', '\n', '\t', '\0', '中', '文', 'é', 'e\u0301', 'ع', 'א', '🙂', '👩🏽‍🔬', '<|endoftext|>', '<|fim_prefix|>', '\ud800', '\udfff'];
  const fuzz = Array.from({ length: 256 }, () => {
    let text = '';
    for (let i = 0; i < 24; i += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      text += alphabet[seed % alphabet.length];
    }
    return text;
  });
  return {
    paperEnglish, chinese, code, toolOutput, longToolOutput, unicode, fuzz,
    systemPrompt: '你是 Roc 的检索子代理。优先用 web_read 读取原文；只输出相关结论，区分外部事实与判断，并标明来源。',
    samples: { paperEnglish, chinese, code, jsonSchema, toolOutput, unicode,
      empty: '', specialOnly: '<|endoftext|><|fim_prefix|><|fim_middle|><|fim_suffix|><|endofprompt|>',
      loneSurrogate: 'invalid \ud800 and \udfff', emoji: '🧪👩🏽‍🔬🇨🇳👨‍👩‍👧‍👦', mixed: 'A\u0301\t العربية\r\n中🙂\0',
      bomAfterSpace: ' \uFEFFa', bomAfterTab: ' \t\uFEFF', repeatedBom: ' \uFEFFa'.repeat(1000) }
  };
}
async function compileVariants() {
  mkdirSync(buildDir, { recursive: true });
  const original = baselineSource;
  const start = original.indexOf('async function loadTokenizer(');
  const end = original.indexOf('export function createContextTokenCounter(', start);
  assert.ok(start >= 0 && end > start, 'production tokenizer seam changed');
  // Preserve the baseline counter, cache, message projection and model mapping.
  // A rejected ESM evaluation stays cached by the runtime, so this prototype does
  // not preserve baseline retry behavior after a candidate initialization failure.
  // Disallowed/allowed sets are empty, matching production's tokenizer.encode(text, [], []).
  const candidateLoader = `async function loadTokenizer(modelId: string): Promise<Tokenizer | null> {
    const module = await import('js-tiktoken/lite');
    let name: TokenizerEncodingName;
    try { name = module.getEncodingNameForModel(modelId as TiktokenModel); } catch { return null; }
    let tokenizer = tokenizers.get(name);
    if (tokenizer === undefined) {
      const paths: Record<TokenizerEncodingName, string> = ${JSON.stringify(Object.fromEntries(['gpt2', 'r50k_base', 'p50k_base', 'p50k_edit', 'cl100k_base', 'o200k_base'].map((name) => [name, pathToFileURL(resolve(candidateDir, `${name}.js`)).href])))};
      tokenizer = import(paths[name]).then((candidate) => {
        ${mergeCache === 'off' ? 'candidate.setMergeCacheSize(0);' : ''}
        return { encode: (text: string) => candidate.encode(text, { allowedSpecial: new Set(), disallowedSpecial: new Set() }) } as Tokenizer;
      });
      tokenizers.set(name, tokenizer);
    }
    try { return await tokenizer; } catch (error) { if (tokenizers.get(name) === tokenizer) tokenizers.delete(name); throw error; }
  }\n\n`;
  for (const [variant, content] of [['baseline', original], ['candidate', original.slice(0, start) + candidateLoader + original.slice(end)]]) {
    await build({ stdin: { contents: content, resolveDir: resolve(root, 'src/main/services/deep-agent/context'), sourcefile: sourcePath, loader: 'ts' }, outfile: resolve(buildDir, `${variant}.mjs`), bundle: true, packages: 'external', format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent' });
  }
}
function runChild(mode, model, variant) {
  const result = spawnSync(process.execPath, [script, '--worker', mode, model, variant], { encoding: 'utf8', env: process.env, maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`worker failed: ${mode} ${model} ${variant}\n${result.stderr}\n${result.stdout}`);
  return parseJson(result.stdout, `worker:${mode}:${model}:${variant}`);
}
async function main() {
  assert.ok(Number.isInteger(sampleCount) && sampleCount >= 2 && Number.isInteger(iterations) && iterations >= 2);
  assert.ok(mergeCache === 'default' || mergeCache === 'off', 'ROC_TOKENIZER_MERGE_CACHE must be default or off');
  await compileVariants();
  const corpus = await makeCorpus();
  const corpusJson = JSON.stringify(corpus);
  writeFileSync(corpusPath, corpusJson);
  const semantic = [];
  for (const model of models) {
    const left = runChild('semantic', model, 'baseline');
    const right = runChild('semantic', model, 'candidate');
    semantic.push({ model, baseline: { counts: left.counts, fuzzCounts: left.fuzzCounts, longCount: left.longCount, first: left.first, profile: left.profile, messageCount: left.messageCount, otherProvider: left.otherProvider, unknownModel: left.unknownModel }, candidate: { counts: right.counts, fuzzCounts: right.fuzzCounts, longCount: right.longCount, first: right.first, profile: right.profile, messageCount: right.messageCount, otherProvider: right.otherProvider, unknownModel: right.unknownModel } });
    if (JSON.stringify(semantic.at(-1).candidate) !== JSON.stringify(semantic.at(-1).baseline)) {
      const rejection = {
        decision: 'no-go', model, baselineRef,
        baselineSourceSha256: sha256(baselineSource), baselineLockfileSha256: sha256(baselineFile('pnpm-lock.yaml')),
        workingLockfileSha256: sha256(readFileSync('pnpm-lock.yaml')),
        benchmarkSha256: sha256(readFileSync(script)), corpusSha256: sha256(corpusJson),
        candidatePackageSha256: sha256(readFileSync(resolve(experiment, 'node_modules/gpt-tokenizer/package.json'))),
        baselinePackageSha256: sha256(readFileSync('node_modules/js-tiktoken/package.json')),
        mergeCache, environment: { node: process.version, electron: process.versions.electron ?? null },
        baselineCounts: left.counts, candidateCounts: right.counts
      };
      const rejectionPath = resolve(experiment, 'semantic-rejection.json');
      writeFileSync(rejectionPath, `${JSON.stringify(rejection, null, 2)}\n`);
      throw new Error(`semantic mismatch for ${model}; no-go record: ${rejectionPath}`);
    }
  }
  const samples = [];
  for (let i = 0; i < sampleCount; i += 1) {
    for (const model of ['gpt-3.5-turbo', 'gpt-4o']) {
      // Alternate order to limit drift from background load/thermal conditions.
      for (const variant of i % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) samples.push(runChild('performance', model, variant));
    }
    process.stderr.write(`sample ${i + 1}/${sampleCount} complete\n`);
  }
  const metrics = {};
  for (const model of ['gpt-3.5-turbo', 'gpt-4o']) {
    metrics[model] = {};
    for (const variant of ['baseline', 'candidate']) {
      const selected = samples.filter((x) => x.model === model && x.variant === variant);
      metrics[model][variant] = Object.fromEntries(['importMs', 'coldFirstMs', 'firstProfileMs', 'firstMessagesMs', 'firstMessagesEventLoopDelayMs', 'peakRssKb'].map((key) => [key, stats(selected.map((x) => x[key]))]));
      for (const key of ['cacheHitMs', 'uncachedMessagesMs', 'uncachedLongTextMs', 'longEventLoopDelayMs', 'profileCachedMs']) metrics[model][variant][key] = { processP50: stats(selected.map((x) => x[key].p50)), processP95: stats(selected.map((x) => x[key].p95)) };
    }
  }
  const output = {
    sourceCommit: baselineRef,
    lockfileSha256: sha256(baselineFile('pnpm-lock.yaml')), sourceSha256: sha256(baselineSource), corpusSha256: sha256(corpusJson),
    environment: { node: process.version, electron: process.versions.electron ?? null, platform: platform(), arch: arch(), kernel: release(), cpu: cpus()[0]?.model },
    dependencyVersions: { baseline: parseJson(readFileSync('node_modules/js-tiktoken/package.json', 'utf8'), 'js-tiktoken/package.json').version, candidate: parseJson(readFileSync(resolve(experiment, 'node_modules/gpt-tokenizer/package.json'), 'utf8'), 'gpt-tokenizer/package.json').version },
    sampling: { processesPerVariantPerModel: sampleCount, iterationsPerProcess: iterations, candidateMergeCache: mergeCache, order: 'alternating', memory: 'process.resourceUsage().maxRSS in KiB, includes common process baseline' },
    corpus: Object.fromEntries(Object.entries(corpus).filter(([name]) => name !== 'samples').map(([name, value]) => { const text = typeof value === 'string' ? value : JSON.stringify(value); return [name, { bytes: Buffer.byteLength(text), sha256: sha256(text) }]; })),
    semantic, metrics, samples
  };
  writeFileSync(resultPath, `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ resultPath, semanticMismatches: semantic.flatMap(({ model, baseline, candidate }) => JSON.stringify(baseline) === JSON.stringify(candidate) ? [] : [model]), metrics }, null, 2)}\n`);
}
if (process.argv[2] === '--worker') {
  process.stdout.write(JSON.stringify(await worker(process.argv[3], process.argv[4], process.argv[5])));
} else {
  await main();
}
