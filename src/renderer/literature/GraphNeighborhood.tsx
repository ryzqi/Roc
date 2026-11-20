import {useId} from 'react';
import type {GraphNode} from './derive-graph';

export function graphRelationLabel(selected: GraphNode, neighbor: GraphNode): string {
  if (selected.kind === 'claim') return neighbor.kind === 'claim' ? '共享证据' : '引用证据';
  if (selected.kind === 'evidence') return neighbor.kind === 'claim' ? '被主张引用' : '原始来源';
  return '提供证据';
}

/** A bounded visual explanation of real adjacency; the complete keyboard list follows it. */
export function GraphNeighborhood({selected, neighbors, total}: {
  selected: GraphNode; neighbors: readonly GraphNode[]; total: number;
}): React.JSX.Element | null {
  const marker = useId().replaceAll(':', '');
  if (neighbors.length === 0) return null;
  const preview = neighbors.slice(0, 4);
  const height = Math.max(112, preview.length * 48 + 16);
  const center = height / 2;
  const title = (value: string, length: number): string => value.length > length ? `${value.slice(0, length - 1)}…` : value;
  return <figure className="knowledge-neighborhood" data-testid="graph-neighborhood-map">
    <svg viewBox={`0 0 540 ${height}`} role="img" aria-label={`${selected.label}的关系概览；完整关系见下方列表`}>
      <defs><marker id={marker} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto-start-reverse"><path d="M0 0L6 3L0 6Z"/></marker></defs>
      <rect className="graph-selected" x="4" y={center - 24} width="176" height="48" rx="8"/>
      <text x="16" y={center + 5}>{title(selected.label, 18)}</text>
      {preview.map((node, index) => {
        const y = 32 + index * 48;
        const incoming = (selected.kind === 'evidence' && node.kind === 'claim') || selected.kind === 'paper' || selected.kind === 'file';
        const shared = selected.kind === 'claim' && node.kind === 'claim';
        return <g key={node.id}>
          <path d={`M180 ${center} C224 ${center}, 248 ${y}, 320 ${y}`}
            strokeDasharray={shared ? '4 4' : undefined}
            markerStart={incoming ? `url(#${marker})` : undefined} markerEnd={incoming || shared ? undefined : `url(#${marker})`}/>
          <text className="graph-edge-label" x="246" y={y - 7} textAnchor="middle">{graphRelationLabel(selected, node)}</text>
          <rect x="324" y={y - 20} width="212" height="40" rx="8"/>
          <text x="336" y={y + 5}>{title(node.label, 22)}</text>
        </g>;
      })}
    </svg>
    <figcaption>{total > preview.length ? `显示本页前 ${preview.length} 项关系，全部 ${total} 项可在下方翻页查看。` : '实线表示直接引用或来源；虚线表示共享证据。'}</figcaption>
  </figure>;
}
