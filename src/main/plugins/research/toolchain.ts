import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import toolsLock from '../../../../resources/research-runtime/tools.lock.json';
import modelsLock from '../../../../resources/research-runtime/models.lock.json';
import workerSource from '../../../../resources/research-runtime/worker.py?raw';
import bibliographySource from '../../../../resources/research-runtime/bibliography.py?raw';
import { researchParsedDocumentSchema, researchRenderedPdfSchema, researchToolchainStatusSchema } from '../../../shared/schemas/research-production';
import { researchBibliographyEntrySchema, type researchBibliographyFormatSchema } from '../../../shared/schemas/research-library';
import { assertResearchDescendant, createResearchDirectory, readResearchFile, researchContentHash, researchRelativePath } from './research-files';
import { runResearchProcess, ResearchProcessError, type ResearchProcessResult } from './process-runner';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const manifestSchema = z.object({
  schemaVersion: z.literal(1), platform: z.literal('darwin'), architecture: z.enum(['arm64', 'x64']),
  versions: z.object({ python: z.string(), uv: z.string(), tectonic: z.string() }).strict(),
  lockHashes: z.record(z.string(), digestSchema),
  entries: z.array(z.discriminatedUnion('type', [
    z.object({ path: z.string(), type: z.literal('file'), size: z.number().int().nonnegative(), sha256: digestSchema, executable: z.boolean() }).strict(),
    z.object({ path: z.string(), type: z.literal('symlink'), target: z.string() }).strict()
  ])).max(100_000)
}).strict();

type Manifest = z.infer<typeof manifestSchema>;
type WorkerInput = { projectRoot: string; sourcePath: string; outputDir: string; jobDir: string; signal?: AbortSignal };
type ResolvedToolchain = { root: string; manifest: Manifest };

export class ResearchToolchain {
  private verification: Promise<ResolvedToolchain> | null = null;

  constructor(private readonly rootPath: string | null) {}

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

  async parseDocument(input: WorkerInput): Promise<z.infer<typeof researchParsedDocumentSchema>> {
    return await this.worker(input, { operation: 'parse_document' }, researchParsedDocumentSchema, 600_000);
  }

  async renderPdf(input: WorkerInput & { page: number; scale: number }): Promise<z.infer<typeof researchRenderedPdfSchema>> {
    return await this.worker(input, { operation: 'render_pdf', page: input.page, scale: input.scale }, researchRenderedPdfSchema, 60_000);
  }

  async extractTemplate(input: WorkerInput): Promise<void> {
    await this.worker(input, { operation: 'extract_template' }, z.object({ sourceHash: digestSchema, fileCount: z.number().int().nonnegative() }).strict(), 60_000);
  }

  async readBibliography(input: WorkerInput & { format: z.infer<typeof researchBibliographyFormatSchema> }): Promise<z.infer<typeof researchBibliographyEntrySchema>[]> {
    const result = await this.worker(input, { operation: 'read_bibliography', format: input.format },
      z.object({ sourceHash: digestSchema, entries: z.array(researchBibliographyEntrySchema) }).strict(), 60_000);
    return result.entries;
  }

  async normalizeBibliography(input: WorkerInput): Promise<z.infer<typeof researchBibliographyEntrySchema>[]> {
    const result = await this.worker(input, { operation: 'normalize_bibliography' },
      z.object({ sourceHash: digestSchema, entries: z.array(researchBibliographyEntrySchema) }).strict(), 60_000);
    return result.entries;
  }

  async writeBibliography(input: WorkerInput & { format: z.infer<typeof researchBibliographyFormatSchema> }): Promise<{ filename: string; content: string }> {
    const result = await this.worker(input, { operation: 'write_bibliography', format: input.format },
      z.object({ sourceHash: digestSchema, filename: z.string(), content: z.string() }).strict(), 60_000);
    return { filename: result.filename, content: result.content };
  }

  async compile(input: { rootPath: string; entryPath: string; outputDir: string; jobDir: string; signal?: AbortSignal }): Promise<ResearchProcessResult> {
    const { root } = await this.resolve();
    const environment = await this.environment(root, input.jobDir);
    return await runResearchProcess({ command: join(root, 'bin/tectonic'),
      args: ['--bundle', join(root, 'tex/bundle.zip'), '--only-cached', '--untrusted', '--keep-logs', '--outdir', input.outputDir, input.entryPath],
      cwd: input.rootPath, readablePaths: [root, input.rootPath], writablePaths: [input.jobDir], environment,
      timeoutMs: 180_000, signal: input.signal, allowOcrAcceleration: false, networkAccess: 'none', allowPosixSpawn: false });
  }

  private async worker<T>(input: WorkerInput, operation: Record<string, unknown>, schema: z.ZodType<T>, timeoutMs: number): Promise<T> {
    const { root } = await this.resolve();
    const request = { ...operation, projectRoot: input.projectRoot, sourcePath: input.sourcePath, outputDir: input.outputDir,
      ...(operation.operation === 'parse_document' ? { modelsPath: join(root, 'models') } : {}) };
    const result = await runResearchProcess({ command: join(root, 'python/bin/python3'), args: ['-I', '-B', join(root, 'worker.py')],
      cwd: input.jobDir, readablePaths: [root, input.sourcePath], writablePaths: [input.jobDir],
      environment: await this.environment(root, input.jobDir), input: JSON.stringify(request), timeoutMs, signal: input.signal,
      allowOcrAcceleration: operation.operation === 'parse_document', networkAccess: 'none', allowPosixSpawn: false });
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
    if (manifest.architecture !== process.arch || manifest.versions.python !== toolsLock.pythonVersion
        || manifest.versions.uv !== toolsLock.uvVersion || manifest.versions.tectonic !== toolsLock.tectonicVersion) {
      throw new ResearchProcessError('research_toolchain_version_mismatch');
    }
    const entries = new Map(manifest.entries.map((entry) => [researchRelativePath(entry.path), entry]));
    if (entries.size !== manifest.entries.length) throw new ResearchProcessError('research_toolchain_manifest_invalid');
    const requireHash = (path: string, hash: string): void => {
      const entry = entries.get(path);
      if (entry?.type !== 'file' || entry.sha256 !== hash) throw new ResearchProcessError('research_toolchain_source_mismatch');
    };
    requireHash('worker.py', researchContentHash(workerSource));
    requireHash('bibliography.py', researchContentHash(bibliographySource));
    requireHash('tex/bundle.zip', toolsLock.texBundle.zipSha256);
    for (const model of modelsLock.models) {
      for (const [path, digest] of Object.entries(model.files)) requireHash(`models/${model.directory}/${path}`, digest);
    }
    const actual: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (relative(root, path) !== 'manifest.json') actual.push(relative(root, path));
      }
    };
    await visit(root);
    if (actual.length !== entries.size || actual.some((path) => !entries.has(path))) {
      throw new ResearchProcessError('research_toolchain_integrity_mismatch');
    }
    let index = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (index < manifest.entries.length) {
        const entry = manifest.entries[index++];
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
    }));
    return { root, manifest };
  }
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; }
  catch { throw new ResearchProcessError('research_json_invalid'); }
}
