import React, { useState, useRef, useEffect, useMemo } from 'react';
import { ResearchPaper } from '../../types/research';
import { MathView } from '../MathView';
import { generateMinerUMarkdown, downloadMarkdownFile } from '../../utils/mineruParser';
import {
  FileText,
  ArrowLeft,
  Search,
  Type,
  FileCode,
  Table as TableIcon,
  Zap,
  Copy,
  Download,
  Check,
  Code2,
  Layers,
  Sparkles,
  Info
} from 'lucide-react';

interface PaperReaderViewProps {
  papers: ResearchPaper[];
  activePaperId: string;
  onSelectPaper: (paper: ResearchPaper) => void;
  onOpenRagWithPaper?: (paper: ResearchPaper) => void;
  onOpenImportModal?: () => void;
  initialViewMode?: 'list' | 'reading';
}

export const PaperReaderView: React.FC<PaperReaderViewProps> = ({
  papers,
  activePaperId,
  onSelectPaper,
  initialViewMode = 'list'
}) => {
  const [viewMode, setViewMode] = useState<'list' | 'reading'>(initialViewMode);
  const [fontSize, setFontSize] = useState<'normal' | 'large'>('normal');
  const [searchQuery, setSearchQuery] = useState('');

  const [readingSubTab, setReadingSubTab] = useState<'content' | 'markdown' | 'extracted_assets' | 'mineru_pipeline'>('content');
  const [copiedMarkdown, setCopiedMarkdown] = useState(false);
  const [copiedLatexIndex, setCopiedLatexIndex] = useState<number | null>(null);

  const contentScrollRef = useRef<HTMLDivElement>(null);

  const currentPaper = useMemo(() => {
    return papers.find((p) => p.id === activePaperId) || papers[0];
  }, [papers, activePaperId]);

  const markdownContent = useMemo(() => {
    if (!currentPaper) return '';
    if (currentPaper.mineruMetadata?.rawMarkdown) {
      return currentPaper.mineruMetadata.rawMarkdown;
    }
    return generateMinerUMarkdown(currentPaper);
  }, [currentPaper]);

  const allExtractedFormulas = useMemo(() => {
    if (!currentPaper) return [];
    const list: { name: string; latex: string; explanation?: string; sectionTitle?: string }[] = [];
    if (currentPaper.keyFormulas) {
      currentPaper.keyFormulas.forEach((f) => {
        list.push({ ...f, sectionTitle: '核心公式' });
      });
    }
    currentPaper.sections?.forEach((sec) => {
      sec.formulas?.forEach((f) => {
        list.push({ ...f, sectionTitle: sec.title });
      });
    });
    return list;
  }, [currentPaper]);

  const allExtractedTables = useMemo(() => {
    if (!currentPaper?.sections) return [];
    const list: { caption: string; headers: string[]; rows: string[][]; sectionTitle: string }[] = [];
    currentPaper.sections.forEach((sec) => {
      sec.tables?.forEach((t) => {
        list.push({ ...t, sectionTitle: sec.title });
      });
    });
    return list;
  }, [currentPaper]);

  const filteredPapers = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return papers;
    return papers.filter((p) => p.title.toLowerCase().includes(q));
  }, [papers, searchQuery]);

  const handleOpenFile = (paper: ResearchPaper) => {
    onSelectPaper(paper);
    setViewMode('reading');
    setReadingSubTab('content');
  };

  const handleCopyMarkdown = () => {
    if (!markdownContent) return;
    navigator.clipboard.writeText(markdownContent);
    setCopiedMarkdown(true);
    setTimeout(() => setCopiedMarkdown(false), 2000);
  };

  const handleDownloadMarkdown = () => {
    if (!currentPaper || !markdownContent) return;
    downloadMarkdownFile(currentPaper.title || 'paper_analysis', markdownContent);
  };

  const handleCopyLatex = (latex: string, index: number) => {
    navigator.clipboard.writeText(latex);
    setCopiedLatexIndex(index);
    setTimeout(() => setCopiedLatexIndex(null), 1800);
  };

  useEffect(() => {
    if (contentScrollRef.current) {
      contentScrollRef.current.scrollTop = 0;
    }
  }, [currentPaper?.id, viewMode, readingSubTab]);

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100 overflow-hidden select-text">
      {/* 1. LIST MODE */}
      {viewMode === 'list' && (
        <div className="flex-1 flex flex-col overflow-hidden bg-zinc-950">
          {/* Top Bar */}
          <div className="h-11 px-4 border-b border-zinc-800 bg-zinc-950 flex items-center justify-between shrink-0 select-none">
            <div className="flex items-center gap-2">
              <FileText size={15} className="text-sky-400" />
              <span className="font-semibold text-xs text-zinc-200">文献列表</span>
              <span className="text-[11px] text-zinc-500 font-mono">
                ({papers.length})
              </span>
            </div>

            <div className="relative w-56 max-w-xs">
              <Search size={13} className="absolute left-2.5 top-2 text-zinc-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索..."
                className="w-full pl-7 pr-3 py-1 text-xs bg-zinc-900 border border-zinc-800 focus:border-zinc-700 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none transition-all"
              />
            </div>
          </div>

          {/* Clean File Name List */}
          <div className="flex-1 overflow-y-auto px-4 py-4 md:px-8">
            <div className="max-w-4xl mx-auto space-y-1.5">
              {filteredPapers.length > 0 ? (
                filteredPapers.map((paper) => {
                  const hasMinerU = Boolean(paper.mineruMetadata);
                  return (
                    <div
                      key={paper.id}
                      onClick={() => handleOpenFile(paper)}
                      className="group bg-zinc-900/80 hover:bg-zinc-850 border border-zinc-800/80 hover:border-zinc-700 rounded-xl px-3.5 py-3 transition-all cursor-pointer flex items-center justify-between shadow-xs"
                    >
                      <div className="flex items-center gap-3 min-w-0 pr-4">
                        <div className="w-7 h-7 rounded-lg bg-zinc-800 border border-zinc-700 flex items-center justify-center shrink-0 text-sky-400">
                          <FileText size={14} />
                        </div>
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-medium text-xs text-zinc-200 group-hover:text-white transition-colors truncate">
                            {paper.title}
                          </span>
                          {hasMinerU && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-zinc-800 text-amber-300 border border-zinc-700 shrink-0">
                              <Zap size={9} />
                              MinerU
                            </span>
                          )}
                          <span className="text-[10px] font-mono text-zinc-500 shrink-0">
                            arXiv:{paper.arxivId}
                          </span>
                        </div>
                      </div>

                      <span className="text-[11px] text-zinc-500 group-hover:text-zinc-300 shrink-0 font-medium">
                        阅读 →
                      </span>
                    </div>
                  );
                })
              ) : (
                <div className="py-20 text-center text-zinc-500 text-xs space-y-2">
                  <FileText size={28} className="mx-auto text-zinc-600 mb-1" />
                  <p className="text-zinc-400 font-medium">{searchQuery ? '未匹配到相关文献' : '文献库暂无文献'}</p>
                  <p className="text-[11px] text-zinc-500">
                    {searchQuery ? '请尝试不同的搜索关键词' : '点击右上角「导入文献」添加 PDF、BibTeX 或 arXiv 论文'}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 2. READING MODE */}
      {viewMode === 'reading' && !currentPaper && (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-xs text-zinc-500 space-y-2">
          <p className="text-zinc-400 font-medium">未选中文献或文献库为空</p>
          <button
            onClick={() => setViewMode('list')}
            className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs transition-colors cursor-pointer"
          >
            返回文献列表
          </button>
        </div>
      )}

      {viewMode === 'reading' && currentPaper && (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Top Reading Navigation Bar */}
          <div className="h-11 px-3 border-b border-zinc-800 bg-zinc-950 flex items-center justify-between shrink-0 select-none overflow-x-auto no-scrollbar gap-2">
            {/* Back Button & File Name */}
            <div className="flex items-center gap-2 min-w-0 shrink">
              <button
                onClick={() => setViewMode('list')}
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-zinc-300 bg-zinc-900 hover:bg-zinc-850 border border-zinc-800 transition-colors shrink-0"
                title="返回文献列表"
              >
                <ArrowLeft size={13} />
                <span>返回</span>
              </button>

              <div className="flex items-center gap-1.5 truncate">
                <FileText size={13} className="text-sky-400 shrink-0" />
                <span className="font-medium text-xs text-zinc-200 truncate max-w-[200px] sm:max-w-xs md:max-w-md">
                  {currentPaper.title}
                </span>
              </div>
            </div>

            {/* Reading Mode Tabs & Controls */}
            <div className="flex items-center gap-1.5 shrink-0">
              <div className="flex items-center p-0.5 bg-zinc-900 border border-zinc-800 rounded-lg text-xs">
                <button
                  onClick={() => setReadingSubTab('content')}
                  className={`px-2.5 py-0.5 rounded-md transition-all font-medium whitespace-nowrap shrink-0 ${
                    readingSubTab === 'content'
                      ? 'bg-zinc-800 text-zinc-100 shadow-xs font-semibold'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  正文
                </button>
                <button
                  onClick={() => setReadingSubTab('markdown')}
                  className={`px-2.5 py-0.5 rounded-md transition-all font-medium flex items-center gap-1 whitespace-nowrap shrink-0 ${
                    readingSubTab === 'markdown'
                      ? 'bg-zinc-800 text-zinc-100 shadow-xs font-semibold'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  <Code2 size={11} />
                  <span>Markdown</span>
                </button>
                <button
                  onClick={() => setReadingSubTab('extracted_assets')}
                  className={`px-2.5 py-0.5 rounded-md transition-all font-medium flex items-center gap-1 whitespace-nowrap shrink-0 ${
                    readingSubTab === 'extracted_assets'
                      ? 'bg-zinc-800 text-zinc-100 shadow-xs font-semibold'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  <Layers size={11} />
                  <span>公式与表</span>
                </button>
                {currentPaper.mineruMetadata && (
                  <button
                    onClick={() => setReadingSubTab('mineru_pipeline')}
                    className={`px-2.5 py-0.5 rounded-md transition-all font-medium flex items-center gap-1 whitespace-nowrap shrink-0 ${
                      readingSubTab === 'mineru_pipeline'
                        ? 'bg-zinc-800 text-zinc-100 shadow-xs font-semibold'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    <Info size={11} />
                    <span>版面</span>
                  </button>
                )}
              </div>

              <button
                onClick={handleCopyMarkdown}
                title="复制 Markdown"
                className="px-2 py-1 bg-zinc-900 hover:bg-zinc-850 border border-zinc-800 text-zinc-300 rounded-lg text-xs font-medium flex items-center gap-1 transition-colors whitespace-nowrap shrink-0"
              >
                {copiedMarkdown ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                <span>{copiedMarkdown ? '已复制' : '复制'}</span>
              </button>

              <button
                onClick={handleDownloadMarkdown}
                title="导出并下载 Markdown"
                className="p-1 bg-zinc-900 hover:bg-zinc-850 border border-zinc-800 text-zinc-300 rounded-lg text-xs transition-colors shrink-0"
              >
                <Download size={13} />
              </button>

              <button
                onClick={() => setFontSize(fontSize === 'normal' ? 'large' : 'normal')}
                title="切换字号"
                className="px-2 py-1 bg-zinc-900 hover:bg-zinc-850 border border-zinc-800 text-zinc-300 rounded-lg text-xs font-medium flex items-center gap-1 transition-colors shrink-0"
              >
                <Type size={11} />
                <span>{fontSize === 'normal' ? '大号' : '标准'}</span>
              </button>
            </div>
          </div>

          {/* Main Content Viewport */}
          <div
            ref={contentScrollRef}
            className="flex-1 overflow-y-auto px-4 py-6 md:px-8 bg-zinc-950"
          >
            {/* SUB-VIEW 1: Standard Article Reader */}
            {readingSubTab === 'content' && (
              <div
                className={`max-w-4xl mx-auto bg-zinc-900/90 border border-zinc-800/90 rounded-xl shadow-xs p-5 md:p-10 space-y-6 text-zinc-200 ${
                  fontSize === 'large' ? 'text-base' : 'text-xs'
                }`}
              >
                {/* Title */}
                <div className="pb-4 border-b border-zinc-800">
                  <h1 className="text-lg md:text-xl font-bold text-zinc-100 leading-snug tracking-tight">
                    {currentPaper.title}
                  </h1>
                  <div className="mt-2 text-[11px] text-zinc-400 font-mono">
                    arXiv:{currentPaper.arxivId} · {currentPaper.year || 2025}
                  </div>
                </div>

                {/* Abstract Content */}
                {currentPaper.abstract && (
                  <div className="space-y-1.5">
                    <span className="font-semibold text-xs text-zinc-300 block">摘要 (Abstract)</span>
                    <div className="leading-relaxed text-zinc-300 bg-zinc-950/80 p-3.5 rounded-lg border border-zinc-800 whitespace-pre-wrap">
                      {currentPaper.abstract}
                    </div>
                  </div>
                )}

                {/* Sections & Paragraphs */}
                {currentPaper.sections && currentPaper.sections.length > 0 ? (
                  currentPaper.sections.map((section) => (
                    <div
                      key={section.id}
                      className="space-y-3 pt-4 border-t border-zinc-800/80"
                    >
                      <h2 className="text-sm md:text-base font-semibold text-zinc-100 tracking-tight">
                        {section.title}
                      </h2>

                      {section.content && (
                        <p className="leading-relaxed text-zinc-300 whitespace-pre-wrap">
                          {section.content}
                        </p>
                      )}

                      {section.paragraphs?.map((para, pIdx) => (
                        <p key={pIdx} className="leading-relaxed text-zinc-300">
                          {para}
                        </p>
                      ))}

                      {/* Formulas within section */}
                      {section.formulas && section.formulas.length > 0 && (
                        <div className="space-y-2.5 my-3">
                          {section.formulas.map((f, fIdx) => (
                            <div
                              key={fIdx}
                              className="p-3 bg-zinc-950 border border-zinc-800 rounded-lg space-y-2"
                            >
                              <div className="flex items-center justify-between text-xs font-medium text-amber-400">
                                <div className="flex items-center gap-1.5">
                                  <FileCode size={12} />
                                  <span>{f.name}</span>
                                </div>
                                <button
                                  onClick={() => handleCopyLatex(f.latex, fIdx)}
                                  className="text-[10px] text-zinc-400 hover:text-zinc-200 flex items-center gap-1 font-mono"
                                >
                                  {copiedLatexIndex === fIdx ? <Check size={10} className="text-emerald-400" /> : <Copy size={10} />}
                                  <span>{copiedLatexIndex === fIdx ? '已复制' : '复制 LaTeX'}</span>
                                </button>
                              </div>
                              <div className="py-2 overflow-x-auto text-center bg-zinc-900/60 rounded border border-zinc-800/80 p-2 text-zinc-100">
                                <MathView math={f.latex} displayMode={true} />
                              </div>
                              {f.explanation && (
                                <p className="text-[11px] text-zinc-400 leading-normal">
                                  {f.explanation}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Tables within section */}
                      {section.tables && section.tables.length > 0 && (
                        <div className="space-y-2.5 my-3">
                          {section.tables.map((tbl, tIdx) => (
                            <div key={tIdx} className="border border-zinc-800 rounded-lg overflow-hidden bg-zinc-950">
                              <div className="px-3 py-1.5 bg-zinc-900 border-b border-zinc-800 flex items-center gap-2 text-xs font-medium text-zinc-300">
                                <TableIcon size={12} className="text-sky-400" />
                                <span>{tbl.caption}</span>
                              </div>
                              <div className="overflow-x-auto">
                                <table className="w-full text-xs text-left">
                                  <thead className="bg-zinc-900/80 border-b border-zinc-800 text-zinc-400 uppercase font-mono">
                                    <tr>
                                      {tbl.headers.map((h, hIdx) => (
                                        <th key={hIdx} className="px-3 py-2 font-medium">{h}</th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-zinc-800 font-mono tabular-nums text-zinc-300">
                                    {tbl.rows.map((row, rIdx) => (
                                      <tr key={rIdx} className="hover:bg-zinc-900/60">
                                        {row.map((cell, cIdx) => (
                                          <td key={cIdx} className="px-3 py-2">{cell}</td>
                                        ))}
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))
                ) : (
                  <div className="space-y-3 pt-2">
                    <p className="leading-relaxed text-zinc-400 whitespace-pre-wrap">
                      {currentPaper.notes || '暂无进一步内容。'}
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* SUB-VIEW 2: Markdown */}
            {readingSubTab === 'markdown' && (
              <div className="max-w-4xl mx-auto space-y-3">
                <div className="bg-zinc-950 text-zinc-200 rounded-xl p-5 font-mono text-xs leading-relaxed border border-zinc-800 overflow-x-auto whitespace-pre-wrap">
                  {markdownContent}
                </div>
              </div>
            )}

            {/* SUB-VIEW 3: Extracted Formulas & Tables Gallery */}
            {readingSubTab === 'extracted_assets' && (
              <div className="max-w-4xl mx-auto space-y-5">
                <div className="space-y-2.5">
                  <h3 className="font-semibold text-xs text-zinc-200 flex items-center gap-2">
                    <Sparkles size={14} className="text-amber-400" />
                    <span>公式 ({allExtractedFormulas.length})</span>
                  </h3>

                  {allExtractedFormulas.length > 0 ? (
                    <div className="space-y-2">
                      {allExtractedFormulas.map((f, idx) => (
                        <div
                          key={idx}
                          className="bg-zinc-900 border border-zinc-800 rounded-xl p-3.5 space-y-2"
                        >
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-medium text-zinc-200">{f.name}</span>
                            <button
                              onClick={() => handleCopyLatex(f.latex, idx)}
                              className="text-xs font-mono px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors flex items-center gap-1"
                            >
                              {copiedLatexIndex === idx ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                              <span>{copiedLatexIndex === idx ? '已复制' : '复制'}</span>
                            </button>
                          </div>
                          <div className="py-2.5 px-2 bg-zinc-950 rounded-lg text-center overflow-x-auto border border-zinc-800 text-zinc-100">
                            <MathView math={f.latex} displayMode={true} />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="bg-zinc-900 p-8 rounded-xl border border-zinc-800 text-center text-zinc-500 text-xs">
                      未发现提取的数学公式
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* SUB-VIEW 4: MinerU Pipeline Details */}
            {readingSubTab === 'mineru_pipeline' && currentPaper.mineruMetadata && (
              <div className="max-w-4xl mx-auto space-y-3">
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
                  <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
                    <div className="flex items-center gap-2">
                      <Zap size={15} className="text-amber-400" />
                      <span className="font-semibold text-xs text-zinc-200">解析指标</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    <div className="p-2.5 bg-zinc-950 rounded-lg border border-zinc-800">
                      <div className="text-[11px] text-zinc-500">还原率</div>
                      <div className="text-base font-bold text-zinc-100 font-mono">{currentPaper.mineruMetadata.layoutScore}%</div>
                    </div>
                    <div className="p-2.5 bg-zinc-950 rounded-lg border border-zinc-800">
                      <div className="text-[11px] text-zinc-500">页数</div>
                      <div className="text-base font-bold text-zinc-100 font-mono">{currentPaper.mineruMetadata.pageCount}</div>
                    </div>
                    <div className="p-2.5 bg-zinc-950 rounded-lg border border-zinc-800">
                      <div className="text-[11px] text-zinc-500">公式数</div>
                      <div className="text-base font-bold text-amber-400 font-mono">{currentPaper.mineruMetadata.formulaCount}</div>
                    </div>
                    <div className="p-2.5 bg-zinc-950 rounded-lg border border-zinc-800">
                      <div className="text-[11px] text-zinc-500">表格数</div>
                      <div className="text-base font-bold text-sky-400 font-mono">{currentPaper.mineruMetadata.tableCount}</div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
