/** Literature canvas tabs use local component state within the existing shell. */
export type LiteratureSubView = 'reader' | 'rag' | 'wiki' | 'graph' | 'monitors';

/** The import dialog's tabs; `?import=`-style deep links are deliberately absent. */
export type ImportTabRequest = 'document' | 'doi' | 'bibliography' | 'manual' | 'search' | 'zotero';
