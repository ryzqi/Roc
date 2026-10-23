import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import toolsLock from '../../../../resources/research-runtime/tools.lock.json';
import workerSource from '../../../../resources/research-runtime/worker.py?raw';
import { researchParseOptionsSchema, researchParsedDocumentSchema, researchRenderedPdfSchema, researchToolchainStatusSchema,
  type ResearchParseOptions, type ResearchParseTier } from '../../../shared/schemas/research-production';
import { researchBibliographyEntrySchema, type researchBibliographyFormatSchema } from '../../../shared/schemas/research-library';
import { assertResearchDescendant, createResearchDirectory, readResearchFile, researchContentHash, researchRelativePath } from './research-files';
import { lockedToolVersions, toolVersionsMatch } from './toolchain-versions';
import { runResearchProcess, ResearchProcessError, type ResearchProcessResult } from './process-runner';
import { ResearchModelStore, type ModelDownloader, type ModelPreferences, type ResearchModelSource, type ResearchModelsStatus } from './model-store';
import type { ModelPack } from '../../../../scripts/research/fetch-models';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const manifestSchema = z.object({
  schemaVersion: z.literal(1), platform: z.literal('darwin'), architecture: z.literal('arm64'),
  // 版本键是开放的：`checkToolVersions` 按 `architectures[arch]` 实际有哪些工具逐键比对，
  // 所以加一个工具（例如 vale）只需要改 lock 与 prepare，不用再动这张 schema。
  versions: z.record(z.string(), z.string()),
  lockHashes: z.record(z.string(), digestSchema),
  entries: z.array(z.discriminatedUnion('type', [
    z.object({ path: z.string(), type: z.literal('file'), size: z.number().int().nonnegative(), sha256: digestSchema, executable: z.boolean() }).strict(),
    z.object({ path: z.string(), type: z.literal('symlink'), target: z.string() }).strict()
  ])).max(100_000)
}).strict();

type Manifest = z.infer<typeof manifestSchema>;
type WorkerInput = { projectRoot: string; sourcePath: string; outputDir: string; jobDir: string; signal?: AbortSignal };

function parseOperationTier(operation: Record<string, unknown>): ResearchParseTier | null {
  const options = operation.options;
  if (operation.operation !== 'parse_document' || options === null || typeof options !== 'object') return null;
  return (options as { tier?: ResearchParseTier }).tier ?? null;
}
type ResolvedToolchain = { root: string; manifest: Manifest };

/** 用户模型选择在 `plugin_config` 里的键（包的持久化位置见 `ConfigStore`）。 */
const MODEL_PREFERENCES_KEY = 'researchModelPreferences';

export class ResearchToolchain {
  private verification: Promise<ResolvedToolchain> | null = null;
  private models: ResearchModelStore;
  private readonly modelsRoot: string | null;
  /** 当前下载任务的取消句柄：设置页的「取消」中止官方 CLI，staging 保留供续传。 */
  private downloadController: AbortController | null = null;

  constructor(private readonly rootPath: string | null, modelsRoot: string | null = null) {
    this.modelsRoot = modelsRoot;
    this.models = new ResearchModelStore(modelsRoot, this.modelDownloader);
  }

  /**
   * 把用户选择接到插件的持久化配置上（`plugin_config` 表）。
   *
   * 只在 `initialize` 时调用一次：存储构造时还没有 `RocPluginContext`，
   * 所以选择项必须在拿到 context 之后重新装配。
   */
  attachModelConfig(config: { get<T>(key: string): T | null; set<T>(key: string, value: T): void }): void {
    const saved = config.get<Partial<ModelPreferences>>(MODEL_PREFERENCES_KEY);
    this.models = new ResearchModelStore(this.modelsRoot, this.modelDownloader, saved ?? {}, (next) => {
      config.set(MODEL_PREFERENCES_KEY, next);
    });
  }

  async status(): Promise<z.infer<typeof researchToolchainStatusSchema>> {
    try {
      const { manifest } = await this.resolve();
      return { available: true, versions: manifest.versions, error: null };
    } catch (error) {
      return { available: false, versions: null, error: error instanceof ResearchProcessError ? error.code : 'research_toolchain_invalid' };
    }
  }

  async identity(): Promise<string> {
    const { manifest } = await this.resolve();
    return researchContentHash(JSON.stringify(manifest.lockHashes));
  }

  async experimentRuntime(jobDir: string): Promise<{ root: string; python: string; pythonVersion: string; uv: string; hash: string; environment: NodeJS.ProcessEnv }> {
    const { root, manifest } = await this.resolve();
    return { root, python: join(root, 'python/bin/python3'), pythonVersion: manifest.versions.python, uv: join(root, 'bin/uv'),
      hash: researchContentHash(JSON.stringify(manifest.lockHashes)), environment: await this.environment(root, jobDir) };
  }

  /**
   * 冻结的解析配置。档位选择属于请求，不属于 worker 默认值：worker 不猜。
   * HTML 强制 flash（提案 §6）：它没有需要版面模型的页，也不建虚构页码。
   */
  async parseDocument(input: WorkerInput & { options: ResearchParseOptions }): Promise<z.infer<typeof researchParsedDocumentSchema>> {
    return await this.worker(input, { operation: 'parse_document', options: input.options }, researchParsedDocumentSchema, 600_000);
  }

  /** 当前默认解析配置：按用户选择的模型包推导，缺包时由调用方显式报错。 */
  defaultParseOptions(mediaType: string): ResearchParseOptions {
    // HTML 固定 flash（提案 §6）：不加载推理模型，也不虚构 PDF 页码。
    const pack = this.models.selectedPack;
    const tier: ResearchParseTier = mediaType === 'text/html' ? 'flash' : pack;
    return researchParseOptionsSchema.parse({
      tier, smallBackend: 'torch', vlmEngine: tier === 'standard' || tier === 'advanced' ? 'llama-cpp' : 'auto',
      device: 'mps', pageRange: '', ocrMode: 'auto'
    });
  }

  async renderPdf(input: WorkerInput & { page: number; scale: number }): Promise<z.infer<typeof researchRenderedPdfSchema>> {
    return await this.job(input, { operation: 'render_pdf', page: input.page, scale: input.scale }, researchRenderedPdfSchema);
  }

  async extractTemplate(input: WorkerInput): Promise<void> {
    await this.job(input, { operation: 'extract_template' }, z.object({ sourceHash: z.string(), fileCount: z.number().int().nonnegative() }).strict());
  }

  async readBibliography(input: WorkerInput & { format: z.infer<typeof researchBibliographyFormatSchema> }): Promise<z.infer<typeof researchBibliographyEntrySchema>[]> {
    const result = await this.job(input, { operation: 'read_bibliography', format: input.format },
      z.object({ sourceHash: z.string(), entries: z.array(researchBibliographyEntrySchema) }).strict());
    return result.entries;
  }

  async normalizeBibliography(input: WorkerInput): Promise<z.infer<typeof researchBibliographyEntrySchema>[]> {
    const result = await this.job(input, { operation: 'normalize_bibliography' },
      z.object({ sourceHash: z.string(), entries: z.array(researchBibliographyEntrySchema) }).strict());
    return result.entries;
  }

  async writeBibliography(input: WorkerInput & { format: z.infer<typeof researchBibliographyFormatSchema> }): Promise<{ filename: string; content: string }> {
    const result = await this.job(input, { operation: 'write_bibliography', format: input.format },
      z.object({ sourceHash: z.string(), filename: z.string(), content: z.string() }).strict());
    return { filename: result.filename, content: result.content };
  }

  /**
   * 用随包的 Vale 检查一段文稿投影，返回**未经信任**的 JSON 报告。
   *
   * 两个不变量比功能本身重要：
   *
   * 1. **离线且无全局配置**。`--no-global` 是必需的：没有它 Vale 会读 `$HOME/.vale.ini` 与
   *    `$XDG_CONFIG_HOME` 下用户装的 style 包，同一段文稿在不同机器上就会给出不同结论，
   *    而这些结论要进导出溯源。`networkAccess: 'none'` 保证 `vale sync` 类行为直接失败。
   * 2. **只写 jobDir**。投影文件是我们自己写进 `jobDir/prose/` 的，Vale 的 `HOME`/`TMPDIR`/
   *    缓存全部指向 jobDir 内的目录，工具链根目录仅只读挂载。
   *
   * 参数顺序与开关是实测得来的，不是照文档抄的：`--sort` 与 `--glob` 在 Vale 3.24.0 会报
   * `argument 'file' does not exist`，`--no-exit` 必须给（有 error 级告警时 Vale 退出码非零，
   * 那不是失败）。另外 Vale 对读不到的文件**静默返回空对象**，所以文件由本方法写入并核对。
   */
  async lintProse(input: { jobDir: string; units: readonly { path: string; content: string }[]; signal?: AbortSignal }): Promise<unknown> {
    const { root } = await this.resolve();
    if (input.units.length === 0) throw new ResearchProcessError('research_prose_no_units');
    const proseDir = await createResearchDirectory(input.jobDir, 'prose');
    const targets: string[] = [];
    for (const unit of input.units) {
      const relative = researchRelativePath(unit.path);
      const target = join(proseDir, relative);
      assertResearchDescendant(proseDir, target);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, unit.content, 'utf8');
      targets.push(target);
    }
    const result = await runResearchProcess({
      command: join(root, 'bin/vale'),
      args: ['--config', join(root, 'vale/.vale.ini'), '--no-global', '--no-color', '--no-exit', '--output=JSON',
        '--minAlertLevel=suggestion', ...targets],
      cwd: proseDir,
      readablePaths: [root, proseDir],
      writablePaths: [input.jobDir],
      environment: await this.proseEnvironment(root, input.jobDir),
      timeoutMs: 120_000, signal: input.signal, allowGpuAcceleration: false, networkAccess: 'none', allowPosixSpawn: false
    });
    if (result.exitCode !== 0) throw new ResearchProcessError('research_prose_lint_failed', result.stdout, result.stderr);
    const parsed = parseJson(result.stdout);
    // 配置或用法错误时 Vale 不回报告，而是一个 `{Code: 'E100', Text: …}` 对象且退出码非零。
    // 走到这里说明退出码是 0，但两端都判一次：静默把 E100 当「没有命中」是这套检查最坏的失败模式。
    if (isProseErrorEnvelope(parsed)) throw new ResearchProcessError('research_prose_lint_failed', result.stdout, result.stderr);
    return parsed;
  }

  private async proseEnvironment(root: string, jobDir: string): Promise<NodeJS.ProcessEnv> {
    const temporary = await createResearchDirectory(jobDir, 'tmp');
    const cache = await createResearchDirectory(jobDir, 'cache');
    const home = await createResearchDirectory(jobDir, 'home');
    // `HOME` 不给系统用户目录：Vale 会去 `$HOME/.config/vale` 与 `$XDG_DATA_HOME` 找配置和
    // 缓存，而那些路径既不在可读名单里，也不应该被读。给一个空目录 + `--no-global` 把
    // 「这台机器上装过什么」从检查结果里剔除。
    return { PATH: `${join(root, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, LANG: 'en_US.UTF-8',
      TMPDIR: temporary, XDG_CACHE_HOME: cache, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share') };
  }

  async compile(input: { rootPath: string; entryPath: string; outputDir: string; jobDir: string; signal?: AbortSignal }): Promise<ResearchProcessResult> {
    const { root } = await this.resolve();
    const environment = await this.environment(root, input.jobDir);
    // `--keep-intermediates` 是为了拿到 `.bbl`：arXiv 不运行 BibTeX，随包不带 `.bbl` 的提交
    // 在那边会把每一处引用渲染成 `?`（`arxiv-preflight.ts` 的 `missing_bbl` 就是这条）。
    // 中间文件只落在 `outputDir`（即导出的 scratch），不会进交付包——取 `.bbl` 是调用方的事。
    return await runResearchProcess({ command: join(root, 'bin/tectonic'),
      args: ['--bundle', join(root, 'tex/bundle.zip'), '--only-cached', '--untrusted', '--keep-logs', '--keep-intermediates',
        '--outdir', input.outputDir, input.entryPath],
      cwd: input.rootPath, readablePaths: [root, input.rootPath], writablePaths: [input.jobDir], environment,
      timeoutMs: 180_000, signal: input.signal, allowGpuAcceleration: false, networkAccess: 'none', allowPosixSpawn: false });
  }

  /**
   * Typst 编译：只服务导出附带的**报告**（`typst-report.ts`），不进 LaTeX 主链。
   *
   * 三个边界与 `compile()` 一致：离线、只写 jobDir、只读工具链根与本次输入的根目录。
   * 额外一条是字体：Typeface 在沙箱里没有 `$HOME/Library/Fonts`，也没有全盘读权限，
   * 所以显式给 `--font-path`（系统字体目录），并把它加入 `readablePaths`。
   * 这样同一台机器上生成的报告不会因为用户装了字型而变样（与 Vale 的 `--no-global` 同一个理由）。
   */
  async compileTypst(input: { rootPath: string; sourcePath: string; outputPath: string; jobDir: string; signal?: AbortSignal }): Promise<ResearchProcessResult> {
    const { root } = await this.resolve();
    // 只加真实存在的目录：沙箱配置会对每个路径做 realpath，不存在就整次失败。
    const fontPaths = ['/System/Library/Fonts', '/System/Library/Fonts/Supplemental'].filter((path) => existsSync(path));
    const temporary = await createResearchDirectory(input.jobDir, 'tmp');
    const cache = await createResearchDirectory(input.jobDir, 'cache');
    const home = await createResearchDirectory(input.jobDir, 'home');
    return await runResearchProcess({ command: join(root, 'bin/typst'),
      args: ['compile', '--root', input.rootPath,
        ...fontPaths.flatMap((path) => ['--font-path', path]),
        input.sourcePath, input.outputPath],
      cwd: input.jobDir,
      readablePaths: [root, input.rootPath, ...fontPaths],
      writablePaths: [input.jobDir],
      environment: { PATH: `${join(root, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: 'en_US.UTF-8',
        HOME: home, TMPDIR: temporary, XDG_CACHE_HOME: cache },
      timeoutMs: 120_000, signal: input.signal, allowGpuAcceleration: false, networkAccess: 'none', allowPosixSpawn: false });
  }

  /**
   * 读一份随包的 CSL 样式文件（`csl/<name>`）。
   *
   * 样式是**数据**：它决定报告里参考文献的排法，所以与 Vale 规则集一样进 `lockHashes`。
   * 只允许 `csl/` 下的 `.csl` 文件名，不把路径拼串交给调用方。
   */
  async typstStyle(name: string): Promise<Buffer> {
    if (!/^[\w.-]+\.csl$/u.test(name)) throw new ResearchProcessError('research_typst_style_invalid');
    const { root } = await this.resolve();
    return await readResearchFile(root, `csl/${name}`, 1024 * 1024);
  }

  async modelsStatus(): Promise<ResearchModelsStatus> {
    return await this.models.status();
  }

  async selectModels(pack: ModelPack, source: ResearchModelSource | undefined): Promise<ResearchModelsStatus> {
    this.models.selectPack(pack);
    if (source !== undefined) this.models.selectSource(source);
    return await this.models.status();
  }

  /**
   * 下载一个包。
   *
   * `pack`/`source` 同时是**选择的写入**：用户在设置页点「下载」就是在选它，
   * 不应再要求一次额外的「选中」操作。
   */
  async downloadModels(pack: ModelPack, source: ResearchModelSource): Promise<ResearchModelsStatus> {
    if (this.downloadController !== null) throw new ResearchProcessError('research_model_download_locked');
    this.models.selectPack(pack);
    this.models.selectSource(source);
    const controller = new AbortController();
    this.downloadController = controller;
    try {
      return await this.models.download(pack, source, controller.signal);
    } finally {
      if (this.downloadController === controller) this.downloadController = null;
    }
  }

  /** 取消当前下载：中止官方 CLI，staging 保留供续传；返回取消后的真实状态。 */
  async cancelModelsDownload(): Promise<ResearchModelsStatus> {
    this.downloadController?.abort();
    return await this.models.status();
  }
  async importModels(directory: string): Promise<ResearchModelsStatus> {
    return await this.models.importDirectory(directory);
  }

  async removeModels(pack: ModelPack): Promise<ResearchModelsStatus> {
    return await this.models.remove(pack);
  }

  /**
   * 官方下载入口：`python -m mineru.kit.main models download <repo> --source <source>`。
   *
   * 用 `-I -B` 与受控环境变量启动，并把 `MINERU_HOME` 指向 staging：官方 CLI 在
   * `$MINERU_HOME/models` 下落盘，并在仓库子目录里生成 `.mineru_complete`。
   * 网络策略是 `full`（此处唯一的联网点，见提案 §5），GPU 不参与。
   */
  private readonly modelDownloader: ModelDownloader = async (repo, staging, source, context) => {
    const { root } = await this.resolve();
    // `MINERU_HOME` 直接指向 staging：官方 CLI 在 `$MINERU_HOME/models/<repo>` 下落盘。
    // `fetchModel` 随后按 `<staging>/<repo>` 校验，所以下完后把仓库目录上提一层。
    await runResearchProcess({
      command: join(root, 'python/bin/python3'),
      args: ['-I', '-B', '-m', 'mineru.kit.main', 'models', 'download', repo.name, '--source', source],
      cwd: staging,
      // 沙箱必须能读到工具链自带的 site-packages，并写入 staging。
      readablePaths: [root],
      writablePaths: [staging],
      environment: {
        PATH: `${join(root, 'python/bin')}:${join(root, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
        LANG: 'en_US.UTF-8',
        HOME: staging, TMPDIR: staging, XDG_CACHE_HOME: join(staging, 'cache'),
        MINERU_HOME: staging,
        HF_HUB_DISABLE_TELEMETRY: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1'
      },
      timeoutMs: 3_600_000,
      allowGpuAcceleration: false,
      networkAccess: 'full',
      allowPosixSpawn: false,
      signal: context.signal
    });
    const downloaded = join(staging, 'models', repo.name);
    const published = join(staging, repo.name);
    await rename(downloaded, published);
  };

  private async job<T>(input: WorkerInput, operation: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    const request = { ...operation, projectRoot: input.projectRoot, sourcePath: input.sourcePath, outputDir: input.outputDir };
    const packagedCli = fileURLToPath(new URL('./research-job-cli.js', import.meta.url));
    if (!existsSync(packagedCli)) {
      return await this.jobInProcess(input, operation, schema);
    }
    const require = createRequire(import.meta.url);
    const optionalNative = (specifier: string): string[] => {
      try { return [dirname(require.resolve(`${specifier}/package.json`))]; }
      catch { return []; }
    };
    const readablePaths = [
      dirname(packagedCli),
      dirname(require.resolve('pdfjs-dist/package.json')),
      dirname(require.resolve('@napi-rs/canvas/package.json')),
      // 只可能有 arm64 的原生 canvas：x64 那份不再进包，解析它只会得到一条无用的放行路径。
      ...optionalNative('@napi-rs/canvas-darwin-arm64'),
      process.execPath,
      join(dirname(process.execPath), '..'),
      input.sourcePath,
      input.projectRoot
    ];
    const result = await runResearchProcess({
      command: process.execPath,
      args: [packagedCli],
      cwd: input.jobDir,
      readablePaths,
      writablePaths: [input.jobDir],
      environment: { ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      timeoutMs: 60_000,
      signal: input.signal,
      input: JSON.stringify(request),
      allowGpuAcceleration: false,
      networkAccess: 'none',
      allowPosixSpawn: false
    });
    const envelope = z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), result: schema }).strict(),
      z.object({ ok: z.literal(false), error: z.object({ code: z.string(), type: z.string() }).strict() }).strict()
    ]).safeParse(parseJson(result.stdout));
    if (!envelope.success) throw new ResearchProcessError('research_worker_response_invalid', '', result.stderr);
    if (!envelope.data.ok) throw new ResearchProcessError(envelope.data.error.code, '', result.stderr);
    if (result.exitCode !== 0) throw new ResearchProcessError('research_worker_failed', '', result.stderr);
    return envelope.data.result;
  }

  private async jobInProcess<T>(input: WorkerInput, operation: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    const { extractResearchTemplate } = await import('./template-archive');
    const { normalizeResearchBibliography, readResearchBibliography, writeResearchBibliography } = await import('./bibliography');
    const { renderResearchPdf } = await import('./pdf-render');
    const base = { projectRoot: input.projectRoot, sourcePath: input.sourcePath, outputDir: input.outputDir, signal: input.signal, timeoutMs: 60_000 };
    const name = operation.operation;
    if (name === 'extract_template') return schema.parse(await extractResearchTemplate(base));
    if (name === 'render_pdf') {
      return schema.parse(await renderResearchPdf({ ...base, page: Number(operation.page), scale: Number(operation.scale) }));
    }
    if (name === 'read_bibliography') {
      return schema.parse(await readResearchBibliography({ ...base, format: operation.format as 'bibtex' | 'biblatex' | 'csl-json' }));
    }
    if (name === 'normalize_bibliography') return schema.parse(await normalizeResearchBibliography(base));
    if (name === 'write_bibliography') {
      return schema.parse(await writeResearchBibliography({ ...base, format: operation.format as 'bibtex' | 'biblatex' | 'csl-json' }));
    }
    throw new ResearchProcessError('research_operation_unknown');
  }

  private async worker<T>(input: WorkerInput, operation: Record<string, unknown>, schema: z.ZodType<T>, timeoutMs: number): Promise<T> {
    const { root } = await this.resolve();
    const tier = parseOperationTier(operation);
    // Flash 不加载模型：不去碰模型目录，也不把“目录存在”当成成功的前提。
    // 租约按**解析档位**登记：`requireReady(pack)` 校验的也必须就是这个包，
    // 否则会校验用户选中的包、却释放解析实际用到的包的租约。
    const modelsPath = tier === null || tier === 'flash' ? null : await this.models.requireReady(tier);
    if (tier === null || tier === 'flash') return await this.runWorker(input, operation, schema, timeoutMs, root, null);
    // 租约覆盖整个解析：其间用户卸载模型不能把这批权重删掉。
    try {
      return await this.runWorker(input, operation, schema, timeoutMs, root, modelsPath);
    } finally {
      this.models.release(tier);
    }
  }

  private async runWorker<T>(input: WorkerInput, operation: Record<string, unknown>, schema: z.ZodType<T>,
    timeoutMs: number, root: string, modelsPath: string | null): Promise<T> {
    const request = { ...operation, projectRoot: input.projectRoot, sourcePath: input.sourcePath, outputDir: input.outputDir,
      ...(modelsPath === null ? {} : { modelsPath }) };
    const result = await runResearchProcess({ command: join(root, 'python/bin/python3'), args: ['-I', '-B', join(root, 'worker.py')],
      cwd: input.jobDir, readablePaths: [root, input.sourcePath, ...(modelsPath === null ? [] : [modelsPath])], writablePaths: [input.jobDir],
      environment: await this.environment(root, input.jobDir), input: JSON.stringify(request), timeoutMs, signal: input.signal,
      allowGpuAcceleration: operation.operation === 'parse_document', networkAccess: 'none', allowPosixSpawn: false });
    const envelope = z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), result: schema }).strict(),
      z.object({ ok: z.literal(false), error: z.object({ code: z.string(), type: z.string() }).strict() }).strict()
    ]).safeParse(parseJson(result.stdout));
    if (!envelope.success) throw new ResearchProcessError('research_worker_response_invalid', '', result.stderr);
    if (!envelope.data.ok) throw new ResearchProcessError(envelope.data.error.code, '', result.stderr);
    if (result.exitCode !== 0) throw new ResearchProcessError('research_worker_failed', '', result.stderr);
    return envelope.data.result;
  }

  private async environment(root: string, jobDir: string): Promise<NodeJS.ProcessEnv> {
    const temporary = await createResearchDirectory(jobDir, 'tmp');
    const cache = await createResearchDirectory(jobDir, 'cache');
    return { PATH: `${join(root, 'python/bin')}:${join(root, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: 'en_US.UTF-8',
      TMPDIR: temporary, XDG_CACHE_HOME: cache, MPLCONFIGDIR: join(cache, 'matplotlib'), TECTONIC_CACHE_DIR: join(cache, 'tectonic'),
      HF_HOME: join(cache, 'huggingface'), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
      HF_HUB_DISABLE_IMPLICIT_TOKEN: '1', HF_HUB_DISABLE_TELEMETRY: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' };
  }

  private async resolve(): Promise<ResolvedToolchain> {
    if (this.verification === null) {
      this.verification = this.verify().catch((error: unknown) => { this.verification = null; throw error; });
    }
    return await this.verification;
  }

  private async verify(): Promise<ResolvedToolchain> {
    if (this.rootPath === null || !isAbsolute(this.rootPath)) throw new ResearchProcessError('research_toolchain_unavailable');
    let root: string;
    try { root = await realpath(this.rootPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ResearchProcessError('research_toolchain_unavailable');
      throw error;
    }
    const manifest = manifestSchema.parse(parseJson((await readResearchFile(root, 'manifest.json', 32 * 1024 * 1024)).toString('utf8')));
    // 只认 arm64：一个 x64 工具链能在它自己的架构上跑起来，但对这个只发 arm64 的应用是错的运行时。
    const expected = lockedToolVersions(toolsLock, 'arm64');
    if (manifest.architecture !== 'arm64' || expected === null || !toolVersionsMatch(manifest.versions, expected)) {
      throw new ResearchProcessError('research_toolchain_version_mismatch');
    }
    const entries = new Map(manifest.entries.map((entry) => [researchRelativePath(entry.path), entry]));
    if (entries.size !== manifest.entries.length) throw new ResearchProcessError('research_toolchain_manifest_invalid');
    const requireHash = (path: string, hash: string): void => {
      const entry = entries.get(path);
      if (entry?.type !== 'file' || entry.sha256 !== hash) throw new ResearchProcessError('research_toolchain_source_mismatch');
    };
    requireHash('worker.py', researchContentHash(workerSource));
    requireHash('tex/bundle.zip', toolsLock.texBundle.zipSha256);
    const actual: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        const relativePath = relative(root, path);
        if (isPackagedModelPath(relativePath)) continue;
        if (entry.isDirectory()) await visit(path);
        else if (relativePath !== 'manifest.json') actual.push(relativePath);
      }
    };
    await visit(root);
    const tracked = [...entries.keys()].filter((path) => !isPackagedModelPath(path));
    if (actual.length !== tracked.length || actual.some((path) => !entries.has(path) || isPackagedModelPath(path))) {
      throw new ResearchProcessError('research_toolchain_integrity_mismatch');
    }
    let index = 0;
    // 抽成命名函数而不是内联 async 回调：`Array.from` 的回调必须显式返回值，
    // 而这里是一个消费共享游标的 while 循环（四个 worker 并行校验条目）。
    const verifyNextEntries = async (): Promise<void> => {
      while (index < manifest.entries.length) {
        const entry = manifest.entries[index++];
        if (isPackagedModelPath(entry.path)) continue;
        const path = join(root, entry.path);
        const info = await lstat(path);
        if (entry.type === 'symlink') {
          if (!info.isSymbolicLink() || isAbsolute(entry.target) || await readlink(path) !== entry.target) {
            throw new ResearchProcessError('research_toolchain_integrity_mismatch');
          }
          assertResearchDescendant(root, await realpath(path));
        } else {
          if (!info.isFile() || info.size !== entry.size || Boolean(info.mode & 0o100) !== entry.executable) {
            throw new ResearchProcessError('research_toolchain_integrity_mismatch');
          }
          const hash = createHash('sha256');
          if (entry.size <= 1024 * 1024) hash.update(await readFile(path));
          else for await (const buffer of createReadStream(path, { highWaterMark: 1024 * 1024 })) hash.update(buffer);
          if (hash.digest('hex') !== entry.sha256) throw new ResearchProcessError('research_toolchain_integrity_mismatch');
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, () => verifyNextEntries()));
    return { root, manifest };
  }
}

/** 子进程/清单的 JSON 形状：先按结构收窄，再由调用方的 zod schema 决定是不是领域对象。 */
type JsonDocument = string | number | boolean | null | JsonDocument[] | { [key: string]: JsonDocument };

function parseJson(value: string): JsonDocument {
  try { return JSON.parse(value) as JsonDocument; }
  catch { throw new ResearchProcessError('research_json_invalid'); }
}

/**
 * Vale 的配置/用法错误信封：一个 `{Line, Path, Text, Code, Span}` 对象，而不是
 * `{ "<file>": [alert, …] }`。区分它和「一个字都没报」是必要的——两者都是合法的 JSON。
 */
function isProseErrorEnvelope(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).Code === 'string';
}

function isPackagedModelPath(path: string): boolean {
  return path === 'models' || path.startsWith('models/');
}
