import {useState,useEffect} from 'react';
import {EditorContent, Node, nodeInputRule, useEditor, type Editor} from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {Markdown} from '@tiptap/markdown';
import {Mathematics} from '@tiptap/extension-mathematics';
import {TableKit} from '@tiptap/extension-table';
import Placeholder from '@tiptap/extension-placeholder';
import {useImeGuard} from '../shared/hooks/use-ime-guard';
import 'katex/dist/katex.min.css';
import './reading.css';

const WikiLink = Node.create({
  name:'wikiLink',group:'inline',inline:true,atom:true,
  addAttributes:()=>({title:{default:'',parseHTML:(element:HTMLElement)=>element.dataset.wikiLink??''}}),
  parseHTML:()=>[{tag:'span[data-wiki-link]'}],
  addInputRules(){return [nodeInputRule({find:/\[\[([^\]\n]+)\]\]$/u,type:this.type,getAttributes:match=>({title:match[1]!.trim()})})];},
  renderHTML:({node})=>['span',{'data-wiki-link':node.attrs.title,class:'reading-wiki-link',role:'link',tabindex:'0'},`[[${node.attrs.title}]]`],
  parseMarkdown:token=>({type:'wikiLink',attrs:{title:String(token.title ?? '')}}),
  renderMarkdown:node=>`[[${node.attrs?.title ?? ''}]]`,
  markdownTokenizer:{name:'wikiLink',level:'inline',start:src=>src.indexOf('[['),tokenize:src=>{
    const match=/^\[\[([^\]\n]+)\]\]/u.exec(src); return match ? {type:'wikiLink',raw:match[0],title:match[1]!.trim()} : undefined;
  }}
});
const actions: {label:string; run:(editor:Editor)=>void}[] = [
  {label:'正文',run:editor=>{editor.chain().focus().setParagraph().run();}},
  {label:'标题 1',run:editor=>{editor.chain().focus().toggleHeading({level:1}).run();}},
  {label:'标题 2',run:editor=>{editor.chain().focus().toggleHeading({level:2}).run();}},
  {label:'项目列表',run:editor=>{editor.chain().focus().toggleBulletList().run();}},
  {label:'有序列表',run:editor=>{editor.chain().focus().toggleOrderedList().run();}},
  {label:'引用',run:editor=>{editor.chain().focus().toggleBlockquote().run();}},
  {label:'代码 / 算法',run:editor=>{editor.chain().focus().toggleCodeBlock().run();}},
  {label:'表格',run:editor=>{editor.chain().focus().insertTable({rows:3,cols:3,withHeaderRow:true}).run();}},
  {label:'分隔线',run:editor=>{editor.chain().focus().setHorizontalRule().run();}}
];
export default function ReadingNoteEditor({markdown,editable,titles,onChange,onLink}: {
  markdown:string;editable:boolean;titles:string[];onChange:(markdown:string)=>void;onLink:(title:string)=>void;
}):React.JSX.Element {
  const [slash,setSlash]=useState(false),[source,setSource]=useState(false),[formula,setFormula]=useState('');
  const [mathPosition,setMathPosition]=useState<{pos:number;block:boolean}|null>(null);
  const formulaIme=useImeGuard();
  const editor=useEditor({extensions:[StarterKit.configure({link:{openOnClick:false}}),Markdown,WikiLink,TableKit,
    Placeholder.configure({placeholder:'写下问题、方法与发现。输入 / 插入内容，[[标题]] 链接笔记。'}),
    Mathematics.configure({katexOptions:{throwOnError:false,trust:false},
      inlineOptions:{onClick:(node,pos)=>{setFormula(String(node.attrs.latex));setMathPosition({pos,block:false});}},
      blockOptions:{onClick:(node,pos)=>{setFormula(String(node.attrs.latex));setMathPosition({pos,block:true});}}})],
    content:markdown,contentType:'markdown',editable,shouldRerenderOnTransaction:false,
    editorProps:{attributes:{'aria-label':'笔记正文',role:'textbox','aria-multiline':'true','data-testid':'notes-editor'},
      handleKeyDown:(_view,event)=>{
        if(event.isComposing)return false;
        if(event.key==='/' && _view.state.selection.$from.parentOffset===0){setSlash(true);return true;}
        if(event.key==='Escape'){setSlash(false);return false;}
        if(event.key==='Enter' && event.target instanceof HTMLElement){const target=event.target.closest<HTMLElement>('[data-wiki-link]');
          if(target){onLink(target.dataset.wikiLink!);return true;}}
        return false;
      },handleClick:(_view,_pos,event)=>{
        const target=(event.target as HTMLElement).closest<HTMLElement>('[data-wiki-link]');
        if(target){onLink(target.dataset.wikiLink!);return true;}return false;
      }},onUpdate:({editor})=>onChange(editor.getMarkdown())});
  useEffect(()=>{editor?.setEditable(editable&&!source);},[editor,editable,source]);
  if(!editor)return <p role="status">加载编辑器…</p>;
  return <div className="reading-editor flex min-h-0 flex-1 flex-col">
    <div className="reading-toolbar" role="toolbar" aria-label="笔记格式">
      <button type="button" disabled={!editable||source} onClick={()=>editor.chain().focus().toggleBold().run()} aria-label="粗体"><b>B</b></button>
      <button type="button" disabled={!editable||source} onClick={()=>editor.chain().focus().toggleItalic().run()} aria-label="斜体"><i>I</i></button>
      <button type="button" disabled={!editable||source} onClick={()=>setSlash(value=>!value)} aria-expanded={slash}>/ 插入</button>
      <select aria-label="插入笔记链接" disabled={!editable||source} value="" onChange={event=>{if(event.target.value)editor.chain().focus().insertContent({type:'wikiLink',attrs:{title:event.target.value}}).run();}}>
        <option value="">[[双链]]</option>{titles.map(title=><option key={title}>{title}</option>)}
      </select>
      <button type="button" onClick={()=>{if(source)editor.commands.setContent(markdown,{contentType:'markdown',emitUpdate:false});setSlash(false);setMathPosition(null);setSource(!source);}} aria-pressed={source}>Markdown 源码</button>
      <button type="button" disabled={!editable||source} aria-label="撤销" onClick={()=>editor.chain().focus().undo().run()}>撤销</button>
      <button type="button" disabled={!editable||source} aria-label="重做" onClick={()=>editor.chain().focus().redo().run()}>重做</button>
    </div>
    {slash&&!source?<div className="reading-toolbar" aria-label="插入块">{actions.map(action=><button type="button" key={action.label} disabled={!editable} onClick={()=>{action.run(editor);setSlash(false);}}>{action.label}</button>)}</div>:null}
    <form className="reading-toolbar" onCompositionStart={formulaIme.onCompositionStart} onCompositionEnd={formulaIme.onCompositionEnd}
      onKeyDown={event=>{if(event.key==='Enter'&&formulaIme.shouldIgnoreKeyDown(event))event.preventDefault();}}
      onSubmit={event=>{event.preventDefault();if(!editable||source||!formula.trim())return;
      if(mathPosition){editor.chain().focus().setNodeSelection(mathPosition.pos).updateAttributes(mathPosition.block?'blockMath':'inlineMath',{latex:formula}).run();}
      else editor.chain().focus().insertInlineMath({latex:formula}).run();setFormula('');setMathPosition(null);}}>
      <input aria-label="LaTeX 公式" placeholder="LaTeX 公式，如 E=mc^2" value={formula} disabled={!editable||source} onChange={event=>setFormula(event.target.value)}/>
      <button type="submit" disabled={!editable || source || !formula.trim()}>{mathPosition?'更新公式':'插入公式'}</button>
      <button type="button" disabled={!editable || source || !formula.trim()} onClick={()=>{editor.chain().focus().insertBlockMath({latex:formula}).run();setFormula('');}}>独立公式</button>
    </form>
    {source?<textarea className="min-h-0 flex-1 resize-none bg-surface p-4 font-mono text-ink" aria-label="Markdown 源码" value={markdown} readOnly={!editable}
      onChange={event=>onChange(event.target.value)}/>:<div className="min-h-0 flex-1 overflow-auto"><EditorContent editor={editor}/></div>}
  </div>;
}
