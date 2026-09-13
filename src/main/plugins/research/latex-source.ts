import type { ResearchClaim, ResearchEvidence, ResearchManuscript } from '../../../shared/types';

export function renderManuscriptLatex(sections: ResearchManuscript['sections'], claims: ResearchClaim[], evidence: ResearchEvidence[]): string {
  return `${renderSections(sections, claims, Object.fromEntries(evidence.map((source) => [source.id, source.id])))}\n\n${renderEvidenceBibliography(evidence)}`;
}

export function renderSections(sections: ResearchManuscript['sections'], claims: ResearchClaim[], citationKeys: Readonly<Record<string, string>>): string {
  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  return sections.map((section) => [
    `\\section{${escapeLatex(section.title)}}`,
    ...section.claimIds.map((id) => {
      const claim = byId.get(id);
      if (claim === undefined) throw new Error('research_claim_not_found');
      return `% claim: ${id}; version: ${claim.version}\n${escapeLatex(claim.content)}${renderCitations(claim.evidenceIds, citationKeys)}`;
    })
  ].join('\n\n')).join('\n\n');
}

export function renderCitations(evidenceIds: readonly string[], citationKeys: Readonly<Record<string, string>>): string {
  const keys = evidenceIds.map((id) => {
    const key = citationKeys[id];
    if (key === undefined) throw new Error('research_citation_key_required');
    return key;
  });
  return `\\cite{${keys.join(',')}}`;
}

export function renderEvidenceBibliography(evidence: ResearchEvidence[]): string {
  const bibliography = evidence.map((source) =>
    `% source-version: ${source.sourceVersion}; excerpt-hash: ${source.contentHash}\n` +
    `\\bibitem{${source.id}} ${escapeLatex(source.title)}. ${escapeLatex(source.sourceId)}. ${escapeLatex(source.locator)}.`
  ).join('\n');
  return `\\begin{thebibliography}{99}\n${bibliography}\n\\end{thebibliography}\n`;
}

export function escapeLatex(text: string): string {
  const replacements: Record<string, string> = {
    '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '%': '\\%', '&': '\\&',
    '#': '\\#', '_': '\\_', '$': '\\$', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}'
  };
  return text.replace(/[\\{}%&#_$~^]/gu, (character) => replacements[character]);
}
