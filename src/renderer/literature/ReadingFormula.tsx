import {useMemo} from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
export default function ReadingFormula({text}:{text:string}):React.JSX.Element {
  const rendered=useMemo(()=>{try{return {html:katex.renderToString(text.replace(/^\s*\$\$?|\$\$?\s*$/g,''),{displayMode:true,throwOnError:true,trust:false,strict:'warn',maxExpand:1000}),error:null};}
    catch(error){return {html:null,error:String(error)};}},[text]);
  return rendered.html===null?<div><pre className="overflow-auto whitespace-pre-wrap">{text}</pre><p className="text-muted">公式无法渲染，显示解析原文。</p></div>:
    <div><div className="overflow-auto" dangerouslySetInnerHTML={{__html:rendered.html}}/>
      <details><summary>公式 LaTeX 原文</summary><pre className="overflow-auto whitespace-pre-wrap">{text}</pre></details></div>;
}
