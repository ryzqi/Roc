import {useEffect, useState} from 'react';
import type {ResearchDocument, ResearchDocumentParse} from '../../shared/types';
import type {LiteratureStore} from './use-literature-store';

type ReaderState = {
  key: string; document: ResearchDocument | null; parsed: ResearchDocumentParse | null;
  loading: boolean; error: string | null
};

/** One explicit parse per selection. A late response has no authority over another selection. */
export function useReaderDocument(literature: LiteratureStore, focusParseId: string | null): {
  document: ResearchDocument | null; parsed: ResearchDocumentParse | null; loading: boolean; error: string | null;
  selectDocument: (documentId: string) => void
  retry: () => void
} {
  const {client, projectId, documents, loadDocumentContent} = literature;
  const libraryItemId = literature.selected?.id ?? null;
  const [selection, setSelection] = useState<{libraryItemId: string | null; documentId: string} | null>(null);
  const [revision, setRevision] = useState(0);
  const selectedDocument = selection?.libraryItemId === libraryItemId
    ? documents.find(document => document.id === selection.documentId) ?? null : documents[0] ?? null;
  const documentId = selectedDocument?.id ?? null;
  const currentParseId = selectedDocument?.currentParseId ?? null;
  const sourceHash = selectedDocument?.sourceHash ?? null;
  const key = JSON.stringify([projectId, libraryItemId, focusParseId, documentId, currentParseId, sourceHash, revision]);
  const [state, setState] = useState<ReaderState | null>(null);

  useEffect(() => {
    let cancelled = false;
    const ordinaryDocument = selectedDocument;
    const update = (next: Omit<ReaderState, 'key'>): void => {
      if (!cancelled) setState({key, ...next});
    };
    update({document: focusParseId === null ? ordinaryDocument : null, parsed: null, loading: true, error: null});
    void (async () => {
      if (libraryItemId === null) {update({document: null, parsed: null, loading: false, error: null}); return;}
      if (projectId === null) throw new Error('请先进入项目再读取文档。');
      let document = ordinaryDocument;
      if (focusParseId !== null) {
        const resolved = await client.api.research.resolveDocumentParse({projectId, parseId: focusParseId});
        if (cancelled) return;
        if (!resolved.ok) throw new Error(resolved.error.message);
        document = resolved.data;
        if (document.libraryItemId !== libraryItemId) throw new Error('所选解析不属于当前文献，无法定位。');
      }
      if (document === null) {update({document: null, parsed: null, loading: false, error: null}); return;}
      const parseId = focusParseId ?? document.currentParseId;
      if (parseId === null) {update({document, parsed: null, loading: false, error: null}); return;}
      const result = await loadDocumentContent({projectId, documentId: document.id, parseId, sourceHash: document.sourceHash, parseHash: null});
      if (cancelled) return;
      if (!result.ok) throw new Error(result.error.message);
      if (result.data.run.id !== parseId || result.data.run.documentId !== document.id ||
          result.data.content.sourceHash !== document.sourceHash) throw new Error('返回的解析与所选文档版本不一致。');
      update({document, parsed: result.data, loading: false, error: null});
    })().catch((error: unknown) => update({document: null, parsed: null, loading: false,
      error: error instanceof Error ? error.message : String(error)}));
    return () => {cancelled = true;};
    // Selection primitives define identity; refreshed objects alone do not replace a fixed parse.
  }, [client, projectId, libraryItemId, focusParseId, documentId, currentParseId, sourceHash, key, loadDocumentContent]);

  const current = state?.key === key ? state : null;
  return {
    document: current?.document ?? null, parsed: current?.parsed ?? null,
    loading: current === null ? libraryItemId !== null && (documentId !== null || focusParseId !== null) : current.loading,
    error: current?.error ?? null,
    selectDocument: documentId => setSelection({libraryItemId, documentId}),
    retry: () => setRevision(revision => revision + 1)
  };
}
