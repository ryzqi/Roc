import {useEffect,useImperativeHandle,useRef,useState,type Ref} from 'react';
import type {z} from 'zod';
import type {translationSettingsSchema} from '../../shared/schemas/research-reading';
import {useAsyncAction,useAsyncResource} from '../app/use-async-resource';
import {BEFORE_NAVIGATE,type NavigationRequest} from '../app/navigation-guard';
import {ConfirmDialog} from '../shell/ConfirmDialog';
import type {RocClient} from '../shared/roc-client';
type Settings=z.infer<typeof translationSettingsSchema>;
type Provider=Settings['provider'];
type Draft=Omit<Settings,'keyConfigured'>&{apiKey:string};
export type ReadingTranslationGuard={request:(proceed:()=>void)=>void};
const providers:Record<Provider,{label:string;url:string}>={google:{label:'Google 内置',url:'https://translate.googleapis.com'},tencent:{label:'腾讯交互翻译',url:'https://transmart.qq.com'},openai:{label:'OpenAI 兼容 / BYOK',url:'https://api.openai.com/v1'},deepl:{label:'DeepL API',url:'https://api-free.deepl.com'},azure:{label:'Azure Translator',url:'https://api.cognitive.microsofttranslator.com'},googleCloud:{label:'Google Cloud',url:'https://translation.googleapis.com'}};
export default function ReadingTranslationPanel({client,projectId,segments,label,onNote,onClose,writable=true,transitionGuardRef}: {
  client:RocClient;projectId:string;segments:{label:string;text:string}[];label:string;onNote:(text:string)=>void;onClose:()=>void;
  writable?:boolean;transitionGuardRef?:Ref<ReadingTranslationGuard>;
}):React.JSX.Element {
  const resource=useAsyncResource('reading-translation-settings',()=>client.api.research.getReadingTranslationSettings({}),{label:'读取翻译设置'});
  const [draft,setDraft]=useState<Draft>({target:'zh-CN',provider:'google',region:'',baseUrl:providers.google.url,model:'',apiKey:''});
  const draftRef=useRef(draft),baseline=useRef<Draft|null>(null);
  const [settings,setSettings]=useState(false),settingsRef=useRef(false),[configured,setConfigured]=useState(false);
  const [operation,setOperation]=useState<'saving'|'translating'|null>(null),operationRef=useRef<typeof operation>(null);
  const [output,setOutput]=useState<{label:string;text:string;source:string}[]>([]);
  const [stopping,setStopping]=useState(false),[stopped,setStopped]=useState(false),stopRequested=useRef(false);
  const [confirmation,setConfirmation]=useState<{message:string;proceed:()=>void}|null>(null);
  const generation=useRef(0),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;};},[]);
  const updateDraft=(patch:Partial<Draft>):void=>{draftRef.current={...draftRef.current,...patch};setDraft(draftRef.current);};
  const acceptSettings=(value:Settings):void=>{
    const {keyConfigured,...fields}=value;
    const next={...fields,apiKey:''};baseline.current=next;draftRef.current=next;setDraft(next);setConfigured(keyConfigured);
  };
  useEffect(()=>{if(resource.data)acceptSettings(resource.data);},[resource.data]);
  const dirty=():boolean=>settingsRef.current&&baseline.current!==null&&JSON.stringify(draftRef.current)!==JSON.stringify(baseline.current);
  const request=(proceed:()=>void):void=>{
    if(operationRef.current==='saving')return;
    if(!dirty()){proceed();return;}
    setConfirmation({message:'尚未保存的翻译设置将被放弃。',proceed:()=>{
      if(baseline.current){draftRef.current=baseline.current;setDraft(baseline.current);}
      proceed();
    }});
  };
  useImperativeHandle(transitionGuardRef,()=>({request}));
  useEffect(()=>{
    const beforeNavigate=(event:Event):void=>{
      const navigation=event as CustomEvent<NavigationRequest>;
      if(navigation.detail.next.projectId===projectId)return;
      if(operationRef.current==='saving'){event.preventDefault();return;}
      if(dirty())request(navigation.detail.defer());
    };
    const beforeUnload=(event:BeforeUnloadEvent):void=>{
      if(operationRef.current!=='saving'&&!dirty())return;
      event.preventDefault();event.returnValue='';
    };
    window.addEventListener(BEFORE_NAVIGATE,beforeNavigate);window.addEventListener('beforeunload',beforeUnload);
    return()=>{window.removeEventListener(BEFORE_NAVIGATE,beforeNavigate);window.removeEventListener('beforeunload',beforeUnload);};
  },[projectId]);
  const saveAction=useAsyncAction((input:Draft)=>client.api.research.saveReadingTranslationSettings({...input,apiKey:input.apiKey||null}),{label:'保存翻译设置'});
  const translateAction=useAsyncAction(async(input:{target:string;generation:number})=>{
    for(const segment of segments){
      if(stopRequested.current||input.generation!==generation.current||!mounted.current)break;
      if(!segment.text.trim())continue;
      const result=await client.api.research.translateReading({projectId,text:segment.text,target:input.target});
      if(input.generation!==generation.current||!mounted.current)break;
      if(!result.ok)return result;
      setOutput(current=>[...current,{label:segment.label,text:result.data.text,source:segment.text}]);
    }
    return {ok:true as const,data:null};
  },{label:'翻译阅读文本'});
  const ready=resource.status==='ready'&&baseline.current!==null;
  const busy=operation!==null;
  const translate=async():Promise<void>=>{
    if(!ready||operationRef.current!==null||dirty())return;
    operationRef.current='translating';setOperation('translating');stopRequested.current=false;
    setStopping(false);setStopped(false);setOutput([]);saveAction.reset();
    await translateAction.run({target:draftRef.current.target,generation:++generation.current});
    if(!mounted.current)return;
    setStopped(stopRequested.current);setStopping(false);operationRef.current=null;setOperation(null);
  };
  const saveSettings=async():Promise<void>=>{
    if(!ready||operationRef.current!==null)return;
    operationRef.current='saving';setOperation('saving');translateAction.reset();
    const result=await saveAction.run({...draftRef.current});
    if(!mounted.current)return;
    if(result.ok){acceptSettings(result.data);settingsRef.current=false;setSettings(false);}
    operationRef.current=null;setOperation(null);
  };
  const changeProvider=(next:Provider):void=>{
    if(operationRef.current!==null)return;
    const proceed=():void=>{updateDraft({provider:next,baseUrl:providers[next].url,apiKey:''});setConfigured(false);};
    if(draftRef.current.apiKey)setConfirmation({message:'更换翻译渠道会清空尚未保存的 API Key。',proceed});
    else proceed();
  };
  const error=resource.error??saveAction.error??translateAction.error;
  const {target,provider,region,baseUrl,model,apiKey}=draft;
  return <section className="max-h-[55%] min-h-0 overflow-auto border-b-[0.5px] border-line" data-testid="reader-translation" aria-label="阅读翻译">
    <div className="reading-toolbar"><strong>{label}</strong><select aria-label="翻译目标语言" value={target} disabled={!ready||busy} onChange={event=>updateDraft({target:event.target.value})}>
      <option value="zh-CN">简体中文</option><option value="en">English</option><option value="ja">日本語</option><option value="de">Deutsch</option><option value="fr">Français</option></select>
      <button type="button" disabled={!ready||busy||dirty()} onClick={()=>void translate()}>开始翻译</button>
      <button type="button" aria-expanded={settings} disabled={!ready||busy} onClick={()=>{
        if(settings)request(()=>{settingsRef.current=false;setSettings(false);});
        else {settingsRef.current=true;setSettings(true);}
      }}>翻译设置</button>
      {operation==='translating'?<button type="button" disabled={stopping} onClick={()=>{
        if(operationRef.current!=='translating')return;
        stopRequested.current=true;setStopping(true);
      }}>停止后续翻译</button>:null}
      <button type="button" disabled={operation==='saving'} onClick={()=>request(onClose)}>关闭</button>
    </div>
    {settings?<fieldset disabled={busy} className="reading-toolbar"><select aria-label="翻译渠道" value={provider} onChange={event=>changeProvider(event.target.value as Provider)}>{Object.entries(providers).map(([id,value])=><option key={id} value={id}>{value.label}</option>)}</select>
      {!['google','tencent'].includes(provider)?<><input aria-label="翻译 API 地址" value={baseUrl} onChange={event=>updateDraft({baseUrl:event.target.value})}/>{provider==='openai'?<input aria-label="翻译模型" placeholder="模型名称" value={model} onChange={event=>updateDraft({model:event.target.value})}/>:null}{provider==='azure'?<input aria-label="Azure 区域" placeholder="例如 eastasia" value={region} onChange={event=>updateDraft({region:event.target.value})}/>:null}
      <input aria-label="翻译 API Key" type="password" autoComplete="off" placeholder={configured?'已保存；留空保留':'API Key'} value={apiKey} onChange={event=>updateDraft({apiKey:event.target.value})}/></>:null}
      <button type="button" onClick={()=>void saveSettings()}>保存翻译设置</button></fieldset>:null}
    {error?<div role="alert" className="p-2 text-[var(--st-warn)]">{error}{resource.status==='error'?<button type="button" className="ml-2 underline" onClick={resource.reload}>重试</button>:null}</div>:null}
    <p role="status" className="px-3 text-muted tabular-nums">{resource.status==='error'?'翻译设置读取失败':!ready?'读取翻译设置…':operation==='saving'?'保存翻译设置…':
      stopping?`已请求停止，等待当前段返回（${output.length} / ${segments.length} 段）`:
      operation==='translating'?`已翻译 ${output.length} / ${segments.length} 段`:
      stopped?`已停止，保留 ${output.length} / ${segments.length} 段`:
      dirty()?'请先保存翻译设置':`${providers[baseline.current?.provider??provider].label}，${segments.length} 段`}</p>
    {output.map((part,index)=><div key={index} className="grid grid-cols-2 gap-3 border-b-[0.5px] border-line p-3"><div><b>{part.label}，原文</b><p className="mt-1 whitespace-pre-wrap">{part.source}</p></div><div><b>译文</b><p className="mt-1 whitespace-pre-wrap">{part.text}</p></div></div>)}
    {output.length?<div className="reading-toolbar"><button type="button" disabled={!writable} onClick={()=>onNote(output.map(part=>`## ${part.label}\n\n${part.text}`).join('\n\n'))}>译文存为笔记</button></div>:null}
    <ConfirmDialog open={confirmation!==null} title="放弃翻译设置草稿？" message={confirmation?.message??''}
      confirmLabel="放弃草稿" confirmDisabled={operation==='saving'} testId="translation-discard-dialog"
      onCancel={()=>setConfirmation(null)} onConfirm={()=>{
        if(operationRef.current==='saving')return;
        const pending=confirmation;setConfirmation(null);pending?.proceed();
      }}/>
  </section>;
}
