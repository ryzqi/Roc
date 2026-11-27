import type {ReactNode} from 'react';
import type {ResearchLibraryItem} from '../../shared/types';
import {formatAuthorList, formatDoi, formatYear, libraryItemTitle, readVenue} from './format';
import './PaperMetaCard.css';

export type PaperMetaCardProps = {
  item: ResearchLibraryItem;
  children?: ReactNode;
  dense?: boolean;
  showIdentifiers?: boolean;
};

/** Flat metadata shared by the library row and Inspector; owns no actions or requests. */
export function PaperMetaCard({
  item,
  children,
  dense = false,
  showIdentifiers = false
}: PaperMetaCardProps): React.JSX.Element {
  const title = libraryItemTitle(item);
  const authors = formatAuthorList(item.metadata.authors, dense ? 2 : Number.MAX_SAFE_INTEGER);
  const allAuthors = formatAuthorList(item.metadata.authors, Number.MAX_SAFE_INTEGER);
  const venue = readVenue(item.bibliography);
  const doi = showIdentifiers ? formatDoi(item.metadata.doi) : null;
  const arxiv = showIdentifiers
    ? (item.metadata.source === 'arxiv' ? item.metadata.externalId
      : item.sources.find(source => source.metadata.source === 'arxiv')?.metadata.externalId)?.trim()
    : undefined;

  return <div className="paper-meta-card" data-dense={dense}>
    <span className="paper-meta-card__title" title={title}>{title}</span>
    <div className="paper-meta-card__metadata">
      <span className="paper-meta-card__authors" title={allAuthors}>{authors}</span>
      <span className="paper-meta-card__year">{formatYear(item.metadata.publishedYear)}</span>
      {venue === null ? null : <span className="paper-meta-card__venue" title={venue}>{venue}</span>}
      <span className="paper-meta-card__citekey" title={item.bibliography.citationKey}>
        <span className="paper-meta-card__hidden">引用键 </span>{item.bibliography.citationKey}
      </span>
    </div>
    {doi === null && !arxiv ? null : <div className="paper-meta-card__identifiers">
      {doi === null ? null : <span>DOI {doi}</span>}
      {!arxiv ? null : <span>arXiv {arxiv}</span>}
    </div>}
    {children === undefined || children === null ? null : <div className="paper-meta-card__content">{children}</div>}
  </div>;
}
