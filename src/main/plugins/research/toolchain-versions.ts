/**
 * 工具链版本键的推导与比对。
 *
 * ## 为什么这是一个独立模块
 *
 * 这份逻辑只回答一个问题：**lock 声明的工具集，和 manifest 记录的工具集，是不是同一个**。
 * 它被 `toolchain.ts` 的 `verify()` 用来决定要不要拒绝整个工具链，但 `toolchain.ts` 自己
 * 加载不了单测——它直读 `tools.lock.json`，并依赖 `pdfjs-dist` 与 `@napi-rs/canvas` 的原生绑定
 *（`tests/unit` 的 `bundle-ts.mjs` 是 `platform:'neutral'` 且没有文件系统基址）。
 *
 * ## 为什么键集来自 lock 而不是写死
 *
 * 工具版本曾经逐个固定在 manifest 校验逻辑中；每增加一个工具都要同步修改 schema、版本比较、
 * `prepare.ts` 的 `ToolsLock` 类型和版本记录，容易漏掉并静默放行。现在以 `architectures[arch]`
 * 的工具名为键集，manifest 对应版本由同名 `<name>Version` 提供。增加工具时只需更新 lock 和准备脚本，
 * 读取侧会自动校验完整键集。
 *
 */

export type ToolchainToolVersions = Readonly<Record<string, string>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 从已解析的 lock 推出这个架构必须记录的工具版本。
 *
 * 返回 `null` 表示 lock 不可信，而不是「没有工具」：一个工具在 `architectures` 里注册了归档，
 * 却没有同名 `<name>Version`，就是在分发一个 manifest 无法审计的二进制。
 */
export function lockedToolVersions(lock: unknown, architecture: string): ToolchainToolVersions | null {
  if (!isRecord(lock) || typeof architecture !== 'string' || architecture.length === 0) return null;
  const architectures = lock.architectures;
  if (!isRecord(architectures)) return null;
  const tools = architectures[architecture];
  if (!isRecord(tools)) return null;
  const names = Object.keys(tools);
  if (names.length === 0) return null;
  const versions: Record<string, string> = {};
  for (const name of names) {
    if (!isRecord(tools[name])) return null;
    const declared = lock[`${name}Version`];
    if (typeof declared !== 'string' || declared.length === 0) return null;
    versions[name] = declared;
  }
  return versions;
}

/**
 * 记录集与期望集必须**逐键完全一致**。
 *
 * 多一个键也是不一致：manifest 里出现 lock 没有的工具，说明工具链不是这套源构建出来的
 * （旧的、手工改过的、或另一台机器上产出的），此时放行等于让不可复现的环境通过校验。
 */
export function toolVersionsMatch(recorded: unknown, expected: ToolchainToolVersions): boolean {
  if (!isRecord(recorded)) return false;
  const keys = Object.keys(recorded);
  const expectedKeys = Object.keys(expected);
  if (keys.length !== expectedKeys.length) return false;
  return expectedKeys.every((key) => typeof recorded[key] === 'string' && recorded[key] === expected[key]);
}
