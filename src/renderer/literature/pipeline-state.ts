import type {PaperAcquisitionJob} from '../../shared/schemas/literature-acquisition';
import type {ResearchDocument} from '../../shared/types';

export type PipelineStage = {id: 'metadata' | 'pdf' | 'parse' | 'index' | 'wiki'; label: string; state: string};

/** Acquisition stages advance only after the preceding durable receipt is verified. */
export function literaturePipeline(document: ResearchDocument | null, job: PaperAcquisitionJob | null): PipelineStage[] {
  const at = job === null ? -1 : ['resolve', 'download', 'import', 'parse', 'index', 'wiki'].indexOf(job.stage);
  const current = job === null ? '' : {
    queued: '排队中', running: '处理中', ready: '已完成', blocked: '待处理', failed: '失败',
    unavailable: '未获取', cancelled: '已取消'
  }[job.status];
  const parseState = document === null ? '未解析' : {
    imported: '未解析', parsing: '解析中', ready: '已完成', failed: '失败', cancelled: '已取消'
  }[document.status];
  return [
    {id: 'metadata', label: '论文信息', state: '已收录'},
    {id: 'pdf', label: '全文', state: document !== null || job?.receipt != null || job?.documentId != null ? '已保存' : at >= 0 && at <= 2 ? current : '未获取'},
    {id: 'parse', label: '解析', state: at > 3 ? '已完成' : at === 3 ? current : parseState},
    {id: 'index', label: '索引', state: at > 4 ? '可检索' : at === 4 ? current : document?.currentParseId ? '待核验' : '未建立'},
    {id: 'wiki', label: '知识页', state: at === 5 ? job?.status === 'ready' ? '可查看' : current : '未确认生成'}
  ];
}
