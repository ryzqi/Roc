import {useEffect, useRef, useState} from 'react';
import type {LiteratureImportResult} from '../../shared/schemas/literature-import';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction} from '../app/use-async-resource';

export type ZoteroSelection = {previewId: string; itemKey: string; title: string};

/** Kept in the dialog so closing or changing tabs does not discard an active import receipt. */
export function useZoteroImportJob(client: RocClient, projectId: string | null, onImported: () => void) {
  const [result, setResult] = useState<LiteratureImportResult | null>(null);
  const [selection, setSelection] = useState<ZoteroSelection[]>([]);
  const [cancelRequested, setCancelRequested] = useState(false);
  const requests = useRef(new Map<string, string>());
  const currentRequest = useRef<string | null>(null);
  const pending = useRef(false);
  const cancelling = useRef(false);
  const cancelled = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {mounted.current = false;};
  }, []);
  const add = useAsyncAction((entries: ZoteroSelection[], requestId: string) =>
    client.api.research.addLiterature({projectId, requestId,
      destination: projectId === null ? 'library_only' : 'current_project',
      entries: entries.map(({previewId, itemKey}) => ({kind: 'zotero', previewId, itemKey}))}),
  {label: '收录 Zotero 文献'});
  const cancel = useAsyncAction(async (requestId: string) => {
    const operation = await client.api.research.getLiteratureImport({projectId, requestId, offset: 0, limit: 30});
    if (!operation.ok) return operation;
    return client.api.research.cancelLiteratureImport({projectId, operationId: operation.data.operationId});
  }, {label: '取消 Zotero 收录'});

  async function submit(entries: ZoteroSelection[]): Promise<boolean> {
    if (!mounted.current || pending.current || cancelling.current || entries.length === 0) return false;
    pending.current = true;
    const key = JSON.stringify(entries.map(({previewId, itemKey}) => [previewId, itemKey]));
    let requestId = requests.current.get(key);
    if (requestId === undefined) {requestId = crypto.randomUUID(); requests.current.set(key, requestId);}
    currentRequest.current = requestId;
    setSelection(entries);
    setResult(null);
    setCancelRequested(false);
    cancelled.current = false;
    cancel.reset();
    try {
      const response = await add.run(entries, requestId);
      if (!mounted.current) return false;
      if (response.ok) {
        setResult(response.data);
        if (response.data.status !== 'completed') requests.current.delete(key);
        onImported();
      }
      return response.ok;
    } finally {pending.current = false;}
  }
  async function requestCancel(): Promise<void> {
    const requestId = currentRequest.current;
    if (!mounted.current || !pending.current || requestId === null || cancelling.current || cancelled.current) return;
    cancelling.current = true;
    try {
      const response = await cancel.run(requestId);
      if (response.ok && mounted.current && currentRequest.current === requestId) {
        cancelled.current = true;
        setCancelRequested(true);
      }
    } finally {cancelling.current = false;}
  }
  return {projectId, pending: add.pending, error: add.error, cancelError: cancel.error,
    cancelling: cancel.pending, cancelRequested, result, selection, submit, requestCancel,
    isPending: () => pending.current || cancelling.current};
}
export type ZoteroImportJob = ReturnType<typeof useZoteroImportJob>;
