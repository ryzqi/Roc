import {createHash} from 'node:crypto';
import {lstat, mkdir, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import type {z} from 'zod';
import {
  hfDownloadStartSchema, hfDownloadReadSchema, hfDownloadCancelSchema, hfDownloadHistorySchema,
  type HfDownloadStart, type HfDownloadReceipt, type hfDownloadHistoryResultSchema
} from '../../../shared/schemas/research-huggingface-downloads';
import {createResearchDirectory} from './research-files';
import {HuggingFaceDownloadRepository} from './huggingface-download-repository';
import {HuggingFaceRepository} from './huggingface-repository';
import {HuggingFaceDownloader, removeHuggingFacePartial, type HfDownloadProgress} from './huggingface-downloader';

type Job = HfDownloadProgress & {controller: AbortController; pending: Promise<void>};
export function huggingFaceDownloadDirectory(projectId: string, downloadId: string): string {
  return `${createHash('sha256').update(projectId).digest('hex')}/${downloadId}`;
}
export class HuggingFaceDownloadService {
  private readonly jobs = new Map<string, Job>();
  private readonly persistenceErrors = new Map<string, unknown>();
  private closed = false;
  private initialized = false;
  private root = '';
  constructor(private readonly repository: HuggingFaceDownloadRepository, private readonly observations: HuggingFaceRepository,
    private readonly downloader: HuggingFaceDownloader, private readonly resourceRoot: string,
    private readonly now: () => string = () => new Date().toISOString()) {}

  async initialize(): Promise<void> {
    await mkdir(this.resourceRoot, {recursive: true, mode: 0o700});
    const info = await lstat(this.resourceRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('research_hf_download_storage_failed');
    this.root = await realpath(this.resourceRoot);
    for (const receipt of this.repository.running()) {
      const directory = await createResearchDirectory(this.root, huggingFaceDownloadDirectory(receipt.projectId, receipt.id));
      await removeHuggingFacePartial(join(directory, `file-${receipt.files.length}.part`));
    }
    this.repository.recoverInterrupted();
    this.initialized = true;
  }

  start(input: HfDownloadStart): HfDownloadReceipt {
    if (this.closed || !this.initialized) throw new Error('research_hf_download_service_closed');
    const request = hfDownloadStartSchema.parse(input);
    const result = this.repository.create(request);
    if (!result.created) {this.requireHealthy(result.receipt.id); return result.receipt;}
    const controller = new AbortController();
    const job: Job = {receipt: result.receipt, controller, pending: Promise.resolve(),
      save: () => {
        try {job.receipt = this.repository.update(job.receipt);}
        catch (error) {this.persistenceErrors.set(job.receipt.id, error); throw error;}
      }};
    this.jobs.set(result.receipt.id, job);
    job.pending = this.execute(job).catch(error => {this.persistenceErrors.set(result.receipt.id, error);})
      .finally(() => {this.jobs.delete(result.receipt.id);});
    return result.receipt;
  }

  read(input: z.infer<typeof hfDownloadReadSchema>): HfDownloadReceipt {
    const request = hfDownloadReadSchema.parse(input);
    const receipt = this.repository.get(request.projectId, request.downloadId);
    this.requireHealthy(receipt.id);
    return receipt;
  }

  history(input: z.infer<typeof hfDownloadHistorySchema>): z.infer<typeof hfDownloadHistoryResultSchema> {
    const result = this.repository.history(input);
    for (const receipt of result.records) this.requireHealthy(receipt.id);
    return result;
  }

  cancel(input: z.infer<typeof hfDownloadCancelSchema>): {cancelled: boolean} {
    const request = hfDownloadCancelSchema.parse(input);
    const receipt = this.repository.get(request.projectId, request.downloadId);
    this.requireHealthy(receipt.id);
    const job = this.jobs.get(receipt.id);
    if (job === undefined) return {cancelled: false};
    job.controller.abort(new Error('research_hf_download_cancelled'));
    return {cancelled: true};
  }

  async releaseProject(projectId: string): Promise<void> {
    const jobs = [...this.jobs.values()].filter(job => job.receipt.projectId === projectId);
    for (const job of jobs) job.controller.abort(new Error('research_hf_download_cancelled'));
    await Promise.all(jobs.map(job => job.pending));
    for (const job of jobs) this.requireHealthy(job.receipt.id);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort(new Error('research_hf_download_interrupted'));
    await Promise.all([...this.jobs.values()].map(job => job.pending));
    if (this.persistenceErrors.size > 0) throw new AggregateError([...this.persistenceErrors.values()], 'research_hf_download_persistence_failed');
  }

  private requireHealthy(id: string): void {
    if (this.persistenceErrors.has(id)) throw new Error('research_hf_download_persistence_failed');
  }

  private async execute(job: Job): Promise<void> {
    const timeout = setTimeout(() => job.controller.abort(new Error('research_hf_download_timeout')), job.receipt.request.timeoutMs);
    const signal = job.controller.signal;
    try {
      const directory = await createResearchDirectory(this.root, huggingFaceDownloadDirectory(job.receipt.projectId, job.receipt.id));
      for (const [index, file] of job.receipt.selectedFiles.entries()) {
        signal.throwIfAborted();
        await this.downloader.download(file, index, directory, job, signal,
          () => this.observations.requireCaptureScope(job.receipt.projectId));
      }
      signal.throwIfAborted();
      job.receipt = {...job.receipt, state: 'completed', finishedAt: this.now(), errorCode: null};
      job.save();
    } catch (error) {
      if (this.persistenceErrors.has(job.receipt.id)) throw error;
      const code = signal.aborted ? (signal.reason as Error).message : error instanceof Error ? error.message : '';
      const known = /^research_hf_download_[a-z0-9_]+$/u.test(code) || code === 'research_project_archived' ||
        code.startsWith('literature_provider_');
      const state = code === 'research_hf_download_cancelled' ? 'cancelled' :
        code === 'research_hf_download_interrupted' ? 'interrupted' : 'failed';
      job.receipt = {...job.receipt, state, finishedAt: this.now(),
        errorCode: known ? code : 'research_hf_download_storage_or_transport_failed'};
      job.save();
    } finally {clearTimeout(timeout);}
  }
}
