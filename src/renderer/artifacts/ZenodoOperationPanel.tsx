import {useEffect,useRef,useState} from 'react';
import type {ZenodoPrepared} from '../../shared/schemas/research-zenodo';
import type {ZenodoOperation} from '../../shared/schemas/research-zenodo-remote';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction,useAsyncResource} from '../app/use-async-resource';
import {formPrimaryButtonClass,formSecondaryButtonClass} from '../shared/form-ui';
import {ZenodoReceipt} from './ZenodoReceipt';
type Api=RocClient['api']['research'];
type Command={kind:'start';input:Parameters<Api['startZenodoOperation']>[0]}|{kind:'resume';input:Parameters<Api['resumeZenodoOperation']>[0]}|{kind:'approve';input:Parameters<Api['approveZenodoPublication']>[0]}|{kind:'publish';input:Parameters<Api['publishZenodo']>[0]}|{kind:'refresh';input:Parameters<Api['refreshZenodoOperation']>[0]};
const button=`${formSecondaryButtonClass} border-[0.5px]`;
export function ZenodoOperationPanel({client,preparation,initial,writable,onDirty,onPending,onSaved}:{client:RocClient;preparation:ZenodoPrepared;initial:ZenodoOperation|null;writable:boolean;onDirty:(v:boolean)=>void;onPending:(v:boolean)=>void;onSaved:()=>void}):React.JSX.Element {
  const [operation,setOperation]=useState(initial),[command,setCommand]=useState<Command|null>(null),[confirmed,setConfirmed]=useState(false),[reviewed,setReviewed]=useState<string|null>(null);
  const busy=useRef(false),mounted=useRef(true),startId=useRef(crypto.randomUUID());
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const existing=useAsyncResource(`zenodo:operation-for-preparation:${preparation.projectId}:${preparation.id}`,
    ()=>client.api.research.getZenodoOperationForPreparation({projectId:preparation.projectId,preparationId:preparation.id}),
    {label:'读取已保存的远端操作'});
  useEffect(()=>{if(existing.status==='ready')setOperation(existing.data);},[existing.status,existing.data]);
  const action=useAsyncAction(async (value:Command)=>{
    switch(value.kind){
      case 'start':return client.api.research.startZenodoOperation(value.input);
      case 'resume':return client.api.research.resumeZenodoOperation(value.input);
      case 'publish':return client.api.research.publishZenodo(value.input);
      case 'refresh':return client.api.research.refreshZenodoOperation(value.input);
      case 'approve':{
        const approved=await client.api.research.approveZenodoPublication(value.input);
        if(!approved.ok)return approved;
        return client.api.research.getZenodoOperation({projectId:preparation.projectId,operationId:value.input.operationId});
      }
    }
  },{label:'Zenodo 远端操作'});
  const cancel=useAsyncAction(async ()=>{
    if(operation!==null)return client.api.research.cancelZenodoOperation({projectId:preparation.projectId,operationId:operation.id});
    const list=await client.api.research.getZenodoOperations({projectId:preparation.projectId,offset:0,limit:20});
    if(!list.ok)return list;
    const found=list.data.records.find(value=>value.request.requestId===startId.current&&value.preparationId===preparation.id);
    if(found===undefined)return {ok:false as const,error:{code:'research_zenodo_operation_not_started',message:'尚未建立可取消的远端操作，请等待当前请求回执。'}};
    return client.api.research.cancelZenodoOperation({projectId:preparation.projectId,operationId:found.id});
  },{label:'取消当前 Zenodo 请求'});
  const run=(value:Command):void=>{
    if(busy.current||(!writable&&value.kind!=='refresh'))return;
    busy.current=true;onPending(true);setCommand(value);onDirty(true);
    void action.run(value).then(result=>{
      busy.current=false;if(!mounted.current)return;onPending(false);
      if(!result.ok)return;
      setOperation(result.data);setCommand(null);onDirty(false);setConfirmed(false);setReviewed(null);onSaved();
    });
  };
  const credential=useAsyncResource(`zenodo:credential:${preparation.projectId}:${preparation.request.environment}`,
    ()=>client.api.research.getZenodoCredentialStatus({projectId:preparation.projectId,environment:preparation.request.environment}),{label:'读取凭据状态'});
  const read=useAsyncAction(()=>client.api.research.getZenodoOperation({projectId:preparation.projectId,operationId:operation!.id}),{label:'读取已保存状态'});
  const pending=action.pending||read.pending,locked=pending||command!==null||existing.status!=='ready';
  const reviewValid=operation?.remote!==null&&operation?.remote!==undefined&&reviewed===`${operation.revision}:${operation.remote.contentHash}`;
  const approved=operation!==null&&operation.approval!==null&&operation.remote!==null&&operation.approval.request.expectedRemoteHash===operation.remote.contentHash&&operation.approval.request.expectedPreparationHash===preparation.contentHash;
  return <section className="flex min-w-0 flex-col gap-3" data-testid="artifact-zenodo-operation">
    <ZenodoReceipt preparation={preparation} {...(operation===null?{}:{operation})}/>
    {existing.error===null?null:<p role="alert">{existing.error}</p>}
    {existing.status!=='error'?null:<button type="button" className={`${button} self-start`} onClick={existing.reload}>重试读取既有操作</button>}
    {credential.error===null?null:<p role="alert">{credential.error}</p>}
    {action.error===null?null:<p role="alert">{action.error}</p>}{read.error===null?null:<p role="alert">{read.error}</p>}{cancel.error===null?null:<p role="alert">{cancel.error}</p>}
    {pending?<p role="status">正在等待 Zenodo 操作回执…</p>:null}
    {operation===null?<>
      <p>创建草稿会上传清单中的全部文件，并写入公开关联标识。正式环境的最终发布将公开这些内容。</p>
      <p>{credential.status==='ready'?(credential.data!.stored?'该环境凭据已保存':'该环境尚未保存凭据'):'正在读取凭据状态…'}</p>
      <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={locked||!writable||credential.status!=='ready'||!credential.data!.stored}
        onClick={()=>run({kind:'start',input:{projectId:preparation.projectId,preparationId:preparation.id,requestId:startId.current,expectedPreparationHash:preparation.contentHash}})}>创建草稿并上传文件</button>
        <button type="button" className={button} disabled={locked} onClick={credential.reload}>刷新凭据状态</button></div>
    </>:<>
      {operation.status!=='ready'?null:<label className="flex items-start gap-2"><input type="checkbox" disabled={locked||!writable} checked={confirmed} onChange={event=>{
        setConfirmed(event.target.checked);setReviewed(event.target.checked?`${operation.revision}:${operation.remote!.contentHash}`:null);
      }}/><span>已审查完整远端元数据、文件、公开关联标识和环境，单独批准公开发布</span></label>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={locked} onClick={()=>run({kind:'refresh',input:{projectId:preparation.projectId,operationId:operation.id}})}>查询远端实际状态</button>
        <button type="button" className={button} disabled={pending} onClick={()=>{
          if(busy.current)return;busy.current=true;onPending(true);void read.run().then(result=>{busy.current=false;if(!mounted.current)return;onPending(false);if(!result.ok)return;setOperation(result.data);setCommand(null);onDirty(false);setConfirmed(false);setReviewed(null);action.reset();onSaved();});
        }}>读取已保存状态</button>
        {operation.remoteId===null||['publish_requested','publish_unknown','published'].includes(operation.status)?null:
          <button type="button" className={button} disabled={locked||!writable} onClick={()=>run({kind:'resume',input:{projectId:preparation.projectId,operationId:operation.id,expectedRevision:operation.revision}})}>核对草稿并补传缺失文件</button>}
        {operation.status!=='ready'?null:<>
          <button type="button" className={button} disabled={locked||!writable||!confirmed||!reviewValid} onClick={()=>run({kind:'approve',input:{projectId:preparation.projectId,operationId:operation.id,expectedRevision:operation.revision,requestId:crypto.randomUUID(),expectedRemoteHash:operation.remote!.contentHash,expectedPreparationHash:preparation.contentHash,confirmPublic:true}})}>保存独立公开批准</button>
          <button type="button" className={`${formPrimaryButtonClass} border-[0.5px]`} disabled={locked||!writable||!approved} onClick={()=>run({kind:'publish',input:{projectId:preparation.projectId,operationId:operation.id,expectedRevision:operation.revision,approvalId:operation.approval!.id}})}>使用该批准公开发布</button>
        </>}
      </div>
    </>}
    {command===null||pending?null:<button type="button" className={`${button} self-start`} disabled={!writable&&command.kind!=='refresh'} onClick={()=>run(command)}>重试同一远端请求</button>}
    {!action.pending||!writable?null:<button type="button" className={`${button} self-start`} disabled={cancel.pending} onClick={()=>{void cancel.run();}}>取消正在进行的请求</button>}
    {operation?.status==='published'?<p>公开记录已发布。取消本地请求不会撤回远端记录。</p>:null}
  </section>;
}
