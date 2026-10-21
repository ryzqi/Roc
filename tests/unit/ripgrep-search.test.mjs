import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

/**
 * ripgrep 集成的两面：**参数与解析**（纯逻辑）和**真的跑一次 rg**（真实二进制）。
 *
 * 为什么两者都要：
 *
 *   1. `parseRipgrepMatchLine` 是 rg `--json` 与 `FileSearchResult` 之间的唯一转换点。
 *      行号、列号、路径归一化错一位，UI 上就是“点了跳到错误的位置”，而那是最难被
 *      静态阅读发现的一类 bug；
 *   2. `buildRipgrepArgs` 少一个 `--fixed-strings` 就把用户的字面量当正则，少一个 `--no-config`
 *      就让结果取决于 `RIPGREP_CONFIG_PATH`。这些开关只能用断言钉住；
 *   3. 单测只证明“逻辑对”，不证明“随包二进制能跑”。`resources/ripgrep-binaries/` 是随包
 *      资源，缺失时两条调用面都会**静默降级**——所以真跑一次，并断言降级路径本身也可用。
 */

const repoRoot = new URL('../../', import.meta.url).pathname;
// 顶层 await 而不是 `before`：`skip` 在注册测试时就求值，那时 `before` 还没跑。
const ripgrep = await importTypeScriptModule('src/main/services/ripgrep-service.ts', { platform: 'node' });
const fileServiceModule = await importTypeScriptModule('src/main/services/file-service.ts', { platform: 'node' });
const tempRoot = mkdtempSync(join(tmpdir(), 'roc-ripgrep-'));

after(() => {
  if (tempRoot !== undefined) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* rg --json → FileSearchResult                                        */
/* ------------------------------------------------------------------ */

const matchLine = JSON.stringify({
  type: 'match',
  data: {
    path: { text: './notes/chapter-1.md' },
    lines: { text: '  the effect size was d = 0.42\n' },
    line_number: 12,
    absolute_offset: 240,
    submatches: [{ match: { text: 'effect' }, start: 6, end: 12 }]
  }
});

test('a match event becomes a path/line/column/preview row', () => {
  const match = ripgrep.parseRipgrepMatchLine(matchLine, 'effect');
  assert.deepEqual(match, {
    relativePath: 'notes/chapter-1.md',
    line: 12,
    column: 7,
    preview: 'the effect size was d = 0.42',
    text: '  the effect size was d = 0.42'
  });
});

test('non-match events and malformed lines are dropped, not guessed', () => {
  assert.equal(ripgrep.parseRipgrepMatchLine(JSON.stringify({ type: 'begin', data: { path: { text: './a.md' } } }), 'x'), null);
  assert.equal(ripgrep.parseRipgrepMatchLine(JSON.stringify({ type: 'summary', data: {} }), 'x'), null);
  assert.equal(ripgrep.parseRipgrepMatchLine('{"type":"match","data":', 'x'), null);
  assert.equal(ripgrep.parseRipgrepMatchLine('not json at all', 'x'), null);
});

test('a non-UTF-8 path is skipped instead of producing a mangled path', () => {
  const event = JSON.stringify({
    type: 'match',
    data: {
      path: { bytes: 'Zm9v' },
      lines: { text: 'foo\n' },
      line_number: 1,
      submatches: [{ start: 0, end: 3 }]
    }
  });
  assert.equal(ripgrep.parseRipgrepMatchLine(event, 'foo'), null);
});

test('the column falls back to the submatch byte offset when the literal is absent', () => {
  // 只可能在 rg 的匹配与 `indexOf` 不一致时发生（例如上游改了大小写策略）。宁可给个
  // 近似列号，也不要给 0 之后点的光标位置。
  const event = JSON.stringify({
    type: 'match',
    data: {
      path: { text: 'a.md' },
      lines: { text: 'Some Line\n' },
      line_number: 3,
      submatches: [{ start: 5, end: 9 }]
    }
  });
  assert.equal(ripgrep.parseRipgrepMatchLine(event, 'some').column, 6);
});

test('paths are normalized to POSIX without a leading ./', () => {
  assert.equal(ripgrep.normalizeRipgrepPath('./a/b.md'), 'a/b.md');
  assert.equal(ripgrep.normalizeRipgrepPath('a/b.md'), 'a/b.md');
  assert.equal(ripgrep.normalizeRipgrepPath(join('a', 'b.md')), 'a/b.md');
});

/* ------------------------------------------------------------------ */
/* 参数：哪几个开关不能丢                                              */
/* ------------------------------------------------------------------ */

test('the argument list is literal, config-free, and passes the query after --', () => {
  const args = ripgrep.buildRipgrepArgs({ rootDir: '/w', query: '-foo' });
  assert.ok(args.includes('--fixed-strings'), 'literal search, otherwise a query is a regex');
  assert.ok(args.includes('--no-config'), 'a user RIPGREP_CONFIG_PATH must not change our results');
  assert.deepEqual(args.slice(args.indexOf('--')), ['--', '-foo', '.']);
});

test('hidden files, size caps and directory exclusions become explicit flags', () => {
  const args = ripgrep.buildRipgrepArgs({
    rootDir: '/w',
    query: 'foo',
    target: 'papers',
    includeHidden: true,
    maxFileSizeBytes: 4096,
    excludeDirectories: ['node_modules'],
    glob: '*.md'
  });
  assert.ok(args.includes('--hidden'));
  assert.deepEqual(args.slice(args.indexOf('--max-filesize'), args.indexOf('--max-filesize') + 2), ['--max-filesize', '4096']);
  assert.ok(args.includes('!node_modules/**'));
  assert.ok(args.includes('!**/node_modules/**'));
  assert.deepEqual(args.slice(args.indexOf('--')), ['--', 'foo', 'papers']);
  assert.ok(args.includes('*.md'));
});

test('disabling ignore rules covers repo, parent and global gitignore', () => {
  // 只加 --no-ignore 会留下「上层目录的 .gitignore」与「全局 gitignore」两个后门，
  // 于是 `files.search` 又会变得取决于用户在别处装了什么。
  const args = ripgrep.buildRipgrepArgs({ rootDir: '/w', query: 'foo', disableIgnoreRules: true });
  for (const flag of ['--no-ignore', '--no-ignore-parent', '--no-ignore-global']) {
    assert.ok(args.includes(flag), `${flag} is required for ignore-independent results`);
  }
  const respecting = ripgrep.buildRipgrepArgs({ rootDir: '/w', query: 'foo' });
  assert.equal(respecting.some((arg) => arg.startsWith('--no-ignore')), false);
});

/* ------------------------------------------------------------------ */
/* 二进制定位                                                          */
/* ------------------------------------------------------------------ */

test('the binary path follows the packaged resources layout and arch', () => {
  const arm = new ripgrep.RipgrepBinaryManager({ arch: 'arm64', resourcesPath: '/Applications/Roc.app/Contents/Resources' });
  assert.equal(arm.getBinaryPath(), '/Applications/Roc.app/Contents/Resources/ripgrep-binaries/darwin-arm64/rg');
  const x64 = new ripgrep.RipgrepBinaryManager({ arch: 'x64', resourcesPath: '/Applications/Roc.app/Contents/Resources' });
  assert.equal(x64.getBinaryPath(), '/Applications/Roc.app/Contents/Resources/ripgrep-binaries/darwin-x64/rg');
  assert.equal(new ripgrep.RipgrepBinaryManager({ arch: 'ia32', resourcesPath: '/x' }).getBinaryPath(), null);
  assert.equal(new ripgrep.RipgrepBinaryManager({ arch: 'arm64', resourceRoot: '/repo' }).getBinaryPath(), '/repo/resources/ripgrep-binaries/darwin-arm64/rg');
});

test('a missing binary reports unavailable instead of throwing on every call', () => {
  const manager = new ripgrep.RipgrepBinaryManager({ arch: 'arm64', resourcesPath: '/nonexistent-roc-resources' });
  assert.equal(manager.isAvailable(), false);
});

/* ------------------------------------------------------------------ */
/* 真跑一个 rg                                                         */
/* ------------------------------------------------------------------ */

function createService() {
  return new ripgrep.RipgrepService(new ripgrep.RipgrepBinaryManager({ arch: process.arch, resourceRoot: repoRoot }));
}

const serviceAvailable = createService().isAvailable();

test('search finds literal matches, honours hidden files and the directory blacklist', { skip: serviceAvailable ? false : 'bundled rg missing for this arch' }, async () => {
  const root = join(tempRoot, 'workspace');
  mkdirSync(join(root, 'papers'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(root, 'papers', 'draft.md'), 'alpha effect size beta\nsecond line without it\n', 'utf8');
  writeFileSync(join(root, '.notes'), 'hidden effect size\n', 'utf8');
  writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'effect size in a dependency\n', 'utf8');

  const result = await createService().search({
    rootDir: root,
    query: 'effect size',
    includeHidden: true,
    excludeDirectories: ['node_modules']
  });

  assert.deepEqual(
    result.matches.map((match) => [match.relativePath, match.line, match.column, match.preview]),
    [
      ['.notes', 1, 8, 'hidden effect size'],
      ['papers/draft.md', 1, 7, 'alpha effect size beta']
    ]
  );
  assert.equal(result.truncated, false);
});

test('search is case-sensitive and literal, like the JS scan it replaced', { skip: serviceAvailable ? false : 'bundled rg missing for this arch' }, async () => {
  const root = join(tempRoot, 'literal');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'a.md'), 'FOO upper\nfoo lower\nf.o middle\n', 'utf8');

  const lower = await createService().search({ rootDir: root, query: 'foo' });
  assert.deepEqual(lower.matches.map((match) => match.line), [2]);

  const dotted = await createService().search({ rootDir: root, query: 'f.o' });
  assert.deepEqual(dotted.matches.map((match) => match.line), [3]);
});

test('an ignored directory is found with disableIgnoreRules (files.search), skipped without it (agent grep)', { skip: serviceAvailable ? false : 'bundled rg missing for this arch' }, async () => {
  // 用 `.ignore` 而不是 `.gitignore`：两者的 ignore 机制相同，但 `.gitignore` 只在 git 仓库里
  // 生效（rg 的既定行为），而单测不该为了造一个 git 仓库而依赖 git 可执行文件。
  const root = join(tempRoot, 'ignored');
  mkdirSync(join(root, 'build'), { recursive: true });
  writeFileSync(join(root, '.ignore'), 'build/\n', 'utf8');
  writeFileSync(join(root, 'build', 'results.md'), 'ignored needle\n', 'utf8');

  const ui = await createService().search({ rootDir: root, query: 'needle', disableIgnoreRules: true });
  assert.deepEqual(ui.matches.map((match) => match.relativePath), ['build/results.md']);

  // Agent grep 保持上游 rg 的 ignore 语义：被 ignore 的目录不参与搜索。
  const agent = await createService().search({ rootDir: root, query: 'needle' });
  assert.deepEqual(agent.matches, []);
});

test('hitting maxResults marks the page truncated and stops early', { skip: serviceAvailable ? false : 'bundled rg missing for this arch' }, async () => {
  const root = join(tempRoot, 'many');
  mkdirSync(root, { recursive: true });
  const file = join(root, 'hits.md');
  writeFileSync(file, '', 'utf8');
  for (let index = 0; index < 40; index += 1) {
    appendFileSync(file, `needle ${index}\n`, 'utf8');
  }

  const result = await createService().search({ rootDir: root, query: 'needle', maxResults: 5 });
  assert.equal(result.matches.length, 5);
  assert.equal(result.truncated, true);
});

test('an empty query never spawns rg', async () => {
  const service = createService();
  assert.deepEqual(await service.search({ rootDir: tempRoot, query: '' }), { matches: [], truncated: false });
});

/* ------------------------------------------------------------------ */
/* FileService：rg 优先，缺失时退回旧扫描                              */
/* ------------------------------------------------------------------ */

/** 每个用例一个独立工作区：降级路径会遍历整个 workspace，共享根目录会把别的夹具搜进来。 */
function createFileService(ripgrepStub, root) {
  const workspaceService = { requireWorkspace: () => ({ path: root }) };
  return new fileServiceModule.FileService({}, { db: null }, workspaceService, ripgrepStub);
}

function createWorkspace(name) {
  const root = join(tempRoot, name);
  mkdirSync(root, { recursive: true });
  return root;
}

test('files.search goes through ripgrep when it is available', { skip: serviceAvailable ? false : 'bundled rg missing for this arch' }, async () => {
  const root = createWorkspace('wired');
  writeFileSync(join(root, 'wired.md'), 'wired needle\n', 'utf8');
  const service = createFileService(createService(), root);

  const result = await service.search({ query: 'needle' });
  assert.deepEqual(result, {
    query: 'needle',
    matches: [{ relativePath: 'wired.md', line: 1, column: 7, preview: 'wired needle' }],
    truncated: false
  });
});

test('a failing ripgrep degrades to the previous scan instead of failing the palette', async () => {
  const root = createWorkspace('degraded');
  writeFileSync(join(root, 'fallback.md'), 'fallback needle\n', 'utf8');
  const broken = {
    isAvailable: () => true,
    search: () => Promise.reject(new Error('ripgrep_search_failed'))
  };
  const service = createFileService(broken, root);

  const result = await service.search({ query: 'needle' });
  assert.deepEqual(
    result.matches.map((match) => [match.relativePath, match.line, match.preview]),
    [['fallback.md', 1, 'fallback needle']]
  );
});

test('an unavailable ripgrep uses the previous scan', async () => {
  const root = createWorkspace('unavailable');
  writeFileSync(join(root, 'legacy.md'), 'legacy needle\n', 'utf8');
  const service = createFileService({ isAvailable: () => false, search: () => Promise.reject(new Error('unused')) }, root);

  const result = await service.search({ query: 'needle' });
  assert.deepEqual(
    result.matches.map((match) => match.relativePath),
    ['legacy.md']
  );
});

test('the empty-query validation survives the new backend', async () => {
  const root = createWorkspace('empty-query');
  const service = createFileService({ isAvailable: () => false, search: () => Promise.reject(new Error('unused')) }, root);
  await assert.rejects(() => service.search({ query: '   ' }), (error) => error.code === 'file_search_query_empty');
});

/* 二进制本身要能执行：这条用 execFile 而不是服务，避免“服务能跑但这颗文件坏了”被掩盖。 */
test('the bundled binaries are executable', { skip: serviceAvailable ? false : 'bundled rg missing for this arch' }, () => {
  const version = execFileSync(join(repoRoot, 'resources', 'ripgrep-binaries', `darwin-${process.arch}`, 'rg'), ['--version'], { encoding: 'utf8' });
  assert.match(version, /^ripgrep \d+\.\d+\.\d+/u);
});

test('every committed binary matches the lock, and the host one reports the locked version', () => {
  // 打包口只校验当前架构；过期的另一架构二进制、或“换了二进制忘了改 lock”只能在这里抓到。
  // 两个架构都核对 sha256，但只有本机能执行的哪一个才核对 `--version`：在 arm64 上跑 x64
  // 的 rg 需要 Rosetta，缺了它这条不该红。
  const lock = JSON.parse(readFileSync(join(repoRoot, 'resources', 'ripgrep-binaries', 'ripgrep.lock.json'), 'utf8'));
  for (const [arch, entry] of Object.entries(lock.architectures)) {
    const binaryPath = join(repoRoot, 'resources', 'ripgrep-binaries', entry.platformDir, 'rg');
    const digest = createHash('sha256').update(readFileSync(binaryPath)).digest('hex');
    assert.equal(digest, entry.binarySha256, `${arch} binary does not match the lock`);
    if (arch !== process.arch) {
      continue;
    }
    const version = execFileSync(binaryPath, ['--version'], { encoding: 'utf8' });
    assert.match(
      version,
      new RegExp(`^ripgrep ${lock.version.replaceAll('.', '\\.')}\\b`, 'u'),
      `${arch} binary reports a different version than the lock`
    );
  }
});
