import React, { useState, useRef } from 'react';
import { MathView } from '../MathView';
import { ResizableDivider } from '../ResizableDivider';
import {
  Play,
  Copy,
  Check,
  FileText
} from 'lucide-react';

import { ModelSettings } from '../../types/research';

interface LatexEditorViewProps {
  initialCode: string;
  onCodeChange: (code: string) => void;
  onAskAgentToEdit?: (prompt: string) => void;
  settings?: ModelSettings;
  onOpenSettings?: (tab?: string) => void;
  fileName?: string;
}

export const LatexEditorView: React.FC<LatexEditorViewProps> = ({
  initialCode,
  onCodeChange,
  settings,
  onOpenSettings,
  fileName
}) => {
  const [code, setCode] = useState(initialCode);
  const [isCompiling, setIsCompiling] = useState(false);
  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState<'split' | 'editor' | 'preview'>('split');
  const [editorWidthPercent, setEditorWidthPercent] = useState<number>(50);
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    setCode(initialCode);
  }, [initialCode]);

  const handleEditorResize = (deltaPx: number) => {
    if (!containerRef.current) return;
    const totalWidth = containerRef.current.clientWidth;
    if (totalWidth <= 0) return;
    const deltaPercent = (deltaPx / totalWidth) * 100;
    setEditorWidthPercent((prev) => Math.max(22, Math.min(78, prev + deltaPercent)));
  };

  const handleRecompile = () => {
    setIsCompiling(true);
    setTimeout(() => {
      setIsCompiling(false);
    }, 450);
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setCode(e.target.value);
    onCodeChange(e.target.value);
  };

  const handleCopyCode = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleInsertTemplate = () => {
    const template = `\\documentclass[11pt,twocolumn]{article}
\\usepackage{amsmath,amssymb,amsfonts}
\\usepackage{graphicx}
\\usepackage{booktabs}

\\title{学术研究论文标题}
\\author{Research Scholar \\\\ Institute of Frontier Studies}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
在此撰写论文摘要，概括核心研究背景、提出方法与实证结论。
\\end{abstract}

\\section{Introduction (引言)}
在此撰写引言背景与研究贡献。

\\section{Methodology (方法设计)}
形式化问题定义与理论推导：
\\begin{equation}
\\mathcal{L}(\\theta) = \\mathbb{E}_{x \\sim \\mathcal{D}} \\left[ \\| f_\\theta(x) - y \\|^2 \\right]
\\end{equation}

\\section{Conclusion (结论)}
在此阐明工作总结与未来展望。

\\end{document}`;
    setCode(template);
    onCodeChange(template);
  };

  // Dynamic LaTeX document parsing for real-time rendered preview
  const parsedDoc = React.useMemo(() => {
    if (!code || !code.trim()) return null;

    const titleMatch = code.match(/\\title\{([^}]+)\}/i);
    const authorMatch = code.match(/\\author\{([^}]+)\}/i);
    const abstractMatch = code.match(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/i);

    // Clean title
    const rawTitle = titleMatch ? titleMatch[1].replace(/\\textbf\{([^}]+)\}/g, '$1') : '';
    // Clean author
    const rawAuthor = authorMatch ? authorMatch[1].replace(/\\\\/g, '\n').replace(/\\textit\{([^}]+)\}/g, '$1') : '';
    const rawAbstract = abstractMatch ? abstractMatch[1].trim() : '';

    // Extract sections
    const sectionRegex = /\\section\*?\{([^}]+)\}([\s\S]*?)(?=(\\section\*?\{|\\end\{document\}|$))/gi;
    const sections: { title: string; body: string }[] = [];
    let match;
    while ((match = sectionRegex.exec(code)) !== null) {
      sections.push({
        title: match[1].trim(),
        body: match[2].trim()
      });
    }

    return {
      title: rawTitle,
      author: rawAuthor,
      abstract: rawAbstract,
      sections
    };
  }, [code]);

  const displayFileName = fileName || 'paper.tex';

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100 overflow-hidden">
      {/* Top Toolbar */}
      <div className="h-10 border-b border-zinc-800 bg-zinc-950 px-3 flex items-center justify-between text-xs shrink-0 select-none overflow-x-auto no-scrollbar gap-2">
        <div className="flex items-center gap-2 shrink-0">
          <FileText size={14} className="text-amber-400" />
          <span className="font-semibold text-zinc-200">{displayFileName}</span>
          <span className="text-[11px] text-zinc-500 font-mono hidden sm:inline">
            {settings?.sandboxConfig?.latexEngine || 'Tectonic'}
          </span>
          <button
            type="button"
            onClick={() => onOpenSettings?.('sandbox')}
            className="text-[10px] text-zinc-500 hover:text-zinc-300 font-mono underline ml-0.5 cursor-pointer"
            title="前往偏好设置修改 LaTeX 编译引擎 (⌘,)"
          >
            设置
          </button>
          <span className="text-[10px] font-mono text-emerald-400 bg-emerald-950/50 border border-emerald-800/60 px-1.5 py-0.5 rounded flex items-center gap-1">
            <span>●</span>
            <span>正常</span>
          </span>
        </div>

        {/* Action Controls & View Options */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* View mode toggle */}
          <div className="flex items-center bg-zinc-900 p-0.5 rounded-lg text-[11px] border border-zinc-800">
            <button
              onClick={() => setViewMode('split')}
              className={`px-2 py-0.5 rounded-md font-medium transition-all cursor-pointer ${
                viewMode === 'split' ? 'bg-zinc-800 text-zinc-100 font-semibold' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              分屏
            </button>
            <button
              onClick={() => setViewMode('editor')}
              className={`px-2 py-0.5 rounded-md font-medium transition-all cursor-pointer ${
                viewMode === 'editor' ? 'bg-zinc-800 text-zinc-100 font-semibold' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              源码
            </button>
            <button
              onClick={() => setViewMode('preview')}
              className={`px-2 py-0.5 rounded-md font-medium transition-all cursor-pointer ${
                viewMode === 'preview' ? 'bg-zinc-800 text-zinc-100 font-semibold' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              预览
            </button>
          </div>

          <button
            onClick={handleRecompile}
            disabled={isCompiling}
            title="编译"
            className="px-2.5 py-1 bg-zinc-100 hover:bg-white disabled:opacity-40 text-zinc-950 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-xs cursor-pointer"
          >
            <Play size={11} className={isCompiling ? 'animate-spin' : ''} />
            <span>{isCompiling ? '编译中' : '编译'}</span>
          </button>

          <button
            onClick={handleCopyCode}
            title="复制源码"
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900 transition-colors cursor-pointer"
          >
            {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
          </button>
        </div>
      </div>

      {/* Main Split Body */}
      <div ref={containerRef} className={`flex-1 flex overflow-hidden min-w-0 ${isDraggingSplit ? 'select-none' : ''}`}>
        {/* Left: Code Editor */}
        {(viewMode === 'split' || viewMode === 'editor') && (
          <div
            style={viewMode === 'split' ? { width: `${editorWidthPercent}%` } : undefined}
            className={`${viewMode === 'split' ? 'shrink-0' : 'flex-1'} flex flex-col border-r border-zinc-800 bg-zinc-950 overflow-hidden min-w-[200px]`}
          >
            <div className="flex-1 relative">
              <textarea
                value={code}
                onChange={handleTextChange}
                spellCheck={false}
                placeholder="在此输入 LaTeX 源码，或点击右侧插入基础模板..."
                style={{ fontSize: `${settings?.editorFontSize || 13}px` }}
                className="w-full h-full bg-zinc-950 p-4 font-mono text-zinc-200 leading-relaxed resize-none focus:outline-none selection:bg-zinc-800 placeholder-zinc-600"
              />
            </div>
          </div>
        )}

        {/* Draggable Divider */}
        {viewMode === 'split' && (
          <ResizableDivider
            onDeltaChange={handleEditorResize}
            onDoubleClickReset={() => setEditorWidthPercent(50)}
            isDragging={isDraggingSplit}
            onDragStart={() => setIsDraggingSplit(true)}
            onDragEnd={() => setIsDraggingSplit(false)}
          />
        )}

        {/* Right: Rendered Academic PDF Preview */}
        {(viewMode === 'split' || viewMode === 'preview') && (
          <div className="flex-1 bg-zinc-900/60 overflow-y-auto p-4 sm:p-6 flex justify-center min-w-[200px]">
            {parsedDoc && (parsedDoc.title || parsedDoc.sections.length > 0 || parsedDoc.abstract) ? (
              /* High-Contrast Academic Paper Sheet */
              <div className="w-full max-w-[640px] min-h-[850px] bg-white text-slate-900 shadow-xl rounded-xs p-6 sm:p-8 font-serif select-text text-[11px] leading-relaxed border border-zinc-400/30 overflow-hidden">
                {/* Paper Title */}
                {parsedDoc.title && (
                  <div className="text-center space-y-2 mb-4">
                    <h1 className="text-base font-bold font-serif tracking-tight text-slate-900">
                      {parsedDoc.title}
                    </h1>
                    {parsedDoc.author && (
                      <div className="text-[10px] text-slate-600 whitespace-pre-line">
                        {parsedDoc.author}
                      </div>
                    )}
                  </div>
                )}

                {/* Abstract */}
                {parsedDoc.abstract && (
                  <div className="bg-slate-50 p-3.5 rounded-sm mb-4 text-[10px] italic border border-slate-200 leading-normal text-slate-800">
                    <span className="font-bold not-italic font-sans text-[11px] block mb-1 text-slate-900">
                      Abstract
                    </span>
                    {parsedDoc.abstract}
                  </div>
                )}

                {/* Sections */}
                {parsedDoc.sections.map((sec, idx) => {
                  // Render equations inside section body
                  const eqMatch = sec.body.match(/\\begin\{equation\}([\s\S]*?)\\end\{equation\}/);
                  const cleanBody = sec.body.replace(/\\begin\{equation\}[\s\S]*?\\end\{equation\}/g, '').trim();

                  return (
                    <div key={idx} className="space-y-2 mb-4">
                      <h2 className="text-xs font-bold font-serif text-slate-900 uppercase tracking-wide border-b border-slate-200 pb-0.5">
                        {sec.title}
                      </h2>
                      {cleanBody && (
                        <p className="text-justify text-slate-800 whitespace-pre-line leading-relaxed">
                          {cleanBody}
                        </p>
                      )}
                      {eqMatch && (
                        <div className="my-2 p-2 bg-slate-50 rounded border border-slate-200 text-center text-slate-900">
                          <MathView math={eqMatch[1].trim()} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              /* Clean Empty State */
              <div className="w-full max-w-[640px] min-h-[480px] bg-zinc-900/40 border border-zinc-800/80 rounded-xl flex flex-col items-center justify-center p-8 text-center space-y-3">
                <FileText size={32} className="text-zinc-600" />
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold text-zinc-300">暂无编译内容</h3>
                  <p className="text-xs text-zinc-500 max-w-sm leading-relaxed">
                    在左侧编辑器中输入 LaTeX 源码，或点击下方按钮插入基础论文模板以开始实时预览排版。
                  </p>
                </div>
                <button
                  onClick={handleInsertTemplate}
                  className="px-3.5 py-1.5 bg-zinc-100 hover:bg-white text-zinc-950 text-xs font-semibold rounded-lg transition-colors shadow-xs cursor-pointer"
                >
                  插入基础 LaTeX 模板
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
