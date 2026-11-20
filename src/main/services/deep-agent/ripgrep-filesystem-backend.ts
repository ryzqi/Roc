import { type GrepResult } from 'deepagents';
import { AtomicFilesystemBackend } from './atomic-filesystem-backend';
import type { RipgrepService } from '../ripgrep-service';
import type { WorkspacePathStructureChangeNotifier } from '../workspace-path-structure-event';

/**
 * 让 Agent 的 `grep` 工具跑在 Roc 自带的 ripgrep 上。
 *
 * deepagents 的 `FilesystemBackend.grep` 已经会 `spawn("rg")`，但它**依赖 PATH**：Finder /
 * Dock 启动的 Roc 只通过 `shell-env` 恢复登录 shell 的 PATH，用户机器上通常没有 ripgrep，
 * 于是实际跑的是 `fg` 全仓枚举 + 逐文件 `includes`——大工作区里一次 grep 就是数秒的同步 IO。
 * 这里的子类把同一次调用交给 `RipgrepService`（显式二进制路径），PATH 不再参与决策。
 *
 * 读取保留上游语义；写入/编辑由 AtomicFilesystemBackend 原子发布，grep 在此替换。
 *
 * 降级：二进制缺失、spawn 失败或 rg 报错时退回 `super.grep`。**注意那条路径不完全等价**：
 * 上游会再试一次 PATH 上的 `rg`，自己没有才落到 `fg` 枚举。也就是说“不看 PATH”只在随包
 * 二进制在位时成立；缺失时只是从「慢」开始退化，而不是从「字面量扫描」开始。
 * Agent 看到的工具契约不变——grep 永远是字面量子串搜索。
 */

/**
 * `maxCount` 为 `null` 时的上限。deepagents 的 `createFilesystemMiddleware` 缺省传
 * `DEFAULT_GREP_MAX_COUNT = 1000`，这里取同一个数，避免「Roc 后端比上游更健谈」。
 */
const DEFAULT_MAX_MATCHES = 1000;

export type RipgrepFilesystemBackendOptions = {
  rootDir: string;
  virtualMode?: boolean;
  maxFileSizeMb?: number;
};

export class RipgrepFilesystemBackend extends AtomicFilesystemBackend {
  // 名字不能跟上游的私有 `maxFileSizeBytes` 撞：TS 会判定基类被错误继承。
  private readonly grepMaxFileSizeBytes: number | null;

  constructor(
    private readonly ripgrep: RipgrepService,
    options: RipgrepFilesystemBackendOptions,
    onWorkspacePathStructureChanged?: WorkspacePathStructureChangeNotifier
  ) {
    super(options, onWorkspacePathStructureChanged);
    // 上游的 `FilesystemBackend` 把 `maxFileSizeMb` 存成私有字段，只用于它的字面量扫描；
    // 走 ripgrep 时得自己带上，否则「同一后端两种文件大小上限」这件事没人会发现。
    this.grepMaxFileSizeBytes =
      options.maxFileSizeMb === undefined ? null : Math.floor(options.maxFileSizeMb * 1024 * 1024);
  }

  override async grep(
    pattern: string,
    dirPath = '/',
    glob: string | null = null,
    maxCount: number | null = null
  ): Promise<GrepResult> {
    if (pattern.length === 0 || !this.ripgrep.isAvailable()) {
      return super.grep(pattern, dirPath, glob, maxCount);
    }
    const virtualPath = dirPath.length === 0 ? '/' : dirPath;
    // 越界（`..`、`~`）不上交给 rg 去判断：它的 cwd 就是工作区根，一个 `..` 会把搜索
    // 带到根目录之外。直接按「没匹配」返回，和上游 resolvePath 拒绝后的结果一致。
    if (virtualPath.includes('..') || virtualPath.startsWith('~')) {
      return { matches: [] };
    }

    const target = virtualPath === '/' ? '.' : virtualPath.replace(/^\/+/u, '');
    const limit = Math.max(1, maxCount ?? DEFAULT_MAX_MATCHES);

    try {
      const result = await this.ripgrep.search({
        rootDir: this.cwd,
        query: pattern,
        target,
        glob,
        maxResults: limit,
        maxFileSizeBytes: this.grepMaxFileSizeBytes ?? undefined
      });
      return {
        matches: result.matches.map((match) => ({
          path: `/${match.relativePath}`,
          line: match.line,
          text: match.text
        })),
        // 命中了上限，或者 rg 被超时掐掉：两种情况的结果都是「有效但不完整」。
        truncated: result.truncated
      };
    } catch {
      return super.grep(pattern, dirPath, glob, maxCount);
    }
  }
}
