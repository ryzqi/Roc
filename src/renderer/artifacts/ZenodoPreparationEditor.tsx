import {useEffect,useRef,useState} from 'react';
import type {ResearchExportExecution} from '../../shared/schemas/research-exports';
import {zenodoInputsRequestSchema,zenodoPrepareSchema,type ZenodoInputs,type ZenodoPrepare,type ZenodoPrepared} from '../../shared/schemas/research-zenodo';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction} from '../app/use-async-resource';
import {formPrimaryButtonClass,formSecondaryButtonClass,formSelectClass} from '../shared/form-ui';
import {ExportTextField} from './ExportMetadataFields';
const button=`${formSecondaryButtonClass} border-[0.5px]`;
export function ZenodoPreparationEditor({client,record,writable,onDirty,onPending,onPrepared,onDiscard}: {client:RocClient;record:ResearchExportExecution;writable:boolean;onDirty:(v:boolean)=>void;onPending:(v:boolean)=>void;onPrepared:(v:ZenodoPrepared)=>void;onDiscard:()=>void}):React.JSX.Element {
  const available=[...(record.archive===null?[]:[{area:'archive' as const,...record.archive}]),...record.files.map(file=>({area:'bundle' as const,...file}))];
  const [files,setFiles]=useState<{area:'archive'|'bundle';path:string;name:string}[]>([]);
  const [environment,setEnvironment]=useState(''),[kind,setKind]=useState('');
  const [fields,setFields]=useState({title:'',description:'',publication_date:'',license:'',version:''});
  const [creators,setCreators]=useState([{name:'',affiliation:'',orcid:''}]);
  const [review,setReview]=useState({privacy:false,fileLicenses:false,authors:false});
  const [preview,setPreview]=useState<{request:ZenodoPrepare;inputs:ZenodoInputs}|null>(null),[error,setError]=useState<string|null>(null);
  const [retry,setRetry]=useState<ZenodoPrepare|null>(null);
  const mounted=useRef(true),busy=useRef(false),requestId=useRef(crypto.randomUUID());
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const read=useAsyncAction((input:Parameters<RocClient['api']['research']['getZenodoInputs']>[0])=>client.api.research.getZenodoInputs(input),{label:'核对拟上传文件'});
  const save=useAsyncAction((input:ZenodoPrepare)=>client.api.research.prepareZenodo(input),{label:'保存 Zenodo 审核准备'});
  const pending=read.pending||save.pending,locked=pending||retry!==null||!writable;
  const change=():void=>{setPreview(null);setError(null);requestId.current=crypto.randomUUID();read.reset();save.reset();onDirty(true);};
  const finish=():boolean=>{busy.current=false;if(!mounted.current)return false;onPending(false);return true;};
  const submit=(request:ZenodoPrepare):void=>{if(busy.current||!writable)return;busy.current=true;onPending(true);void save.run(request).then(result=>{if(!finish())return;if(!result.ok){setRetry(request);return;}setRetry(null);onDirty(false);onPrepared(result.data);});};
  return <form className="flex min-w-0 flex-col gap-3" data-testid="artifact-zenodo-editor" noValidate onSubmit={event=>{event.preventDefault();if(preview!==null)submit(preview.request);}}>
    <fieldset disabled={locked} className="flex min-w-0 flex-col gap-2">
      <legend>选择拟公开文件</legend>
      {available.map(file=>{const chosen=files.find(value=>value.area===file.area&&value.path===file.path);return <div key={`${file.area}:${file.path}`} className="flex min-w-0 flex-col gap-1 border-t-[0.5px] border-line pt-2">
        <label className="flex min-w-0 items-start gap-2"><input type="checkbox" checked={chosen!==undefined} onChange={event=>{setFiles(event.target.checked?[...files,{area:file.area,path:file.path,name:''}]:files.filter(value=>value!==chosen));change();}}/><span className="break-all">{file.area} / {file.path}，{file.size} B</span></label>
        {chosen===undefined?null:<ExportTextField label={`上传名 ${file.path}`} value={chosen.name} onChange={name=>{setFiles(files.map(value=>value===chosen?{...value,name}:value));change();}}/>}
      </div>;})}
      <label className="flex flex-col gap-1">Zenodo 环境<select aria-label="Zenodo 环境" className={`${formSelectClass} border-[0.5px]`} value={environment} onChange={event=>{setEnvironment(event.target.value);change();}}><option value="">选择环境</option><option value="sandbox">测试环境</option><option value="production">正式环境</option></select></label>
      <label className="flex flex-col gap-1">出版类型<select aria-label="出版类型" className={`${formSelectClass} border-[0.5px]`} value={kind} onChange={event=>{setKind(event.target.value);change();}}><option value="">选择类型</option><option value="article">文章</option><option value="preprint">预印本</option><option value="report">报告</option></select></label>
      {(['title','description','publication_date','license','version'] as const).map(key=><ExportTextField key={key} label={{title:'Zenodo 标题',description:'Zenodo 说明',publication_date:'Zenodo 发布日期',license:'Zenodo 许可 ID',version:'Zenodo 版本'}[key]} type={key==='publication_date'?'date':'text'} multiline={key==='description'} value={fields[key]} onChange={value=>{setFields({...fields,[key]:value});change();}}/>)}
      {creators.map((creator,index)=><section key={index} className="flex min-w-0 flex-col gap-2" aria-label={`Zenodo 作者 ${index+1}`}>
        {(['name','affiliation','orcid'] as const).map(key=><ExportTextField key={key} label={`作者 ${index+1} ${{name:'姓名',affiliation:'单位（可留空）',orcid:'ORCID（可留空）'}[key]}`} value={creator[key]} onChange={value=>{setCreators(creators.map((item,at)=>at===index?{...item,[key]:value}:item));change();}}/>)}
        <button type="button" className={`${button} self-start`} disabled={creators.length===1} onClick={()=>{setCreators(creators.filter((_,at)=>at!==index));change();}}>移除作者 {index+1}</button>
      </section>)}
      <button type="button" className={`${button} self-start`} disabled={creators.length>=100} onClick={()=>{setCreators([...creators,{name:'',affiliation:'',orcid:''}]);change();}}>添加 Zenodo 作者</button>
      {(['privacy','fileLicenses','authors'] as const).map(key=><label key={key} className="flex items-start gap-2"><input type="checkbox" checked={review[key]} onChange={event=>{setReview({...review,[key]:event.target.checked});change();}}/><span>{{privacy:'已检查隐私，允许所选内容公开',fileLicenses:'已核对全部文件的公开许可',authors:'已核对作者与署名授权'}[key]}</span></label>)}
    </fieldset>
    {error===null?null:<p role="alert" className="break-words text-[var(--st-warn)]">{error}</p>}
    {read.error===null?null:<p role="alert">{read.error}</p>}{save.error===null?null:<p role="alert">{save.error}</p>}
    {pending?<p role="status">{read.pending?'正在核对实际文件…':'正在保存本地准备…'}</p>:null}
    {preview===null?null:<section data-testid="artifact-zenodo-local-preview" className="flex min-w-0 flex-col gap-2"><h3>拟公开清单</h3><p>{preview.request.environment==='sandbox'?'测试环境':'正式环境'}，{preview.request.metadata.title}，{preview.request.metadata.license}，{preview.request.metadata.version}</p><p className="whitespace-pre-wrap break-words">{preview.request.metadata.description}</p><p>{preview.request.metadata.publication_type}，{preview.request.metadata.publication_date}，公开访问</p>{preview.request.metadata.creators.map((creator,index)=><p key={index}>{creator.name}，{creator.affiliation}，{creator.orcid}</p>)}{preview.inputs.files.map(file=><p key={file.name} className="break-all">{file.name}，{file.size} B，SHA-256 {file.sha256}，MD5 {file.md5}</p>)}</section>}
    <div className="flex flex-wrap gap-2">
      <button type="button" className={button} disabled={locked} onClick={()=>{
        if(busy.current)return;
        const selected=zenodoInputsRequestSchema.safeParse({projectId:record.projectId,exportId:record.id,files});
        if(!selected.success){setError(selected.error.issues.map(issue=>issue.message).join('；'));return;}
        const parsed=zenodoPrepareSchema.omit({expectedInputsHash:true}).safeParse({...selected.data,requestId:requestId.current,environment,
          metadata:{...fields,upload_type:'publication',publication_type:kind,access_right:'open',creators:creators.map(creator=>({name:creator.name,...(creator.affiliation===''?{}:{affiliation:creator.affiliation}),...(creator.orcid===''?{}:{orcid:creator.orcid})}))},review});
        if(!parsed.success){setError(parsed.error.issues.map(issue=>`${issue.path.join('.')}：${issue.message}`).join('；'));return;}
        busy.current=true;onPending(true);setPreview(null);void read.run(selected.data).then(result=>{if(!finish()||!result.ok)return;setError(null);setPreview({request:{...parsed.data,expectedInputsHash:result.data.contentHash},inputs:result.data});});
      }}>预览并核对拟上传文件</button>
      <button type="submit" className={`${formPrimaryButtonClass} border-[0.5px]`} disabled={locked||preview===null}>确认清单并保存本地准备</button>
      {retry===null?null:<button type="button" className={button} disabled={pending||!writable} onClick={()=>submit(retry)}>重试同一准备请求</button>}
      <button type="button" className={button} disabled={pending||retry!==null} onClick={()=>{onDirty(false);onDiscard();}}>放弃 Zenodo 编辑</button>
    </div>
  </form>;
}
