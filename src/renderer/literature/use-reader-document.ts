import {useEffect, useRef, useState} from 'react';
import type {ResearchDocument, ResearchDocumentParse} from '../../shared/types';
import type {LiteratureStore} from './use-literature-store';
import {requestReadingChange} from './reading-interactions';

type ReaderState = {
  key: string; document: ResearchDocument | null; parsed: ResearchDocumentParse | null;
  loading: boolean; error: string | null
};
type ReaderSource = {
  key: string; scope: string; document: ResearchDocument | null; focusParseId: string | null
};

/** One explicit parse per selection. A late response has no authority over another selection. */
export function useReaderDocument(literature: LiteratureStore, focusParseId: string | null): {
  document: ResearchDocument | null; parsed: ResearchDocumentParse | null; loading: boolean; error: string | null;
  selectDocument: (documentId: string) => void
  retry: () => void; updateAvailable: boolean; acceptUpdate: () => void
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
  const scope = JSON.stringify([projectId, libraryItemId]);
  const requestedKey = JSON.stringify([scope, focusParseId, documentId, focusParseId === null ? currentParseId : null, sourceHash, revision]);
  const requested: ReaderSource = {key: requestedKey, scope, document: selectedDocument, focusParseId};
  const requestedRef = useRef(requested); requestedRef.current = requested;
  const [accepted, setAccepted] = useState(requested);
  // A background refresh must release the source's editors before replacing their parse.
  // A different project/item never renders the previous scope under its new header.
  const source = accepted.scope === scope ? accepted : requested;
  const key = source.key;
  const acceptUpdate = (): void => {
    const next = requestedRef.current;
    requestReadingChange(projectId ?? '', () => {
      if (requestedRef.current.key === next.key && requestedRef.current.scope === next.scope) setAccepted(next);
    });
  };
  useEffect(() => {
    if (requestedKey === accepted.key) return;
    if (scope !== accepted.scope) {setAccepted(requestedRef.current); return;}
    acceptUpdate();
  }, [requestedKey, scope, accepted.key, accepted.scope]);
  const [state, setState] = useState<ReaderState | null>(null);

  useEffect(() => {
    let cancelled = false;
    const ordinaryDocument = source.document, retainedFocus = source.focusParseId;
    const update = (next: Omit<ReaderState, 'key'>): void => {
      if (!cancelled) setState({key, ...next});
    };
    update({document: retainedFocus === null ? ordinaryDocument : null, parsed: null, loading: true, error: null});
    void (async () => {
      if (libraryItemId === null) {update({document: null, parsed: null, loading: false, error: null}); return;}
      if (projectId === null) throw new Error('请先进入项目再读取文档。');
      let document = ordinaryDocument;
      if (retainedFocus !== null) {
        const resolved = await client.api.research.resolveDocumentParse({projectId, parseId: retainedFocus});
        if (cancelled) return;
        if (!resolved.ok) throw new Error(resolved.error.message);
        document = resolved.data;
        if (document.libraryItemId !== libraryItemId) throw new Error('所选解析不属于当前文献，无法定位。');
      }
      if (document === null) {update({document: null, parsed: null, loading: false, error: null}); return;}
      const parseId = retainedFocus ?? document.currentParseId;
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
  }, [client, projectId, libraryItemId, key, loadDocumentContent]);

  const current = state?.key === key ? state : null;
  const retainedDocument = current?.document ?? null;
  const document = retainedDocument === null ? null : documents.find(value =>
    value.id === retainedDocument.id && value.sourceHash === retainedDocument.sourceHash) ?? retainedDocument;
  return {
    document, parsed: current?.parsed ?? null,
    loading: current === null ? libraryItemId !== null && (source.document !== null || source.focusParseId !== null) : current.loading,
    error: current?.error ?? null,
    selectDocument: documentId => setSelection({libraryItemId, documentId}),
    retry: () => setRevision(revision => revision + 1),
    updateAvailable: key !== requestedKey, acceptUpdate
  };
}
