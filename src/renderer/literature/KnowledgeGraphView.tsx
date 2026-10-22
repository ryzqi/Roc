import { useMemo, useState } from 'react';
import { Bot, Compass, ExternalLink, Search, X } from 'lucide-react';
import type { ResearchClaim, ResearchEvidence } from '../../shared/types';
import type { ResearchLibraryItem } from '../../shared/types';
import { EmptyState } from '../shell/EmptyState';
import { deriveGraph, graphNeighbors, GRAPH_LAYOUT_NODE_LIMIT, type GraphNode, type GraphNodeKind } from './derive-graph';

/**
 * Knowledge graph.
 *
 * Deliberately **not** a force layout. Two reasons, both measured rather than
 * aesthetic:
 *
 *   1. the legacy view needs a physics simulation to place nodes that came from
 *      mock data; with real data the graph is either empty (gate 4: draw nothing)
 *      or small enough that a deterministic layered list is readable;
 *   2. a simulation is the classic source of a "nice looking" picture that hides
 *      "there is nothing here". A list of real edges cannot lie.
 *
 * Above `GRAPH_LAYOUT_NODE_LIMIT` the view stays a list and says why (T5.7 / R11).
 * When the projection is empty this renders the empty state — never a placeholder
 * node, never a sample edge.
 *
 * Node kinds are text badges, not colours alone (AGENTS.md).
 *
 * ## Two interactions kept, one deliberately not
 *
 * The graph can have a text filter, a category filter, zoom controls, and
 * 「让助手扩展这个节点」.
 *
 *   - **Text filter** — ported. It is the only way to find a node once the graph
 *     is past a screenful, and it composes with the kind chips.
 *   - **Ask the assistant about a node** — ported, and routed through the shared
 *     literature store's `askAssistant` so the run lands in the same
 *     thread-adoption path the reader's 「问助手」 uses (`AppShell` opens the panel
 *     on the run's thread). Here the panel opens as part of the hand-off.
 *   - **Zoom in / out / reset** — **not** ported, because there is nothing to zoom:
 *     this is a deterministic list, not a canvas with a viewport transform. Shipping
 *     a zoom control that scales a list would be animation for its own sake and
 *     would imply a layout the view deliberately does not have.
 */

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
  const selectedNode: GraphNode | null = graph.nodes.find((node) => node.id === effectiveSelected) ?? null;
  const neighbours = selectedNode === null ? [] : graphNeighbors(graph, selectedNode.id);

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
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
        <span className="text-muted text-[var(--font-meta-size)]" data-testid="graph-counts">
          {graph.nodes.length} 节点 · {graph.links.length} 关系
        </span>
        <div className="ml-1 flex h-[var(--control-height-compact)] min-w-[150px] flex-1 items-center gap-1.5 rounded-control border border-line bg-surface px-2 sm:max-w-[220px]">
          <Search size={11} aria-hidden="true" className="shrink-0 text-subtle" />
          <input
            value={filterText}
            onChange={(event) => setFilterText(event.target.value)}
            placeholder="过滤节点…"
            aria-label="过滤图谱节点"
            data-testid="graph-filter-text"
            className="min-w-0 flex-1 bg-transparent text-ink text-[var(--font-micro-size)] placeholder:text-subtle"
          />
          {filterText.length === 0 ? null : (
            <button
              type="button"
              onClick={() => setFilterText('')}
              aria-label="清除节点过滤"
              data-testid="graph-filter-clear"
              className="shrink-0 rounded-control text-subtle hover:text-ink"
            >
              <X size={11} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="ml-1 flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => setKindFilter('all')}
            aria-pressed={kindFilter === 'all'}
            data-testid="graph-filter-all"
            className={
              kindFilter === 'all'
                ? 'h-[var(--control-height-compact)] rounded-control border border-line bg-accent-soft px-2 text-ink text-[var(--font-micro-size)]'
                : 'h-[var(--control-height-compact)] rounded-control border border-line px-2 text-muted text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)]'
            }
          >
            全部
          </button>
          {graph.kinds.map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => setKindFilter(kind)}
              aria-pressed={kindFilter === kind}
              data-testid={`graph-filter-${kind}`}
              className={
                kindFilter === kind
                  ? 'h-[var(--control-height-compact)] rounded-control border border-line bg-accent-soft px-2 text-ink text-[var(--font-micro-size)]'
                  : 'h-[var(--control-height-compact)] rounded-control border border-line px-2 text-muted text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)]'
              }
            >
              {KIND_LABELS[kind]} {graph.nodes.filter((node) => node.kind === kind).length}
            </button>
          ))}
        </div>
        {graph.nodes.length > GRAPH_LAYOUT_NODE_LIMIT ? (
          <span className="ml-auto text-[var(--st-warn)] text-[var(--font-micro-size)]" data-testid="graph-large">
            节点超过 {GRAPH_LAYOUT_NODE_LIMIT}：只提供列表与筛选（力导向布局会卡顿）。
          </span>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1">
        <ul className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="图谱节点" data-testid="graph-node-list">
          {visibleNodes.length === 0 ? (
            <li className="px-2 py-4 text-muted text-[var(--font-meta-size)]" data-testid="graph-no-match">
              没有匹配的节点。
            </li>
          ) : null}
          {visibleNodes.map((node) => {
            const active = node.id === effectiveSelected;
            return (
              <li key={node.id}>
                <button
                  type="button"
                  onClick={() => setSelectedNodeId(node.id === selectedNodeId ? null : node.id)}
                  aria-current={active ? 'true' : undefined}
                  data-testid={`graph-node-${node.id}`}
                  className={`flex w-full flex-col gap-0.5 rounded-control px-2 py-1 text-left ${
                    active ? 'bg-accent-soft active:bg-[var(--accent-soft-strong)]' : 'hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]'
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="shrink-0 rounded-control border border-line px-1 text-subtle text-[var(--font-micro-size)]">
                      {KIND_LABELS[node.kind]}
                    </span>
                    <span className="truncate text-ink text-[var(--font-meta-size)]">{node.label}</span>
                  </span>
                  {node.detail.length === 0 ? null : (
                    <span className="truncate text-muted text-[var(--font-micro-size)]">{node.detail}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>

        <aside className="hidden w-72 shrink-0 flex-col gap-2 border-l border-line p-3 lg:flex" aria-label="节点详情">
          {selectedNode === null ? (
            <p className="text-muted text-[var(--font-meta-size)]" data-testid="graph-no-selection">
              选一个节点查看它的关系。
            </p>
          ) : (
            <>
              <h3 className="text-ink" data-testid="graph-detail-label">
                {selectedNode.label}
              </h3>
              <p className="text-muted text-[var(--font-micro-size)]">
                {KIND_LABELS[selectedNode.kind]}
                {selectedNode.detail.length === 0 ? '' : ` · ${selectedNode.detail}`}
              </p>
              <p className="text-subtle text-[var(--font-micro-size)]" data-testid="graph-detail-id">
                {selectedNode.id}
              </p>
              <h4 className="mt-1 text-muted text-[var(--font-meta-size)]">直接相连（{neighbours.length}）</h4>
              {neighbours.length === 0 ? (
                <p className="text-subtle text-[var(--font-micro-size)]" data-testid="graph-no-neighbours">
                  这个节点没有任何已记录的关系。
                </p>
              ) : (
                <ul className="flex flex-col gap-0.5" data-testid="graph-neighbours">
                  {neighbours.map((node) => (
                    <li key={node.id} className="truncate text-ink text-[var(--font-micro-size)]">
                      <span className="mr-1 rounded-control border border-line px-1 text-subtle">{KIND_LABELS[node.kind]}</span>
                      {node.label}
                    </li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                onClick={() => setSelectedNodeId(selectedNode.id)}
                data-testid="graph-open-node"
                className="mt-1 flex h-[var(--control-height-compact)] items-center gap-1 self-start rounded-control border border-line px-2 text-ink text-[var(--font-meta-size)] hover:bg-[var(--overlay-hover)]"
              >
                <ExternalLink size={11} aria-hidden="true" />
                固定这个节点
              </button>
              {onAskAssistantAboutNode === undefined ? null : (
                <button
                  type="button"
                  onClick={() => onAskAssistantAboutNode(selectedNode)}
                  data-testid="graph-ask-assistant"
                  className="flex h-[var(--control-height-compact)] items-center gap-1 self-start rounded-control border border-line bg-surface px-2 font-medium text-ink text-[var(--font-meta-size)] hover:bg-[var(--surface-card-hover)] active:bg-[var(--overlay-active)]"
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
