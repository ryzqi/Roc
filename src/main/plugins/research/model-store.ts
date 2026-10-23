import { isAbsolute, join } from 'node:path';
import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import modelsLock from '../../../../resources/research-runtime/models.lock.json';
import {
  PACK_REPOS, downloadedBytesFor, inspectInstalledModels, installModels, packBytes, readSources, totalBytes,
  verifyModelRepository, type ModelPack, type ModelSource, type ModelsLock
} from '../../../../scripts/research/fetch-models';
import { ResearchProcessError } from './process-runner';
import type { researchModelJobSchema, researchModelsStatusSchema } from '../../../shared/schemas/research-production';
import type { z } from 'zod';

export type ResearchModelsStatus = z.infer<typeof researchModelsStatusSchema>;
export type ResearchModelSource = ResearchModelsStatus['source'];
type ModelJob = z.infer<typeof researchModelJobSchema>;
type PackStatus = ResearchModelsStatus['packs'][number];

/**
 * 清单 JSON 的字面量类型会把 `schemaVersion` 拓宽成 `number`，而 `ModelsLock` 要求字面量 `2`；
 * `readSources` 在解析期会重新校验 `schemaVersion === 2`，这是缓存验证后的唯一依据。
 */
// SAFETY: `resources/research-runtime/models.lock.json` 由 prepare.ts 按 schemaVersion 2 生成，
// 且每次读取都经 `readSources` 校验（不是 TS 能静态证明的关系）。
const LOCK = modelsLock as unknown as ModelsLock;

/** 持久化的用户选择。只存用户显式选过的东西，不存推导出来的状态。 */
export type ModelPreferences = { pack: ModelPack; source: ResearchModelSource };

const PACKS = ['basic', 'standard', 'advanced', 'flash'] as const;
const SOURCES: readonly ResearchModelSource[] = ['auto', 'huggingface', 'modelscope'];

/**
 * 官方下载入口（`mineru-kit models download <repo> --source <source>`）。
 *
 * 由 `ResearchToolchain` 提供：只有它知道受控 Python 与沙箱策略。
 * 目标仓库必须落在 `staging/<repo-name>`，标记文件由官方 CLI 生成。
 */
export type ModelDownloader = (repo: ModelSource, staging: string, source: ResearchModelSource,
  context: { signal: AbortSignal }) => Promise<void>;

/**
 * MinerU 模型仓库的本地状态与用户管理（提案 §5）。
 *
 * 两条不同的路径必须区分开：
 * - `requireReady()` 是**解析前的确证**，做全量摘要校验（2 GB 读一遍），失败即阻断解析；
 * - `status()` 只做存在性与大小检查，可以频繁调用（设置页、论文阅读器都在轮询）。
 *
 * 下载永远走官方入口生成的 `.mineru_complete` 标记，然后由 Roc 逐文件核对摘要后才发布；
 * Roc 从不自己写标记伪装 ready。
 */
export class ResearchModelStore {
  private job: ModelJob | null = null;
  /** 正在被解析任务使用的包。取消/卸载不能删掉别人正在读的权重。 */
  private readonly leases = new Map<ModelPack, number>();
  private readonly verified = new Set<ModelPack>();
  private preferences: ModelPreferences;

  constructor(
    private readonly rootPath: string | null,
    private readonly downloader: ModelDownloader | null,
    preferences: Partial<ModelPreferences> = {},
    private readonly persist: ((next: ModelPreferences) => void) | null = null
  ) {
    this.preferences = {
      pack: isModelPack(preferences.pack) ? preferences.pack : 'basic',
      source: isModelSource(preferences.source) ? preferences.source : 'auto'
    };
  }

  /** 用户选择的配置包；解析的默认档位跟着它走。 */
  get selectedPack(): ModelPack {
    return this.preferences.pack;
  }

  get selectedSource(): ResearchModelSource {
    return this.preferences.source;
  }

  selectPack(pack: ModelPack): void {
    if (this.preferences.pack === pack) return;
    this.preferences = { ...this.preferences, pack };
    this.persist?.(this.preferences);
  }

  selectSource(source: ResearchModelSource): void {
    if (this.preferences.source === source) return;
    this.preferences = { ...this.preferences, source };
    this.persist?.(this.preferences);
  }

  async status(): Promise<ResearchModelsStatus> {
    const snapshot = await this.snapshot();
    return { ...snapshot, downloading: this.job !== null, job: this.job };
  }

  /**
   * 解析前调用。模型目录可能被设为只读，因此这里只读不写；
   * 缺失或不匹配时抛 `research_models_unavailable` 或具体的 hash 错误码。
   */
  async requireReady(pack: ModelPack = this.preferences.pack): Promise<string> {
    const root = this.requireRoot();
    if (!this.verified.has(pack)) {
      const inspected = await inspectInstalledModels(root, LOCK, { verifyHashes: true, packs: [pack] });
      if (!inspected.ready) throw new ResearchProcessError(inspected.error ?? 'research_models_unavailable');
      this.verified.add(pack);
    }
    this.leases.set(pack, (this.leases.get(pack) ?? 0) + 1);
    return root;
  }

  /** 解析结束：释放该包的租约，之后的卸载才允许删文件。 */
  release(pack: ModelPack): void {
    const current = this.leases.get(pack) ?? 0;
    if (current <= 1) this.leases.delete(pack);
    else this.leases.set(pack, current - 1);
  }

  /**
   * 下载（或校验）一个配置包。
   *
   * 同一时刻只允许一个任务：两个包共享 torch 仓库，并发下载没有意义，
   * 而且官方下载锁只按仓库名分发。`signal` 取消后 staging 保留，下一次重试能续传。
   */
  async download(pack: ModelPack, source: ResearchModelSource, signal?: AbortSignal): Promise<ResearchModelsStatus> {
    if (this.job !== null) throw new ResearchProcessError('research_model_download_locked');
    const downloader = this.downloader;
    if (downloader === null) throw new ResearchProcessError('research_model_downloader_unavailable');
    const root = this.requireRoot();
    const total = packBytes(LOCK, pack);
    // 进度来自磁盘：官方下载器不汇报字节，但每落盘一个文件就算出来真实值。
    const report = async (): Promise<void> => {
      if (this.job === null) return;
      this.job = { ...this.job, bytesDone: await downloadedBytesFor(root, LOCK, pack) };
    };
    this.job = { pack, source, phase: 'downloading', bytesDone: await downloadedBytesFor(root, LOCK, pack), bytesTotal: total,
      startedAt: new Date().toISOString() };
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    if (signal?.aborted === true) controller.abort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const tick = setInterval(() => { void report(); }, 1_000);
    tick.unref();
    try {
      await installModels(LOCK, root, { packs: [pack], context: { signal: controller.signal },
        download: async (repo, staging) => { await downloader(repo, staging, source, { signal: controller.signal }); } });
      // 下载器已经逐文件核对过；这里再走一遍严格校验，把「官方说好了」变成「Roc 验过了」。
      this.job = { pack, source, phase: 'verifying', bytesDone: total, bytesTotal: total, startedAt: this.job.startedAt };
      const inspected = await inspectInstalledModels(root, LOCK, { verifyHashes: true, packs: [pack] });
      if (!inspected.ready) throw new ResearchProcessError(inspected.error ?? 'research_models_invalid');
      this.verified.add(pack);
      return await this.status();
    } finally {
      clearInterval(tick);
      signal?.removeEventListener('abort', onAbort);
      this.job = null;
    }
  }

  /**
   * 导入用户已经下载好的目录（提案 §5）。
   *
   * 源目录只读：先按清单校验，再把**清单内的文件**复制到 staging，重新校验后才发布。
   * 不依赖源目录之后还在，也不修改它。
   */
  async importDirectory(directory: string): Promise<ResearchModelsStatus> {
    if (this.job !== null) throw new ResearchProcessError('research_model_download_locked');
    if (!isAbsolute(directory)) throw new ResearchProcessError('research_model_import_path_invalid');
    const root = this.requireRoot();
    const source = await realpathIfDirectory(directory);
    const stagingRoot = await mkdtemp(join(root, '.import-'));
    try {
      let matched = 0;
      for (const repo of readSources(LOCK)) {
        const candidate = await findRepo(source, repo.name);
        if (candidate === null) continue;
        // 导入先做宽松校验（用户目录里可能有 `.cache` 之类），复制后再严格校验发布。
        await verifyModelRepository(candidate, repo, { strict: false });
        await copyRepo(candidate, join(stagingRoot, repo.name), repo);
        await verifyModelRepository(join(stagingRoot, repo.name), repo, { strict: true });
        matched += 1;
      }
      if (matched === 0) throw new ResearchProcessError('research_model_import_empty');
      await mkdir(join(root, '.locks'), { recursive: true });
      for (const repo of readSources(LOCK)) {
        const staged = join(stagingRoot, repo.name);
        const destination = join(root, repo.name);
        if (!(await exists(staged))) continue;
        // 已存在的仓库不覆盖：导入不能悄悄替换正在被解析使用的权重。
        if (await exists(destination)) continue;
        await rename(staged, destination);
      }
      this.verified.clear();
      return await this.status();
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }

  /**
   * 卸载一个配置包独占的仓库。
   *
   * 共享仓库（torch 被 basic/standard/flash 共用）只有在没有其它已就绪包或活动租约需要时才删。
   */
  async remove(pack: ModelPack): Promise<ResearchModelsStatus> {
    if (this.job !== null) throw new ResearchProcessError('research_model_download_locked');
    const root = this.requireRoot();
    const installed = await inspectInstalledModels(root, LOCK, { packs: [pack] });
    const busy = new Set<string>();
    for (const other of PACKS) {
      const leased = (this.leases.get(other) ?? 0) > 0;
      const status = other === pack ? null : await inspectInstalledModels(root, LOCK, { packs: [other] });
      if (!leased && status?.ready !== true) continue;
      for (const name of PACK_REPOS[other]) busy.add(name);
    }
    for (const model of installed.models) {
      if (!model.ready || busy.has(model.name)) continue;
      await rm(join(root, model.name), { recursive: true, force: true });
    }
    this.verified.delete(pack);
    return await this.status();
  }

  /** 实际占用（按清单内文件统计，不数 `.cache`）。 */
  async installedBytes(): Promise<number> {
    if (this.rootPath === null) return 0;
    return await totalBytes(this.rootPath);
  }

  private requireRoot(): string {
    if (this.rootPath === null || !isAbsolute(this.rootPath)) throw new ResearchProcessError('research_models_unavailable');
    return this.rootPath;
  }

  private async snapshot(): Promise<Omit<ResearchModelsStatus, 'downloading' | 'job'>> {
    if (this.rootPath === null || !isAbsolute(this.rootPath)) {
      return { ready: false, error: 'research_models_unavailable', selectedPack: this.preferences.pack,
        source: this.preferences.source, packs: PACKS.map(emptyPack), models: [] };
    }
    const all = await inspectInstalledModels(this.rootPath, LOCK, {});
    const packs: PackStatus[] = [];
    for (const pack of PACKS) {
      const inspected = await inspectInstalledModels(this.rootPath, LOCK, { packs: [pack] });
      packs.push({
        pack,
        ready: inspected.ready,
        bytes: packBytes(LOCK, pack),
        installedBytes: inspected.models.filter((model) => model.ready).reduce((sum, model) => sum + model.bytes, 0),
        state: packState(pack, inspected, this.job),
        error: inspected.ready ? null : (inspected.error ?? 'research_model_missing'),
        models: [...PACK_REPOS[pack]]
      });
    }
    return {
      ready: packs.find((entry) => entry.pack === this.preferences.pack)?.ready === true,
      error: all.error,
      selectedPack: this.preferences.pack,
      source: this.preferences.source,
      packs,
      models: all.models
    };
  }
}

function emptyPack(pack: ModelPack): PackStatus {
  return { pack, ready: false, bytes: packBytes(LOCK, pack), installedBytes: 0, state: 'missing',
    error: 'research_models_unavailable', models: [...PACK_REPOS[pack]] };
}

/** 一个包的可见状态：正在进行的任务优先于落盘检查。 */
function packState(
  pack: ModelPack,
  inspected: { ready: boolean; models: { error: string | null }[] },
  job: ModelJob | null
): PackStatus['state'] {
  if (job !== null && job.pack === pack) return job.phase === 'verifying' ? 'verifying' : 'downloading';
  if (inspected.ready) return 'ready';
  const broken = inspected.models.some((model) => model.error !== null && !model.error.startsWith('research_model_missing'));
  return broken ? 'incompatible' : 'missing';
}

/**
 * 在用户的目录里找某个仓库。
 *
 * 两种常见布局都接受：`<dir>/<repo>`（直接指向模型根）和 `<dir>/models/<repo>`
 * （直接指向 MinerU 的 `MINERU_HOME`）。
 */
async function findRepo(source: string, name: string): Promise<string | null> {
  for (const candidate of [join(source, name), join(source, 'models', name)]) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function realpathIfDirectory(directory: string): Promise<string> {
  let resolved: string;
  try { resolved = await realpath(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ResearchProcessError('research_model_import_missing');
    throw error;
  }
  if (!(await stat(resolved)).isDirectory()) throw new ResearchProcessError('research_model_import_invalid');
  return resolved;
}

/** 只复制清单内的文件与目录级就绪标记：源目录里的额外内容不能进入 Roc 的模型根。 */
async function copyRepo(source: string, destination: string, repo: ModelSource): Promise<void> {
  const copy = async (relativePath: string): Promise<void> => {
    const to = join(destination, relativePath);
    await mkdir(join(to, '..'), { recursive: true });
    await cp(join(source, relativePath), to);
  };
  for (const filename of Object.keys(repo.files)) await copy(filename);
  // 目录级标记必须一起带过来：MinerU 的本地就绪检查只认这些标记。
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.cache') continue;
    for (const marker of await readdir(join(source, entry.name), { withFileTypes: true })) {
      if (marker.isFile() && marker.name === '.mineru_complete') await copy(`${entry.name}/${marker.name}`);
    }
  }
}

function isModelPack(value: unknown): value is ModelPack {
  return PACKS.includes(value as ModelPack);
}

function isModelSource(value: unknown): value is ResearchModelSource {
  return SOURCES.includes(value as ResearchModelSource);
}
