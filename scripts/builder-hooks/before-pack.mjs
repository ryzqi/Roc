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
 * 架构。Roc 只发 Apple Silicon，所以 x64 与 universal 目标必须在这里被**明确拒绝**，
 * 而不是打出半个应用或合成一个用不上的双架构包。
 *
 * 同时接受数字枚举与字符串：electron-builder 各版本在 hook 里两种都出现过。
 */
const ARM64_TARGET = 3;
const ARM64_NAME = 'arm64';

function targetArchitectures(contextArch) {
  if (contextArch === undefined) {
    if (process.arch !== 'arm64') throw new Error(`Roc ships darwin arm64 only; host is ${process.arch}.`);
    return ['arm64'];
  }
  const isArm64 = contextArch === ARM64_TARGET || contextArch === ARM64_NAME;
  if (!isArm64) {
    throw new Error(`Unsupported packaging target arch: ${String(contextArch)}. Roc ships darwin arm64 only.`);
  }
  return ['arm64'];
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
