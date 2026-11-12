import {useEffect,useRef,useState} from 'react';
import type {z} from 'zod';
import type {translationSettingsSchema} from '../../shared/schemas/research-reading';
import type {RocClient} from '../shared/roc-client';
type Provider=z.infer<typeof translationSettingsSchema>['provider'];
const providers:Record<Provider,{label:string;url:string}>={google:{label:'Google 内置',url:'https://translate.googleapis.com'},tencent:{label:'腾讯交互翻译',url:'https://transmart.qq.com'},openai:{label:'OpenAI 兼容 / BYOK',url:'https://api.openai.com/v1'},deepl:{label:'DeepL API',url:'https://api-free.deepl.com'},azure:{label:'Azure Translator',url:'https://api.cognitive.microsofttranslator.com'},googleCloud:{label:'Google Cloud',url:'https://translation.googleapis.com'}};
export default function ReadingTranslationPanel({client,projectId,segments,label,onNote,onClose}: {
  client:RocClient;projectId:string;segments:{label:string;text:string}[];label:string;onNote:(text:string)=>void;onClose:()=>void;
}):React.JSX.Element {
  const [target,setTarget]=useState('zh-CN'),[provider,setProvider]=useState<Provider>('google');
  const [region,setRegion]=useState('');
  const [baseUrl,setBaseUrl]=useState('https://api.openai.com/v1'),[model,setModel]=useState(''),[apiKey,setApiKey]=useState('');
  const [settings,setSettings]=useState(false),[configured,setConfigured]=useState(false),[busy,setBusy]=useState(false);
  const [output,setOutput]=useState<{label:string;text:string}[]>([]),[error,setError]=useState<string|null>(null);
  const generation=useRef(0),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;void client.api.research.getReadingTranslationSettings({}).then(result=>{
    if(!mounted.current)return;if(!result.ok){setError(result.error.message);return;}
    setTarget(result.data.target);setProvider(result.data.provider);setConfigured(result.data.keyConfigured);
    setBaseUrl(result.data.baseUrl);setModel(result.data.model);setRegion(result.data.region);
  }).catch(error=>{if(mounted.current)setError(String(error));});return()=>{mounted.current=false;generation.current++;};},[client]);
  const translate=async():Promise<void>=>{
    const run=++generation.current;setBusy(true);setError(null);setOutput([]);
    try{for(const segment of segments){if(!segment.text.trim())continue;
      const result=await client.api.research.translateReading({projectId,text:segment.text,target});
      if(run!==generation.current||!mounted.current)return;if(!result.ok)throw new Error(result.error.message);
      setOutput(current=>[...current,{label:segment.label,text:result.data.text}]);
    }}catch(error){if(run===generation.current&&mounted.current)setError(String(error));}
    finally{if(run===generation.current&&mounted.current)setBusy(false);}
  };
  const saveSettings=async():Promise<void>=>{
    setBusy(true);setError(null);try{const result=await client.api.research.saveReadingTranslationSettings({provider,baseUrl,model,region,target,apiKey:apiKey||null});
      if(!result.ok)throw new Error(result.error.message);setApiKey('');setConfigured(result.data.keyConfigured);setSettings(false);
    }catch(error){setError(String(error));}finally{setBusy(false);}
  };
  return <section className="max-h-[55%] min-h-0 overflow-auto border-b-[0.5px] border-line" data-testid="reader-translation" aria-label="阅读翻译">
    <div className="reading-toolbar"><strong>{label}</strong><select aria-label="翻译目标语言" value={target} disabled={busy} onChange={event=>setTarget(event.target.value)}>
      <option value="zh-CN">简体中文</option><option value="en">English</option><option value="ja">日本語</option><option value="de">Deutsch</option><option value="fr">Français</option></select>
      <button type="button" disabled={busy} onClick={()=>void translate()}>开始翻译</button><button type="button" disabled={busy} onClick={()=>setSettings(!settings)}>翻译设置</button>
      {busy?<button type="button" onClick={()=>{generation.current++;setBusy(false);}}>停止后续翻译</button>:null}
      <button type="button" onClick={onClose}>关闭</button>
    </div>
    {settings?<div className="reading-toolbar"><select aria-label="翻译渠道" value={provider} onChange={event=>{const next=event.target.value as Provider;setProvider(next);setBaseUrl(providers[next].url);setConfigured(false);setApiKey('');}}>{Object.entries(providers).map(([id,value])=><option key={id} value={id}>{value.label}</option>)}</select>
      {!['google','tencent'].includes(provider)?<><input aria-label="翻译 API 地址" value={baseUrl} onChange={event=>setBaseUrl(event.target.value)}/>{provider==='openai'?<input aria-label="翻译模型" placeholder="模型名称" value={model} onChange={event=>setModel(event.target.value)}/>:null}{provider==='azure'?<input aria-label="Azure 区域" placeholder="例如 eastasia" value={region} onChange={event=>setRegion(event.target.value)}/>:null}
      <input aria-label="翻译 API Key" type="password" autoComplete="off" placeholder={configured?'已保存；留空保留':'API Key'} value={apiKey} onChange={event=>setApiKey(event.target.value)}/></>:null}
      <button type="button" disabled={busy} onClick={()=>void saveSettings()}>保存翻译设置</button></div>:null}
    {error?<p role="alert" className="p-2 text-[var(--st-warn)]">{error}</p>:null}
    <p role="status" className="px-3 text-muted">{busy?`已翻译 ${output.length} / ${segments.length} 段`:`${providers[provider].label}，${segments.length} 段`}</p>
    {output.map((part,index)=><div key={index} className="grid grid-cols-2 gap-3 border-b-[0.5px] border-line p-3"><div><b>{part.label}，原文</b><p className="mt-1 whitespace-pre-wrap">{segments.find(segment=>segment.label===part.label)?.text}</p></div><div><b>译文</b><p className="mt-1 whitespace-pre-wrap">{part.text}</p></div></div>)}
    {output.length?<div className="reading-toolbar"><button type="button" onClick={()=>onNote(output.map(part=>`## ${part.label}\n\n${part.text}`).join('\n\n'))}>译文存为笔记</button></div>:null}
  </section>;
}
