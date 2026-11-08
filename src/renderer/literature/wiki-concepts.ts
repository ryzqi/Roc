import type {ResearchClaim, ResearchEvidence} from '../../shared/types';
import type {ResearchWikiSnapshot} from '../../shared/schemas/research-wiki';

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


/** Command palette needs summaries only; no excerpts, paper joins or shared-neighbor expansion. */
export function wikiConceptRows(claims: readonly ResearchClaim[], evidence: readonly ResearchEvidence[],
  relations: ResearchWikiSnapshot['relations'] = []): Array<{id: string; label: string; subtitle: string}> {
  const loaded = new Set(evidence.map(record => record.id));
  const endpoints = new Map<string, Set<string>>();
  for (const relation of relations) {
    if (!loaded.has(relation.evidenceId)) continue;
    const ids = endpoints.get(relation.claimId) ?? new Set<string>();
    ids.add(relation.evidenceId);
    endpoints.set(relation.claimId, ids);
  }
  return claims.map(claim => {
    const ids = new Set([...claim.evidenceIds.filter(id => loaded.has(id)), ...(endpoints.get(claim.id) ?? [])]);
    return {id: claim.id, label: conceptTitle(claim.content), subtitle: ids.size === 0 ? '尚无引用证据' : `引用 ${ids.size} 条证据`};
  });
}
