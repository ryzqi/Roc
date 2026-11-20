import {listPaperAcquisitionResultSchema, paperAcquisitionJobSchema,
  type PaperAcquisitionJob} from '../../shared/schemas/literature-acquisition';
import type {RocClient} from '../shared/roc-client';

/** Typed renderer bridge for durable literature acquisition queries and actions. */
export async function listLiteratureProcessing(client: RocClient, projectId: string, offset: number) {
  const result = await client.api.research.listAcquisition({projectId, destination: 'current_project', offset, limit: 20});
  if (!result.ok) return result;
  const data = listPaperAcquisitionResultSchema.parse(result.data);
  if (data.jobs.some(job => job.projectId !== projectId)) throw new Error('文献处理返回了其他项目的任务。');
  return {...result, data};
}

export async function changeLiteratureProcessing(client: RocClient, projectId: string, job: PaperAcquisitionJob,
  action: 'retry' | 'cancel', replacementDocumentId?: string) {
  if (job.projectId !== projectId) throw new Error('文献处理任务不属于当前项目。');
  const api = client.api.research;
  const request = {projectId, destination: 'current_project' as const, jobId: job.id, generation: job.generation,
    ...(replacementDocumentId === undefined ? {} : {replacementDocumentId})};
  const result = await (action === 'retry' ? api.retryAcquisition(request) : api.cancelAcquisition(request));
  if (!result.ok) return result;
  const data = paperAcquisitionJobSchema.parse(result.data);
  if (data.projectId !== projectId || data.id !== job.id || data.libraryItemId !== job.libraryItemId) {
    throw new Error('文献处理返回的任务与请求不一致。');
  }
  return {...result, data};
}

export const acquisitionStageLabels: Readonly<Record<PaperAcquisitionJob['stage'], string>> = {
  resolve: '查找 PDF', download: '下载 PDF', import: '登记文档', parse: '解析全文', index: '全文索引', wiki: '生成 Wiki'
};
export const acquisitionStatusLabels: Readonly<Record<PaperAcquisitionJob['status'], string>> = {
  queued: '后台排队中', running: '处理中', ready: '已就绪', blocked: '受阻', failed: '失败', unavailable: '暂无可获取 PDF', cancelled: '已取消'
};
export function canRetryAcquisition(job: PaperAcquisitionJob): boolean {
  return ['failed', 'blocked', 'unavailable', 'cancelled'].includes(job.status);
}
export function canCancelAcquisition(job: PaperAcquisitionJob): boolean {
  return !['ready', 'cancelled'].includes(job.status);
}

/** Page-local verified milestones; never treat total (all pages) as the denominator for these counts. */
export function acquisitionPageProgress(jobs: readonly PaperAcquisitionJob[]) {
  return {metadata: jobs.length, pdf: jobs.filter(job => job.receipt !== null || job.documentId !== null).length,
    indexed: jobs.filter(job => job.stage === 'wiki').length,
    wiki: jobs.filter(job => job.stage === 'wiki' && job.status === 'ready').length};
}
