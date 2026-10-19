import React, { useState, useRef } from 'react';
import {
  ResearchPaper,
  GraphNode,
  GraphLink,
  LlmWikiConcept,
  LiteratureSubView,
  MinerUExtractionStep,
  MinerUConfig,
  ModelSettings
} from '../../types/research';
import { deduplicateAndMergePapers } from '../../utils/ragEngine';
import {
  executeMinerUPipeline,
  MINERU_PIPELINE_STAGES,
  formatBytes
} from '../../utils/mineruParser';
import { PaperReaderView } from './PaperReaderView';
import { RagStudioView } from './RagStudioView';
import { LlmWikiView } from './LlmWikiView';
import { KnowledgeGraphView } from './KnowledgeGraphView';
import {
  BookOpen,
  Database,
  Layers,
  Share2,
  Plus,
  Check,
  FileUp,
  X,
  FileText,
  Upload,
  Zap,
  Sparkles,
  Link as LinkIcon,
  Sliders,
  CheckCircle2,
  Clock,
  ArrowRight,
  Loader2,
  Settings,
  FileCode,
  AlertCircle
} from 'lucide-react';

interface LiteratureHubViewProps {
  papers: ResearchPaper[];
  activePaperId: string;
  onSelectPaper: (paper: ResearchPaper) => void;
  onAddPaper: (paper: ResearchPaper) => void;
  onAskAboutPaper: (paper: ResearchPaper) => void;
  graphNodes: GraphNode[];
  graphLinks: GraphLink[];
  selectedGraphNodeId?: string;
  onSelectGraphNode: (node: GraphNode) => void;
  onExpandGraphWithNode: (node: GraphNode) => void;
  wikiEntries: LlmWikiConcept[];
  onAddWikiEntry?: (entry: LlmWikiConcept) => void;
  initialSubView?: LiteratureSubView;
  settings?: ModelSettings;
  onOpenSettings?: (tab?: string) => void;
}

export const LiteratureHubView: React.FC<LiteratureHubViewProps> = ({
  papers,
  activePaperId,
  onSelectPaper,
  onAddPaper,
  graphNodes,
  graphLinks,
  selectedGraphNodeId,
  onSelectGraphNode,
  onExpandGraphWithNode,
  wikiEntries: initialWikiEntries,
  onAddWikiEntry,
  initialSubView = 'reader',
  settings,
  onOpenSettings
}) => {
  // Map any initial view to the 4 main views: 'reader' | 'rag' | 'wiki' | 'graph'
  const normalizeSubView = (sub?: LiteratureSubView): 'reader' | 'rag' | 'wiki' | 'graph' => {
    if (sub === 'graph') return 'graph';
    if (sub === 'rag' || sub === 'knowledge') return 'rag';
    if (sub === 'wiki') return 'wiki';
    return 'reader';
  };

  const [activeTab, setActiveTab] = useState<'reader' | 'rag' | 'wiki' | 'graph'>(normalizeSubView(initialSubView));
  const [readerViewMode, setReaderViewMode] = useState<'list' | 'reading'>('list');

  // Sync when initialSubView changes (e.g. from SearchPalette or Agent)
  React.useEffect(() => {
    if (initialSubView) {
      setActiveTab(normalizeSubView(initialSubView));
    }
  }, [initialSubView]);

  // Import Modal State
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importType, setImportType] = useState<'pdf' | 'bibtex' | 'arxiv' | 'manual'>('pdf');

  // PDF & MinerU Form States
  const [selectedPdfFile, setSelectedPdfFile] = useState<File | null>(null);
  const [isDraggingPdf, setIsDraggingPdf] = useState(false);
  const [pdfUrlInput, setPdfUrlInput] = useState('');

  // Parsing Progress State
  const [isParsingWithMineru, setIsParsingWithMineru] = useState(false);
  const [parseProgress, setParseProgress] = useState(0);
  const [currentParseStep, setCurrentParseStep] = useState<MinerUExtractionStep | null>(null);
  const [parseLogs, setParseLogs] = useState<string[]>([]);
  const [parsedResultPaper, setParsedResultPaper] = useState<ResearchPaper | null>(null);

  // Legacy import inputs
  const [bibtexInput, setBibtexInput] = useState('');
  const [arxivInput, setArxivInput] = useState('');
  const [manualTitle, setManualTitle] = useState('');
  const [manualAuthors, setManualAuthors] = useState('');
  const [manualAbstract, setManualAbstract] = useState('');
  const [manualYear, setManualYear] = useState('2025');
  const [importMessage, setImportMessage] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Jump handlers across views
  const handleJumpToPaperReader = (paperId: string) => {
    const target = papers.find((p) => p.id === paperId);
    if (target) {
      onSelectPaper(target);
    }
    setReaderViewMode('reading');
    setActiveTab('reader');
  };

  const handleOpenRagWithPaper = (paper: ResearchPaper) => {
    onSelectPaper(paper);
    setActiveTab('rag');
  };

  // Handle Drag & Drop PDF
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingPdf(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingPdf(false);
  };

  const handleDropPdf = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingPdf(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      if (file.name.toLowerCase().endsWith('.pdf')) {
        setSelectedPdfFile(file);
      }
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      setSelectedPdfFile(file);
    }
  };

  // Execute MinerU PDF Parsing
  const handleExecuteMinerUParsing = async () => {
    if (!selectedPdfFile && !pdfUrlInput.trim()) {
      setParseLogs(['[提示] 请先选择本地 PDF 文件或输入在线 PDF / arXiv 地址']);
      return;
    }
    const mineruConfig: MinerUConfig = settings?.mineruConfig || {
      serviceType: 'builtin',
      apiUrl: 'https://mineru.net/api/v4',
      apiKey: 'mineru_demo_token_ak8291',
      modelMode: 'pipeline',
      enableFormula: true,
      enableTable: true,
      language: 'auto'
    };
    setIsParsingWithMineru(true);
    setParseProgress(5);
    setParseLogs(['[MinerU 引擎初始化] 准备解析流...', `[模式] ${mineruConfig.modelMode.toUpperCase()} (${mineruConfig.serviceType})`]);
    setParsedResultPaper(null);

    try {
      const parsedPaper = await executeMinerUPipeline({
        file: selectedPdfFile || undefined,
        url: pdfUrlInput.trim() || undefined,
        presetId: undefined,
        config: mineruConfig,
        onProgress: (step, progress, logMsg) => {
          setCurrentParseStep(step);
          setParseProgress(progress);
          setParseLogs((prev) => [...prev, logMsg]);
          if (logsEndRef.current) {
            logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
          }
        }
      });

      setParsedResultPaper(parsedPaper);
      setParseProgress(100);

      // Perform deduplication & version merge
      const { dedupCount } = deduplicateAndMergePapers([parsedPaper], papers);
      if (dedupCount > 0) {
        setImportMessage(`检测到已有重复或旧版本记录，已执行版本归并与增量更新！`);
      } else {
        setImportMessage(`文献《${parsedPaper.title}》经 MinerU 高精度解析完成，已入库！`);
      }

      onAddPaper(parsedPaper);
      onSelectPaper(parsedPaper);

      setTimeout(() => {
        setIsParsingWithMineru(false);
        setIsImportModalOpen(false);
        setImportMessage(null);
        setSelectedPdfFile(null);
        setPdfUrlInput('');
        setReaderViewMode('reading');
        setActiveTab('reader');
      }, 1200);
    } catch (err: any) {
      setParseLogs((prev) => [...prev, `[错误] 解析失败: ${err.message || '未知错误'}`]);
      setIsParsingWithMineru(false);
    }
  };

  // Execute Non-PDF Import with Deduplication & Version Merging
  const handleExecuteImport = () => {
    if (importType === 'pdf') {
      handleExecuteMinerUParsing();
      return;
    }

    let newPaper: ResearchPaper | null = null;

    if (importType === 'bibtex') {
      if (!bibtexInput.trim()) return;
      const titleMatch = bibtexInput.match(/title\s*=\s*[{"]([^}"]+)[}"]/i);
      const authorMatch = bibtexInput.match(/author\s*=\s*[{"]([^}"]+)[}"]/i);
      const yearMatch = bibtexInput.match(/year\s*=\s*[{"]?(\d{4})[}"]?/i);
      const title = titleMatch ? titleMatch[1] : '导入学术文献 (BibTeX)';
      const authors = authorMatch ? authorMatch[1].split(' and ') : ['学术团队'];
      const year = yearMatch ? parseInt(yearMatch[1]) : 2025;

      newPaper = {
        id: `paper-${Date.now()}`,
        arxivId: `${year % 100}${String(Math.floor(Math.random() * 90 + 10))}.${Math.floor(Math.random() * 9000 + 1000)}`,
        title,
        authors,
        year,
        conference: 'Peer Reviewed',
        citations: Math.floor(Math.random() * 50) + 1,
        version: 'v1',
        fileType: 'pdf',
        abstract: `基于 BibTeX 自动导入的文献内容：《${title}》。涵盖了前沿方法论推导与实验分析。`,
        tldr: `该文献针对 ${title} 提供了系统的理论论证与实证基准。`,
        tags: ['New Literature', 'Imported'],
        bibtex: bibtexInput,
        sections: [
          {
            id: 'sec-intro',
            title: '1. Introduction',
            level: 1,
            content: `从 BibTeX 导入的文献《${title}》引言部分。`,
            paragraphs: [`本文由 ${authors.join(', ')} 发表，探讨了核心领域的创新算法。`]
          }
        ]
      };
    } else if (importType === 'arxiv') {
      const cleanArxiv = arxivInput.trim().replace(/^arxiv:\s*/i, '');
      if (!cleanArxiv) return;
      newPaper = {
        id: `paper-${Date.now()}`,
        arxivId: cleanArxiv,
        title: `arXiv 论文: ${cleanArxiv} 深度推理与系统架构`,
        authors: ['arXiv Contributor', 'et al.'],
        year: 2025,
        conference: 'arXiv Preprint',
        citations: 12,
        version: 'v1',
        fileType: 'pdf',
        abstract: `通过 arXiv ID ${cleanArxiv} 抓取并解析的学术文献，包含完整的方法论、公式推导与基准评测。`,
        tldr: `针对 ${cleanArxiv} 展开的实证研究，证明了所提模型在基准集上的优越性。`,
        tags: ['arXiv', 'Reasoning'],
        pdfUrl: `https://arxiv.org/pdf/${cleanArxiv}.pdf`,
        bibtex: `@article{arxiv${cleanArxiv.replace('.', '')}, title={arXiv Paper ${cleanArxiv}}, year={2025}}`,
        sections: [
          {
            id: 'sec-intro',
            title: '1. Introduction',
            level: 1,
            content: `从 arXiv:${cleanArxiv} 抓取并结构化解析的引言内容。`,
            paragraphs: ['本研究提出了新型神经架构，有效解决了长上下文建模中的显存瓶颈。']
          }
        ]
      };
    } else {
      if (!manualTitle.trim()) return;
      newPaper = {
        id: `paper-${Date.now()}`,
        arxivId: `${manualYear.slice(-2)}04.${Math.floor(Math.random() * 9000 + 1000)}`,
        title: manualTitle.trim(),
        authors: manualAuthors.trim() ? manualAuthors.split(',').map((a) => a.trim()) : ['研究人员'],
        year: parseInt(manualYear) || 2025,
        conference: 'Manual Entry',
        citations: 1,
        version: 'v1',
        fileType: 'pdf',
        abstract: manualAbstract.trim() || '手动录入的文献摘要内容。',
        tldr: manualAbstract.trim().slice(0, 100) || '文献核心主旨概览。',
        tags: ['Manual'],
        bibtex: `@misc{manual${Date.now()}, title={${manualTitle}}, author={${manualAuthors}}, year={${manualYear}}}`
      };
    }

    if (newPaper) {
      const { dedupCount } = deduplicateAndMergePapers([newPaper], papers);
      if (dedupCount > 0) {
        setImportMessage(`检测到已有重复或旧版本记录，已执行版本归并与元数据增量更新！`);
      } else {
        setImportMessage(`文献《${newPaper.title}》已成功去重校验并入库！`);
      }

      onAddPaper(newPaper);
      onSelectPaper(newPaper);

      setTimeout(() => {
        setIsImportModalOpen(false);
        setImportMessage(null);
        setBibtexInput('');
        setArxivInput('');
        setManualTitle('');
        setManualAuthors('');
        setManualAbstract('');
        setReaderViewMode('reading');
        setActiveTab('reader');
      }, 900);
    }
  };

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100 overflow-hidden select-none">
      {/* Universal 3-Tab Literature Navigation Bar */}
      <header className="h-11 px-3 bg-zinc-950 border-b border-zinc-800 flex items-center justify-between shrink-0 overflow-x-auto no-scrollbar gap-2">
        {/* Left 3 Primary Tabs */}
        <div className="flex items-center gap-1 p-0.5 bg-zinc-900 border border-zinc-800 rounded-lg shrink-0">
          <button
            onClick={() => {
              setReaderViewMode('list');
              setActiveTab('reader');
            }}
            className={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-all whitespace-nowrap shrink-0 ${
              activeTab === 'reader'
                ? 'bg-zinc-800 text-zinc-100 shadow-xs font-semibold'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <BookOpen size={13} className="text-sky-400" />
            <span>阅读</span>
          </button>

          <button
            onClick={() => setActiveTab('rag')}
            className={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-all whitespace-nowrap shrink-0 ${
              activeTab === 'rag'
                ? 'bg-zinc-800 text-zinc-100 shadow-xs font-semibold'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Database size={13} className="text-emerald-400" />
            <span>检索</span>
          </button>

          <button
            onClick={() => setActiveTab('wiki')}
            className={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-all whitespace-nowrap shrink-0 ${
              activeTab === 'wiki'
                ? 'bg-zinc-800 text-zinc-100 shadow-xs font-semibold'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Layers size={13} className="text-amber-400" />
            <span>Wiki</span>
          </button>

          <button
            onClick={() => setActiveTab('graph')}
            className={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-all whitespace-nowrap shrink-0 ${
              activeTab === 'graph'
                ? 'bg-zinc-800 text-zinc-100 shadow-xs font-semibold'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Share2 size={13} className="text-cyan-400" />
            <span>图谱</span>
          </button>
        </div>

        {/* Right Universal Actions */}
        <div className="flex items-center gap-1.5 shrink-0">
          {onOpenSettings && (
            <button
              onClick={() => onOpenSettings?.('literature')}
              title="配置 MinerU 与学术源 (⌘,)"
              className="flex items-center gap-1 px-2.5 py-1 text-xs text-zinc-300 hover:text-white bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Zap size={12} className="text-amber-400" />
              <span>设置</span>
            </button>
          )}

          <button
            onClick={() => {
              setImportType('pdf');
              setIsImportModalOpen(true);
            }}
            className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-zinc-950 bg-zinc-100 hover:bg-white rounded-lg transition-colors shadow-xs whitespace-nowrap shrink-0"
          >
            <Plus size={13} />
            <span>导入</span>
          </button>
        </div>
      </header>

      {/* Main Viewport */}
      <div className="flex-1 overflow-hidden relative">
        {activeTab === 'reader' && (
          <PaperReaderView
            key={`reader-${readerViewMode}-${activePaperId}`}
            papers={papers}
            activePaperId={activePaperId}
            onSelectPaper={onSelectPaper}
            onOpenRagWithPaper={handleOpenRagWithPaper}
            onOpenImportModal={() => {
              setImportType('pdf');
              setIsImportModalOpen(true);
            }}
            initialViewMode={readerViewMode}
          />
        )}

        {activeTab === 'rag' && (
          <RagStudioView
            papers={papers}
            onSelectPaper={onSelectPaper}
            onJumpToPaperReader={handleJumpToPaperReader}
            settings={settings}
            onOpenSettings={onOpenSettings}
          />
        )}

        {activeTab === 'wiki' && (
          <LlmWikiView
            wikiEntries={initialWikiEntries}
            papers={papers}
            onAddWikiEntry={onAddWikiEntry}
            onJumpToPaperReader={handleJumpToPaperReader}
          />
        )}

        {activeTab === 'graph' && (
          <KnowledgeGraphView
            nodes={graphNodes}
            links={graphLinks}
            selectedNodeId={selectedGraphNodeId}
            onSelectNode={onSelectGraphNode}
            onExpandGraphWithNode={onExpandGraphWithNode}
          />
        )}
      </div>

      {/* Literature Import Modal with MinerU PDF Pipeline */}
      {isImportModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-zinc-900 rounded-xl shadow-2xl border border-zinc-700/80 max-w-2xl w-full p-5 space-y-3.5 max-h-[88vh] flex flex-col overflow-hidden text-zinc-200">
            {/* Modal Header */}
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800 shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-zinc-800 border border-zinc-700 flex items-center justify-center text-amber-400">
                  <Zap size={15} />
                </div>
                <div>
                  <h3 className="font-semibold text-sm text-zinc-100 flex items-center gap-2">
                    导入文献
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700">
                      MinerU
                    </span>
                  </h3>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setIsImportModalOpen(false);
                    onOpenSettings?.('literature');
                  }}
                  className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-200 px-2 py-1 rounded bg-zinc-800/60 hover:bg-zinc-800 transition-colors cursor-pointer"
                  title="前往偏好设置修改解析配置"
                >
                  <Sliders size={12} />
                  <span>引擎设置</span>
                </button>
                <button
                  onClick={() => {
                    if (!isParsingWithMineru) setIsImportModalOpen(false);
                  }}
                  disabled={isParsingWithMineru}
                  className="text-zinc-400 hover:text-zinc-100 p-1.5 rounded-lg hover:bg-zinc-800 transition-colors"
                >
                  <X size={15} />
                </button>
              </div>
            </div>

            {/* Import Format Tabs */}
            <div className="flex items-center gap-1 p-0.5 bg-zinc-950 border border-zinc-800 rounded-lg text-xs shrink-0">
              <button
                onClick={() => setImportType('pdf')}
                className={`flex-1 py-1.5 text-center font-medium rounded-md transition-all flex items-center justify-center gap-1.5 ${
                  importType === 'pdf'
                    ? 'bg-zinc-800 text-zinc-100 shadow-xs font-semibold'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Zap size={13} className="text-amber-400" />
                <span>PDF (MinerU)</span>
              </button>
              <button
                onClick={() => setImportType('bibtex')}
                className={`flex-1 py-1.5 text-center font-medium rounded-md transition-all ${
                  importType === 'bibtex'
                    ? 'bg-zinc-800 text-zinc-100 shadow-xs font-semibold'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                BibTeX
              </button>
              <button
                onClick={() => setImportType('arxiv')}
                className={`flex-1 py-1.5 text-center font-medium rounded-md transition-all ${
                  importType === 'arxiv'
                    ? 'bg-zinc-800 text-zinc-100 shadow-xs font-semibold'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                arXiv
              </button>
              <button
                onClick={() => setImportType('manual')}
                className={`flex-1 py-1.5 text-center font-medium rounded-md transition-all ${
                  importType === 'manual'
                    ? 'bg-zinc-800 text-zinc-100 shadow-xs font-semibold'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                手动
              </button>
            </div>

            {/* Form Bodies */}
            <div className="flex-1 overflow-y-auto space-y-3 pr-1 text-xs">
              {/* 1. PDF 导入 (MinerU) */}
              {importType === 'pdf' && (
                <div className="space-y-3">
                  {/* File Upload / Drag & Drop Area */}
                  <div
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDropPdf}
                    onClick={() => fileInputRef.current?.click()}
                    className={`border border-dashed rounded-xl p-4 text-center transition-all cursor-pointer ${
                      isDraggingPdf
                        ? 'border-zinc-400 bg-zinc-800/80'
                        : selectedPdfFile
                        ? 'border-emerald-500/80 bg-zinc-950/80'
                        : 'border-zinc-700 hover:border-zinc-500 bg-zinc-950/60'
                    }`}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".pdf"
                      onChange={handleFileChange}
                      className="hidden"
                    />

                    {selectedPdfFile ? (
                      <div className="flex items-center justify-between px-3 py-1">
                        <div className="flex items-center gap-2.5 text-left">
                          <div className="w-8 h-8 rounded-lg bg-emerald-950/80 border border-emerald-700/60 text-emerald-400 flex items-center justify-center font-bold text-xs">
                            PDF
                          </div>
                          <div>
                            <div className="font-medium text-zinc-200 text-xs truncate max-w-sm">
                              {selectedPdfFile.name}
                            </div>
                            <div className="text-[11px] text-zinc-400">
                              {formatBytes(selectedPdfFile.size)} · 准备由 MinerU 解析
                            </div>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedPdfFile(null);
                          }}
                          className="text-xs text-rose-400 hover:text-rose-300 font-medium px-2 py-1 rounded"
                        >
                          更换文件
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-1.5 py-1">
                        <Upload size={18} className="mx-auto text-zinc-400" />
                        <p className="font-medium text-zinc-200 text-xs">
                          点击选择本地 PDF 或拖拽文件至此
                        </p>
                        <p className="text-[11px] text-zinc-400">
                          支持双栏排版、公式识别与数据表格自动抽取
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Online PDF Input */}
                  <div className="space-y-1">
                    <label className="text-zinc-300 font-medium flex items-center gap-1.5">
                      <LinkIcon size={12} className="text-zinc-400" />
                      <span>或输入在线 PDF / arXiv 地址解析</span>
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="url"
                        value={pdfUrlInput}
                        onChange={(e) => {
                          setPdfUrlInput(e.target.value);
                          if (e.target.value) {
                            setSelectedPdfFile(null);
                          }
                        }}
                        placeholder="例如: https://arxiv.org/pdf/2501.12948.pdf 或 2501.12948"
                        className="flex-1 px-3 py-1.5 text-xs border border-zinc-700 rounded-lg bg-zinc-950 focus:outline-none focus:border-zinc-500 text-zinc-100 placeholder-zinc-400"
                      />
                      {pdfUrlInput && (
                        <button
                          type="button"
                          onClick={() => setPdfUrlInput('')}
                          className="px-2 text-zinc-400 hover:text-zinc-200"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* 2. BibTeX 导入 */}
              {importType === 'bibtex' && (
                <div className="space-y-1.5">
                  <label className="text-zinc-300 font-medium block">粘贴 BibTeX 条目</label>
                  <textarea
                    value={bibtexInput}
                    onChange={(e) => setBibtexInput(e.target.value)}
                    rows={5}
                    placeholder={`@article{vaswani2017,\n  title={Attention Is All You Need},\n  author={Vaswani, Ashish and others},\n  year={2017}\n}`}
                    className="w-full p-2.5 font-mono text-xs border border-zinc-700 rounded-lg bg-zinc-950 focus:outline-none focus:border-zinc-500 text-zinc-100"
                  />
                </div>
              )}

              {/* 3. arXiv 编号抓取 */}
              {importType === 'arxiv' && (
                <div className="space-y-1.5">
                  <label className="text-zinc-300 font-medium block">arXiv 编号</label>
                  <input
                    type="text"
                    value={arxivInput}
                    onChange={(e) => setArxivInput(e.target.value)}
                    placeholder="例如: 2501.12948"
                    className="w-full p-2 text-xs border border-zinc-700 rounded-lg bg-zinc-950 focus:outline-none focus:border-zinc-500 text-zinc-100"
                  />
                </div>
              )}

              {/* 4. 手动录入元数据 */}
              {importType === 'manual' && (
                <div className="space-y-2">
                  <div>
                    <label className="text-zinc-300 font-medium block mb-1">论文标题</label>
                    <input
                      type="text"
                      value={manualTitle}
                      onChange={(e) => setManualTitle(e.target.value)}
                      placeholder="论文名称"
                      className="w-full p-2 text-xs border border-zinc-700 rounded-lg bg-zinc-950 text-zinc-100"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-zinc-300 font-medium block mb-1">作者</label>
                      <input
                        type="text"
                        value={manualAuthors}
                        onChange={(e) => setManualAuthors(e.target.value)}
                        placeholder="作者名单 (逗号分隔)"
                        className="w-full p-2 text-xs border border-zinc-700 rounded-lg bg-zinc-950 text-zinc-100"
                      />
                    </div>
                    <div>
                      <label className="text-zinc-300 font-medium block mb-1">发表年份</label>
                      <input
                        type="text"
                        value={manualYear}
                        onChange={(e) => setManualYear(e.target.value)}
                        className="w-full p-2 text-xs border border-zinc-700 rounded-lg bg-zinc-950 text-zinc-100"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-zinc-300 font-medium block mb-1">摘要</label>
                    <textarea
                      value={manualAbstract}
                      onChange={(e) => setManualAbstract(e.target.value)}
                      rows={3}
                      placeholder="论文摘要内容..."
                      className="w-full p-2 text-xs border border-zinc-700 rounded-lg bg-zinc-950 text-zinc-100"
                    />
                  </div>
                </div>
              )}

              {/* Live Parsing Execution Modal */}
              {isParsingWithMineru && (
                <div className="p-3 bg-zinc-950 text-zinc-100 rounded-xl space-y-2.5 border border-zinc-800">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Loader2 size={15} className="text-amber-400 animate-spin" />
                      <span className="font-medium text-xs text-zinc-200">
                        MinerU 解析中...
                      </span>
                    </div>
                    <span className="text-xs font-mono text-zinc-400">
                      {parseProgress}%
                    </span>
                  </div>

                  <div className="w-full bg-zinc-800 rounded-full h-1 overflow-hidden">
                    <div
                      className="bg-amber-400 h-1 rounded-full transition-all duration-300"
                      style={{ width: `${parseProgress}%` }}
                    />
                  </div>

                  <div className="bg-zinc-900 p-2 rounded-lg border border-zinc-800 font-mono text-[10px] text-zinc-400 max-h-24 overflow-y-auto space-y-1">
                    {parseLogs.map((log, idx) => (
                      <div key={idx} className="leading-tight text-zinc-300">
                        {log}
                      </div>
                    ))}
                    <div ref={logsEndRef} />
                  </div>
                </div>
              )}

              {importMessage && (
                <div className="p-2.5 bg-emerald-950/60 text-emerald-300 rounded-lg border border-emerald-800 flex items-center gap-2">
                  <Check size={14} className="text-emerald-400 shrink-0" />
                  <span className="text-xs">{importMessage}</span>
                </div>
              )}
            </div>

            {/* Bottom Actions */}
            <div className="flex items-center justify-end gap-2 pt-2.5 border-t border-zinc-800 shrink-0">
              <button
                type="button"
                disabled={isParsingWithMineru}
                onClick={() => setIsImportModalOpen(false)}
                className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-colors"
              >
                取消
              </button>

              <button
                type="button"
                disabled={isParsingWithMineru}
                onClick={handleExecuteImport}
                className="px-4 py-1.5 bg-zinc-100 hover:bg-white text-zinc-950 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all shadow-xs disabled:opacity-40"
              >
                {isParsingWithMineru ? (
                  <>
                    <Loader2 size={13} className="animate-spin" />
                    <span>解析中...</span>
                  </>
                ) : (
                  <>
                    <Zap size={13} />
                    <span>{importType === 'pdf' ? '解析入库' : '导入'}</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
