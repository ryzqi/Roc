import {figureUnderstandingRequestSchema, figureUnderstandingResultSchema, figureUnderstandingVersion,
  type FigureUnderstandingRequest, type FigureUnderstandingResult} from '../../../shared/schemas/research-figure-understanding';
import type {ResearchRepository} from './repository';
import {ScientificSearchSnapshots} from './scientific-search-snapshot';
import {figureUnderstandingPromptVersion, type FigureUnderstandingSessionFactory} from './figure-understanding-model';

type Job = {projectId: string; controller: AbortController; done: Promise<FigureUnderstandingResult>};
/** Response-only candidates: no Evidence writes, automatic extraction, persistent history or model startup work. */
export class FigureUnderstandingService {
  private readonly snapshots: ScientificSearchSnapshots;
  private readonly jobs = new Set<Job>();
  private readonly releasing = new Set<string>();
  private closed = false;
  constructor(private readonly repository: ResearchRepository, roots: {library: string | null; index: string | null},
    private readonly createSession: FigureUnderstandingSessionFactory, private readonly modelStamp: () => string) {
    this.snapshots = new ScientificSearchSnapshots(repository, roots);
  }

  async analyze(input: FigureUnderstandingRequest, external = new AbortController().signal): Promise<FigureUnderstandingResult> {
    const request = figureUnderstandingRequestSchema.parse(input), {projectId, documentId, objectId} = request;
    this.requireProject(projectId); external.throwIfAborted();
    if (this.jobs.size >= 2 || [...this.jobs].some(j => j.projectId === projectId)) throw new Error('research_figure_busy');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('research_figure_deadline_exceeded')), 120_000);
    timer.unref();
    const signal = AbortSignal.any([controller.signal, external]);
    const done = Promise.resolve().then(async () => {
      const generations = this.snapshots.catalog(projectId, [documentId]).filter(g => g.snapshot.paperIR.identity.documentId === documentId);
      const [paper] = await this.snapshots.capture(projectId, generations, signal);
      const figure = paper?.ir.figures.find(f => f.id === objectId);
      if (!paper || !figure) throw new Error('research_figure_object_invalid');
      const {asset, reason} = await this.snapshots.readVisualAsset(paper, objectId, 2048, signal);
      if (!asset) throw new Error(`research_figure_asset_unavailable:${reason}`);
      if (asset.bytes.length > 8 * 1024 ** 2) throw new Error('research_figure_image_budget_exceeded');
      const files = await this.snapshots.guardFiles(projectId, generations, signal), stamp = this.modelStamp();
      const fence = () => {
        signal.throwIfAborted(); this.requireProject(projectId);
        if (this.modelStamp() !== stamp) throw new Error('research_figure_model_changed');
        files(); asset.assertCurrent(); this.snapshots.assertReceiptCurrent(projectId, paper.receipt);
      };
      const session = await this.createSession();
      await this.snapshots.assertCurrent(projectId, [paper.receipt], signal); fence();
      const caption = figure.data.captions.filter(c => c.status === 'linked').map(c => c.evidence.text).join('\n');
      const interpretation = await session.interpret({bytes: asset.bytes, caption: caption.slice(0, 8000) || null}, signal);
      await this.snapshots.assertCurrent(projectId, [paper.receipt], signal); fence();
      return figureUnderstandingResultSchema.parse({version: figureUnderstandingVersion, projectId,
        source: {documentId, objectId, kind: 'figure', source: paper.receipt, image: asset.image},
        model: session.model, promptVersion: figureUnderstandingPromptVersion, createdAt: new Date().toISOString(),
        interpretationKind: 'derived', scientificApproval: 'unreviewed', verification: 'verify_original_pdf',
        exactValues: 'requires_table_or_text', interpretation});
    });
    const job = {projectId, controller, done}; this.jobs.add(job);
    try {return await done;} finally {clearTimeout(timer); this.jobs.delete(job);}
  }
  private requireProject(projectId: string): void {
    if (this.closed) throw new Error('research_figure_closed');
    if (this.releasing.has(projectId)) throw new Error('research_figure_project_releasing');
    if (this.repository.getProject(projectId).status === 'archived') throw new Error('research_project_archived');
  }
  async releaseProject(projectId: string): Promise<void> {
    const jobs = [...this.jobs].filter(j => j.projectId === projectId);
    for (const job of jobs) job.controller.abort(new Error('research_figure_cancelled'));
    await Promise.allSettled(jobs.map(j => j.done));
  }
  async withProjectReleased<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('research_figure_closed');
    if (this.releasing.has(projectId)) throw new Error('research_figure_project_releasing');
    this.repository.getProject(projectId); this.releasing.add(projectId);
    try {await this.releaseProject(projectId); return await action();}
    finally {this.releasing.delete(projectId);}
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs) job.controller.abort(new Error('research_figure_cancelled'));
    await Promise.allSettled([...this.jobs].map(j => j.done));
  }
}
