import { useMemo, useState } from 'react';
import { Bot, Compass, Search, X } from 'lucide-react';
import type { ResearchClaim, ResearchEvidence } from '../../shared/types';
import type { ResearchLibraryItem } from '../../shared/types';
import { EmptyState } from '../shell/EmptyState';
import { deriveGraph, graphNeighborIds, GRAPH_PAGE_SIZE, type GraphNode, type GraphNodeKind } from './derive-graph';

/** Recorded relations with bounded node and selected-neighborhood lists. */

export type KnowledgeGraphViewProps = {
  claims: readonly ResearchClaim[];
  evidence: readonly ResearchEvidence[];
  libraryItems: readonly ResearchLibraryItem[];
  /** Highlight this node's neighbourhood; set when arriving from the wiki. */
  focusClaimId?: string | null;
  /** Hands the node to the research assistant. */
  onAskAssistantAboutNode?: (node: GraphNode) => void;
};

const KIND_LABELS: Readonly<Record<GraphNodeKind, string>> = {
  paper: '文献',
  claim: '主张',
  evidence: '证据',
  file: '文件'
};

export function KnowledgeGraphView({
  claims,
  evidence,
  libraryItems,
  focusClaimId = null,
  onAskAssistantAboutNode
}: KnowledgeGraphViewProps): React.JSX.Element {
  const graph = useMemo(
    () => deriveGraph({ claims, evidence, libraryItems }),
    [claims, evidence, libraryItems]
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<GraphNodeKind | 'all'>('all');
  const [filterText, setFilterText] = useState('');
  const [requestedPage, setPage] = useState(0);
  const [neighbourPaging, setNeighbourPaging] = useState({ nodeId: '', page: 0 });

  const focusNodeId = focusClaimId === null ? null : `claim:${focusClaimId}`;
  const effectiveSelected = selectedNodeId ?? focusNodeId;

  const query = filterText.trim().toLowerCase();
  const visibleNodes = useMemo(
    () =>
      graph.nodes
        .filter((node) => kindFilter === 'all' || node.kind === kindFilter)
        .filter(
          (node) =>
            query.length === 0 ||
            node.label.toLowerCase().includes(query) ||
            node.detail.toLowerCase().includes(query)
        ),
    [graph.nodes, kindFilter, query]
  );
  const selectedNode = effectiveSelected === null ? undefined : graph.nodeById.get(effectiveSelected);
  const neighbourIds = useMemo(() => effectiveSelected === null ? [] : graphNeighborIds(graph, effectiveSelected), [graph, effectiveSelected]);
  const page = Math.min(requestedPage, Math.max(0, Math.ceil(visibleNodes.length / GRAPH_PAGE_SIZE) - 1));
  const neighbourPage = Math.min(neighbourPaging.nodeId === effectiveSelected ? neighbourPaging.page : 0,
    Math.max(0, Math.ceil(neighbourIds.length / GRAPH_PAGE_SIZE) - 1));
  const pageNodes = visibleNodes.slice(page * GRAPH_PAGE_SIZE, (page + 1) * GRAPH_PAGE_SIZE);
  const neighbours = neighbourIds.slice(neighbourPage * GRAPH_PAGE_SIZE, (neighbourPage + 1) * GRAPH_PAGE_SIZE).map(id => graph.nodeById.get(id)!);
  const kindCounts = useMemo(() => {
    const counts: Record<GraphNodeKind, number> = { paper: 0, claim: 0, evidence: 0, file: 0 };
    for (const node of graph.nodes) counts[node.kind] += 1;
    return counts;
  }, [graph.nodes]);
  const changeText = (text: string): void => { setFilterText(text); setPage(0); };
  const changeKind = (kind: GraphNodeKind | 'all'): void => { setKindFilter(kind); setPage(0); };
  const selectNode = (nodeId: string): void => { setSelectedNodeId(nodeId); setNeighbourPaging({ nodeId, page: 0 }); };

  if (graph.nodes.length === 0) {
    return (
      <EmptyState
        icon={Compass}
        title="尚无图谱数据"
        testId="graph-empty"
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="knowledge-graph">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b-[0.5px] border-line px-3 py-2">
        <span className="text-muted text-[var(--font-meta-size)]" data-testid="graph-counts">
          {graph.nodes.length} 节点 / {graph.links.length} 引用与来源关系
        </span>
        <div className="ml-1 flex h-[var(--control-height-compact)] min-w-[150px] flex-1 items-center gap-1.5 rounded-control border-[0.5px] border-line bg-surface px-2 sm:max-w-[220px]">
          <Search size={11} aria-hidden="true" className="shrink-0 text-subtle" />
          <input
            value={filterText}
            onChange={(event) => changeText(event.target.value)}
            placeholder="过滤节点…"
            aria-label="过滤图谱节点"
            data-testid="graph-filter-text"
            className="min-w-0 flex-1 bg-transparent text-ink text-[var(--font-meta-size)] placeholder:text-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          />
          {filterText.length === 0 ? null : (
            <button
              type="button"
              onClick={() => changeText('')}
              aria-label="清除节点过滤"
              data-testid="graph-filter-clear"
              className="shrink-0 rounded-control text-subtle hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              <X size={11} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="ml-1 flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => changeKind('all')}
            aria-pressed={kindFilter === 'all'}
            data-testid="graph-filter-all"
            className={
              kindFilter === 'all'
                ? 'h-[var(--control-height-compact)] rounded-control border-[0.5px] border-line focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent bg-accent-soft px-2 text-ink text-[var(--font-meta-size)]'
                : 'h-[var(--control-height-compact)] rounded-control border-[0.5px] border-line px-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent text-muted text-[var(--font-meta-size)] hover:bg-[var(--overlay-hover)]'
            }
          >
            全部
          </button>
          {graph.kinds.map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => changeKind(kind)}
              aria-pressed={kindFilter === kind}
              data-testid={`graph-filter-${kind}`}
              className={
                kindFilter === kind
                  ? 'h-[var(--control-height-compact)] rounded-control border-[0.5px] border-line focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent bg-accent-soft px-2 text-ink text-[var(--font-meta-size)]'
                  : 'h-[var(--control-height-compact)] rounded-control border-[0.5px] border-line px-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent text-muted text-[var(--font-meta-size)] hover:bg-[var(--overlay-hover)]'
              }
            >
              {KIND_LABELS[kind]} {kindCounts[kind]}
            </button>
          ))}
        </div>

      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section className="flex min-h-0 flex-1 flex-col px-2" aria-label="图谱节点浏览">
        <ul className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="图谱节点" data-testid="graph-node-list">
          {visibleNodes.length === 0 ? (
            <li className="px-2 py-4 text-muted text-[var(--font-meta-size)]" data-testid="graph-no-match">
              没有匹配的节点。
            </li>
          ) : null}
          {pageNodes.map((node) => {
            const active = node.id === effectiveSelected;
            return (
              <li key={node.id}>
                <button
                  type="button"
                  onClick={() => selectNode(node.id)}
                  aria-current={active ? 'true' : undefined}
                  data-testid={`graph-node-${node.id}`}
                  className={`flex w-full flex-col gap-0.5 rounded-control px-2 py-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
                    active ? 'bg-accent-soft active:bg-[var(--accent-soft-strong)]' : 'hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]'
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="shrink-0 rounded-control border-[0.5px] border-line px-1 text-subtle text-[var(--font-meta-size)]">
                      {KIND_LABELS[node.kind]}
                    </span>
                    <span className="truncate text-ink text-[var(--font-meta-size)]">{node.label}</span>
                  </span>
                  {node.detail.length === 0 ? null : (
                    <span className="truncate text-muted text-[var(--font-meta-size)]">{node.detail}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        <GraphPagination area="nodes" page={page} total={visibleNodes.length} onPage={setPage} />
        </section>
        <aside className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 border-t-[0.5px] border-line p-3 lg:w-72 lg:flex-none lg:border-l-[0.5px] lg:border-t-0" aria-label="节点详情">
          {selectedNode === undefined ? (
            <p className="text-muted text-[var(--font-meta-size)]" data-testid="graph-no-selection">
              选一个节点查看它的关系。
            </p>
          ) : (
            <>
              <h3 className="shrink-0 break-words text-ink text-[var(--font-meta-size)]" data-testid="graph-detail-label">
                {selectedNode.label}
              </h3>
              <p className="text-muted text-[var(--font-meta-size)]">
                {KIND_LABELS[selectedNode.kind]}
                {selectedNode.detail.length === 0 ? '' : ` / ${selectedNode.detail}`}
              </p>
              <p className="shrink-0 break-all text-subtle text-[var(--font-meta-size)]" data-testid="graph-detail-id">
                {selectedNode.id}
              </p>
              <h4 className="mt-1 shrink-0 text-muted text-[var(--font-meta-size)]" data-testid="graph-neighbour-count">相连及共享证据（{neighbourIds.length}）</h4>
              {neighbourIds.length === 0 ? (
                <p className="text-subtle text-[var(--font-meta-size)]" data-testid="graph-no-neighbours">
                  这个节点没有任何已记录的关系。
                </p>
              ) : (
                <ul className="min-h-0 flex-1 overflow-y-auto" aria-label="节点邻域" data-testid="graph-neighbours">
                  {neighbours.map((node) => (
                    <li key={node.id}>
                      <button type="button" onClick={() => selectNode(node.id)} data-testid={`graph-neighbour-${node.id}`}
                        className="flex w-full items-start gap-1.5 rounded-control px-2 py-1 text-left text-ink text-[var(--font-meta-size)] hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                        <span className="shrink-0 rounded-control border-[0.5px] border-line px-1 text-subtle">{KIND_LABELS[node.kind]}</span>
                        <span className="min-w-0 break-words">{node.label}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <GraphPagination area="neighbours" page={neighbourPage} total={neighbourIds.length}
                onPage={value => setNeighbourPaging({ nodeId: selectedNode.id, page: value })} />
              {onAskAssistantAboutNode === undefined ? null : (
                <button
                  type="button"
                  onClick={() => onAskAssistantAboutNode(selectedNode)}
                  data-testid="graph-ask-assistant"
                  className="flex shrink-0 h-[var(--control-height-compact)] items-center gap-1 self-start rounded-control border-[0.5px] border-line bg-surface px-2 font-medium text-ink text-[var(--font-meta-size)] hover:bg-[var(--surface-card-hover)] active:bg-[var(--overlay-active)]"
                >
                  <Bot size={11} aria-hidden="true" className="text-[var(--icon-agent)]" />
                  让助手扩展这个节点
                </button>
              )}
            </>
          )}
        </aside>
      </div>

    </div>
  );
}

function GraphPagination({ area, page, total, onPage }: {
  area: 'nodes' | 'neighbours'; page: number; total: number; onPage: (page: number) => void;
}): React.JSX.Element {
  const pages = Math.max(1, Math.ceil(total / GRAPH_PAGE_SIZE));
  const label = area === 'nodes' ? '节点' : '邻域';
  const control = 'h-[var(--control-height-compact)] rounded-control border-[0.5px] border-line px-2 text-[var(--font-meta-size)] hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] disabled:opacity-40 disabled:pointer-events-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';
  return (
    <nav aria-label={`${label}分页`} className="flex shrink-0 flex-wrap items-center gap-2 py-2" data-testid={`graph-${area}-pagination`}>
      <button type="button" className={control} disabled={page === 0} onClick={() => onPage(page - 1)} aria-label={`上一页${label}`}>上一页</button>
      <span className="text-muted text-[var(--font-meta-size)] tabular-nums" data-testid={`graph-${area}-page`}>{page + 1} / {pages}，共 {total} 项</span>
      <button type="button" className={control} disabled={page + 1 >= pages} onClick={() => onPage(page + 1)} aria-label={`下一页${label}`}>下一页</button>
    </nav>
  );
}
