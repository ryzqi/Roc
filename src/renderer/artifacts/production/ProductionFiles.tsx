import {useState} from 'react';
import type {ResearchArtifactInspectRequest} from '../../../shared/schemas/research-artifact-inspector';
import type {ResearchProductionInput} from '../../../shared/schemas/research-production-inputs';
import type {RocClient} from '../../shared/roc-client';
import {useAsyncResource} from '../../app/use-async-resource';
import {formSecondaryButtonClass} from '../../shared/form-ui';

type File=ResearchProductionInput['files'][number];
const areas: Record<File['area'],string>={input:'输入',output:'输出',log:'日志',bundle:'交付文件'};
const rasterTypes=new Map<string,string>([['png','image/png'],['jpg','image/jpeg'],['jpeg','image/jpeg'],['webp','image/webp']]);
const areaOrder=['input','output','log','bundle'] as const;
const extension=(path: string): string=>path.split('.').at(-1)?.toLowerCase()??'';
const previewLimit=4*1024*1024;

export function ProductionFiles({client,input,request}: {client: RocClient;input: ResearchProductionInput;request: ResearchArtifactInspectRequest}): React.JSX.Element {
  const [area,setArea]=useState<File['area']>(input.source.kind==='export'?'bundle':'output');
  const [selected,setSelected]=useState<File|null>(null);
  const read=useAsyncResource(selected===null?null:`production:file:${JSON.stringify([request,selected])}`,()=>{
    if(selected===null||request.expectedVersion===null) throw new Error('research_production_file_selection_required');
    return client.api.research.readProductionReviewFile({projectId:request.projectId,artifactId:request.artifactId,
      expectedVersion:request.expectedVersion,area:selected.area,path:selected.path,expectedFileHash:selected.sha256});
  },{label:'读取生产文件'});
  const content=read.status==='ready'?read.data:null;
  const files=input.files.filter(file=>file.area===area);
  return <section className="flex flex-col gap-2" aria-label="保存的生产文件">
    <div className="flex flex-wrap gap-1" aria-label="文件区域">
      {areaOrder.filter(value=>input.files.some(file=>file.area===value)).map(value=>
        <button type="button" key={value} aria-pressed={area===value} data-testid={`artifact-production-area-${value}`}
          className={`${formSecondaryButtonClass} ${area===value?'border-[var(--accent)] bg-[var(--accent-soft)] text-ink':''}`}
          onClick={()=>{setArea(value);setSelected(null);}}>{areas[value]}</button>)}
    </div>
    {files.length===0?<p className="text-muted">该区域没有保存的文件。</p>:<ul className="flex flex-col">
      {files.map(file=>{
        const type=extension(file.path),unsupported=['pdf','zip'].includes(type);
        return <li key={`${file.area}:${file.path}`} className="flex flex-col gap-1 border-b-[0.5px] border-line py-2">
          <div className="flex items-start justify-between gap-2">
            <button type="button" disabled={file.size>previewLimit||unsupported} data-testid="artifact-production-file"
              data-path={file.path} data-area={file.area} aria-pressed={selected?.path===file.path&&selected.area===file.area}
              className={`${formSecondaryButtonClass} min-w-0 break-all text-left disabled:cursor-not-allowed disabled:opacity-50`}
              onClick={()=>setSelected(file)}>{file.path}</button>
            <span className="shrink-0 text-muted text-[var(--font-meta-size)]">{file.size.toLocaleString()} B</span>
          </div>
          <p className="break-all font-mono text-muted text-[var(--font-meta-size)]">SHA-256 {file.sha256}</p>
          {file.size>previewLimit?<p className="text-muted">超过 4 MiB 预览上限。</p>:
            type==='pdf'?<p className="text-muted">PDF 定位预览入口尚未接入。</p>:
            type==='zip'?<p className="text-muted">交付压缩包只展示保存的校验信息。</p>:null}
        </li>;
      })}
    </ul>}
    {read.status==='loading'?<p role="status">正在读取选定文件…</p>:null}
    {read.error===null?null:<div className="flex flex-col items-start gap-2">
      <p role="alert" className="break-words text-[var(--st-warn)]">{read.error}</p>
      <button type="button" className={formSecondaryButtonClass} data-testid="artifact-production-retry"
        onClick={read.reload}>重试读取文件</button>
    </div>}
    {content===null?null:<section className="flex flex-col gap-2" data-testid="artifact-production-content">
      <h3 className="break-all font-medium">{content.file.path}</h3>
      <p className="break-all font-mono text-muted text-[var(--font-meta-size)]">已校验 SHA-256 {content.file.sha256}</p>
      {content.encoding==='utf8'?<pre tabIndex={0} aria-label="保存的生产文件正文" data-testid="artifact-production-text"
        className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words font-mono text-[var(--font-meta-size)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]">{content.content}</pre>:
        rasterTypes.get(extension(content.file.path))===undefined?<p className="text-muted">文件是二进制内容，当前没有对应预览类型。</p>:
          <img data-testid="artifact-production-image" className="max-h-[480px] max-w-full self-start object-contain"
            alt={`${input.artifact.title} ${content.file.path}`} src={`data:${rasterTypes.get(extension(content.file.path))};base64,${content.content}`}/>}
    </section>}
  </section>;
}
