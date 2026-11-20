import type { ResearchClaim, ResearchEvidence, ResearchIndexedFile, ResearchLibraryItem } from '../../shared/types';

/** Project only recorded relations. Shared-evidence neighbors are expanded on demand, without a claim clique. */

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
  kind: 'cites' | 'sourced-from';
};

export type KnowledgeGraph = {
  nodes: GraphNode[];
  links: GraphLink[];
  /** Node kinds present, so the view can offer only meaningful filters. */
  kinds: GraphNodeKind[];
  nodeById: Map<string, GraphNode>;
  nodeOrder: Map<string, number>;
  adjacent: Map<string, Set<string>>;
  claimsByEvidence: Map<string, Set<string>>;
  evidenceByClaim: Map<string, Set<string>>;
};

export const GRAPH_PAGE_SIZE = 50;

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
  const claimsByEvidence = new Map<string, Set<string>>();
  const evidenceByClaim = new Map<string, Set<string>>();

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
        item.metadata.authors.length === 0 ? '作者未知' : item.metadata.authors.slice(0, 2).join(', '),
        item.metadata.publishedYear === null ? null : String(item.metadata.publishedYear)
      ]
        .filter((part): part is string => part !== null)
        .join(' / ')
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
        : nodeIds.has(`file:${record.sourceId}`)
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
      const evidenceNodeId = `evidence:${evidenceId}`;
      const claimNodeId = `claim:${claim.id}`;
      addRelation(claimsByEvidence, evidenceNodeId, claimNodeId);
      addRelation(evidenceByClaim, claimNodeId, evidenceNodeId);
    }
  }

  const adjacent = new Map<string, Set<string>>();
  for (const link of links) {
    addRelation(adjacent, link.source, link.target);
    addRelation(adjacent, link.target, link.source);
  }
  const kinds = [...new Set(nodes.map((node) => node.kind))];

  return {
    nodes, links, kinds, adjacent, claimsByEvidence, evidenceByClaim,
    nodeById: new Map(nodes.map(node => [node.id, node])),
    nodeOrder: new Map(nodes.map((node, index) => [node.id, index]))
  };
}

function addRelation(index: Map<string, Set<string>>, source: string, target: string): void {
  let targets = index.get(source);
  if (targets === undefined) {
    targets = new Set<string>();
    index.set(source, targets);
  }
  targets.add(target);
}

/** Expand only the selected neighborhood, in projection order. */
export function graphNeighborIds(graph: KnowledgeGraph, nodeId: string): string[] {
  const neighbours = new Set(graph.adjacent.get(nodeId));
  for (const evidenceId of graph.evidenceByClaim.get(nodeId) ?? []) {
    for (const claimId of graph.claimsByEvidence.get(evidenceId)!) {
      neighbours.add(claimId);
    }
  }
  neighbours.delete(nodeId);
  return [...neighbours].sort((left, right) => graph.nodeOrder.get(left)! - graph.nodeOrder.get(right)!);
}

export function graphNeighbors(
  graph: KnowledgeGraph,
  request: { nodeId: string; offset: number; limit: number }
): { nodes: GraphNode[]; total: number } {
  const ids = graphNeighborIds(graph, request.nodeId);
  return {
    total: ids.length,
    nodes: ids.slice(request.offset, request.offset + request.limit).map(id => graph.nodeById.get(id)!)
  };
}
