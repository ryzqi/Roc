import React, { useState, useMemo, useRef } from 'react';
import { LlmWikiConcept, ResearchPaper, WikiClaimCard } from '../../types/research';
import { MathView } from '../MathView';
import {
  Layers,
  Search,
  Plus,
  BookOpen,
  Link2,
  Copy,
  Check,
  ArrowRight,
  X,
  Sparkles,
  GitBranch,
  ShieldCheck,
  FileText
} from 'lucide-react';

interface LlmWikiViewProps {
  wikiEntries: LlmWikiConcept[];
  papers: ResearchPaper[];
  onAddWikiEntry?: (entry: LlmWikiConcept) => void;
  onJumpToPaperReader?: (paperId: string) => void;
}

export const LlmWikiView: React.FC<LlmWikiViewProps> = ({
  wikiEntries,
  papers,
  onAddWikiEntry,
  onJumpToPaperReader
}) => {
  const [selectedConceptId, setSelectedConceptId] = useState<string>(
    wikiEntries[0]?.id || 'grpo-optimization'
  );
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedSuccess, setCopiedSuccess] = useState(false);

  // Concept Extractor Modal state
  const [isExtractorModalOpen, setIsExtractorModalOpen] = useState(false);
  const [extractPaperId, setExtractPaperId] = useState<string>(papers[0]?.id || '');
  const [newTitle, setNewTitle] = useState('');
  const [newCategory, setNewCategory] = useState<LlmWikiConcept['category']>('algorithm');
  const [newSummary, setNewSummary] = useState('');
  const [newLatex, setNewLatex] = useState('');
  const [newExplanation, setNewExplanation] = useState('');
  const [newClaim, setNewClaim] = useState('');

  const detailScrollRef = useRef<HTMLDivElement>(null);

  // Active Concept
  const currentConcept = useMemo(
    () => wikiEntries.find((w) => w.id === selectedConceptId) || wikiEntries[0],
    [wikiEntries, selectedConceptId]
  );

  // Dynamic Backlinks Calculation
  const conceptBacklinksMap = useMemo(() => {
    const map = new Map<string, { conceptId: string; conceptTitle: string }[]>();

    wikiEntries.forEach((entry) => {
      const linkMatches = entry.content.match(/\[\[(.*?)\]\]/g) || [];
      linkMatches.forEach((match) => {
        const rawTarget = match.replace(/\[\[|\]\]/g, '').trim();
        const targetEntry = wikiEntries.find(
          (e) =>
            e.title.toLowerCase().includes(rawTarget.toLowerCase()) ||
            e.id.toLowerCase() === rawTarget.toLowerCase() ||
            rawTarget.toLowerCase().includes(e.id.toLowerCase())
        );

        if (targetEntry && targetEntry.id !== entry.id) {
          const existing = map.get(targetEntry.id) || [];
          if (!existing.some((x) => x.conceptId === entry.id)) {
            existing.push({ conceptId: entry.id, conceptTitle: entry.title });
            map.set(targetEntry.id, existing);
          }
        }
      });
    });

    return map;
  }, [wikiEntries]);

  // Categories filter list
  const categories = [
    { id: 'all', label: '全部' },
    { id: 'theory', label: '理论' },
    { id: 'architecture', label: '架构' },
    { id: 'algorithm', label: '算法' },
    { id: 'benchmark', label: '评测' },
    { id: 'metric', label: '指标' }
  ];

  // Filtered concepts
  const filteredConcepts = useMemo(() => {
    return wikiEntries.filter((c) => {
      if (selectedCategory !== 'all' && c.category !== selectedCategory) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchTitle = c.title.toLowerCase().includes(q);
        const matchSummary = c.summary.toLowerCase().includes(q);
        const matchContent = c.content.toLowerCase().includes(q);
        return matchTitle || matchSummary || matchContent;
      }
      return true;
    });
  }, [wikiEntries, selectedCategory, searchQuery]);

  const handleSelectConcept = (conceptId: string) => {
    setSelectedConceptId(conceptId);
    if (detailScrollRef.current) {
      detailScrollRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const handleWikiLinkClick = (rawTarget: string) => {
    const cleanTarget = rawTarget.trim();
    const matched = wikiEntries.find(
      (e) =>
        e.title.toLowerCase().includes(cleanTarget.toLowerCase()) ||
        cleanTarget.toLowerCase().includes(e.title.toLowerCase()) ||
        e.id.toLowerCase() === cleanTarget.toLowerCase()
    );

    if (matched) {
      handleSelectConcept(matched.id);
    }
  };

  const handleCopyMarkdown = () => {
    if (!currentConcept) return;
    const md = `# ${currentConcept.title}
分类: ${currentConcept.category}
核心主旨: ${currentConcept.summary}

## 形式化定义
${currentConcept.formalDefinition?.latex ? `$$${currentConcept.formalDefinition.latex}$$` : ''}
${currentConcept.formalDefinition?.explanation || ''}

## 核心解析
${currentConcept.content}
`;
    navigator.clipboard.writeText(md);
    setCopiedSuccess(true);
    setTimeout(() => setCopiedSuccess(false), 2000);
  };

  const handleSaveExtractedConcept = () => {
    if (!newTitle.trim()) return;

    const sourcePaper = papers.find((p) => p.id === extractPaperId);
    const newId = newTitle.toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, '-');

    const createdClaims: WikiClaimCard[] = [];
    if (newClaim.trim() && sourcePaper) {
      createdClaims.push({
        id: `claim-${Date.now()}`,
        claim: newClaim.trim(),
        sourcePaperTitle: sourcePaper.title,
        paperId: sourcePaper.id,
        arxivId: sourcePaper.arxivId,
        excerpt: sourcePaper.abstract.slice(0, 160),
        stance: 'empirical_verified',
        confidence: 0.95
      });
    }

    const newEntry: LlmWikiConcept = {
      id: newId,
      title: newTitle.trim(),
      category: newCategory,
      summary: newSummary.trim() || `${newTitle} 的学术概念与形式化解析。`,
      formalDefinition: newLatex.trim()
        ? {
            latex: newLatex.trim(),
            explanation: newExplanation.trim() || '形式化数学表述与参数说明。'
          }
        : undefined,
      content: `### 1. 理论机制\n${newSummary || newTitle} 是长思维链强化学习与模型能力演进中的关键概念。\n\n### 2. 关联技术演进\n在关于 [[DeepSeek-R1]] 与 [[GRPO (Group Relative Policy Optimization)]] 的研究中发挥了重要作用。`,
      evolutionTimeline: sourcePaper
        ? [
            {
              year: sourcePaper.year,
              paperTitle: sourcePaper.title,
              milestone: `在文献《${sourcePaper.title}》中系统提出或重点应用。`
            }
          ]
        : [],
      claimCards: createdClaims,
      comparativeMatrix: [],
      backlinks: [],
      relatedConcepts: ['grpo-optimization', 'self-attention'],
      paperIds: sourcePaper ? [sourcePaper.id] : []
    };

    if (onAddWikiEntry) {
      onAddWikiEntry(newEntry);
    }
    setSelectedConceptId(newEntry.id);
    setIsExtractorModalOpen(false);

    setNewTitle('');
    setNewSummary('');
    setNewLatex('');
    setNewExplanation('');
    setNewClaim('');
  };

  const renderContentWithWikiLinks = (text: string) => {
    const parts = text.split(/(\[\[.*?\]\])/g);
    return parts.map((part, index) => {
      const match = part.match(/^\[\[(.*?)\]\]$/);
      if (match) {
        const linkTarget = match[1];
        return (
          <button
            key={index}
            onClick={() => handleWikiLinkClick(linkTarget)}
            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 mx-0.5 text-sky-400 hover:text-white bg-sky-950/80 hover:bg-sky-850 border border-sky-850 rounded font-medium transition-colors"
            title={`点击跳转至词条: ${linkTarget}`}
          >
            <Link2 size={10} className="text-sky-400" />
            <span>{linkTarget}</span>
          </button>
        );
      }
      return <span key={index}>{part}</span>;
    });
  };

  const currentBacklinks = useMemo(() => {
    if (!currentConcept) return [];
    const calculated = conceptBacklinksMap.get(currentConcept.id) || [];
    const staticLinks = currentConcept.backlinks || [];
    const merged = [...calculated];
    staticLinks.forEach((sl) => {
      if (!merged.some((m) => m.conceptId === sl.conceptId)) {
        merged.push(sl);
      }
    });
    return merged;
  }, [currentConcept, conceptBacklinksMap]);

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100 select-none overflow-hidden">
      {/* 1. Header & Filter Bar */}
      <header className="h-11 px-3 bg-zinc-950 border-b border-zinc-800 flex items-center justify-between shrink-0 overflow-x-auto no-scrollbar gap-2">
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="flex items-center gap-1.5 font-semibold text-xs text-zinc-200">
            <Layers size={14} className="text-amber-400" />
            <span>Wiki</span>
          </div>
          <span className="text-zinc-800">|</span>

          {/* Category Filter Buttons */}
          <div className="flex items-center p-0.5 bg-zinc-900 border border-zinc-800 rounded-lg text-xs">
            {categories.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setSelectedCategory(cat.id)}
                className={`px-2 py-0.5 rounded-md transition-all font-medium whitespace-nowrap shrink-0 text-xs ${
                  selectedCategory === cat.id
                    ? 'bg-zinc-800 text-zinc-100 font-semibold shadow-xs'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>
        </div>

        {/* Right Search & Action */}
        <div className="flex items-center gap-1.5 shrink-0">
          <div className="relative w-36 sm:w-48">
            <Search size={12} className="absolute left-2.5 top-2 text-zinc-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索..."
              className="w-full pl-7 pr-2.5 py-1 text-xs bg-zinc-900 border border-zinc-800 rounded-lg focus:outline-none focus:border-zinc-700 text-zinc-200 placeholder-zinc-500"
            />
          </div>

          <button
            onClick={() => setIsExtractorModalOpen(true)}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-zinc-950 bg-zinc-100 hover:bg-white rounded-lg transition-colors shadow-xs shrink-0 whitespace-nowrap"
          >
            <Plus size={12} />
            <span>提取</span>
          </button>
        </div>
      </header>

      {/* 2. Knowledge Stream Layout */}
      <div className="flex-1 flex overflow-hidden min-w-0">
        {/* Left: Concept Stream Directory */}
        <aside className="w-72 sm:w-80 min-w-[240px] max-w-[360px] bg-zinc-950 border-r border-zinc-800 flex flex-col h-full shrink-0">
          <div className="p-2.5 border-b border-zinc-800 flex items-center justify-between text-xs text-zinc-400 shrink-0">
            <span className="font-semibold text-zinc-300">目录</span>
            <span className="font-mono tabular-nums text-[11px] text-zinc-500">{filteredConcepts.length} 项</span>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            {filteredConcepts.length === 0 ? (
              <div className="py-16 text-center text-xs text-zinc-500 space-y-2">
                <Layers size={22} className="mx-auto text-zinc-600 mb-1" />
                <p className="text-zinc-400 font-medium">{wikiEntries.length === 0 ? '暂无 Wiki 概念词条' : '无匹配词条'}</p>
                <p className="text-[11px] text-zinc-500">
                  {wikiEntries.length === 0 ? '点击右上角「提取」或导入文献生成学术词条' : '请尝试更换搜索词'}
                </p>
              </div>
            ) : (
              filteredConcepts.map((concept) => {
                const isSelected = concept.id === selectedConceptId;
                const backlinksCount = (conceptBacklinksMap.get(concept.id) || []).length;
                const papersCount = concept.paperIds?.length || 1;

                return (
                  <button
                    key={concept.id}
                    onClick={() => handleSelectConcept(concept.id)}
                    className={`w-full text-left p-2.5 rounded-xl transition-all border ${
                      isSelected
                        ? 'bg-zinc-800/90 border-zinc-700 shadow-xs'
                        : 'bg-zinc-900/50 hover:bg-zinc-900 border-zinc-800/60'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span
                        className={`text-xs truncate ${
                          isSelected ? 'text-zinc-100 font-semibold' : 'text-zinc-300'
                        }`}
                      >
                        {concept.title}
                      </span>
                      <span className="text-[10px] text-zinc-500 uppercase font-mono shrink-0 ml-1">
                        {concept.category}
                      </span>
                    </div>

                    <p className="text-[11px] text-zinc-400 line-clamp-2 leading-relaxed mb-1.5 font-sans">
                      {concept.summary}
                    </p>

                    <div className="flex items-center gap-2 text-[10px] text-zinc-500 font-mono">
                      <span>🔗 {backlinksCount} 引用</span>
                      <span aria-hidden="true">·</span>
                      <span>📄 {papersCount} 文献</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        {/* Right: Concept Deep Inspection */}
        <main
          ref={detailScrollRef}
          className="flex-1 bg-zinc-950 overflow-y-auto p-4 sm:p-6 space-y-5 select-text min-w-0"
        >
          {currentConcept ? (
            <div className="max-w-4xl mx-auto space-y-5">
              {/* Concept Header Card */}
              <section className="bg-zinc-900/80 rounded-xl border border-zinc-800/90 p-4 sm:p-5 shadow-xs space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-base sm:text-lg font-bold text-zinc-100 tracking-tight truncate">
                      {currentConcept.title}
                    </h2>
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-400 mt-1 font-mono">
                      <span className="uppercase text-amber-400 font-semibold">
                        {currentConcept.category}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{currentConcept.paperIds?.length || 1} 篇支撑文献</span>
                      <span aria-hidden="true">·</span>
                      <span>{currentBacklinks.length} 处反向引用</span>
                    </div>
                  </div>

                  <button
                    onClick={handleCopyMarkdown}
                    className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-zinc-300 hover:text-white bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg transition-colors shrink-0"
                  >
                    {copiedSuccess ? (
                      <>
                        <Check size={11} className="text-emerald-400" />
                        <span className="text-emerald-400">已复制</span>
                      </>
                    ) : (
                      <>
                        <Copy size={11} />
                        <span>复制</span>
                      </>
                    )}
                  </button>
                </div>

                {/* Summary / TL;DR */}
                <div className="text-xs text-zinc-300 bg-zinc-950/80 p-3 rounded-lg border border-zinc-800 leading-relaxed font-sans">
                  <span className="font-semibold text-zinc-200">主旨：</span>
                  {currentConcept.summary}
                </div>

                {/* Formal Definition & LaTeX Math */}
                {currentConcept.formalDefinition?.latex && (
                  <div className="pt-2 border-t border-zinc-800/80 space-y-2">
                    <div className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
                      <Sparkles size={12} className="text-amber-400" />
                      <span>数学定义</span>
                    </div>

                    <div className="py-2.5 px-3 bg-zinc-950 text-zinc-100 rounded-lg text-center overflow-x-auto border border-zinc-800">
                      <MathView math={currentConcept.formalDefinition.latex} displayMode={true} />
                    </div>

                    {currentConcept.formalDefinition.explanation && (
                      <p className="text-xs text-zinc-400 leading-relaxed">
                        {currentConcept.formalDefinition.explanation}
                      </p>
                    )}
                  </div>
                )}
              </section>

              {/* Body Article with Interactive [[WikiLinks]] */}
              <section className="bg-zinc-900/80 rounded-xl border border-zinc-800/90 p-4 sm:p-5 shadow-xs space-y-3">
                <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
                  <span className="text-xs font-semibold text-zinc-200">
                    机制解析
                  </span>
                </div>

                <div className="text-xs text-zinc-300 leading-relaxed space-y-3 font-sans">
                  {currentConcept.content.split('\n\n').map((paragraph, pIdx) => {
                    if (paragraph.startsWith('### ')) {
                      return (
                        <h4 key={pIdx} className="font-semibold text-xs sm:text-sm text-zinc-100 pt-1">
                          {paragraph.replace('### ', '')}
                        </h4>
                      );
                    }
                    if (paragraph.startsWith('$$') && paragraph.endsWith('$$')) {
                      return (
                        <div key={pIdx} className="my-2 py-2 px-3 bg-zinc-950 rounded border border-zinc-800 text-center text-zinc-100">
                          <MathView math={paragraph.replace(/\$\$/g, '')} displayMode={true} />
                        </div>
                      );
                    }
                    return (
                      <p key={pIdx} className="whitespace-pre-line leading-relaxed">
                        {renderContentWithWikiLinks(paragraph)}
                      </p>
                    );
                  })}
                </div>
              </section>

              {/* Backlinks Network */}
              <section className="bg-zinc-900/80 rounded-xl border border-zinc-800/90 p-4 sm:p-5 shadow-xs space-y-3">
                <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
                    <GitBranch size={13} className="text-sky-400" />
                    <span>反向链接</span>
                  </div>
                  <span className="text-[11px] font-mono text-zinc-500 tabular-nums">
                    {currentBacklinks.length} 个来源
                  </span>
                </div>

                {currentBacklinks.length === 0 ? (
                  <p className="text-xs text-zinc-500 py-1">当前词条尚未被其他概念直接引用</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {currentBacklinks.map((link) => (
                      <button
                        key={link.conceptId}
                        onClick={() => handleSelectConcept(link.conceptId)}
                        className="flex items-center gap-1.5 px-2.5 py-1 bg-zinc-950 hover:bg-zinc-850 border border-zinc-800 hover:border-zinc-700 rounded-lg text-xs font-medium text-zinc-300 hover:text-white transition-colors"
                      >
                        <Link2 size={11} className="text-sky-400" />
                        <span>{link.conceptTitle}</span>
                        <ArrowRight size={10} className="text-zinc-500" />
                      </button>
                    ))}
                  </div>
                )}
              </section>

              {/* Claim Cards */}
              {currentConcept.claimCards && currentConcept.claimCards.length > 0 && (
                <section className="bg-zinc-900/80 rounded-xl border border-zinc-800/90 p-4 sm:p-5 shadow-xs space-y-3">
                  <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
                      <ShieldCheck size={13} className="text-emerald-400" />
                      <span>实证论断</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                    {currentConcept.claimCards.map((claim) => (
                      <div
                        key={claim.id}
                        className="bg-zinc-950 border border-zinc-800 rounded-xl p-3 space-y-2 text-xs"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-zinc-200 leading-snug">
                            {claim.claim}
                          </span>
                          <span className="font-mono text-[10px] text-emerald-400 font-semibold shrink-0 ml-2">
                            置信度 {Math.round(claim.confidence * 100)}%
                          </span>
                        </div>

                        <div className="text-[11px] text-zinc-400 italic bg-zinc-900/60 p-2 rounded-lg border border-zinc-850 leading-relaxed font-sans">
                          "{claim.excerpt}"
                        </div>

                        <div className="flex items-center justify-between pt-1 text-[11px] text-zinc-500">
                          <span className="truncate max-w-[180px] font-medium text-zinc-400">
                            {claim.sourcePaperTitle}
                          </span>
                          {onJumpToPaperReader && claim.paperId && (
                            <button
                              onClick={() => onJumpToPaperReader(claim.paperId)}
                              className="text-sky-400 hover:text-sky-300 flex items-center gap-0.5 transition-colors"
                            >
                              <span>查看原文</span>
                              <ArrowRight size={10} />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Comparative Matrix */}
              {currentConcept.comparativeMatrix && currentConcept.comparativeMatrix.length > 0 && (
                <section className="bg-zinc-900/80 rounded-xl border border-zinc-800/90 p-4 sm:p-5 shadow-xs space-y-3">
                  <div className="text-xs font-semibold text-zinc-200 pb-2 border-b border-zinc-800">
                    跨模型对比矩阵
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-xs text-left">
                      <thead>
                        <tr className="border-b border-zinc-800 text-zinc-400 font-mono text-[11px]">
                          <th className="py-2 px-3">对比维度</th>
                          {currentConcept.comparativeMatrix[0].comparisons.map((c, idx) => (
                            <th key={idx} className="py-2 px-3 font-semibold text-zinc-300">
                              {c.paper}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-800/80">
                        {currentConcept.comparativeMatrix.map((row, rIdx) => (
                          <tr key={rIdx} className="hover:bg-zinc-850/50">
                            <td className="py-2 px-3 font-medium text-zinc-300">
                              {row.aspect}
                            </td>
                            {row.comparisons.map((c, cIdx) => (
                              <td key={cIdx} className="py-2 px-3 text-zinc-400">
                                {c.value}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              {/* Source Literature & Evolution Timeline */}
              <section className="bg-zinc-900/80 rounded-xl border border-zinc-800/90 p-4 sm:p-5 shadow-xs space-y-3">
                <div className="text-xs font-semibold text-zinc-200 pb-2 border-b border-zinc-800 flex items-center justify-between">
                  <span>演进脉络</span>
                  <span className="text-[11px] text-zinc-500 font-mono">
                    {currentConcept.evolutionTimeline?.length || 0} 个里程碑
                  </span>
                </div>

                {/* Timeline */}
                {currentConcept.evolutionTimeline && currentConcept.evolutionTimeline.length > 0 && (
                  <div className="space-y-2.5 pl-2 border-l-2 border-zinc-800 ml-1">
                    {currentConcept.evolutionTimeline.map((item, idx) => (
                      <div key={idx} className="relative pl-3 text-xs space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold text-zinc-200 text-[11px]">
                            {item.year}
                          </span>
                          <span className="font-semibold text-zinc-300">
                            {item.paperTitle}
                          </span>
                        </div>
                        <p className="text-[11px] text-zinc-400 leading-relaxed">
                          {item.milestone}
                        </p>
                      </div>
                    ))}
                  </div>
                )}

                {/* Actionable Paper Jump Links */}
                <div className="pt-3 border-t border-zinc-800 flex flex-wrap gap-2 text-xs">
                  {papers
                    .filter((p) => currentConcept.paperIds?.includes(p.id) || p.title.includes('DeepSeek'))
                    .map((p) => (
                      <div
                        key={p.id}
                        className="flex items-center justify-between gap-3 px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg flex-1 min-w-[260px]"
                      >
                        <div className="truncate">
                          <div className="font-medium text-zinc-200 truncate">《{p.title}》</div>
                          <div className="text-[10px] text-zinc-500 font-mono">arXiv:{p.arxivId} · {p.year}</div>
                        </div>
                        {onJumpToPaperReader && (
                          <button
                            onClick={() => onJumpToPaperReader(p.id)}
                            className="px-2 py-0.5 text-xs font-medium text-sky-400 hover:text-sky-300 hover:bg-zinc-900 rounded transition-colors shrink-0 flex items-center gap-1"
                          >
                            <span>阅读全文</span>
                            <ArrowRight size={10} />
                          </button>
                        )}
                      </div>
                    ))}
                </div>
              </section>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-xs text-zinc-500 space-y-2 p-8 text-center">
              <Layers size={28} className="text-zinc-600 mb-1" />
              <p className="text-zinc-400 font-medium">Wiki 词条库为空</p>
              <p className="text-[11px] text-zinc-500 max-w-xs">
                您可以点击顶部「提取」按钮，从学术文献中提取关键算法、数学定理或理论假说。
              </p>
            </div>
          )}
        </main>
      </div>

      {/* 3. Concept Extractor Modal */}
      {isExtractorModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-800 max-w-lg w-full p-5 space-y-4 animate-fadeIn text-zinc-100 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <FileText size={15} className="text-amber-400" />
                <h3 className="font-semibold text-xs text-zinc-100">从文献提取或新建 Wiki 词条</h3>
              </div>
              <button
                onClick={() => setIsExtractorModalOpen(false)}
                className="text-zinc-500 hover:text-zinc-300 text-sm"
              >
                <X size={15} />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-zinc-400 font-medium mb-1">选择来源学术文献</label>
                <select
                  value={extractPaperId}
                  onChange={(e) => {
                    setExtractPaperId(e.target.value);
                    const p = papers.find((x) => x.id === e.target.value);
                    if (p && !newTitle) {
                      setNewTitle(p.tags[0] || '新型推理架构');
                      setNewSummary(p.tldr || p.abstract.slice(0, 100));
                    }
                  }}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 focus:outline-none focus:border-zinc-700"
                >
                  {papers.map((p) => (
                    <option key={p.id} value={p.id}>
                      《{p.title}》 (arXiv:{p.arxivId})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-zinc-400 font-medium mb-1">概念词条全称 *</label>
                  <input
                    type="text"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder="如: DPO 直接偏好对齐"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-700"
                  />
                </div>

                <div>
                  <label className="block text-zinc-400 font-medium mb-1">分类</label>
                  <select
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value as any)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 focus:outline-none focus:border-zinc-700"
                  >
                    <option value="theory">理论 (Theory)</option>
                    <option value="algorithm">算法 (Algorithm)</option>
                    <option value="architecture">架构 (Architecture)</option>
                    <option value="benchmark">评测 (Benchmark)</option>
                    <option value="metric">指标 (Metric)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-zinc-400 font-medium mb-1">摘要 (TL;DR)</label>
                <textarea
                  rows={2}
                  value={newSummary}
                  onChange={(e) => setNewSummary(e.target.value)}
                  placeholder="用一两句话概括该概念的本质与核心优势..."
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-700 resize-none"
                />
              </div>

              <div>
                <label className="block text-zinc-400 font-medium mb-1">形式化 LaTeX 公式 (可选)</label>
                <input
                  type="text"
                  value={newLatex}
                  onChange={(e) => setNewLatex(e.target.value)}
                  placeholder="如: \mathcal{L}_{DPO}(\theta) = -\mathbb{E}[\log \sigma(...)]"
                  className="w-full font-mono bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-700"
                />
              </div>

              <div>
                <label className="block text-zinc-400 font-medium mb-1">论文核心论断 (Claim)</label>
                <input
                  type="text"
                  value={newClaim}
                  onChange={(e) => setNewClaim(e.target.value)}
                  placeholder="如: 无需显式奖励模型即可完成策略对齐"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-700"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-800">
              <button
                onClick={() => setIsExtractorModalOpen(false)}
                className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleSaveExtractedConcept}
                disabled={!newTitle.trim()}
                className="px-4 py-1.5 text-xs font-medium text-zinc-950 bg-zinc-100 hover:bg-white disabled:bg-zinc-700 rounded-lg transition-colors shadow-xs"
              >
                保存并加入知识网络
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
