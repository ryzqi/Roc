import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import toolsLock from '../../../../resources/research-runtime/tools.lock.json';
import { researchParseOptionsSchema, researchParsedDocumentSchema, researchParserIdentityPayload, researchRenderedPdfSchema, researchToolchainStatusSchema,
  type ResearchParseOptions } from '../../../shared/schemas/research-production';
import { researchBibliographyEntrySchema, type researchBibliographyFormatSchema } from '../../../shared/schemas/research-library';
import type { ResearchModelPack } from '../../../shared/schemas/research-production';
import { researchFigureRenderJobResultSchema, researchFigureRenderJobSchema, type ResearchFigureRenderJob } from '../../../shared/schemas/research-figures';
import { assertResearchDescendant, createResearchDirectory, readResearchFile, researchContentHash, researchPath, researchRelativePath } from './research-files';
import { lockedToolVersions, toolVersionsMatch } from './toolchain-versions';
import { runResearchProcess, ResearchProcessError, type ResearchProcessResult } from './process-runner';
import { ResearchModelStore, type ModelPreferences, type ResearchModelFiles, type ResearchModelsStatus } from './model-store';
import { modelPackManifest } from './model-catalog';

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
type FigureWorkerInput = WorkerInput & Pick<ResearchFigureRenderJob, 'inputPaths' | 'label' | 'timeoutMs' | 'figure'>;
export type ResearchTypeScriptRuntime = {
  root: string; executable: string; runnerPath: string; runnerHash: string; nodeVersion: string; platform: string; architecture: string;
  hash: string; packageEntries: Record<'csv-parse' | 'csv-stringify' | 'd3-dsv' | 'simple-statistics', string>;
  packageRoots: string[]; packages: Array<{ name: string; version: string }>; environment: NodeJS.ProcessEnv;
};

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
    this.models = new ResearchModelStore(modelsRoot);
  }

  /**
   * 把用户选择接到插件的持久化配置上（`plugin_config` 表）。
   *
   * 只在 `initialize` 时调用一次：存储构造时还没有 `RocPluginContext`，
   * 所以选择项必须在拿到 context 之后重新装配。
   */
  attachModelConfig(config: { get<T>(key: string): T | null; set<T>(key: string, value: T): void }): void {
    const saved = config.get<Partial<ModelPreferences>>(MODEL_PREFERENCES_KEY);
    this.models = new ResearchModelStore(this.modelsRoot, saved ?? {}, (next) => {
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
    return researchContentHash(JSON.stringify(researchParserIdentityPayload(modelPackManifest(this.models.selectedPack))));
  }

  async nativeRuntime(jobDir: string): Promise<{ root: string; hash: string; environment: NodeJS.ProcessEnv }> {
    const { root, manifest } = await this.resolve();
    return { root, hash: researchContentHash(JSON.stringify(manifest.lockHashes)), environment: await this.baseEnvironment(root, jobDir, true) };
  }

  async typescriptRuntime(jobDir: string): Promise<ResearchTypeScriptRuntime> {
    const { root } = await this.resolve();
    const runnerPath = await researchPath(root, 'typescript-experiment-runner.mts');
    const runnerHash = researchContentHash(await readResearchFile(root, 'typescript-experiment-runner.mts', 1024 * 1024));
    const specifiers = ['csv-parse', 'csv-stringify', 'd3-dsv', 'simple-statistics'] as const;
    const packageEntries = {} as ResearchTypeScriptRuntime['packageEntries'];
    const packageRoots: string[] = [];
    const packages: Array<{ name: string; version: string }> = [];
    for (const specifier of specifiers) {
      const entryUrl = import.meta.resolve(specifier);
      if (!entryUrl.startsWith('file:')) throw new ResearchProcessError('research_experiment_package_invalid');
      const entry = await realpath(fileURLToPath(entryUrl));
      let packageRoot = dirname(entry);
      while (!existsSync(join(packageRoot, 'package.json')) && dirname(packageRoot) !== packageRoot) packageRoot = dirname(packageRoot);
      if (!existsSync(join(packageRoot, 'package.json'))) throw new ResearchProcessError('research_experiment_package_missing');
      const packageJson = parseJson((await readResearchFile(packageRoot, 'package.json', 1024 * 1024)).toString('utf8'));
      if (packageJson === null || typeof packageJson !== 'object' || !('version' in packageJson) || typeof packageJson.version !== 'string') {
        throw new ResearchProcessError('research_experiment_package_invalid');
      }
      packageEntries[specifier] = entry;
      packageRoots.push(await realpath(packageRoot));
      packages.push({ name: specifier, version: packageJson.version });
    }
    packages.sort((left, right) => left.name.localeCompare(right.name));
    const nodeVersion = process.versions.node;
    const platform = process.platform;
    const architecture = process.arch;
    const features = process.features as NodeJS.ProcessFeatures & { typescript?: string };
    if (features.typescript !== 'strip' || process.versions.electron === undefined) {
      throw new ResearchProcessError('research_experiment_typescript_runtime_unavailable');
    }
    const identity = { engine: 'typescript', sourceVersion: 1, nodeVersion, electronVersion: process.versions.electron,
      platform, architecture, runnerHash, packages };
    return { root, executable: process.execPath, runnerPath, runnerHash, nodeVersion, platform, architecture,
      hash: researchContentHash(JSON.stringify(identity)), packageEntries, packageRoots: [...new Set(packageRoots)], packages,
      environment: await this.baseEnvironment(root, jobDir, false) };
  }

  /** Parse uses available pinned ONNX models; born-digital PDF and HTML still work without model files. */
  async parseDocument(input: WorkerInput & { options: ResearchParseOptions }): Promise<z.infer<typeof researchParsedDocumentSchema>> {
    const isHtml = ['.html', '.htm'].includes(extname(input.sourcePath).toLowerCase());
    const models = isHtml ? null : await this.models.tryRequireReady(input.options.tier);
    try {
      return await this.job(input, {
        operation: 'parse_document', options: input.options,
        modelFiles: models?.files ?? null, modelManifest: models?.manifest ?? ''
      }, researchParsedDocumentSchema);
    } finally {
      if (models !== null) this.models.release(models.pack);
    }
  }

  /** Freeze the user-selected model tier; actual inference device is recorded by the parser. */
  defaultParseOptions(_mediaType: string): ResearchParseOptions {
    return researchParseOptionsSchema.parse({ tier: this.models.selectedPack, device: 'coreml', pageRange: '' });
  }

  async renderFigure(input: FigureWorkerInput): Promise<z.infer<typeof researchFigureRenderJobResultSchema>> {
    const operation = researchFigureRenderJobSchema.parse({
      operation: 'render_figure', projectRoot: input.projectRoot, sourcePath: input.sourcePath, outputDir: input.outputDir,
      inputPaths: input.inputPaths, label: input.label, timeoutMs: input.timeoutMs, figure: input.figure
    });
    return await this.job(input, operation, researchFigureRenderJobResultSchema);
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
    const environment = await this.baseEnvironment(root, input.jobDir, true);
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

  async selectModels(pack: ResearchModelPack): Promise<ResearchModelsStatus> {
    this.models.selectPack(pack);
    return await this.models.status();
  }

  /** Download a pinned pack; the selected pack changes with the download action. */
  async downloadModels(pack: ResearchModelPack): Promise<ResearchModelsStatus> {
    if (this.downloadController !== null) throw new ResearchProcessError('research_model_download_locked');
    this.models.selectPack(pack);
    const controller = new AbortController();
    this.downloadController = controller;
    try {
      return await this.models.download(pack, controller.signal);
    } finally {
      if (this.downloadController === controller) this.downloadController = null;
    }
  }

  async cancelModelsDownload(): Promise<ResearchModelsStatus> {
    this.downloadController?.abort();
    return await this.models.status();
  }

  async importModels(directory: string, pack: ResearchModelPack): Promise<ResearchModelsStatus> {
    return await this.models.importDirectory(directory, pack);
  }

  async removeModels(pack: ResearchModelPack): Promise<ResearchModelsStatus> {
    return await this.models.remove(pack);
  }

  private async job<T>(input: WorkerInput, operation: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    const request = { ...operation, projectRoot: input.projectRoot, sourcePath: input.sourcePath, outputDir: input.outputDir };
    const packagedCli = fileURLToPath(new URL('./research-job-cli.js', import.meta.url));
    if (!existsSync(packagedCli)) {
      if (operation.operation === 'parse_document') throw new ResearchProcessError('research_worker_unavailable');
      return await this.jobInProcess(input, operation, schema);
    }
    const require = createRequire(import.meta.url);
    const canvasRequire = createRequire(require.resolve('@napi-rs/canvas/package.json'));
    const optionalNative = (specifier: string): string[] => {
      try { return [dirname(canvasRequire.resolve(`${specifier}/package.json`))]; }
      catch { return []; }
    };
    const packageRoot = (specifier: string): string[] => {
      try {
        let current = dirname(require.resolve(specifier));
        while (!existsSync(join(current, 'package.json')) && dirname(current) !== current) current = dirname(current);
        return existsSync(join(current, 'package.json')) ? [current] : [];
      } catch { return []; }
    };
    const modelFiles = operation.operation === 'parse_document' && operation.modelFiles !== null && typeof operation.modelFiles === 'object'
      ? operation.modelFiles as Partial<ResearchModelFiles> : null;
    const modelPaths = modelFiles === null ? [] : Object.values(modelFiles).filter((path): path is string => typeof path === 'string');
    // Unpacked dist/dev output lives below the repository package scope. Node
    // reads that package.json to load ESM, and dependencies remain external for native modules.
    let packageScope = dirname(packagedCli);
    while (!existsSync(join(packageScope, 'package.json')) && dirname(packageScope) !== packageScope) {
      packageScope = dirname(packageScope);
    }
    const packageScopeFiles = existsSync(join(packageScope, 'package.json')) ? [join(packageScope, 'package.json')] : [];
    const readablePaths = [
      dirname(packagedCli),
      ...packageScopeFiles,
      dirname(require.resolve('zod/package.json')),
      dirname(require.resolve('pdfjs-dist/package.json')),
      dirname(require.resolve('@napi-rs/canvas/package.json')),
      ...packageRoot('vega'),
      ...packageRoot('vega-lite'),
      ...packageRoot('paddleocr'),
      ...packageRoot('onnxruntime-node'),
      ...packageRoot('htmlparser2'),
      ...packageRoot('utif'),
      // Only the arm64 native canvas package is shipped in the macOS release.
      ...optionalNative('@napi-rs/canvas-darwin-arm64'),
      process.execPath,
      join(dirname(process.execPath), '..'),
      input.sourcePath,
      input.projectRoot,
      ...modelPaths
    ];
    const parseOptions = operation.operation === 'parse_document' && operation.options !== null && typeof operation.options === 'object'
      ? operation.options as Partial<ResearchParseOptions> : null;
    let timeoutMs = 60_000;
    let terminationGraceMs = 1000;
    if (operation.operation === 'parse_document') {
      // The parser's own timeout aborts its job first; leave time for an active native inference to settle and release sessions.
      timeoutMs = 660_000;
      terminationGraceMs = 60_000;
    }
    else if (operation.operation === 'render_figure') {
      const requestedTimeout = typeof operation.timeoutMs === 'number' ? operation.timeoutMs : 60_000;
      timeoutMs = Math.max(1, Math.min(3_600_000, requestedTimeout));
    }
    const result = await runResearchProcess({
      command: process.execPath,
      args: [packagedCli],
      cwd: input.jobDir,
      readablePaths,
      writablePaths: [input.jobDir],
      environment: { ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      timeoutMs,
      terminationGraceMs,
      signal: input.signal,
      input: JSON.stringify(request),
      allowGpuAcceleration: parseOptions?.device === 'coreml' && modelPaths.length > 0,
      networkAccess: 'none',
      allowPosixSpawn: false
    });
    const envelope = z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), result: schema }).strict(),
      z.object({ ok: z.literal(false), error: z.object({ code: z.string(), type: z.string() }).strict() }).strict()
    ]).safeParse(parseJson(result.stdout, result.stderr));
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
    if (name === 'parse_document') {
      const { parseResearchDocument } = await import('./document-parser');
      return schema.parse(await parseResearchDocument({
        projectRoot: input.projectRoot, sourcePath: input.sourcePath, outputDir: input.outputDir,
        signal: input.signal, timeoutMs: 600_000,
        options: researchParseOptionsSchema.parse(operation.options),
        modelFiles: operation.modelFiles as ResearchModelFiles | null,
        modelManifest: typeof operation.modelManifest === 'string' ? operation.modelManifest : ''
      }));
    }
    if (name === 'render_figure') {
      const { renderResearchFigure } = await import('./figure-renderer');
      const request = researchFigureRenderJobSchema.parse({
        operation: 'render_figure', projectRoot: input.projectRoot, sourcePath: input.sourcePath, outputDir: input.outputDir,
        inputPaths: operation.inputPaths, label: operation.label, timeoutMs: operation.timeoutMs, figure: operation.figure
      });
      return schema.parse(await renderResearchFigure(request, input.signal));
    }
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

  private async baseEnvironment(root: string, jobDir: string, includeRuntimeTools: boolean): Promise<NodeJS.ProcessEnv> {
    const temporary = await createResearchDirectory(jobDir, 'tmp');
    const cache = await createResearchDirectory(jobDir, 'cache');
    const systemPath = '/usr/bin:/bin:/usr/sbin:/sbin';
    return { PATH: includeRuntimeTools ? `${join(root, 'bin')}:${systemPath}` : systemPath, LANG: 'en_US.UTF-8',
      TMPDIR: temporary, XDG_CACHE_HOME: cache, TECTONIC_CACHE_DIR: join(cache, 'tectonic') };
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

function parseJson(value: string, stderr = ''): JsonDocument {
  try { return JSON.parse(value) as JsonDocument; }
  catch { throw new ResearchProcessError('research_json_invalid', value, stderr); }
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
