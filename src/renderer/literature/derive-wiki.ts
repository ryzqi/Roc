import type {ResearchWikiSnapshot} from '../../shared/schemas/research-wiki';
import type { ResearchClaim, ResearchEvidence, ResearchLibraryItem } from '../../shared/types';

/**
 * Derived LLM-Wiki projection.
 *
 * **Pure functions over real data only.** The legacy `LlmWikiView` shipped a
 * `mockWikiEntries` array and rendered it when the store was empty, which is
 * exactly the failure R12 warns about: a derived view that looks populated while
 * the backend has nothing. Nothing here invents content — with no claims and no
 * evidence the result is an empty list and the view shows its empty state.
 *
 * What a "concept" is, given that the backend has no concept table:
 *
 *   - claims are the unit of knowledge (`research.claims.list`);
 *   - each claim points at evidence ids (`evidenceIds`), which resolve to
 *     `research.evidence.list` records;
 *   - a concept page is therefore **one claim plus its evidence**, and the graph
 *     edges between concepts are the evidence they share.
 *
 * That is a projection, not a model: two claims that happen to cite the same
 * paper are not claimed to be "about the same thing". The UI says so, and every
 * card names the interfaces it came from.
 */

export type WikiEvidenceCard = {
  id: string;
  title: string;
  excerpt: string;
  locator: string;
  sourceType: ResearchEvidence['sourceType'];
  sourceId: string;
  /** Set when this evidence came from a retrieval hit, so the reader can jump. */
  chunkId: string;
  referenceStatus: 'recorded' | 'superseded' | 'unknown';
  relations: ResearchWikiSnapshot['relations'];
};

export type WikiRelatedPaper = {
  libraryItemId: string;
  title: string;
  year: number | null;
};

export type WikiConceptPage = {
  claimId: string;
  title: string;
  content: string;
  status: ResearchClaim['status'];
  review: 'unreviewed' | 'confirmed' | 'qualified' | 'contradicted' | 'stale';
  evidence: WikiEvidenceCard[];
  /** `research.library.*` items this claim's evidence resolves to. */
  papers: WikiRelatedPaper[];
  /** True when the claim cites evidence that is not in the loaded evidence list. */
  hasMissingEvidence: boolean;
};

export type WikiTimelineEntry = {
  year: number;
  claimIds: string[];
};

export type WikiBacklink = {
  fromClaimId: string;
  toClaimId: string;
  /** Evidence ids both claims cite. Never empty. */
  sharedEvidenceIds: string[];
};

export type WikiProjection = {
  pages: WikiConceptPage[];
  timeline: WikiTimelineEntry[];
  backlinks: WikiBacklink[];
  /** Evidence records that no claim references (shown as "未归类证据"). */
  orphanEvidence: WikiEvidenceCard[];
};

/** Short, stable title for a claim: its first sentence/line, trimmed. */
export function conceptTitle(content: string, maxLength = 48): string {
  const collapsed = content.replace(/\s+/gu, ' ').trim();
  if (collapsed.length === 0) {
    return '（无内容主张）';
  }
  const firstSentence = collapsed.split(/(?<=[。．.!?！？])\s*/u)[0] ?? collapsed;
  const base = firstSentence.length > 0 ? firstSentence : collapsed;
  return base.length <= maxLength ? base : `${base.slice(0, maxLength - 1)}…`;
}

function toEvidenceCard(evidence: ResearchEvidence): WikiEvidenceCard {
  return {
    id: evidence.id,
    title: evidence.title,
    excerpt: evidence.excerpt,
    locator: evidence.locator,
    sourceType: evidence.sourceType,
    sourceId: evidence.sourceId,
    chunkId: evidence.chunkId,
    referenceStatus: 'unknown',
    relations: []
  };
}

/**
 * Evidence rows carry `sourceId`, which for `sourceType: 'literature'` is the
 * library item id — that is what makes "which paper does this claim lean on"
 * answerable from real data.
 */
function papersForEvidence(
  evidence: readonly ResearchEvidence[],
  libraryItems: readonly ResearchLibraryItem[]
): WikiRelatedPaper[] {
  const byId = new Map(libraryItems.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const papers: WikiRelatedPaper[] = [];
  for (const record of evidence) {
    if (record.sourceType !== 'literature' || seen.has(record.sourceId)) {
      continue;
    }
    seen.add(record.sourceId);
    const item = byId.get(record.sourceId);
    if (item !== undefined) {
      papers.push({
        libraryItemId: item.id,
        title: item.metadata.title.trim().length > 0 ? item.metadata.title : item.bibliography.title,
        year: item.metadata.publishedYear
      });
    }
  }
  return papers;
}

export function deriveWiki(input: {
  claims: readonly ResearchClaim[];
  evidence: readonly ResearchEvidence[];
  libraryItems: readonly ResearchLibraryItem[];
  snapshot?: ResearchWikiSnapshot;
}): WikiProjection {
  const evidenceById = new Map(input.evidence.map((record) => [record.id, record]));

  const sources = new Map(input.snapshot?.sources.map(source => [source.evidence.id, source]));
  const relationsByClaim = new Map<string, ResearchWikiSnapshot['relations']>();
  for (const relation of input.snapshot?.relations ?? []) {
    const group = relationsByClaim.get(relation.claimId) ?? [];
    group.push(relation);
    relationsByClaim.set(relation.claimId, group);
  }
  const pages: WikiConceptPage[] = input.claims.map((claim) => {
    const relations = relationsByClaim.get(claim.id) ?? [];
    const ids = [...new Set([...claim.evidenceIds, ...relations.map(relation => relation.evidenceId)])];
    const evidence = ids.flatMap(id => {
      const record = evidenceById.get(id);
      return record === undefined ? [] : [{...toEvidenceCard(record),
        referenceStatus: sources.get(id)?.referenceStatus ?? 'unknown' as const,
        relations: relations.filter(relation => relation.evidenceId === id)}];
    });
    const current = relations.filter(relation => relation.status === 'confirmed' && relation.claimVersion === claim.version &&
      sources.get(relation.evidenceId)?.referenceStatus === 'recorded');
    const supports = current.filter(relation => relation.kind === 'supports' || relation.kind === 'qualifies');
    const review: WikiConceptPage['review'] = current.some(relation => relation.kind === 'contradicts') ? 'contradicted' :
      evidence.some(card => claim.evidenceIds.includes(card.id) && card.referenceStatus === 'superseded') ? 'stale' :
      claim.evidenceIds.length > 0 && claim.evidenceIds.every(id => supports.some(relation => relation.evidenceId === id)) ?
        supports.some(relation => relation.kind === 'qualifies') ? 'qualified' : 'confirmed' :
      relations.some(relation => relation.status === 'invalidated') ? 'stale' : 'unreviewed';
    return {
      claimId: claim.id, title: conceptTitle(claim.content), content: claim.content, status: claim.status,
      review, evidence,
      papers: papersForEvidence(ids.flatMap(id => evidenceById.has(id) ? [evidenceById.get(id)!] : []), input.libraryItems),
      hasMissingEvidence: evidence.length !== ids.length
    };
  });

  // Timeline uses real years only: a claim without a dated paper is not placed
  // on a timeline at an invented date.
  const yearsByClaim = new Map<string, number>();
  for (const page of pages) {
    const years = page.papers.map((paper) => paper.year).filter((year): year is number => year !== null);
    if (years.length > 0) {
      yearsByClaim.set(page.claimId, Math.min(...years));
    }
  }
  const timelineByYear = new Map<number, string[]>();
  for (const [claimId, year] of yearsByClaim) {
    timelineByYear.set(year, [...(timelineByYear.get(year) ?? []), claimId]);
  }
  const timeline: WikiTimelineEntry[] = [...timelineByYear.entries()]
    .map(([year, claimIds]) => ({ year, claimIds: [...claimIds].sort() }))
    .sort((left, right) => left.year - right.year);

  // Backlinks = shared evidence. Computed pairwise but bounded by a per-claim
  // inverse index, so this stays linear in the number of evidence links rather
  // than quadratic in claims.
  const claimsByEvidence = new Map<string, string[]>();
  for (const claim of input.claims) {
    for (const evidenceId of new Set(claim.evidenceIds)) {
      claimsByEvidence.set(evidenceId, [...(claimsByEvidence.get(evidenceId) ?? []), claim.id]);
    }
  }
  const shared = new Map<string, string[]>();
  for (const [evidenceId, claimIds] of claimsByEvidence) {
    if (claimIds.length < 2) {
      continue;
    }
    for (const left of claimIds) {
      for (const right of claimIds) {
        if (left === right) {
          continue;
        }
        const key = `${left}\u0000${right}`;
        shared.set(key, [...(shared.get(key) ?? []), evidenceId]);
      }
    }
  }
  const claimOrder = new Map(input.claims.map((claim, index) => [claim.id, index]));
  const backlinks: WikiBacklink[] = [...shared.entries()]
    .map(([key, sharedEvidenceIds]) => {
      const [fromClaimId, toClaimId] = key.split('\u0000') as [string, string];
      return { fromClaimId, toClaimId, sharedEvidenceIds: [...sharedEvidenceIds].sort() };
    })
    .filter((link) => (claimOrder.get(link.fromClaimId) ?? 0) < (claimOrder.get(link.toClaimId) ?? 0))
    .sort(
      (left, right) =>
        (claimOrder.get(left.fromClaimId) ?? 0) - (claimOrder.get(right.fromClaimId) ?? 0) ||
        (claimOrder.get(left.toClaimId) ?? 0) - (claimOrder.get(right.toClaimId) ?? 0)
    );

  const referenced = new Set(pages.flatMap(page => page.evidence.map(card => card.id)));
  const orphanEvidence = input.evidence
    .filter((record) => !referenced.has(record.id))
    .map(record => ({...toEvidenceCard(record), referenceStatus: sources.get(record.id)?.referenceStatus ?? 'unknown' as const}));

  return { pages, timeline, backlinks, orphanEvidence };
}
