#!/usr/bin/env node

/**
 * P4 「仅 arm64」收敛的核对器（proposal §4 第 1–3 条、§9 P4 行、§10「架构与界面」）。
 *
 * 为什么需要它：单架构收敛是一堆**分散在构建脚本、锁文件、hook、运行时校验里的常量**，
 * 没有任何一处编译器或单测会同时看全它们。漏一处不会让本机构建失败——它只会在别处
 * 静默地产出一个 x64 slice，或者让 `--x64` 悄悄打出半个应用。所以这里做的是**全量清点**：
 * 逐项断言「唯一的架构是 arm64」，并把每一处证据原文留在报告里。
 *
 * 三类检查：
 *
 *   A. **构建入口拒绝非 arm64。** 不只是「没有配置 x64」——`package:mac` / `package:dir` /
 *      before-pack hook / 工具链 prepare 必须在**非 arm64 请求**上明确报错。被拒绝是断言，
 *      不是跳过。
 *   B. **锁文件与清单只有 arm64。** `tools.lock.json`、`ripgrep.lock.json`、
 *      `r-process.lock.json` 里的架构键集必须恰为 `['arm64']`；工具链 manifest schema 只接受
 *      arm64（否则一个 x64 工具链仍能被接受并跑起来）。
 *   C. **打包配置不筛 x64 预编译产物、也不合成 universal。** `electron-builder.yml` 里
 *      `sqlite-vec-darwin-x64`、`darwin-!(${arch})` 这类分支要么不存在，要么按 arch 收窄。
 *
 * 用法：
 *   node scripts/verify-arm64-only.mjs            # 检查
 *   node scripts/verify-arm64-only.mjs --strict   # 额外要求 packaged 产物存在（打包后）
 *
 * 退出码非 0 表示至少一项不成立。报告写 `.artifacts/arm64-only/`。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const artifactsDir = resolve('.artifacts/arm64-only');
mkdirSync(artifactsDir, { recursive: true });

const results = [];
let failures = 0;

function assertCheck(area, claim, ok, evidence) {
  results.push({ area, claim, ok, evidence: String(evidence ?? '') });
  if (!ok) failures += 1;
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${area} · ${claim}\n        ${String(evidence ?? '').slice(0, 300)}`);
}

function readJson(path) {
  const text = readFileSync(resolve(path), 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const strict = process.argv.includes('--strict');

/**
 * 递归找出 Resources 下所有 Mach-O，按 `lipo -archs` 分成三类。
 *
 * `lipo` 对非 Mach-O 文件会报错退出，所以先按后缀/可执行位粗筛，再让 `lipo` 判定——
 * 让它去跑一遍数据文件只会把 `lipo` 的错误刷满日志。
 */
function scanMachO(root) {
  const arm64Only = [];
  const universal = [];
  const pureX64 = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(so|dylib|node)(\.|$)/u.test(entry.name) && !entry.name.endsWith('bin/python3')) continue;
      let archs;
      try {
        archs = execFileSync('/usr/bin/lipo', ['-archs', full], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch {
        continue;
      }
      const relative = full.slice(root.length + 1);
      if (archs === 'arm64') arm64Only.push(relative);
      else if (/arm64/u.test(archs) && /x86_64/u.test(archs)) universal.push(relative);
      else if (/x86_64/u.test(archs)) pureX64.push(relative);
    }
  }
  return { arm64Only, universal, pureX64 };
}

// ── A. 构建入口必须拒绝非 arm64 ────────────────────────────────────────────────

for (const [script, label] of [
  ['scripts/package-mac.mjs', 'package:mac'],
  ['scripts/package-dir.mjs', 'package:dir']
]) {
  const source = readFileSync(resolve(script), 'utf8');
  // 收窄后这两个入口不再接受 x64：既不能出现 `'x64'` 比较，也不能保留 `--${process.arch}`。
  // 「只有 arm64 被接受」必须由代码证明，不能靠「本机恰好是 arm64」。
  const mentionsX64 = /'x64'/.test(source);
  const isArm64Only = /process\.arch !== 'arm64'/.test(source) || /arch !== arm64/u.test(source);
  assertCheck('A 构建入口', `${label} 拒绝非 arm64 宿主`, !mentionsX64, mentionsX64 ? `仍出现 'x64': ${script}` : 'no x64 literal');
  assertCheck('A 构建入口', `${label} 显式校验 arm64`, isArm64Only, isArm64Only ? 'guards arm64' : `missing arm64 guard in ${script}`);
}

const beforePack = readFileSync(resolve('scripts/builder-hooks/before-pack.mjs'), 'utf8');
assertCheck(
  'A 构建入口',
  'before-pack hook 只接受 arm64 目标架构',
  !/'x64'/.test(beforePack) && !/universal/i.test(beforePack.replace(/\/\*[\s\S]*?\*\//gu, '')),
  /'x64'/.test(beforePack) ? 'hook 仍声明 x64 目标' : 'hook 无 x64/universal 目标'
);

// 工具链 prepare 只能在 arm64 宿主上构建，且只能产出 arm64。
const prepare = readFileSync(resolve('scripts/research/prepare.ts'), 'utf8');
assertCheck(
  'A 构建入口',
  '工具链 prepare 的 hostArchitecture() 只返回 arm64',
  /function hostArchitecture\(\): 'arm64' \{/.test(prepare),
  /function hostArchitecture\(\): 'arm64' \{/.test(prepare) ? 'return type narrowed to arm64' : 'hostArchitecture still returns arm64|x64'
);

// ── B. 锁文件与清单只有 arm64 ──────────────────────────────────────────────────

for (const [path, label] of [
  ['resources/research-runtime/tools.lock.json', 'tools.lock.json'],
  ['resources/ripgrep-binaries/ripgrep.lock.json', 'ripgrep.lock.json'],
  ['resources/research-runtime/r-process.lock.json', 'r-process.lock.json']
]) {
  if (!existsSync(resolve(path))) {
    assertCheck('B 锁文件', `${label} 存在`, false, `missing ${path}`);
    continue;
  }
  const lock = readJson(path);
  const arches = label === 'r-process.lock.json' ? lock.architectures : Object.keys(lock.architectures ?? {});
  assertCheck(
    'B 锁文件',
    `${label} 的架构键集恰为 ['arm64']`,
    Array.isArray(arches) && arches.length === 1 && arches[0] === 'arm64',
    JSON.stringify(arches)
  );
}

// 工具链 manifest schema：接受 x64 就等于接受一个不适合本应用的运行时。
const toolchainSource = readFileSync(resolve('src/main/plugins/research/toolchain.ts'), 'utf8');
assertCheck(
  'B 清单',
  'toolchain manifest schema 只接受 architecture=arm64',
  /architecture: z\.literal\('arm64'\)/.test(toolchainSource),
  /architecture: z\.literal\('arm64'\)/.test(toolchainSource) ? "z.literal('arm64')" : 'schema still admits x64'
);
assertCheck(
  'B 清单',
  'manifest 校验与 lockedToolVersions 都按 arm64 取值',
  !/process\.arch/.test(toolchainSource.split('\n').filter((line) => line.includes('lockedToolVersions') || line.includes('manifest.architecture')).join('\n')),
  'checks 不再读 process.arch'
);

// r-process 原生助手：只构建 arm64 slice，且运行时只接受 arm64。
const rProcessBuild = readFileSync(resolve('scripts/research/build-r-process.ts'), 'utf8');
assertCheck(
  'B 原生助手',
  'r-process 只构建 arm64 slice（不再 lipo 合成双架构）',
  !/x86_64/.test(rProcessBuild) && !/'x64'/.test(rProcessBuild),
  /x86_64/.test(rProcessBuild) ? 'still compiles x86_64 slice' : 'arm64 only'
);
const rProcessRuntime = readFileSync(resolve('src/main/plugins/research/experiment-native-process.ts'), 'utf8');
assertCheck(
  'B 原生助手',
  'r-process 运行时只接受 arm64',
  /process\.arch !== 'arm64'/.test(rProcessRuntime) && !/'x64'/.test(rProcessRuntime),
  /'x64'/.test(rProcessRuntime) ? 'runtime still admits x64' : 'arm64 only'
);

// ── C. 打包配置 ────────────────────────────────────────────────────────────────

const builderConfig = readFileSync(resolve('electron-builder.yml'), 'utf8');
assertCheck(
  'C 打包',
  'electron-builder 不筛 sqlite-vec-darwin-x64',
  !/sqlite-vec-darwin-x64/.test(builderConfig),
  /sqlite-vec-darwin-x64/.test(builderConfig) ? 'still references darwin-x64 native module' : 'arm64 only'
);
assertCheck(
  'C 打包',
  'electron-builder 的 asarUnpack 不含 darwin-!(${arch}) 式双架构分支',
  !/darwin-!\(\$\{arch\}\)/.test(builderConfig),
  /darwin-!\(\$\{arch\}\)/.test(builderConfig) ? 'negated-arch branch present' : 'no negated branch'
);
assertCheck(
  'C 打包',
  'electron-builder 不声明 universal target',
  !/universal/i.test(builderConfig),
  /universal/i.test(builderConfig) ? 'universal present' : 'no universal'
);

// ── D.（可选）已打包产物的架构 ────────────────────────────────────────────────

if (strict) {
  const appBinary = resolve('release/mac-arm64/Roc.app/Contents/MacOS/Roc');
  if (!existsSync(appBinary)) {
    assertCheck('D 产物', '打包后的 Roc 可执行文件存在', false, `missing ${appBinary}`);
  } else {
    const info = execFileSync('/usr/bin/lipo', ['-archs', appBinary], { encoding: 'utf8' }).trim();
    assertCheck('D 产物', '打包后的 Roc 只含 arm64', info === 'arm64', info);
    const toolchainPython = resolve('release/mac-arm64/Roc.app/Contents/Resources/research-toolchain/python/bin/python3');
    if (existsSync(toolchainPython)) {
      const pyInfo = execFileSync('/usr/bin/lipo', ['-archs', toolchainPython], { encoding: 'utf8' }).trim();
      assertCheck('D 产物', '随包 Python 只含 arm64', pyInfo === 'arm64', pyInfo);
    } else {
      assertCheck('D 产物', '随包 Python 存在', false, `missing ${toolchainPython}`);
    }

    // 逐二进制清点随包的 Mach-O。
    //
    // 这里要区分三种情况，因为它们的结论完全不同：
    //   arm64            → 正确。
    //   arm64 + x86_64   → 上游 wheel 发布的 fat 二进制，在 Apple Silicon 上跑的是 arm64 那半，**无害**。
    //   纯 x86_64        → 真正的缺陷：在 arm64 上这条路径根本没法执行（或被 Rosetta 静默接管）。
    //
    // 只看 “有没有 x86_64” 会把 19 个 fat wheel 误报成问题；只看 “是不是 arm64-only” 同样误报。
    // 所以只把**纯 x64** 当作失败，并把三类计数写进报告。
    const scanned = scanMachO(resolve('release/mac-arm64/Roc.app/Contents/Resources'));
    writeFileSync(join(artifactsDir, 'macho-inventory.json'), `${JSON.stringify(scanned, null, 2)}\n`, 'utf8');
    assertCheck('D 产物', '随包二进制里没有纯 x86_64 slice', scanned.pureX64.length === 0,
      scanned.pureX64.length === 0
        ? `arm64=${scanned.arm64Only.length} universal=${scanned.universal.length} pureX64=0`
        : `纯 x64: ${scanned.pureX64.slice(0, 5).join(', ')}`);
    // 应用自身的原生模块必须是 arm64-only：它们由我们在本机构建，不是上游 wheel。
    const appNative = scanned.pureX64.length === 0
      ? scanned.universal.filter((p) => p.includes('app.asar.unpacked'))
      : [...scanned.pureX64, ...scanned.universal.filter((p) => p.includes('app.asar.unpacked'))];
    assertCheck('D 产物', '应用原生模块（.node）都是 arm64-only', appNative.length === 0, appNative.join(', ') || 'no universal app native modules');
  }
}

writeFileSync(join(artifactsDir, 'report.json'), `${JSON.stringify({ strict, failures, results }, null, 2)}\n`, 'utf8');
console.log(`\narm64-only 核对：${results.length - failures}/${results.length} 通过${failures > 0 ? `，${failures} 项不成立` : ''}。报告：${join(artifactsDir, 'report.json')}`);
process.exit(failures === 0 ? 0 : 1);
