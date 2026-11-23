import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Bot, Compass, Search, X } from 'lucide-react';
import type { ResearchClaim, ResearchEvidence } from '../../shared/types';
import type { ResearchLibraryItem } from '../../shared/types';
import { EmptyState } from '../shell/EmptyState';
import { deriveGraph, graphNeighborIds, GRAPH_PAGE_SIZE, type GraphNode, type GraphNodeKind } from './derive-graph';
import type {RocClient} from '../shared/roc-client';
import {GraphNeighborhood, graphRelationLabel} from './GraphNeighborhood';
import './knowledge-workspace.css';
import {ScientificKnowledgePanel} from './ScientificKnowledgePanel';
import {useViewActive} from '../shared/view-activity';

const inactiveGraph = deriveGraph({claims: [], evidence: [], libraryItems: []});

/** Recorded relations with bounded node and selected-neighborhood lists. */

export type KnowledgeGraphViewProps = {
  client?: RocClient;
  projectId?: string | null;
  claims: readonly ResearchClaim[];
  evidence: readonly ResearchEvidence[];
  libraryItems: readonly ResearchLibraryItem[];
  /** Highlight this node's neighbourhood; set when arriving from the wiki. */
  focusClaimId?: string | null;
  /** A repeated open of the same claim still reveals its neighbourhood. */
  focusRequestId?: number;
  /** Hands the node to the research assistant. */
  onAskAssistantAboutNode?: (node: GraphNode) => void;
};

const KIND_LABELS: Readonly<Record<GraphNodeKind, string>> = {
  paper: '文献',
  claim: '主张',
  evidence: '证据',
  file: '文件'
};

function nodeDetail(node: GraphNode): string {
  if (node.kind !== 'claim') return node.detail;
  return ({supported: '声明有支撑', hypothesis: '假设', pending: '待定'} as Record<string, string>)[node.detail] ?? node.detail;
}

export function KnowledgeGraphView(props: KnowledgeGraphViewProps): React.JSX.Element {
  const [scientific, setScientific] = useState(false);
  useEffect(() => { setScientific(false); }, [props.focusClaimId, props.focusRequestId]);
  if (!props.client || !props.projectId) return <RecordedKnowledgeGraph {...props}/>;
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    <nav className="knowledge-view-switch" aria-label="知识关系视图">
      <button type="button" className="knowledge-view-button" aria-pressed={!scientific} onClick={() => setScientific(false)}>引用与来源关系</button>
      <button type="button" className="knowledge-view-button" aria-pressed={scientific} onClick={() => setScientific(true)}>科研实体关系</button>
    </nav>
    {scientific ? <ScientificKnowledgePanel client={props.client} projectId={props.projectId} graph/> : <RecordedKnowledgeGraph {...props}/>}
  </div>;
}

function RecordedKnowledgeGraph({
  claims,
  evidence,
  libraryItems,
  focusClaimId = null,
  focusRequestId = 0,
  onAskAssistantAboutNode
}: KnowledgeGraphViewProps): React.JSX.Element | null {
  const active = useViewActive();
  const graph = useMemo(
    () => active ? deriveGraph({ claims, evidence, libraryItems }) : inactiveGraph,
    [active, claims, evidence, libraryItems]
  );
  const focusKey = `${focusRequestId}:${focusClaimId ?? ''}`;
  const [selection, setSelection] = useState<{nodeId: string; focusKey: string} | null>(null);
  const [browsing, setBrowsing] = useState({open: false, focusKey});
  const [kindFilter, setKindFilter] = useState<GraphNodeKind | 'all'>('all');
  const [filterText, setFilterText] = useState('');
  const [requestedPage, setPage] = useState(0);
  const [neighbourPaging, setNeighbourPaging] = useState({ nodeId: '', page: 0 });

  const focusNodeId = focusClaimId === null ? null : `claim:${focusClaimId}`;
  const effectiveSelected = selection?.focusKey === focusKey ? selection.nodeId : focusNodeId;

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
  const changeText = (text: string): void => { setFilterText(text); setPage(0); setBrowsing({open: true, focusKey}); };
  const changeKind = (kind: GraphNodeKind | 'all'): void => { setKindFilter(kind); setPage(0); setBrowsing({open: true, focusKey}); };
  const selectNode = (nodeId: string): void => { setSelection({nodeId, focusKey}); setBrowsing({open: false, focusKey}); setNeighbourPaging({ nodeId, page: 0 }); };

  // Keep only the small filters/selection above; release the graph maps and DOM.
  if (!active) return null;

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
    <div className="knowledge-graph flex h-full min-h-0 min-w-0 flex-col" data-testid="knowledge-graph" data-browsing={(browsing.open && browsing.focusKey === focusKey) || selectedNode === undefined}>
      <div className="knowledge-toolbar">
        <span className="text-muted text-[length:var(--font-meta-size)]" data-testid="graph-counts">
          {graph.nodes.length} 节点 / {graph.links.length} 引用与来源关系
        </span>
        <div className="knowledge-search">
          <Search size={11} aria-hidden="true" className="shrink-0 text-subtle" />
          <input
            value={filterText}
            onChange={(event) => changeText(event.target.value)}
            placeholder="过滤节点…"
            aria-label="过滤图谱节点"
            data-testid="graph-filter-text"
            className="min-w-0 flex-1 bg-transparent text-ink text-[length:var(--font-meta-size)] placeholder:text-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
          />
          {filterText.length === 0 ? null : (
            <button
              type="button"
              onClick={() => changeText('')}
              aria-label="清除节点过滤"
              data-testid="graph-filter-clear"
              className="shrink-0 rounded-control text-subtle hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
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
                ? 'h-[var(--control-height-compact)] rounded-control border-[0.5px] border-line focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring bg-accent-soft px-2 text-ink text-[length:var(--font-meta-size)]'
                : 'h-[var(--control-height-compact)] rounded-control border-[0.5px] border-line px-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring text-muted text-[length:var(--font-meta-size)] hover:bg-[var(--overlay-hover)]'
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
                  ? 'h-[var(--control-height-compact)] rounded-control border-[0.5px] border-line focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring bg-accent-soft px-2 text-ink text-[length:var(--font-meta-size)]'
                  : 'h-[var(--control-height-compact)] rounded-control border-[0.5px] border-line px-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring text-muted text-[length:var(--font-meta-size)] hover:bg-[var(--overlay-hover)]'
              }
            >
              {KIND_LABELS[kind]} {kindCounts[kind]}
            </button>
          ))}
        </div>

      </div>

      <div className="knowledge-browser knowledge-graph-browser">
        <section className="knowledge-directory" aria-label="图谱节点浏览">
        <div className="knowledge-directory-heading"><span>关系目录</span><span>{visibleNodes.length} 项</span></div>
        <ul className="knowledge-directory-scroll" aria-label="图谱节点" data-testid="graph-node-list">
          {visibleNodes.length === 0 ? (
            <li className="px-2 py-4 text-muted text-[length:var(--font-meta-size)]" data-testid="graph-no-match">
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
                  className={`flex w-full flex-col gap-0.5 rounded-control px-2 py-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring ${
                    active ? 'bg-accent-soft active:bg-[var(--accent-soft-strong)]' : 'hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]'
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="shrink-0 rounded-control border-[0.5px] border-line px-1 text-subtle text-[length:var(--font-meta-size)]">
                      {KIND_LABELS[node.kind]}
                    </span>
                    <span className="knowledge-row-title min-w-0 text-ink">{node.label}</span>
                  </span>
                  {node.detail.length === 0 ? null : (
                    <span className="truncate text-muted text-[length:var(--font-meta-size)]">{nodeDetail(node)}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="px-3"><GraphPagination area="nodes" page={page} total={visibleNodes.length} onPage={setPage} /></div>
        </section>
        <aside className="knowledge-detail knowledge-graph-detail" aria-label="节点详情">
          {selectedNode === undefined ? (
            <div className="knowledge-graph-prompt" data-testid="graph-no-selection">
              <Compass size={32} strokeWidth={1.5} aria-hidden="true"/>
              <h3 className="text-ink">选择一个节点</h3>
            </div>
          ) : (
            <>
              <button type="button" className="knowledge-back knowledge-view-button" onClick={() => setBrowsing({open: true, focusKey})}><ArrowLeft size={14} aria-hidden="true"/>返回关系目录</button>
              <header className="knowledge-graph-detail-header">
                <div className="min-w-0">
                  <h3 className="break-words text-ink" data-testid="graph-detail-label">{selectedNode.label}</h3>
                  <p>{KIND_LABELS[selectedNode.kind]}{selectedNode.detail.length === 0 ? '' : ` / ${nodeDetail(selectedNode)}`}</p>
                </div>
                {onAskAssistantAboutNode === undefined ? null : (
                  <button type="button" onClick={() => onAskAssistantAboutNode(selectedNode)} data-testid="graph-ask-assistant"
                    className="knowledge-view-button shrink-0 border-[0.5px] border-line">
                    <Bot size={14} aria-hidden="true" className="text-[var(--icon-agent)]"/>问助手
                  </button>
                )}
              </header>
              <GraphNeighborhood selected={selectedNode} neighbors={neighbours} total={neighbourIds.length}/>
              <h4 className="shrink-0 text-muted text-[length:var(--font-meta-size)]" data-testid="graph-neighbour-count">相连及共享证据（{neighbourIds.length}）</h4>
              {neighbourIds.length === 0 ? (
                <p className="text-subtle" data-testid="graph-no-neighbours">这个节点没有任何已记录的关系。</p>
              ) : (
                <ul className="knowledge-neighbor-list flex-1 overflow-y-auto" aria-label="节点邻域" data-testid="graph-neighbours">
                  {neighbours.map(node => <li key={node.id}>
                    <button type="button" onClick={() => selectNode(node.id)} data-testid={`graph-neighbour-${node.id}`} className="knowledge-neighbor-button">
                      <span className="knowledge-relation-label">{graphRelationLabel(selectedNode, node)}</span>
                      <span className="min-w-0 break-words">{node.label}<span className="ml-2 text-muted text-[length:var(--font-meta-size)]">{KIND_LABELS[node.kind]}</span></span>
                    </button>
                  </li>)}
                </ul>
              )}
              <GraphPagination area="neighbours" page={neighbourPage} total={neighbourIds.length}
                onPage={value => setNeighbourPaging({nodeId: selectedNode.id, page: value})}/>
              <details className="knowledge-node-id shrink-0"><summary>节点标识</summary><p className="break-all" data-testid="graph-detail-id">{selectedNode.id}</p></details>
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
  const control = 'h-[var(--control-height-compact)] rounded-control border-[0.5px] border-line px-2 text-[length:var(--font-meta-size)] hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] disabled:opacity-40 disabled:pointer-events-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring';
  return (
    <nav aria-label={`${label}分页`} className="flex shrink-0 flex-wrap items-center gap-2 py-2" data-testid={`graph-${area}-pagination`}>
      <button type="button" className={control} disabled={page === 0} onClick={() => onPage(page - 1)} aria-label={`上一页${label}`}>上一页</button>
      <span className="text-muted text-[length:var(--font-meta-size)] tabular-nums" data-testid={`graph-${area}-page`}>{page + 1} / {pages}，共 {total} 项</span>
      <button type="button" className={control} disabled={page + 1 >= pages} onClick={() => onPage(page + 1)} aria-label={`下一页${label}`}>下一页</button>
    </nav>
  );
}
