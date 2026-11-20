import { useVisiblePolling } from '../shared/view-activity';
import {useEffect, useRef, useState} from 'react';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource, useAsyncAction} from '../app/use-async-resource';
import {formSecondaryButtonClass} from '../shared/form-ui';

const labels = {queued:'排队中', running:'生成向量中', blocked:'待配置', failed:'失败', ready:'已完成'};
export function KnowledgeJobs({client, projectId}: {client: RocClient; projectId: string | null}): React.JSX.Element {
  const [offset, setOffset] = useState(0);
  const jobs = useAsyncResource(`knowledge-jobs:${projectId}:${offset}`,
    ()=>client.api.research.knowledgeJobs({projectId, offset}), {label:'读取文献向量索引任务'});
  const retry = useAsyncAction((input: {documentId:string; generation:string})=>client.api.research.retryKnowledgeJob(input),
    {label:'重试向量索引'});
  const retryInFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(()=>{
    mounted.current = true;
    return ()=>{mounted.current = false;};
  },[]);
  const runRetry = async (input: {documentId:string; generation:string}): Promise<void> => {
    if (retryInFlight.current || !mounted.current) return;
    retryInFlight.current = true;
    await retry.run(input);
    retryInFlight.current = false;
    if (mounted.current) jobs.reload();
  };
  useEffect(()=>{setOffset(0);},[projectId]);
  useVisiblePolling(jobs.reload, 3000);
  return <section className="border-b-[0.5px] border-line p-4" data-testid="rag-source-jobs">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-[length:var(--font-h3-size)] font-medium">文献与实验向量索引</h3>
      <button type="button" className={formSecondaryButtonClass} onClick={jobs.reload}>刷新任务</button></div>
    <p className="text-xs text-subtle">关键词索引已独立保存；向量任务会在重启后继续。</p>
    {jobs.error && <p role="alert">{jobs.error}</p>}{retry.error && <p role="alert">{retry.error}</p>}
    {jobs.data === null && !jobs.error && <p role="status" className="text-xs text-subtle">正在读取任务…</p>}
    {jobs.data?.length===0 && <p className="text-xs text-subtle">当前没有任务。</p>}
    <ul>{jobs.data?.map(job=><li key={job.documentId} className="flex items-start justify-between gap-2 py-2 text-xs">
      <div className="min-w-0"><p className="flex flex-wrap gap-x-2 break-words"><span>{job.title}</span><span className="text-subtle">{labels[job.status]}</span></p>
        {job.error && <p className="break-words text-subtle">{job.error}</p>}</div>
      {(job.status==='failed'||job.status==='blocked') && <button type="button" className={formSecondaryButtonClass}
        disabled={retry.pending} onClick={()=>{void runRetry({documentId:job.documentId,generation:job.generation});}}>重试</button>}
    </li>)}</ul>
    <div className="flex flex-wrap items-center gap-2 text-xs"><button type="button" className={formSecondaryButtonClass} disabled={offset===0}
      onClick={()=>setOffset(value=>Math.max(0,value-50))}>上一页</button><span className="tabular-nums">第 {offset/50+1} 页</span>
      <button type="button" className={formSecondaryButtonClass} disabled={jobs.data?.length!==50} onClick={()=>setOffset(value=>value+50)}>下一页</button></div>
  </section>;
}
