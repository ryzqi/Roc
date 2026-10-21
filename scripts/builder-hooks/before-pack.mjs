import {
  assertLiveResearchToolchainForPackaging,
  assertRipgrepBinaryForPackaging,
  createPackagingEnvironment,
  runCommand,
  sanitizeLanggraphSdkForPackaging,
  verifyWorkspaceBetterSqlite3
} from '../lib/native-packaging.mjs';

/**
 * electron-builder 的 `Arch` 枚举（`builder-util`）：0 ia32 / 1 x64 / 2 armv7l / 3 arm64 / 4 universal。
 *
 * 为什么不能直接读 `process.arch`：宿主架构 ≠ 目标架构。在 arm64 Mac 上跑
 * `electron-builder --x64` 完全合法，而 `electron-builder.yml` 的 `darwin-${arch}` 打的是**目标**
 * 架构——按宿主校验会放过一个根本没进包的 `darwin-x64/rg`（或科研工具链）。所以读 hook 的
 * `context.arch`，只接受能在这里对上号的架构；对不上就失败，而不是猜一个。
 *
 * 同时接受数字枚举与字符串：electron-builder 各版本在 hook 里两种都出现过。
 */
const RIPGREP_ARCHES_BY_TARGET = new Map([
  [1, ['x64']],
  [3, ['arm64']],
  [4, ['arm64', 'x64']]
]);

const RIPGREP_ARCHES_BY_NAME = new Map([
  ['x64', ['x64']],
  ['arm64', ['arm64']],
  ['universal', ['arm64', 'x64']]
]);

function targetArchitectures(contextArch) {
  if (contextArch === undefined) {
    return [process.arch];
  }
  const byTarget = typeof contextArch === 'number' ? RIPGREP_ARCHES_BY_TARGET.get(contextArch) : undefined;
  const byName = typeof contextArch === 'string' ? RIPGREP_ARCHES_BY_NAME.get(contextArch) : undefined;
  const architectures = byTarget ?? byName;
  if (architectures === undefined) {
    throw new Error(`Unsupported packaging target arch: ${String(contextArch)}. Roc ships darwin arm64/x64 only.`);
  }
  return architectures;
}

export default async function beforePack(context) {
  const langgraphSdkSanitize = sanitizeLanggraphSdkForPackaging();
  if (langgraphSdkSanitize.rewrittenFiles.length > 0) {
    console.log(
      `Sanitized @langchain/langgraph-sdk bundled pnpm imports in ${langgraphSdkSanitize.rewrittenFiles.length} file(s) for packaging.`
    );
  }
  verifyWorkspaceBetterSqlite3({
    run: (command, args, options) =>
      runCommand(command, args, {
        ...options,
        env: createPackagingEnvironment(options?.env)
      })
  });
  for (const architecture of targetArchitectures(context?.arch)) {
    assertLiveResearchToolchainForPackaging({ architecture });
    assertRipgrepBinaryForPackaging({ architecture });
  }
}
