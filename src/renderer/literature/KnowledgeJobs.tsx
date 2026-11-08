import { useVisiblePolling } from '../shared/view-activity';
import {useEffect, useState} from 'react';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource, useAsyncAction} from '../app/use-async-resource';

const labels = {queued:'排队中', running:'生成向量中', blocked:'待配置', failed:'失败', ready:'已完成'};
export function KnowledgeJobs({client, projectId}: {client: RocClient; projectId: string | null}): React.JSX.Element {
  const [offset, setOffset] = useState(0);
  const jobs = useAsyncResource(`knowledge-jobs:${projectId}:${offset}`,
    ()=>client.api.research.knowledgeJobs({projectId, offset}), {label:'读取文献向量索引任务'});
  const retry = useAsyncAction((input: {documentId:string; generation:string})=>client.api.research.retryKnowledgeJob(input),
    {label:'重试向量索引'});
  useEffect(()=>{setOffset(0);},[projectId]);
  useVisiblePolling(jobs.reload, 3000);
  return <section className="border-b border-line p-4" data-testid="rag-source-jobs">
    <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">文献与实验向量索引</h3>
      <button type="button" className="rounded-control border border-line px-2 py-1 disabled:opacity-50" onClick={jobs.reload}>刷新任务</button></div>
    <p className="text-xs text-subtle">关键词索引已独立保存；向量任务会在重启后继续。</p>
    {jobs.error && <p role="alert">{jobs.error}</p>}{retry.error && <p role="alert">{retry.error}</p>}
    {jobs.data?.length===0 && <p className="text-xs text-subtle">当前没有任务。</p>}
    <ul>{jobs.data?.map(job=><li key={job.documentId} className="flex items-start justify-between gap-2 py-2 text-xs">
      <div className="min-w-0"><p className="break-words">{job.title} · {labels[job.status]}</p>
        {job.error && <p className="text-subtle">{job.error}</p>}</div>
      {(job.status==='failed'||job.status==='blocked') && <button type="button" className="rounded-control border border-line px-2 py-1 disabled:opacity-50 shrink-0"
        disabled={retry.pending} onClick={()=>{void retry.run({documentId:job.documentId,generation:job.generation}).then(()=>jobs.reload());}}>重试</button>}
    </li>)}</ul>
    <div className="flex items-center gap-2 text-xs"><button type="button" className="rounded-control border border-line px-2 py-1 disabled:opacity-50" disabled={offset===0}
      onClick={()=>setOffset(value=>Math.max(0,value-50))}>上一页</button><span>第 {offset/50+1} 页</span>
      <button type="button" className="rounded-control border border-line px-2 py-1 disabled:opacity-50" disabled={jobs.data?.length!==50} onClick={()=>setOffset(value=>value+50)}>下一页</button></div>
  </section>;
}
