import {useEffect,useRef,useState} from 'react';
import type {ResearchExportExecution} from '../../shared/schemas/research-exports';
import type {ZenodoPrepared} from '../../shared/schemas/research-zenodo';
import type {ZenodoOperation} from '../../shared/schemas/research-zenodo-remote';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction,useAsyncResource} from '../app/use-async-resource';
import {formSecondaryButtonClass,formSelectClass} from '../shared/form-ui';
import {ZenodoPreparationEditor} from './ZenodoPreparationEditor';
import {ZenodoOperationPanel} from './ZenodoOperationPanel';
import {zenodoStatusLabels} from './ZenodoReceipt';
const button=`${formSecondaryButtonClass} border-[0.5px]`;
export function ZenodoPanel({client,record,writable,onDirty,onPending}:{client:RocClient;record:ResearchExportExecution;writable:boolean;onDirty:(v:boolean)=>void;onPending:(v:boolean)=>void}):React.JSX.Element {
  const [editing,setEditing]=useState(false),[dirty,setDirty]=useState(false),[pending,setPending]=useState(false);
  const [prepared,setPrepared]=useState<ZenodoPrepared|null>(null),[selected,setSelected]=useState<ZenodoOperation|null>(null);
  const [environment,setEnvironment]=useState(''),[plaintext,setPlaintext]=useState(''),[credentialDirty,setCredentialDirty]=useState(false);
  const [offset,setOffset]=useState(0),[operationOffset,setOperationOffset]=useState(0),[historyNonce,setHistoryNonce]=useState(0);
  const busy=useRef(false),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const reportDirty=(value:boolean):void=>{setDirty(value);onDirty(value||credentialDirty);};
  const reportPending=(value:boolean):void=>{setPending(value);onPending(value);};
  const credential=useAsyncResource(environment===''?null:`zenodo:secret:${record.projectId}:${environment}:${historyNonce}`,
    ()=>client.api.research.getZenodoCredentialStatus({projectId:record.projectId,environment:environment as 'sandbox'|'production'}),{label:'读取凭据状态'});
  const secret=useAsyncAction((kind:'save'|'clear')=>kind==='save'?client.api.research.saveZenodoCredential({projectId:record.projectId,environment:environment as 'sandbox'|'production',plaintext}):client.api.research.clearZenodoCredential({projectId:record.projectId,environment:environment as 'sandbox'|'production'}),{label:'更新 Zenodo 凭据'});
  const preparations=useAsyncResource(historyNonce===0?null:`zenodo:preparations:${record.projectId}:${offset}:${historyNonce}`,
    ()=>client.api.research.getZenodoPreparations({projectId:record.projectId,offset,limit:20}),{label:'读取准备历史'});
  const operations=useAsyncResource(historyNonce===0?null:`zenodo:operations:${record.projectId}:${operationOffset}:${historyNonce}`,
    ()=>client.api.research.getZenodoOperations({projectId:record.projectId,offset:operationOffset,limit:20}),{label:'读取远端操作历史'});
  const choose=useAsyncAction((value:ZenodoOperation)=>client.api.research.getZenodoPreparation({projectId:record.projectId,preparationId:value.preparationId}),{label:'读取该操作的准备清单'});
  const locked=pending||dirty||credentialDirty||secret.pending||choose.pending;
  const refresh=():void=>setHistoryNonce(value=>value+1);
  const changeCredential=(value:boolean):void=>{setCredentialDirty(value);onDirty(value||dirty);};
  const credentialAction=(kind:'save'|'clear'):void=>{
    if(busy.current||!writable||environment==='')return;
    busy.current=true;reportPending(true);
    // Plaintext leaves component state as soon as the IPC call captures it.
    const result=secret.run(kind);setPlaintext('');changeCredential(false);
    void result.then(value=>{busy.current=false;if(!mounted.current)return;reportPending(false);if(value.ok)refresh();});
  };
  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-3" data-testid="artifact-zenodo-panel" aria-label="审核式 Zenodo 发布">
    <h2 className="font-medium">审核式 Zenodo 发布</h2>
    <fieldset className="flex min-w-0 flex-col gap-2" disabled={pending||dirty||secret.pending||!writable}>
      <legend>环境凭据</legend>
      <label className="flex flex-col gap-1">凭据环境<select aria-label="凭据环境" className={`${formSelectClass} border-[0.5px]`} value={environment} disabled={credentialDirty} onChange={event=>setEnvironment(event.target.value)}><option value="">选择环境</option><option value="sandbox">测试环境</option><option value="production">正式环境</option></select></label>
      {environment===''?null:<>
        <p>{credential.status==='ready'?(credential.data!.stored?'凭据已加密保存':'该环境没有保存凭据'):'正在读取凭据状态…'}</p>
        <label className="flex flex-col gap-1">Zenodo 访问令牌<input type="password" autoComplete="off" className={`${formSelectClass} border-[0.5px]`} value={plaintext} onChange={event=>{setPlaintext(event.target.value);changeCredential(event.target.value!=='');}}/></label>
        <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={plaintext===''} onClick={()=>credentialAction('save')}>加密保存凭据</button>
          <button type="button" className={button} disabled={credentialDirty||credential.status!=='ready'||!credential.data!.stored} onClick={()=>credentialAction('clear')}>清除该环境凭据</button>
          <button type="button" className={button} disabled={!credentialDirty} onClick={()=>{setPlaintext('');changeCredential(false);}}>放弃令牌输入</button>
          <button type="button" className={button} disabled={credentialDirty} onClick={credential.reload}>刷新凭据状态</button></div>
      </>}
    </fieldset>
    {credential.error===null?null:<p role="alert">{credential.error}</p>}{secret.error===null?null:<p role="alert">{secret.error}</p>}{choose.error===null?null:<p role="alert">{choose.error}</p>}
    {!editing?null:<ZenodoPreparationEditor client={client} record={record} writable={writable&&!credentialDirty} onDirty={reportDirty} onPending={reportPending} onDiscard={()=>{setEditing(false);reportDirty(false);}} onPrepared={value=>{setEditing(false);setPrepared(value);setSelected(null);refresh();}}/>}
    {prepared===null?null:<ZenodoOperationPanel key={`${prepared.id}:${selected?.id??'new'}`} client={client} preparation={prepared} initial={selected} writable={writable&&!credentialDirty} onDirty={reportDirty} onPending={reportPending} onSaved={refresh}/>}
    <div className="flex flex-wrap gap-2">
      {!writable?null:<button type="button" className={button} disabled={locked||editing} onClick={()=>{setPrepared(null);setSelected(null);setEditing(true);reportDirty(true);}}>审查新的 Zenodo 准备</button>}
      <button type="button" className={button} disabled={locked||preparations.status==='loading'||operations.status==='loading'} onClick={refresh}>读取 Zenodo 历史</button>
    </div>
    {preparations.error===null?null:<p role="alert">{preparations.error}</p>}{operations.error===null?null:<p role="alert">{operations.error}</p>}
    {preparations.status!=='ready'?null:<section className="flex min-w-0 flex-col gap-2" aria-label="本地准备历史"><h3>项目准备历史，共 {preparations.data!.total} 项</h3>
      <ul>{preparations.data!.records.map(value=><li key={value.id}><button type="button" className={`${button} h-auto max-w-full py-1 text-left break-words`} disabled={locked} onClick={()=>{setEditing(false);setPrepared(value);setSelected(null);}}>{value.request.metadata.title}，{value.request.environment}，导出 {value.request.exportId}，{value.createdAt}</button></li>)}</ul>
      <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={locked||offset===0} onClick={()=>setOffset(Math.max(0,offset-20))}>上一页准备</button><button type="button" className={button} disabled={locked||preparations.data!.nextOffset===null} onClick={()=>setOffset(preparations.data!.nextOffset!)}>下一页准备</button></div>
    </section>}
    {operations.status!=='ready'?null:<section className="flex min-w-0 flex-col gap-2" aria-label="远端操作历史"><h3>项目远端操作，共 {operations.data!.total} 项</h3>
      <ul>{operations.data!.records.map(value=><li key={value.id}><button type="button" className={`${button} h-auto max-w-full py-1 text-left break-words`} disabled={locked} onClick={()=>{
        busy.current=true;reportPending(true);void choose.run(value).then(result=>{busy.current=false;if(!mounted.current)return;reportPending(false);if(!result.ok)return;setEditing(false);setPrepared(result.data);setSelected(value);});
      }}>{value.environment}，{zenodoStatusLabels[value.status]}，{value.id}</button></li>)}</ul>
      <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={locked||operationOffset===0} onClick={()=>setOperationOffset(Math.max(0,operationOffset-20))}>上一页操作</button><button type="button" className={button} disabled={locked||operations.data!.nextOffset===null} onClick={()=>setOperationOffset(operations.data!.nextOffset!)}>下一页操作</button></div>
    </section>}
  </section>;
}
