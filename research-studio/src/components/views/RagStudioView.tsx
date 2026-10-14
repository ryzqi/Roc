import React, { useState, useMemo, useRef } from 'react';
import { ResearchPaper, ModelSettings } from '../../types/research';
import { MathView } from '../MathView';
import {
  Database,
  Search,
  RefreshCw,
  Copy,
  Check,
  FileCode,
  Sliders,
  ArrowRight,
  BookOpen,
  FileText,
  CornerDownRight,
  Sparkles,
  ChevronDown,
  ChevronUp
} from 'lucide-react';

export interface FinalChunkItem {
  id: string;
  chunkIndex: number;
  paperId: string;
  paperTitle: string;
  arxivId: string;
  section: string;
  granularity: 'parent' | 'child' | 'overview';
  parentId?: string;
  childIds?: string[];
  contentType: 'text' | 'formula' | 'table' | 'abstract' | 'section_summary';
  content: string;
  tokenCount: number;
  charCount: number;
  contextualPrefix: string;
  vectorPreview: number[];
  vectorDim: number;
  latex?: string;
  tableData?: { headers: string[]; rows: string[][] };
}

interface RagStudioViewProps {
  papers: ResearchPaper[];
  onSelectPaper: (paper: ResearchPaper) => void;
  onJumpToPaperReader?: (paperId: string) => void;
  settings?: ModelSettings;
  onOpenSettings?: (tab?: string) => void;
}

// Generates realistic mock embedding vector given seed and dim
function generateVectorFingerprint(seed: string, dim: number): number[] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  }
  const preview: number[] = [];
  for (let i = 0; i < 6; i++) {
    const val = Math.sin(h + i * 1.618) * 0.08;
    preview.push(Number(val.toFixed(4)));
  }
  return preview;
}

function getEmbeddingDimension(model?: string): number {
  if (!model) return 1536;
  if (model.includes('3-large')) return 3072;
  if (model.includes('bge-m3') || model.includes('e5-large')) return 1024;
  if (model.includes('004')) return 768;
  return 1536;
}

// Tokenize text into words/stems
function tokenizeText(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

// Compute accurate simulated cosine similarity score
function computeCosineSimilarity(query: string, chunk: FinalChunkItem): number {
  const qTokens = tokenizeText(query);
  if (qTokens.length === 0) return 0;

  const targetTokens = tokenizeText(
    `${chunk.contextualPrefix} ${chunk.section} ${chunk.content} ${chunk.paperTitle}`
  );
  const targetSet = new Set(targetTokens);

  let exactMatches = 0;
  let partialMatches = 0;

  qTokens.forEach((qt) => {
    if (targetSet.has(qt)) {
      exactMatches += 1;
    } else {
      for (const tt of targetSet) {
        if (tt.includes(qt) || qt.includes(tt)) {
          partialMatches += 1;
          break;
        }
      }
    }
  });

  // Calculate normalized intersection
  const matchScore = (exactMatches * 1.0 + partialMatches * 0.45) / Math.sqrt(qTokens.length + 0.1);

  // Bonus for section & title match
  let titleBonus = 0;
  if (tokenizeText(chunk.paperTitle).some((t) => qTokens.includes(t))) titleBonus += 0.15;
  if (tokenizeText(chunk.section).some((t) => qTokens.includes(t))) titleBonus += 0.12;

  // Base deterministic hash similarity for natural vector spread
  let hashVal = 0;
  const hashSeed = `${query}:${chunk.id}`;
  for (let i = 0; i < hashSeed.length; i++) {
    hashVal = (hashVal + hashSeed.charCodeAt(i) * 17) % 100;
  }
  const spread = (hashVal / 100) * 0.08;

  const finalSim = Math.min(0.97, Math.max(0.05, 0.45 * matchScore + titleBonus + spread));
  return Number(finalSim.toFixed(3));
}

export const RagStudioView: React.FC<RagStudioViewProps> = ({
  papers,
  onJumpToPaperReader,
  settings,
  onOpenSettings
}) => {
  const childChunkSize = settings?.ragChunkSize || 512;
  const embeddingModel = settings?.ragEmbeddingModel || 'text-embedding-004';
  const enableContextualPrefix = settings?.ragEnableContextualPrefix ?? true;
  const topK = settings?.topK || 5;
  const similarityThreshold = settings?.ragSimilarityThreshold ?? 0.55;

  const [isBuilding, setIsBuilding] = useState(false);
  const [buildSuccessMessage, setBuildSuccessMessage] = useState<string | null>(null);

  // Search & Filter states for Left Chunks Explorer
  const [searchQuery, setSearchQuery] = useState('');
  const [filterPaperId, setFilterPaperId] = useState<string>('all');
  const [granularityFilter, setGranularityFilter] = useState<'all' | 'parent' | 'child' | 'formula_table'>('all');
  const [copiedChunkId, setCopiedChunkId] = useState<string | null>(null);
  const [expandedVectorChunkId, setExpandedVectorChunkId] = useState<string | null>(null);

  // Right retrieval states
  const [testQuery, setTestQuery] = useState('');
  const [expandedParentResultId, setExpandedParentResultId] = useState<string | null>(null);
  const [highlightedChunkId, setHighlightedChunkId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    query: string;
    matchedChunks: { chunk: FinalChunkItem; score: number; parent?: FinalChunkItem }[];
    generatedAnswer: string;
    citations: { index: number; chunkId: string; paperTitle: string }[];
  } | null>(null);

  const resultCardsRef = useRef<{ [key: string]: HTMLDivElement | null }>({});

  // Generate chunks based on structural decomposition + Parent-Child + Contextual Retrieval
  const finalChunks: FinalChunkItem[] = useMemo(() => {
    const items: FinalChunkItem[] = [];
    let globalIndex = 1;
    const vectorDim = getEmbeddingDimension(embeddingModel);

    papers.forEach((paper) => {
      // 1. Overview / Abstract Chunk
      const abstractPrefix = enableContextualPrefix
        ? `[文献: 《${paper.title}》 | 摘要总览]`
        : '';
      const absContent = `${paper.abstract}\n核心主旨：${paper.tldr || ''}`;

      items.push({
        id: `chunk-${paper.id}-overview`,
        chunkIndex: globalIndex++,
        paperId: paper.id,
        paperTitle: paper.title,
        arxivId: paper.arxivId,
        section: 'Abstract & Overview',
        granularity: 'overview',
        contentType: 'abstract',
        content: absContent,
        tokenCount: Math.round(absContent.length / 3.2),
        charCount: absContent.length,
        contextualPrefix: abstractPrefix,
        vectorPreview: generateVectorFingerprint(`${paper.id}-abs`, vectorDim),
        vectorDim
      });

      // 2. Sections: Parent & Child Chunks
      const sections = paper.sections && paper.sections.length > 0
        ? paper.sections
        : [
            {
              id: 'sec-1',
              title: '1. Introduction & Methodology',
              level: 1,
              content: paper.notes || '学术研究方法论与背景介绍。',
              paragraphs: [
                paper.abstract,
                `本文针对 ${paper.title} 的核心课题开展理论推导与实验验证。`
              ],
              formulas: paper.keyFormulas
            }
          ];

      sections.forEach((sec, sIdx) => {
        const parentId = `chunk-${paper.id}-p-s${sIdx}`;
        const childIdsForThisSection: string[] = [];

        const parentPrefix = enableContextualPrefix
          ? `[章节全貌: 《${paper.title}》 | ${sec.title}]`
          : '';

        const fullSectionText = [
          sec.content,
          sec.paragraphs?.join('\n\n') || '',
          sec.formulas?.map((f) => `公式 ${f.name}: ${f.explanation}`).join('\n') || ''
        ].filter(Boolean).join('\n\n');

        const parentItem: FinalChunkItem = {
          id: parentId,
          chunkIndex: globalIndex++,
          paperId: paper.id,
          paperTitle: paper.title,
          arxivId: paper.arxivId,
          section: sec.title,
          granularity: 'parent',
          childIds: childIdsForThisSection,
          contentType: 'section_summary',
          content: fullSectionText || sec.title,
          tokenCount: Math.round((fullSectionText || sec.title).length / 3.0),
          charCount: (fullSectionText || sec.title).length,
          contextualPrefix: parentPrefix,
          vectorPreview: generateVectorFingerprint(`${paper.id}-parent-${sIdx}`, vectorDim),
          vectorDim
        };

        const sectionChildItems: FinalChunkItem[] = [];

        // A. Paragraph Child Chunks
        if (sec.paragraphs && sec.paragraphs.length > 0) {
          sec.paragraphs.forEach((pText, pIdx) => {
            const childId = `chunk-${paper.id}-c-s${sIdx}-p${pIdx}`;
            childIdsForThisSection.push(childId);

            const childPrefix = enableContextualPrefix
              ? `[来源: 《${paper.title}》 | 章节: ${sec.title} | 段落 #${pIdx + 1}]`
              : '';

            sectionChildItems.push({
              id: childId,
              chunkIndex: globalIndex++,
              paperId: paper.id,
              paperTitle: paper.title,
              arxivId: paper.arxivId,
              section: sec.title,
              granularity: 'child',
              parentId: parentId,
              contentType: 'text',
              content: pText,
              tokenCount: Math.round(pText.length / 3.2),
              charCount: pText.length,
              contextualPrefix: childPrefix,
              vectorPreview: generateVectorFingerprint(`${paper.id}-c-s${sIdx}-p${pIdx}`, vectorDim),
              vectorDim
            });
          });
        }

        // B. Formula Child Chunks
        if (sec.formulas && sec.formulas.length > 0) {
          sec.formulas.forEach((f, fIdx) => {
            const formulaChildId = `chunk-${paper.id}-c-s${sIdx}-f${fIdx}`;
            childIdsForThisSection.push(formulaChildId);

            const fPrefix = enableContextualPrefix
              ? `[来源: 《${paper.title}》 | 章节: ${sec.title} | 公式: ${f.name}]`
              : '';

            sectionChildItems.push({
              id: formulaChildId,
              chunkIndex: globalIndex++,
              paperId: paper.id,
              paperTitle: paper.title,
              arxivId: paper.arxivId,
              section: sec.title,
              granularity: 'child',
              parentId: parentId,
              contentType: 'formula',
              content: `公式 ${f.name}: ${f.explanation}`,
              latex: f.latex,
              tokenCount: Math.round((f.explanation.length + f.latex.length) / 3.2),
              charCount: f.explanation.length + f.latex.length,
              contextualPrefix: fPrefix,
              vectorPreview: generateVectorFingerprint(`${paper.id}-c-s${sIdx}-f${fIdx}`, vectorDim),
              vectorDim
            });
          });
        }

        // C. Tables
        if (sec.tables && sec.tables.length > 0) {
          sec.tables.forEach((t, tIdx) => {
            const tableChildId = `chunk-${paper.id}-c-s${sIdx}-t${tIdx}`;
            childIdsForThisSection.push(tableChildId);

            const tPrefix = enableContextualPrefix
              ? `[来源: 《${paper.title}》 | 章节: ${sec.title} | 实验表格]`
              : '';

            sectionChildItems.push({
              id: tableChildId,
              chunkIndex: globalIndex++,
              paperId: paper.id,
              paperTitle: paper.title,
              arxivId: paper.arxivId,
              section: sec.title,
              granularity: 'child',
              parentId: parentId,
              contentType: 'table',
              content: `${t.caption}: ${t.headers?.join(' | ') || ''}`,
              tableData: t.headers && t.rows ? { headers: t.headers, rows: t.rows } : undefined,
              tokenCount: 160,
              charCount: 380,
              contextualPrefix: tPrefix,
              vectorPreview: generateVectorFingerprint(`${paper.id}-c-s${sIdx}-t${tIdx}`, vectorDim),
              vectorDim
            });
          });
        }

        // Push parent and all child chunks
        items.push(parentItem, ...sectionChildItems);
      });
    });

    return items;
  }, [papers, embeddingModel, enableContextualPrefix]);

  // Filtered Chunks for Left Explorer
  const filteredChunks = useMemo(() => {
    return finalChunks.filter((c) => {
      if (filterPaperId !== 'all' && c.paperId !== filterPaperId) return false;
      if (granularityFilter === 'parent' && c.granularity !== 'parent') return false;
      if (granularityFilter === 'child' && c.granularity !== 'child') return false;
      if (granularityFilter === 'formula_table' && c.contentType !== 'formula' && c.contentType !== 'table') return false;

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchContent = c.content.toLowerCase().includes(q);
        const matchSection = c.section.toLowerCase().includes(q);
        const matchPaper = c.paperTitle.toLowerCase().includes(q);
        const matchId = c.id.toLowerCase().includes(q);
        return matchContent || matchSection || matchPaper || matchId;
      }

      return true;
    });
  }, [finalChunks, filterPaperId, granularityFilter, searchQuery]);

  // Execute Semantic Retrieval
  const handleExecuteSearch = (queryToRun?: string) => {
    const q = (queryToRun !== undefined ? queryToRun : testQuery).trim();
    if (!q) return;

    if (queryToRun !== undefined) {
      setTestQuery(queryToRun);
    }

    // Rank all child & overview chunks by cosine similarity
    const candidates = finalChunks.filter((c) => c.granularity === 'child' || c.granularity === 'overview');
    const scoredList = candidates
      .map((chunk) => {
        const score = computeCosineSimilarity(q, chunk);
        const parent = chunk.parentId ? finalChunks.find((p) => p.id === chunk.parentId) : undefined;
        return { chunk, score, parent };
      })
      .filter((item) => item.score >= similarityThreshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    // Synthesize grounded RAG generation answer based on recalled evidence
    let generatedAnswer = '';
    const citations: { index: number; chunkId: string; paperTitle: string }[] = [];

    if (scoredList.length > 0) {
      scoredList.forEach((item, idx) => {
        citations.push({
          index: idx + 1,
          chunkId: item.chunk.id,
          paperTitle: item.chunk.paperTitle
        });
      });

      const topItem = scoredList[0];
      const secondItem = scoredList[1];

      if (q.includes('GRPO') || q.includes('PPO') || q.includes('显存')) {
        generatedAnswer = `根据文献检索结论，GRPO 相比传统 PPO 核心在于彻底摒弃了独立 Value Critic 网络 [1]。通过在采样候选组内计算胜负均值与方差归一化优势，在大规模强化学习阶段节省了约 50% 训练显存 [1]。此外，在候选组数 G ≥ 8 时相对优势估计具有良好的收敛稳定性 [${secondItem ? 2 : 1}]。`;
      } else if (q.includes('Attention') || q.includes('缩放') || q.includes('根号')) {
        generatedAnswer = `检索证据表明，Self-Attention 引入 1/√d_k 缩放因子的根本原因在于防止大维度下的向量点积数值过大 [1]。点积过大会导致 Softmax 函数进入梯度接近为零的饱和区域，缩放能保证方差稳定维持在 1 左右，从而避免反向传播停滞 [${secondItem ? 2 : 1}]。`;
      } else if (q.includes('DPO') || q.includes('对数几率') || q.includes('奖励')) {
        generatedAnswer = `DPO（直接偏好优化）通过数学换元证明策略模型自身隐含了最优奖励闭式解 [1]。它利用当前策略与参考模型在偏好数据上的对数几率差直接构建交叉熵损失，从而跳过了显式奖励模型训练与不稳定的在线采样阶段 [${secondItem ? 2 : 1}]。`;
      } else {
        generatedAnswer = `基于检索召回的文献分块证据 [1]，关于“${q}”的核心结论如下：${topItem.chunk.content.slice(0, 140)}...${secondItem ? ` 此外在对应章节小节中指出：${secondItem.chunk.content.slice(0, 110)}... [2]` : ''}`;
      }
    } else {
      generatedAnswer = `在当前相似度阈值 (≥ ${similarityThreshold}) 下未召回有效分块。建议适当调低相似度阈值或增加 Top-K 检索量。`;
    }

    setTestResult({
      query: q,
      matchedChunks: scoredList,
      generatedAnswer,
      citations
    });
  };

  // Rebuild vector index handler
  const handleRebuildIndex = () => {
    setIsBuilding(true);
    setBuildSuccessMessage(null);
    setTimeout(() => {
      setIsBuilding(false);
      setBuildSuccessMessage(`已基于 ${embeddingModel} 完成全量切分与向量索引重建 (${finalChunks.length} 个分块)`);
      setTimeout(() => setBuildSuccessMessage(null), 3500);
    }, 700);
  };

  const handleCopyText = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedChunkId(id);
    setTimeout(() => setCopiedChunkId(null), 1800);
  };

  const handleCitationClick = (chunkId: string) => {
    setHighlightedChunkId(chunkId);
    const targetElement = resultCardsRef.current[chunkId];
    if (targetElement) {
      targetElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    setTimeout(() => {
      setHighlightedChunkId((curr) => (curr === chunkId ? null : curr));
    }, 2500);
  };

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100 select-none overflow-hidden">
      {/* 1. Header Bar */}
      <header className="h-11 px-3 bg-zinc-950 border-b border-zinc-800 flex items-center justify-between shrink-0 overflow-x-auto no-scrollbar gap-2">
        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-1.5 font-semibold text-xs text-zinc-200">
            <Database size={14} className="text-emerald-400" />
            <span>向量库</span>
          </div>
          <span className="text-zinc-700">|</span>
          <div className="flex items-center gap-2 text-[11px] text-zinc-400">
            <span>文献 {papers.length} 篇</span>
            <span aria-hidden="true">·</span>
            <span>分块 {finalChunks.length} 个</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">{getEmbeddingDimension(embeddingModel)} 维</span>
            <span aria-hidden="true">·</span>
            <span className="text-zinc-500 font-mono">{embeddingModel} ({childChunkSize} tok)</span>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {buildSuccessMessage && (
            <span className="text-[11px] text-emerald-400 font-medium animate-fadeIn">
              {buildSuccessMessage}
            </span>
          )}

          <button
            onClick={() => onOpenSettings?.('rag')}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700 transition-colors cursor-pointer"
            title="前往偏好设置修改向量与检索超参 (⌘,)"
          >
            <Sliders size={12} />
            <span>偏好设置</span>
          </button>

          <button
            onClick={handleRebuildIndex}
            disabled={isBuilding}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-zinc-950 bg-zinc-100 hover:bg-white disabled:bg-zinc-700 rounded-lg transition-colors cursor-pointer"
          >
            <RefreshCw size={12} className={isBuilding ? 'animate-spin' : ''} />
            <span>{isBuilding ? '构建中' : '重建'}</span>
          </button>
        </div>
      </header>

      {/* 3. Main Split Workbench */}
      <div className="flex-1 flex overflow-hidden min-w-0">
        {/* LEFT COLUMN: 分块库检视 */}
        <section className="w-5/12 min-w-[340px] max-w-[560px] bg-zinc-950 border-r border-zinc-800 flex flex-col h-full">
          {/* Controls */}
          <div className="p-2.5 border-b border-zinc-800 space-y-2 bg-zinc-950 shrink-0">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-zinc-300">分块</span>
              <span className="text-[11px] text-zinc-500 font-mono tabular-nums">
                {filteredChunks.length} / {finalChunks.length}
              </span>
            </div>

            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-2 text-zinc-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索分块..."
                className="w-full pl-7 pr-3 py-1 text-xs bg-zinc-900 border border-zinc-800 focus:border-zinc-700 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-1.5 text-xs">
              <select
                value={filterPaperId}
                onChange={(e) => setFilterPaperId(e.target.value)}
                className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-zinc-300 text-xs truncate focus:outline-none"
              >
                <option value="all">全部文献</option>
                {papers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>

              <select
                value={granularityFilter}
                onChange={(e) => setGranularityFilter(e.target.value as any)}
                className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-zinc-300 text-xs focus:outline-none"
              >
                <option value="all">全部类型</option>
                <option value="parent">父块</option>
                <option value="child">子块</option>
                <option value="formula_table">公式与表</option>
              </select>
            </div>
          </div>

          {/* Chunks List */}
          <div className="flex-1 overflow-y-auto p-2.5 space-y-2">
            {filteredChunks.length === 0 ? (
              <div className="py-16 text-center text-xs text-zinc-500 space-y-2">
                <Database size={24} className="mx-auto text-zinc-600 mb-1" />
                <p className="text-zinc-400 font-medium">{papers.length === 0 ? '暂无向量分块' : '无匹配分块记录'}</p>
                <p className="text-[11px] text-zinc-500">
                  {papers.length === 0 ? '在文献库导入文献后，系统将自动构建多层级 RAG 向量索引' : '请尝试调整筛选条件'}
                </p>
              </div>
            ) : (
              filteredChunks.map((chunk) => {
                const isVectorExpanded = expandedVectorChunkId === chunk.id;
                return (
                  <article
                    key={chunk.id}
                    className="p-2.5 bg-zinc-900/80 rounded-xl border border-zinc-800/80 hover:border-zinc-700 transition-colors"
                  >
                    <div className="flex items-center justify-between text-xs text-zinc-400 mb-1">
                      <div className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-300">
                        <span className="font-semibold text-zinc-200">{chunk.id}</span>
                        <span aria-hidden="true">·</span>
                        <span className="text-zinc-400">
                          {chunk.granularity === 'parent'
                            ? '父小节'
                            : chunk.contentType === 'formula'
                            ? '公式'
                            : chunk.contentType === 'table'
                            ? '表格'
                            : chunk.contentType === 'abstract'
                            ? '摘要'
                            : '段落'}
                        </span>
                      </div>

                      <div className="font-mono text-[11px] text-zinc-500 tabular-nums">
                        <span>{chunk.tokenCount} T</span>
                      </div>
                    </div>

                    <div className="text-xs text-zinc-400 mb-1.5 flex items-center gap-1 truncate">
                      <span className="text-zinc-300 font-medium truncate" title={chunk.paperTitle}>
                        《{chunk.paperTitle}》
                      </span>
                    </div>

                    {chunk.contextualPrefix && (
                      <div className="text-[10px] font-mono text-sky-400 bg-sky-950/60 px-1.5 py-0.5 rounded border border-sky-800/60 mb-1.5 inline-block">
                        {chunk.contextualPrefix}
                      </div>
                    )}

                    <div className="text-xs text-zinc-300 leading-relaxed font-sans line-clamp-3 select-text">
                      {chunk.contentType === 'formula' && chunk.latex ? (
                        <div className="my-1 py-1 px-2 bg-zinc-950 rounded border border-zinc-800 text-center text-zinc-100">
                          <MathView math={chunk.latex} displayMode={true} />
                        </div>
                      ) : (
                        chunk.content
                      )}
                    </div>

                    <div className="mt-2 pt-1 border-t border-zinc-800/80 flex items-center justify-between text-[11px]">
                      <button
                        onClick={() =>
                          setExpandedVectorChunkId(isVectorExpanded ? null : chunk.id)
                        }
                        className="text-zinc-400 hover:text-zinc-200 flex items-center gap-1 font-mono transition-colors"
                      >
                        <FileCode size={11} />
                        <span>{chunk.vectorDim}维向量</span>
                        {isVectorExpanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                      </button>

                      <button
                        onClick={() => handleCopyText(chunk.id, chunk.content)}
                        className="text-zinc-500 hover:text-zinc-300 flex items-center gap-1 transition-colors"
                        title="复制分块原文"
                      >
                        {copiedChunkId === chunk.id ? (
                          <>
                            <Check size={11} className="text-emerald-400" />
                            <span className="text-emerald-400 text-[10px]">已复制</span>
                          </>
                        ) : (
                          <>
                            <Copy size={11} />
                            <span className="text-[10px]">复制</span>
                          </>
                        )}
                      </button>
                    </div>

                    {isVectorExpanded && (
                      <div className="mt-1.5 p-2 bg-zinc-950 text-zinc-300 rounded font-mono text-[10px] space-y-1 animate-fadeIn border border-zinc-800">
                        <div className="text-zinc-500 flex items-center justify-between">
                          <span>前 6 维数值:</span>
                          <span>{embeddingModel}</span>
                        </div>
                        <div className="text-emerald-400 break-all leading-tight">
                          [{chunk.vectorPreview.join(', ')}, ...]
                        </div>
                      </div>
                    )}
                  </article>
                );
              })
            )}
          </div>
        </section>

        {/* RIGHT COLUMN: 检索测试与召回引用 */}
        <section className="flex-1 bg-zinc-950 flex flex-col h-full overflow-hidden min-w-0">
          {/* Top Retrieval Input & Presets */}
          <div className="p-3 bg-zinc-950 border-b border-zinc-800 space-y-2 shrink-0">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type="text"
                  value={testQuery}
                  onChange={(e) => setTestQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleExecuteSearch();
                  }}
                  placeholder="输入学术检索问题..."
                  className="w-full px-3 py-1.5 text-xs bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-700"
                />
              </div>

              <button
                onClick={() => handleExecuteSearch()}
                className="px-3.5 py-1.5 text-xs font-semibold text-zinc-950 bg-zinc-100 hover:bg-white rounded-lg transition-colors shadow-xs flex items-center gap-1.5 shrink-0"
              >
                <Search size={12} />
                <span>检索</span>
              </button>
            </div>

            {/* Tuning Parameters */}
            <div className="flex items-center justify-end gap-2 text-xs pt-0.5 overflow-x-auto no-scrollbar">

              <div className="flex items-center gap-2.5 text-zinc-400 font-mono text-[11px] shrink-0">
                <div className="flex items-center gap-1">
                  <span>Top-K:</span>
                  <span className="font-semibold text-zinc-200">{topK}</span>
                </div>
                <div className="flex items-center gap-1">
                  <span>阈值:</span>
                  <span className="font-semibold text-zinc-200">{similarityThreshold.toFixed(2)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Results Area */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {!testResult ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-8 text-zinc-500 space-y-2">
                <Search size={24} className="text-zinc-700" />
                <p className="text-xs">输入问题即可检索相关学术切块并生成证据引用</p>
              </div>
            ) : (
              <>
                {/* RAG Grounded Answer Card */}
                <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 shadow-xs space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-100">
                      <Sparkles size={13} className="text-amber-400" />
                      <span>回答</span>
                    </div>
                    <span className="text-[11px] text-zinc-500 font-mono tabular-nums">
                      命中 {testResult.matchedChunks.length} 块
                    </span>
                  </div>

                  <div className="text-xs text-zinc-300 leading-relaxed font-sans select-text">
                    {testResult.generatedAnswer.split(/(\[\d+\])/g).map((part, pIdx) => {
                      const match = part.match(/\[(\d+)\]/);
                      if (match) {
                        const citeNum = parseInt(match[1]);
                        const citeItem = testResult.citations.find((c) => c.index === citeNum);
                        return (
                          <button
                            key={pIdx}
                            onClick={() => {
                              if (citeItem) handleCitationClick(citeItem.chunkId);
                            }}
                            className="inline-flex items-center px-1 mx-0.5 text-[11px] font-mono font-semibold text-sky-400 hover:text-white bg-sky-950/80 hover:bg-sky-700 border border-sky-850 rounded transition-colors"
                            title={`查看来源 #${citeNum}: ${citeItem?.paperTitle || ''}`}
                          >
                            [{citeNum}]
                          </button>
                        );
                      }
                      return <span key={pIdx}>{part}</span>;
                    })}
                  </div>
                </section>

                {/* Recalled Chunks List */}
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between text-xs text-zinc-400 px-1">
                    <span className="font-semibold text-zinc-300">证据</span>
                    <span className="font-mono tabular-nums text-[11px]">
                      相似度 ≥ {similarityThreshold.toFixed(2)}
                    </span>
                  </div>

                  {testResult.matchedChunks.length === 0 ? (
                    <div className="p-8 text-center bg-zinc-900 border border-zinc-800 rounded-lg text-xs text-zinc-500">
                      未找到满足阈值条件的分块
                    </div>
                  ) : (
                    testResult.matchedChunks.map((item, index) => {
                      const isHighlighted = highlightedChunkId === item.chunk.id;
                      const isParentExpanded = expandedParentResultId === item.chunk.id;

                      return (
                        <div
                          key={item.chunk.id}
                          ref={(el) => {
                            resultCardsRef.current[item.chunk.id] = el;
                          }}
                          className={`bg-zinc-900/90 rounded-xl border transition-all p-3.5 space-y-2 ${
                            isHighlighted
                              ? 'border-zinc-300 ring-1 ring-white/20 shadow-md'
                              : 'border-zinc-800 hover:border-zinc-700'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="flex items-center justify-center w-5 h-5 rounded bg-zinc-800 text-zinc-100 font-mono text-[11px] font-bold">
                                #{index + 1}
                              </span>
                              <div className="flex items-center gap-1.5 font-mono text-xs">
                                <span className="font-bold text-emerald-400 tabular-nums">
                                  相似度 {(item.score * 100).toFixed(1)}%
                                </span>
                              </div>
                            </div>

                            <span className="font-mono text-[11px] text-zinc-500">{item.chunk.id}</span>
                          </div>

                          <div className="flex items-center justify-between text-xs pt-0.5">
                            <div className="flex items-center gap-1 text-zinc-300 font-medium truncate">
                              <BookOpen size={12} className="text-zinc-500 shrink-0" />
                              <span className="truncate max-w-[240px]">《{item.chunk.paperTitle}》</span>
                              <span className="text-zinc-600">/</span>
                              <span className="text-zinc-400 truncate max-w-[140px]">{item.chunk.section}</span>
                            </div>

                            {onJumpToPaperReader && (
                              <button
                                onClick={() => onJumpToPaperReader(item.chunk.paperId)}
                                className="text-sky-400 hover:text-sky-300 text-[11px] flex items-center gap-0.5 transition-colors shrink-0"
                              >
                                <span>原文</span>
                                <ArrowRight size={10} />
                              </button>
                            )}
                          </div>

                          <div className="text-xs text-zinc-300 leading-relaxed font-sans select-text bg-zinc-950 p-2.5 rounded-lg border border-zinc-800">
                            {item.chunk.contentType === 'formula' && item.chunk.latex ? (
                              <div className="py-1 text-center">
                                <MathView math={item.chunk.latex} displayMode={true} />
                                <div className="mt-1 text-[11px] text-zinc-400">{item.chunk.content}</div>
                              </div>
                            ) : (
                              item.chunk.content
                            )}
                          </div>

                          {item.parent && (
                            <div className="pt-0.5">
                              <button
                                onClick={() =>
                                  setExpandedParentResultId(isParentExpanded ? null : item.chunk.id)
                                }
                                className="text-zinc-400 hover:text-zinc-200 text-[11px] flex items-center gap-1 transition-colors"
                              >
                                <CornerDownRight size={11} className="text-zinc-500" />
                                <span>
                                  {isParentExpanded ? '收起父章节上下文' : '展开父章节上下文 (Parent Chunk)'}
                                </span>
                                {isParentExpanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                              </button>

                              {isParentExpanded && (
                                <div className="mt-1.5 p-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-xs text-zinc-300 leading-relaxed space-y-1 animate-fadeIn">
                                  <div className="font-medium text-zinc-400 text-[11px]">
                                    完整父小节: {item.parent.section}
                                  </div>
                                  <div className="whitespace-pre-line text-zinc-300 text-xs select-text">
                                    {item.parent.content}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
