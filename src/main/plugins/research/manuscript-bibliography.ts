import type {ResearchEvidence} from '../../../shared/types';
import type {BibliographyEntry, ResearchLibraryRepository} from './library-repository';
import {escapeLatex} from './latex-source';

export function manuscriptBibliographyEntry(evidence: ResearchEvidence, library: Pick<ResearchLibraryRepository, 'get'>): BibliographyEntry {
  if (evidence.sourceType === 'literature') {
    const item = library.get(evidence.sourceId);
    if (item.archived) throw new Error('research_export_reference_archived');
    return item.bibliography;
  }
  return {citationKey: evidence.id, entryType: 'misc', fields: {title: escapeLatex(evidence.title),
    note: escapeLatex(`${evidence.sourceType}: ${evidence.sourceId}`)}, preambles: [], csl: null, title: evidence.title,
    authors: [], doi: null, publishedYear: null, abstract: null, url: null};
}
