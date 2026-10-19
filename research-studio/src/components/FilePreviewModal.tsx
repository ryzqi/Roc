import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { VirtualFile } from '../types/research';
import { MathView } from './MathView';
import {
  FileText,
  FileCode,
  BookOpen,
  FileSpreadsheet,
  File,
  Copy,
  Check,
  ExternalLink,
  Save,
  Edit3,
  Eye,
  Search,
  ChevronLeft,
  ChevronRight,
  X,
  Code2
} from 'lucide-react';

interface FilePreviewModalProps {
  file: VirtualFile | null;
  files: VirtualFile[];
  isOpen: boolean;
  onClose: () => void;
  onOpenInEditor?: (file: VirtualFile) => void;
  onSaveContent?: (path: string, content: string) => void;
  onSelectFile?: (file: VirtualFile) => void;
}

export const FilePreviewModal: React.FC<FilePreviewModalProps> = ({
  file,
  files,
  isOpen,
  onClose,
  onOpenInEditor,
  onSaveContent,
  onSelectFile
}) => {
  const [content, setContent] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'source' | 'rendered'>('source');
  const [isSaved, setIsSaved] = useState(true);

  const lines = useMemo(() => content.split('\n'), [content]);

  useEffect(() => {
    if (file) {
      setContent(file.content || '');
      setIsSaved(true);
      setIsEditing(false);
      setSearchQuery('');
      if (file.type === 'md') {
        setActiveTab('rendered');
      } else {
        setActiveTab('source');
      }
    }
  }, [file]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !file) return null;

  const currentIndex = files.findIndex((f) => f.path === file.path);
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < files.length - 1 && currentIndex !== -1;

  const handlePrev = () => {
    if (hasPrev && onSelectFile) {
      onSelectFile(files[currentIndex - 1]);
    }
  };

  const handleNext = () => {
    if (hasNext && onSelectFile) {
      onSelectFile(files[currentIndex + 1]);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSave = () => {
    if (onSaveContent) {
      onSaveContent(file.path, content);
      setIsSaved(true);
    }
  };

  const lineCount = lines.length;
  const charCount = content.length;
  const estimatedSize = (charCount / 1024).toFixed(1);

  const getFileIcon = (type: VirtualFile['type']) => {
    switch (type) {
      case 'tex':
        return <FileText size={15} className="text-amber-400 shrink-0" />;
      case 'py':
        return <FileCode size={15} className="text-sky-400 shrink-0" />;
      case 'bib':
        return <BookOpen size={15} className="text-purple-400 shrink-0" />;
      case 'json':
        return <FileSpreadsheet size={15} className="text-emerald-400 shrink-0" />;
      case 'md':
        return <FileText size={15} className="text-teal-400 shrink-0" />;
      default:
        return <File size={15} className="text-zinc-400 shrink-0" />;
    }
  };

  const getFileTypeName = (type: VirtualFile['type']) => {
    switch (type) {
      case 'tex':
        return 'LaTeX';
      case 'py':
        return 'Python';
      case 'bib':
        return 'BibTeX';
      case 'json':
        return 'JSON';
      case 'md':
        return 'Markdown';
      default:
        return '文本';
    }
  };

  const renderLatexPreview = () => {
    const titleMatch = content.match(/\\title\{([^}]+)\}/);
    const abstractMatch = content.match(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/);
    const sections = content.split(/\\section\{([^}]+)\}/);

    return (
      <div className="max-w-3xl mx-auto p-6 md:p-8 space-y-5 bg-zinc-900 rounded-xl border border-zinc-800 text-zinc-100 font-serif">
        <div className="text-center pb-5 border-b border-zinc-800">
          <span className="text-[10px] font-mono tracking-widest text-zinc-500 uppercase">
            IEEE TRANSACTIONS TEMPLATE PREVIEW
          </span>
          <h1 className="text-xl md:text-2xl font-bold text-zinc-100 mt-2 leading-snug">
            {titleMatch ? titleMatch[1] : file.name}
          </h1>
          <p className="text-xs text-zinc-400 mt-1.5 font-sans">
            Research Team · Institute of AI Systems · Automated Preview
          </p>
        </div>

        {abstractMatch && (
          <div className="bg-zinc-950 p-3.5 rounded-lg border border-zinc-800 text-xs leading-relaxed font-sans text-zinc-300">
            <span className="font-bold text-zinc-100 mr-2">ABSTRACT:</span>
            {abstractMatch[1].trim()}
          </div>
        )}

        <div className="space-y-4 text-xs md:text-sm leading-relaxed font-sans text-zinc-300">
          {sections.map((sec, idx) => {
            if (idx === 0) return null;
            if (idx % 2 === 1) {
              return (
                <h2
                  key={idx}
                  className="text-sm md:text-base font-semibold text-zinc-100 pt-3 border-t border-zinc-800 flex items-center gap-2"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                  <span>{sec}</span>
                </h2>
              );
            }
            const cleanContent = sec
              .replace(/\\begin\{equation\}[\s\S]*?\\end\{equation\}/g, '[Formula Equation]')
              .replace(/\\begin\{table\}[\s\S]*?\\end\{table\}/g, '[Data Table]')
              .replace(/\\end\{document\}/g, '')
              .trim();

            return (
              <div key={idx} className="space-y-2.5 text-zinc-300">
                <p className="whitespace-pre-wrap">{cleanContent.slice(0, 500)}</p>
                {sec.includes('\\mathcal{L}') && (
                  <div className="my-2.5 py-2.5 px-3 bg-zinc-950 rounded-lg border border-zinc-800 text-center font-mono">
                    <MathView
                      math="\mathcal{L}_{\text{distill}}(\theta) = \alpha \mathcal{L}_{\text{NLL}}(y; \theta) + (1-\alpha) \mathcal{D}_{\text{KL}}(\mathcal{S}_\theta(y|x) \parallel \mathcal{T}(y|x))"
                      displayMode={true}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const renderMarkdownPreview = () => {
    return (
      <div className="max-w-3xl mx-auto p-5 md:p-8 space-y-4 bg-zinc-900 rounded-xl border border-zinc-800 font-sans text-zinc-200 text-xs md:text-sm leading-relaxed">
        {content.split('\n\n').map((block, idx) => {
          if (block.startsWith('# ')) {
            return (
              <h1 key={idx} className="text-lg md:text-xl font-bold text-zinc-100 pb-2 border-b border-zinc-800">
                {block.replace('# ', '')}
              </h1>
            );
          }
          if (block.startsWith('## ')) {
            return (
              <h2 key={idx} className="text-sm md:text-base font-semibold text-zinc-100 pt-2">
                {block.replace('## ', '')}
              </h2>
            );
          }
          if (block.startsWith('### ')) {
            return (
              <h3 key={idx} className="text-xs md:text-sm font-semibold text-zinc-200">
                {block.replace('### ', '')}
              </h3>
            );
          }
          if (block.startsWith('- ') || block.startsWith('* ')) {
            return (
              <ul key={idx} className="list-disc pl-5 space-y-1 text-zinc-300">
                {block.split('\n').map((item, i) => (
                  <li key={i}>{item.replace(/^[-*]\s+/, '')}</li>
                ))}
              </ul>
            );
          }
          if (block.startsWith('```')) {
            const codeLines = block.split('\n').slice(1, -1).join('\n');
            return (
              <pre
                key={idx}
                className="p-3 bg-zinc-950 text-zinc-200 rounded-lg text-xs font-mono overflow-x-auto border border-zinc-800"
              >
                <code>{codeLines}</code>
              </pre>
            );
          }
          return (
            <p key={idx} className="text-zinc-300">
              {block}
            </p>
          );
        })}
      </div>
    );
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      onClick={onClose}
      className="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-6 bg-black/60 backdrop-blur-sm select-none animate-in fade-in duration-150"
    >
      <div
        className="bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-800 w-full max-w-5xl h-[88vh] flex flex-col overflow-hidden select-text text-zinc-100"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Window Bar */}
        <header className="h-11 px-3 sm:px-4 border-b border-zinc-800 bg-zinc-900 flex items-center justify-between shrink-0 select-none overflow-x-auto no-scrollbar gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            {/* macOS Dot indicators */}
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={onClose}
                className="w-3 h-3 rounded-full bg-rose-500 hover:bg-rose-600 transition-colors cursor-pointer"
                title="关闭预览 (Esc)"
              />
              <button
                onClick={handlePrev}
                disabled={!hasPrev}
                className="w-3 h-3 rounded-full bg-amber-400 hover:bg-amber-500 disabled:opacity-30 transition-colors cursor-pointer"
                title="上一个文件"
              />
              <button
                onClick={handleNext}
                disabled={!hasNext}
                className="w-3 h-3 rounded-full bg-emerald-500 hover:bg-emerald-600 disabled:opacity-30 transition-colors cursor-pointer"
                title="下一个文件"
              />
            </div>

            <div className="h-4 w-px bg-zinc-800 shrink-0" />

            {/* File Path & Type Info */}
            <div className="flex items-center gap-2 min-w-0">
              {getFileIcon(file.type)}
              <span className="font-semibold text-xs text-zinc-200 truncate font-mono">
                {file.path}
              </span>
              <span className="hidden sm:inline-block text-[11px] text-zinc-500 font-sans">
                ({getFileTypeName(file.type)})
              </span>
              {!isSaved && (
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" title="未保存更改" />
              )}
            </div>
          </div>

          {/* Right Action Buttons */}
          <div className="flex items-center gap-1.5 shrink-0">
            {/* Search Input toggle */}
            <div className="relative hidden md:block">
              <Search size={12} className="absolute left-2.5 top-2 text-zinc-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="在文件中检索..."
                className="w-36 lg:w-44 pl-7 pr-2.5 py-1 text-xs bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-700 transition-colors"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-2 text-zinc-500 hover:text-zinc-300"
                >
                  <X size={11} />
                </button>
              )}
            </div>

            {/* View Mode Switcher */}
            {(file.type === 'tex' || file.type === 'md') && (
              <div className="flex items-center bg-zinc-950 border border-zinc-800 p-0.5 rounded-lg text-xs font-sans">
                <button
                  onClick={() => setActiveTab('source')}
                  className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors ${
                    activeTab === 'source'
                      ? 'bg-zinc-800 text-zinc-100 font-semibold shadow-xs'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  <Code2 size={11} />
                  <span>源码</span>
                </button>
                <button
                  onClick={() => setActiveTab('rendered')}
                  className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors ${
                    activeTab === 'rendered'
                      ? 'bg-zinc-800 text-zinc-100 font-semibold shadow-xs'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  <Eye size={11} />
                  <span>渲染</span>
                </button>
              </div>
            )}

            {/* Edit / Read-Only Toggle */}
            <button
              onClick={() => setIsEditing(!isEditing)}
              className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium border transition-colors ${
                isEditing
                  ? 'bg-amber-950/60 text-amber-300 border-amber-800/80'
                  : 'bg-zinc-950 hover:bg-zinc-850 text-zinc-300 border-zinc-800'
              }`}
              title={isEditing ? '退出编辑模式' : '进入编辑模式'}
            >
              <Edit3 size={11} />
              <span className="hidden sm:inline">{isEditing ? '编辑中' : '编辑'}</span>
            </button>

            {/* Save Button */}
            {isEditing && (
              <button
                onClick={handleSave}
                disabled={isSaved}
                className="flex items-center gap-1 px-2.5 py-1 bg-zinc-100 hover:bg-white disabled:bg-zinc-700 text-zinc-950 rounded-lg text-xs font-semibold transition-colors shadow-xs cursor-pointer"
                title="保存文件内容"
              >
                <Save size={11} />
                <span>保存</span>
              </button>
            )}

            {/* Copy Button */}
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium bg-zinc-950 hover:bg-zinc-850 text-zinc-300 border border-zinc-800 transition-colors cursor-pointer"
              title="复制代码"
            >
              {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
              <span className="hidden sm:inline">{copied ? '已复制' : '复制'}</span>
            </button>

            {/* Open in Editor CTA */}
            {onOpenInEditor && (
              <button
                onClick={() => {
                  onOpenInEditor(file);
                  onClose();
                }}
                className="flex items-center gap-1 px-2.5 py-1 bg-zinc-100 hover:bg-white text-zinc-950 rounded-lg text-xs font-semibold transition-colors shadow-xs cursor-pointer"
                title="打开"
              >
                <ExternalLink size={11} />
                <span className="hidden sm:inline">打开</span>
              </button>
            )}

            {/* Close Cross */}
            <button
              onClick={onClose}
              className="p-1 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors ml-0.5 cursor-pointer"
              title="关闭"
            >
              <X size={14} />
            </button>
          </div>
        </header>

        {/* Content View Area */}
        <div className="flex-1 overflow-hidden flex bg-zinc-950 font-mono text-xs">
          {activeTab === 'rendered' && (file.type === 'tex' || file.type === 'md') ? (
            <div className="flex-1 overflow-y-auto p-4 md:p-6 bg-zinc-950 font-sans">
              {file.type === 'tex' ? renderLatexPreview() : renderMarkdownPreview()}
            </div>
          ) : (
            <div className="flex-1 flex overflow-hidden">
              {/* Line Numbers Column */}
              <div className="w-10 py-3 bg-zinc-950 text-zinc-600 text-right pr-2.5 select-none border-r border-zinc-850 font-mono text-xs shrink-0 overflow-hidden">
                {lines.map((_, idx) => (
                  <div key={idx} className="leading-relaxed">
                    {idx + 1}
                  </div>
                ))}
              </div>

              {/* Code Editor Area */}
              <div className="flex-1 relative overflow-auto p-3 bg-zinc-950">
                {isEditing ? (
                  <textarea
                    value={content}
                    onChange={(e) => {
                      setContent(e.target.value);
                      setIsSaved(false);
                    }}
                    className="w-full h-full p-0 font-mono text-xs leading-relaxed text-zinc-200 bg-transparent border-none outline-none resize-none"
                    spellCheck={false}
                    autoFocus
                  />
                ) : (
                  <div className="leading-relaxed whitespace-pre font-mono text-xs text-zinc-300">
                    {lines.map((line, idx) => {
                      const isHighlighted =
                        searchQuery.trim() &&
                        line.toLowerCase().includes(searchQuery.toLowerCase());

                      return (
                        <div
                          key={idx}
                          className={`${
                            isHighlighted ? 'bg-amber-950/70 text-amber-200 px-1 rounded' : ''
                          }`}
                        >
                          {line || '\n'}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Bottom Status Footer */}
        <footer className="h-8 px-4 border-t border-zinc-800 bg-zinc-900 flex items-center justify-between text-[11px] text-zinc-500 shrink-0 select-none font-sans">
          <div className="flex items-center gap-2 sm:gap-3 truncate">
            <span className="truncate">{file.path}</span>
            <span>·</span>
            <span className="shrink-0">{lineCount} 行</span>
            <span>·</span>
            <span className="shrink-0">{charCount} 字符</span>
            <span>·</span>
            <span className="shrink-0">{estimatedSize} KB</span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handlePrev}
              disabled={!hasPrev}
              className="flex items-center gap-1 text-zinc-400 hover:text-zinc-200 disabled:opacity-30 cursor-pointer"
            >
              <ChevronLeft size={11} />
              <span className="hidden sm:inline">上一文件</span>
            </button>
            <span>/</span>
            <button
              onClick={handleNext}
              disabled={!hasNext}
              className="flex items-center gap-1 text-zinc-400 hover:text-zinc-200 disabled:opacity-30 cursor-pointer"
            >
              <span className="hidden sm:inline">下一文件</span>
              <ChevronRight size={11} />
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body
  );
};
