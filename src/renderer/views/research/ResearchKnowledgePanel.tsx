import { Send } from 'lucide-react';

import { TextInput } from '../../components/ui';

import type {
  ResearchEvidence,
  ResearchKnowledgeSearchResult
} from '../../../shared/types';

export function ResearchKnowledgePanel({
  evidence,
  projectId,
  query,
  readOnly = false,
  result,
  working,
  onCapture,
  onQueryChange,
  onSearch
}: {
  evidence: ResearchEvidence[];
  projectId: string | null;
  query: string;
  readOnly?: boolean;
  result: ResearchKnowledgeSearchResult | null;
  working: boolean;
  onCapture: (chunkId: string) => void;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
}): React.JSX.Element {
  const capturedChunkIds = new Set(evidence.map((item) => item.chunkId));
  const writeBlocked = working || readOnly;
  return (
    <section className="research-tool-panel" data-testid="research-knowledge-panel">
      <div className="research-tool-heading">
        <div>
          <h2>知识库</h2>
          <p>关键词和向量混合召回，使用 RRF 合并排序。命中片段可捕获为当前项目证据。</p>
        </div>
        <form className="research-search-form" onSubmit={(event) => { event.preventDefault(); onSearch(); }}>
          <TextInput aria-label="搜索知识库" data-testid="research-knowledge-query" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索证据、笔记或论文片段" />
          <button className="action-button action-button--primary" disabled={working} type="submit" data-testid="research-knowledge-search">
            <Send aria-hidden="true" size={15} />
            搜索
          </button>
        </form>
      </div>
      <div className="research-knowledge-summary">
        <span>关键词 {result?.keywordCount ?? 0}</span>
        <span>向量 {result?.vectorCount ?? 0}</span>
        <span>{result?.embeddingModel ?? '未启用嵌入模型'}</span>
        <span data-testid="research-evidence-count">已捕获 {evidence.length}</span>
      </div>
      <div className="research-knowledge-list">
        {result === null ? <div className="research-loading">输入查询开始召回证据。</div> : result.hits.map((hit) => (
          <article className="research-knowledge-row" key={hit.chunkId}>
            <div className="research-knowledge-rank">RRF {hit.rrfScore.toFixed(4)}</div>
            <h3>{hit.title}</h3>
            <p>{hit.content}</p>
            <div className="research-literature-meta">
              <span>{hit.sourceType} · {hit.sourceId}</span>
              <span>{hit.locator ?? '未定位'}</span>
              {capturedChunkIds.has(hit.chunkId) ? <span data-testid={`research-evidence-captured-${hit.chunkId}`}>已捕获</span> : (
                <button className="action-button" disabled={writeBlocked || projectId === null} type="button" data-testid={`research-evidence-capture-${hit.chunkId}`} onClick={() => onCapture(hit.chunkId)}>捕获证据</button>
              )}
            </div>
          </article>
        ))}
      </div>
      {evidence.length === 0 ? null : (
        <div className="research-literature-list" data-testid="research-evidence-list">
          {evidence.map((item) => (
            <article className="research-literature-row" key={item.id}>
              <div className="research-literature-source">{item.locator}</div>
              <h3>{item.title}</h3>
              <p>{item.excerpt}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
