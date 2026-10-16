import type { ResearchClaim, ResearchEvidence, ResearchIndexedFile, ResearchLibraryItem } from '../../shared/types';

/**
 * Derived knowledge-graph projection (T5.7, ADR-M10).
 *
 * Same discipline as `derive-wiki.ts`: pure, real data only, and **no graph when
 * there is no data** (R12 / gate 4). The legacy view seeded a layout with mock
 * nodes, which is the one thing a derived view must never do.
 *
 * Nodes are the three things the backend actually stores — library items,
 * claims, and evidence — plus project-indexed files, which are the only other
 * first-class "thing" with an id in the contract. Edges are only relations the
 * data itself expresses:
 *
 *   - claim → evidence (the claim cites it)
 *   - evidence → library item / indexed file (where the evidence came from)
 *   - claim ↔ claim (shared evidence; the same edge list the wiki backlinks use)
 *
 * Deliberately absent: any "related concepts" edge derived from title similarity.
 * That would be an invented relation, and a graph full of invented edges is worse
 * than an empty graph.
 */

export type GraphNodeKind = 'paper' | 'claim' | 'evidence' | 'file';

export type GraphNode = {
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** Secondary line in the detail panel; never a synthetic score. */
  detail: string;
};

export type GraphLink = {
  id: string;
  source: string;
  target: string;
  kind: 'cites' | 'sourced-from' | 'shares-evidence';
};

export type KnowledgeGraph = {
  nodes: GraphNode[];
  links: GraphLink[];
  /** Node kinds present, so the view can offer only meaningful filters. */
  kinds: GraphNodeKind[];
};

/** Above this node count the view degrades to a filtered list (T5.7 / R11). */
export const GRAPH_LAYOUT_NODE_LIMIT = 300;

function paperLabel(item: ResearchLibraryItem): string {
  const title = item.metadata.title.trim();
  return title.length > 0 ? title : item.bibliography.title.trim().length > 0 ? item.bibliography.title : '（无题名）';
}

export function deriveGraph(input: {
  claims: readonly ResearchClaim[];
  evidence: readonly ResearchEvidence[];
  libraryItems: readonly ResearchLibraryItem[];
  indexedFiles?: readonly ResearchIndexedFile[];
}): KnowledgeGraph {
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];
  const nodeIds = new Set<string>();

  const addNode = (node: GraphNode): void => {
    if (nodeIds.has(node.id)) {
      return;
    }
    nodeIds.add(node.id);
    nodes.push(node);
  };

  for (const item of input.libraryItems) {
    addNode({
      id: `paper:${item.id}`,
      kind: 'paper',
      label: paperLabel(item),
      detail: [
        item.metadata.authors.length === 0 ? '作者未知' : item.metadata.authors.slice(0, 2).join(' · '),
        item.metadata.publishedYear === null ? null : String(item.metadata.publishedYear)
      ]
        .filter((part): part is string => part !== null)
        .join(' · ')
    });
  }

  for (const file of input.indexedFiles ?? []) {
    addNode({
      id: `file:${file.id}`,
      kind: 'file',
      label: file.path,
      detail: file.status
    });
  }

  for (const record of input.evidence) {
    addNode({
      id: `evidence:${record.id}`,
      kind: 'evidence',
      label: record.title,
      detail: record.locator
    });
    // Where the evidence came from, using only ids the record carries.
    const sourceNodeId =
      record.sourceType === 'literature'
        ? `paper:${record.sourceId}`
        : (input.indexedFiles ?? []).some((file) => file.id === record.sourceId)
          ? `file:${record.sourceId}`
          : null;
    if (sourceNodeId !== null && nodeIds.has(sourceNodeId)) {
      links.push({
        id: `sourced-from:${record.id}:${sourceNodeId}`,
        source: `evidence:${record.id}`,
        target: sourceNodeId,
        kind: 'sourced-from'
      });
    }
  }

  for (const claim of input.claims) {
    addNode({
      id: `claim:${claim.id}`,
      kind: 'claim',
      label: claim.content.replace(/\s+/gu, ' ').trim().slice(0, 60),
      detail: claim.status
    });
    for (const evidenceId of new Set(claim.evidenceIds)) {
      if (!nodeIds.has(`evidence:${evidenceId}`)) {
        continue;
      }
      links.push({
        id: `cites:${claim.id}:${evidenceId}`,
        source: `claim:${claim.id}`,
        target: `evidence:${evidenceId}`,
        kind: 'cites'
      });
    }
  }

  // claim ↔ claim: shared evidence, deduplicated to one edge per pair.
  const claimsByEvidence = new Map<string, string[]>();
  for (const claim of input.claims) {
    for (const evidenceId of new Set(claim.evidenceIds)) {
      claimsByEvidence.set(evidenceId, [...(claimsByEvidence.get(evidenceId) ?? []), claim.id]);
    }
  }
  const seenPairs = new Set<string>();
  for (const claimIds of claimsByEvidence.values()) {
    if (claimIds.length < 2) {
      continue;
    }
    for (const left of claimIds) {
      for (const right of claimIds) {
        if (left === right) {
          continue;
        }
        const pair = [left, right].sort().join('\u0000');
        if (seenPairs.has(pair)) {
          continue;
        }
        seenPairs.add(pair);
        links.push({
          id: `shares-evidence:${pair.replace('\u0000', ':')}`,
          source: `claim:${left}`,
          target: `claim:${right}`,
          kind: 'shares-evidence'
        });
      }
    }
  }

  // Drop links whose endpoints are not both rendered: a layout with a dangling
  // edge either throws or silently invents a node.
  const visible = new Set(nodes.map((node) => node.id));
  const visibleLinks = links.filter((link) => visible.has(link.source) && visible.has(link.target));
  const kinds = [...new Set(nodes.map((node) => node.kind))];

  return { nodes, links: visibleLinks, kinds };
}

/** Nodes adjacent to the given one, for the detail panel. */
export function graphNeighbors(graph: KnowledgeGraph, nodeId: string): GraphNode[] {
  const neighbours = new Set<string>();
  for (const link of graph.links) {
    if (link.source === nodeId) {
      neighbours.add(link.target);
    } else if (link.target === nodeId) {
      neighbours.add(link.source);
    }
  }
  return graph.nodes.filter((node) => neighbours.has(node.id));
}
