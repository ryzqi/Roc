import { accessSync, constants, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';

/**
 * ripgrep（`rg`）是 Roc 的**唯一**文件内容搜索引擎。
 *
 * 两个调用面共用这一个服务：
 *
 *   1. `files.search`（⌘K 的「文件内容」分组、侧栏内容检索）——替换原先逐文件读入内存再
 *      `indexOf` 的 JS 扫描；旧实现的 `defaultSearchMaxVisitedFiles` / `defaultSearchMaxBytes`
 *      是为了别把主进程拖死才存在的，现在由 rg 自己的遍历与 `--max-filesize` 承担；
 *   2. Agent 的 `grep` 工具——deepagents 的 `FilesystemBackend.grep` 会 `spawn("rg")`，
 *      但那是**看 PATH**：Finder/Dock 启动的 Roc 只恢复登录 shell 的 PATH，用户没装 rg 时
 *      它就静默退回逐文件 `fg` 扫描。这里改成显式路径，于是「agent 检索快」不取决于用户
 *      是否恰好装了 ripgrep。
 *
 * 二进制与许可证登记在 `resources/ripgrep-binaries/ripgrep.lock.json`，由 README 的
 * 「外部集成」记录版本 / 网址 / 许可证 / 更新方式。二进制缺失时**不是**错误路径：
 * `FileService` 退回旧的 JS 扫描，Agent 退回 deepagents 的字面量搜索——降级要慢，不要挂。
 *
 * 参数固定策略：`--fixed-strings`（旧扫描是字面量子串，不引入正则语义变化）、
 * `--no-config`（不读 `RIPGREP_CONFIG_PATH`，否则同一份查询在别人机器上结果不同）。
 */

export type RipgrepMatch = {
  /** 相对搜索根目录的路径，POSIX 分隔符，无前导 `./`。 */
  relativePath: string;
  /** 1 起始行号。 */
  line: number;
  /** 1 起始列号；按查询字符串在该行里的字符位置计算，与旧扫描一致。 */
  column: number;
  /** 行内容去除首尾空白，给 UI 预览。 */
  preview: string;
  /** 原始行内容（不含行尾换行），给 Agent 的 grep 结果。 */
  text: string;
};

export type RipgrepSearchOptions = {
  /** 搜索根目录；rg 以它为 cwd，结果路径都相对它。 */
  rootDir: string;
  /** 字面量查询。空字符串直接返回空结果，不启动子进程。 */
  query: string;
  /** cwd 下的搜索目标（文件或目录）；缺省 `.`。 */
  target?: string;
  /** 额外的 `--glob` 过滤（例如 `*.md`）。 */
  glob?: string | null;
  /** 命中上限；达到后立即结束 rg。 */
  maxResults?: number;
  /**
   * 是否搜索点文件。工作区内容搜索传 `true`（旧扫描包含 `.env` 这类文件）；
   * Agent grep 保持 `false`，与 deepagents 自带的 rg 调用一致。
   */
  includeHidden?: boolean;
  /**
   * 是否忽略 `.gitignore` / `.ignore` / 全局 gitignore。工作区内容搜索传 `true`：旧的一次
   * 逐文件扫描不看这些文件，用户不该因为仓库里恰好有一行 `.gitignore` 就搜不到东西。
   * Agent grep 保持 `false`（上游 rg 也尊重 ignore 规则）。
   */
  disableIgnoreRules?: boolean;
  /** 目录名黑名单：翻译成 `--glob '!<dir>/**'` 与 `--glob '!**\/<dir>/**'`。 */
  excludeDirectories?: readonly string[];
  /** 单文件上限；rg 默认没有，缺省不传。 */
  maxFileSizeBytes?: number;
  /** 兜底超时；超时后杀掉 rg，并把已收到的命中按 `truncated` 返回。 */
  timeoutMs?: number;
};

export type RipgrepSearchResult = {
  matches: RipgrepMatch[];
  truncated: boolean;
};

export type RipgrepBinaryManagerOptions = {
  arch?: NodeJS.Architecture;
  /** 仓库内的 `resources` 目录；打包后不传，走 `process.resourcesPath`。 */
  resourceRoot?: string;
  resourcesPath?: string;
};

type ElectronProcess = NodeJS.Process & {
  defaultApp?: boolean;
  resourcesPath?: string;
};

const DEFAULT_MAX_RESULTS = 100;
const DEFAULT_TIMEOUT_MS = 15_000;

/** 二进制缺失或不可执行。调用方据此降级，而不是把 failure 抛给用户。 */
export class RipgrepUnavailableError extends Error {
  constructor() {
    super('ripgrep_unavailable');
    this.name = 'RipgrepUnavailableError';
  }
}

/**
 * 定位随包的 `rg`。
 *
 * 与 `RTKBinaryManager` 同一套规则（`resourcesPath` → `resources/`），因为它们由
 * `electron-builder` 的同一段 `mac.extraResources` 放到 `Roc.app/Contents/Resources`。
 */
export class RipgrepBinaryManager {
  private readonly binaryPath: string | null;

  constructor(private readonly options: RipgrepBinaryManagerOptions = {}) {
    this.binaryPath = this.resolveBinaryPath();
  }

  getBinaryPath(): string | null {
    return this.binaryPath;
  }

  isAvailable(): boolean {
    if (this.binaryPath === null || !existsSync(this.binaryPath)) {
      return false;
    }
    try {
      accessSync(this.binaryPath, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  private resolveBinaryPath(): string | null {
    // Roc 只随包 darwin-arm64/rg。别的架构上返回 null 让 `files.search` 走它已有的
    // JS 回退/报不可用路径，而不是去拼一个不存在的 darwin-x64 目录。
    if ((this.options.arch ?? process.arch) !== 'arm64') {
      return null;
    }
    const platformDir = 'darwin-arm64';
    return path.join(this.resourceBaseDir(), 'ripgrep-binaries', platformDir, 'rg');
  }

  private resourceBaseDir(): string {
    if (this.options.resourcesPath !== undefined) {
      return this.options.resourcesPath;
    }
    const electronProcess = process as ElectronProcess;
    if (electronProcess.resourcesPath !== undefined && electronProcess.defaultApp !== true) {
      return electronProcess.resourcesPath;
    }
    return path.join(this.options.resourceRoot ?? process.cwd(), 'resources');
  }
}

/** 把 `./a/b.md`、`a/b.md` 归一成 `a/b.md`（POSIX 分隔符，无 `./` 前缀）。 */
export function normalizeRipgrepPath(rawPath: string): string {
  const normalized = rawPath.split(path.sep).join('/');
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

/**
 * 解析 rg `--json` 的一行。
 *
 * 只认 `type: "match"`：`begin` / `end` / `summary` 携带的是文件级与汇总信息，UI 与 Agent
 * 都用不到。非 UTF-8 路径（rg 以 `path.bytes` 输出）与二进制文件命中一律跳过——返回一个
 * 猜出来的路径比丢一条命中更糟。
 */
export function parseRipgrepMatchLine(line: string, query: string): RipgrepMatch | null {
  if (!line.includes('"type":"match"')) {
    return null;
  }
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof event !== 'object' || event === null) {
    return null;
  }
  const record = event as {
    type?: unknown;
    data?: {
      path?: { text?: unknown };
      lines?: { text?: unknown };
      line_number?: unknown;
      submatches?: Array<{ start?: unknown }>;
    };
  };
  if (record.type !== 'match' || record.data === undefined) {
    return null;
  }
  const rawPath = record.data.path?.text;
  const rawLine = record.data.lines?.text;
  const lineNumber = record.data.line_number;
  if (typeof rawPath !== 'string' || typeof rawLine !== 'string' || typeof lineNumber !== 'number') {
    return null;
  }
  const text = rawLine.replace(/\r?\n$/u, '');
  const characterIndex = text.indexOf(query);
  const byteStart = record.data.submatches?.[0]?.start;
  const column =
    characterIndex >= 0 ? characterIndex + 1 : typeof byteStart === 'number' ? byteStart + 1 : 1;
  return {
    relativePath: normalizeRipgrepPath(rawPath),
    line: lineNumber,
    column,
    preview: text.trim(),
    text
  };
}

/**
 * 组装 rg 参数。抽成纯函数是为了让单测盯住「哪些开关必须在」——少一个
 * `--fixed-strings` 就把用户的字面量当正则，结果从「搜不到」变成「莫名命中」。
 */
export function buildRipgrepArgs(options: RipgrepSearchOptions): string[] {
  const args = ['--json', '--fixed-strings', '--no-config', '--no-messages'];
  if (options.includeHidden === true) {
    args.push('--hidden');
  }
  if (options.disableIgnoreRules === true) {
    // 三个一起才算“不依赖仓库配置”：--no-ignore 关掉本仓库的 ignore 文件，
    // --no-ignore-parent 关掉上层目录的，--no-ignore-global 关掉全局 gitignore。
    args.push('--no-ignore', '--no-ignore-parent', '--no-ignore-global');
  }
  if (options.maxFileSizeBytes !== undefined) {
    args.push('--max-filesize', String(options.maxFileSizeBytes));
  }
  for (const directory of options.excludeDirectories ?? []) {
    args.push('--glob', `!${directory}/**`, '--glob', `!**/${directory}/**`);
  }
  if (typeof options.glob === 'string' && options.glob.length > 0) {
    args.push('--glob', options.glob);
  }
  args.push('--', options.query, options.target ?? '.');
  return args;
}

export class RipgrepService {
  constructor(private readonly binaryManager = new RipgrepBinaryManager()) {}

  isAvailable(): boolean {
    return this.binaryManager.isAvailable();
  }

  async search(options: RipgrepSearchOptions): Promise<RipgrepSearchResult> {
    if (options.query.length === 0) {
      return { matches: [], truncated: false };
    }
    const binaryPath = this.binaryManager.getBinaryPath();
    if (binaryPath === null || !this.binaryManager.isAvailable()) {
      throw new RipgrepUnavailableError();
    }
    return this.run(binaryPath, options);
  }

  private async run(binaryPath: string, options: RipgrepSearchOptions): Promise<RipgrepSearchResult> {
    const maxResults = Math.max(1, options.maxResults ?? DEFAULT_MAX_RESULTS);
    const args = buildRipgrepArgs(options);

    return await new Promise<RipgrepSearchResult>((resolve, reject) => {
      const matches: RipgrepMatch[] = [];
      let truncated = false;
      let settled = false;

      const child = spawn(binaryPath, args, {
        cwd: options.rootDir,
        stdio: ['ignore', 'pipe', 'ignore']
      });

      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        lines.close();
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve({ matches, truncated });
      };

      const timer = setTimeout(() => {
        truncated = true;
        child.kill('SIGKILL');
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      const lines = createInterface({ input: child.stdout });

      lines.on('line', (line) => {
        if (settled || matches.length >= maxResults) {
          return;
        }
        const match = parseRipgrepMatchLine(line, options.query);
        if (match === null) {
          return;
        }
        matches.push(match);
        if (matches.length >= maxResults) {
          // 提前收工：剩下的命中调用方已经不看了，让它把整个仓库跑完只是白烧 CPU。
          truncated = true;
          child.kill('SIGTERM');
        }
      });

      child.on('error', () => {
        finish(new RipgrepUnavailableError());
      });

      // rg 的退出码：0 = 有命中，1 = 无命中，2 = 出错（例如目标不存在）。
      // 只有「2 且一条都没收到」才算失败；超时被杀时 code 是 null，已收到的命中仍然有效。
      child.on('close', (code) => {
        if (code === 2 && matches.length === 0) {
          finish(new Error('ripgrep_search_failed'));
          return;
        }
        finish();
      });
    });
  }
}
