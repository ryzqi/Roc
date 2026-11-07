import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { z } from 'zod';

import type { researchProseLintRequestSchema, researchTexLintRequestSchema, ResearchProseLintReport } from '../../../shared/schemas/research-prose';
import { buildProseBundle, projectProseAlerts, summarizeProseFindings, type ProseBundle } from './prose-projection';
import type { ResearchRepository } from './repository';
import type { ResearchToolchain } from './toolchain';

import {researchContentHash, readResearchFile, researchWorkspace} from './research-files';
import {projectTexProse} from './tex-prose-projection';

type ProseTools = Pick<ResearchToolchain, 'lintProse' | 'status' | 'utilityIdentity'>;

/**
 * 按当前文稿结构跑一次确定性的 prose 检查。
 *
 * ## 为什么它属于「服务」而不是「角色工具」
 *
 * 检查要落到 `claimId` 上才有用，而 claim 结构在正文落库之后才完整：阶段角色手里的输出里
 * `sections[].claimIndexes` 还没变成 id（`run-repository.attachOutput` 才做这层映射）。所以
 * 角色在运行期只能拿到上一轮的产物，真正能定位的检查只能发生在**产物存在之后**。
 *
 * 角色侧仍然有它的位置：`writing` / `revision` 的 Skill 负责「写的时候就别产生这类问题」，
 * 本服务负责「写完之后有一份不依赖模型的结论」。两者回答的不是同一个问题。
 *
 * ## 不写库
 *
 * 报告不落库，也不进阶段输出契约（`researchStageOutputSchema` 是 `.strict()` 的，往角色输出
 * 里加字段会让那次运行直接失败）。需要留档时由调用方把报告写进导出的 `provenance/`。
 */
export class ResearchProseLintService {
  private readonly active = new Set<{ controller: AbortController; promise: Promise<unknown> }>();
  private closed = false;
  private readonly cache = new Map<string, string>();
  private cacheBytes = 0;

  constructor(private readonly repository: ResearchRepository, private readonly tools: ProseTools, private readonly rootPath: string | null) {}

  async lint(request: z.infer<typeof researchProseLintRequestSchema>): Promise<ResearchProseLintReport> {
    return await this.job(async (directory, signal) => {
      const project = this.repository.getProject(request.projectId);
      const artifact = this.repository.getArtifact(request.artifactId);
      if (artifact.projectId !== request.projectId) throw new Error('research_artifact_project_mismatch');
      // 只检查正文。别的产物没有 sections/claims 结构，投影出来只会是一份无定位的报告。
      if (artifact.kind !== 'manuscript') throw new Error('research_prose_artifact_kind_invalid');
      // `inspectBundle` 而不是 `exportBundle`：检查的用处恰恰在批之前。导出仍然只认已批准正文。
      const bundle = this.repository.manuscripts.inspectBundle({ projectId: request.projectId, artifactId: request.artifactId });
      const projection = buildProseBundle({
        sections: bundle.manuscript.sections.map((section) => ({ title: section.title, claimIds: section.claimIds })),
        claims: bundle.claims
      });
      const contentHash = researchContentHash(JSON.stringify({sections: bundle.manuscript.sections, claims: bundle.claims}));
      if (request.expectedHash !== undefined && request.expectedHash !== contentHash) throw new Error('research_prose_target_changed');
      const report = await this.checkProjection(directory, signal, projection, {projectId: request.projectId, artifactId: artifact.id,
        artifactTitle: artifact.title, language: project.language,
        target: {kind: 'artifact', path: null, contentHash, projectionVersion: 'roc-prose-v2', limitations: []}});
      const current = this.repository.manuscripts.inspectBundle({projectId: request.projectId, artifactId: request.artifactId});
      if (researchContentHash(JSON.stringify({sections: current.manuscript.sections, claims: current.claims})) !== contentHash) {
        throw new Error('research_prose_target_changed');
      }
      return report;
    });
  }

  async lintTex(request: z.infer<typeof researchTexLintRequestSchema>): Promise<ResearchProseLintReport> {
    return this.job(async (directory, signal) => {
      const project = this.repository.getProject(request.projectId);
      if (!request.path.endsWith('.tex')) throw new Error('research_prose_tex_required');
      const root = await researchWorkspace(project.workspacePath);
      const bytes = await readResearchFile(root, request.path, 2 * 1024 * 1024);
      const contentHash = researchContentHash(bytes);
      if (request.expectedHash !== undefined && request.expectedHash !== contentHash) throw new Error('research_prose_target_changed');
      const {projection, limitations} = projectTexProse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
      const report = await this.checkProjection(directory, signal, projection, {projectId: request.projectId, artifactId: null,
        artifactTitle: request.path, language: project.language,
        target: {kind: 'workspace_tex', path: request.path, contentHash, projectionVersion: 'roc-prose-v2', limitations}});
      if (researchContentHash(await readResearchFile(root, request.path, 2 * 1024 * 1024)) !== contentHash) throw new Error('research_prose_target_changed');
      return report;
    });
  }

  private async checkProjection(directory: string, signal: AbortSignal, projection: ProseBundle,
    target: Pick<ResearchProseLintReport, 'projectId' | 'artifactId' | 'artifactTitle' | 'language' | 'target'>): Promise<ResearchProseLintReport> {
    const status = await this.tools.status();
    const valeVersion = status.versions?.vale;
    if (status.available !== true || valeVersion === undefined) throw new Error('research_prose_lint_unavailable');
    const toolchainHash = await this.tools.utilityIdentity();
    const key = researchContentHash(JSON.stringify({projectId: target.projectId, version: target.target.projectionVersion,
      language: target.language, toolchainHash, valeVersion, units: projection.units.map(({path, content}) => ({path, content}))}));
    const cached = this.cache.get(key);
    const raw: unknown = cached === undefined ? await this.tools.lintProse({jobDir: directory, units: projection.units,
      signal, admission: {projectId: target.projectId, priority: 'user'}}) : JSON.parse(cached);
    this.requireActive(signal);
    // Always remap raw alerts against the current claim IDs; never cache located findings.
    const {findings, truncated, droppedUnits} = projectProseAlerts(raw, projection);
    if (cached === undefined && !truncated && droppedUnits.length === 0) {
      const serialized = JSON.stringify(raw);
      const bytes = Buffer.byteLength(serialized);
      if (bytes <= 1024 * 1024) {
        while (this.cache.size >= 32 || this.cacheBytes + bytes > 8 * 1024 * 1024) {
          const oldest = this.cache.keys().next().value;
          if (oldest === undefined) break;
          this.cacheBytes -= Buffer.byteLength(this.cache.get(oldest)!); this.cache.delete(oldest);
        }
        this.cache.set(key, serialized); this.cacheBytes += bytes;
      }
    }
    return {...target, cache: cached === undefined ? 'miss' : 'hit', valeVersion, toolchainHash, checkedAt: new Date().toISOString(),
      counts: summarizeProseFindings(findings), truncated, droppedUnits, findings};
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.cache.clear(); this.cacheBytes = 0;
    for (const task of this.active) task.controller.abort();
    await Promise.allSettled([...this.active].map((task) => task.promise));
  }

  /**
   * 检查是只读的，但仍要一次运行一个私有目录：Vale 的 `HOME`、缓存与投影文件都写在里面，
   * 跑完即删。目录名带 `.prose-` 前缀，与库、导出、实验各自的 job 目录区分开。
   */
  private async job<T>(operation: (directory: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('research_prose_lint_closed');
    const controller = new AbortController();
    const task: { controller: AbortController; promise: Promise<unknown> } = { controller, promise: Promise.resolve() };
    const execute = async (): Promise<T> => {
      if (this.rootPath === null || !isAbsolute(this.rootPath)) throw new Error('research_prose_lint_storage_unavailable');
      try {
        if ((await lstat(this.rootPath)).isSymbolicLink()) throw new Error('research_prose_lint_storage_symlink');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
      const root = await realpath(this.rootPath);
      const directory = await mkdtemp(join(root, '.prose-'));
      try { this.requireActive(controller.signal); return await operation(directory, controller.signal); }
      finally { await rm(directory, { recursive: true, force: true }); }
    };
    this.active.add(task);
    const pending = execute();
    task.promise = pending;
    try { return await pending; }
    finally { this.active.delete(task); }
  }

  private requireActive(signal: AbortSignal): void {
    if (signal.aborted || this.closed) throw new Error('research_prose_lint_cancelled');
  }
}
