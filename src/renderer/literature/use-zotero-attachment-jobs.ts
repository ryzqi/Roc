import {useEffect, useRef, useState} from 'react';
import type {z} from 'zod';
import type {ZoteroAttachmentInspection, ZoteroAttachmentGrant, ZoteroAttachmentImport,
  zoteroAttachmentRequestSchema} from '../../shared/schemas/research-zotero-attachment';
import {runIpcAction} from '../app/loaded-state';
import type {RocClient} from '../shared/roc-client';

export type ZoteroAttachmentSource = z.infer<typeof zoteroAttachmentRequestSchema>;
type Entry = {
  phase: 'idle' | 'checking' | 'granting' | 'importing';
  inspection: ZoteroAttachmentInspection | null;
  grant: ZoteroAttachmentGrant | null;
  receipt: ZoteroAttachmentImport | null;
  grantRequestId: string | null;
  importRequest: {requestId: string; destination: 'library_only' | 'current_project'} | null;
  grantCancelled: boolean;
  cancelling: boolean;
  cancelRequested: boolean;
  error: string | null;
  cancelError: string | null;
};
const empty: Entry = {phase: 'idle', inspection: null, grant: null, receipt: null,
  grantRequestId: null, importRequest: null, grantCancelled: false, cancelling: false, cancelRequested: false,
  error: null, cancelError: null};

/** Dialog-owned jobs survive details, tab and dialog closure; keys retain the actual source scope. */
export function useZoteroAttachmentJobs(client: RocClient, projectId: string | null, onImported: () => void) {
  const [entries, setEntries] = useState<ReadonlyMap<string, Entry>>(new Map());
  const current = useRef(new Map<string, Entry>());
  const mounted = useRef(true);
  const activeProject = useRef(projectId);
  activeProject.current = projectId;
  useEffect(() => {
    mounted.current = true;
    return () => {mounted.current = false;};
  }, []);
  const keyFor = (source: ZoteroAttachmentSource): string => JSON.stringify([projectId,
    source.serverId, source.library.kind, source.library.id, source.operationId, source.itemKey, source.attachmentKey]);
  function publish(key: string, entry: Entry): void {
    current.current.set(key, entry);
    if (mounted.current) setEntries(new Map(current.current));
  }
  function begin(source: ZoteroAttachmentSource, phase: Entry['phase']): {key: string; entry: Entry} | null {
    const key = keyFor(source), saved = current.current.get(key) ?? empty;
    if (saved.phase !== 'idle' || saved.cancelling) return null;
    const entry = {...saved, phase, error: null, cancelError: null};
    publish(key, entry);
    return {key, entry};
  }
  async function inspect(source: ZoteroAttachmentSource): Promise<void> {
    const job = begin(source, 'checking');
    if (job === null) return;
    const response = await runIpcAction(() => client.api.research.inspectZoteroAttachment({...source, projectId}));
    publish(job.key, response.ok ? {...empty, inspection: response.data} :
      {...job.entry, phase: 'idle', error: response.error});
  }
  async function grant(source: ZoteroAttachmentSource): Promise<void> {
    const job = begin(source, 'granting');
    if (job === null) return;
    const requestId = job.entry.grantRequestId ?? crypto.randomUUID();
    const pending = {...job.entry, grantRequestId: requestId, grantCancelled: false};
    publish(job.key, pending);
    const response = await runIpcAction(() => client.api.research.grantZoteroAttachment({
      projectId, inspectionId: pending.inspection!.inspectionId, requestId}));
    if (!response.ok) publish(job.key, {...pending, phase: 'idle', error: response.error});
    else if (response.data.status === 'cancelled') publish(job.key, {...pending, phase: 'idle',
      grantRequestId: null, grantCancelled: true});
    else publish(job.key, {...pending, phase: 'idle', grant: response.data.grant});
  }
  async function importFile(source: ZoteroAttachmentSource, destination: 'library_only' | 'current_project'): Promise<void> {
    const job = begin(source, 'importing');
    if (job === null) return;
    const importRequest = job.entry.importRequest ?? {requestId: crypto.randomUUID(), destination};
    const pending = {...job.entry, importRequest, cancelRequested: false};
    publish(job.key, pending);
    const response = await runIpcAction(() => client.api.research.importZoteroAttachment({
      projectId, grantId: pending.grant!.grantId, ...importRequest}));
    const latest = current.current.get(job.key)!;
    publish(job.key, response.ok ? {...latest, phase: 'idle', receipt: response.data} :
      {...latest, phase: 'idle', error: response.error});
    if (response.ok && mounted.current && activeProject.current === projectId) onImported();
  }
  async function cancel(source: ZoteroAttachmentSource): Promise<void> {
    const key = keyFor(source), entry = current.current.get(key)!;
    if (entry.cancelling || entry.cancelRequested) return;
    publish(key, {...entry, cancelling: true, cancelError: null});
    const response = await runIpcAction(() => client.api.research.cancelZoteroAttachmentImport({
      projectId, requestId: entry.importRequest!.requestId}));
    const latest = current.current.get(key)!;
    publish(key, response.ok ? {...latest, cancelling: false, cancelRequested: response.data.cancelRequested, cancelError: null} :
      {...latest, cancelling: false, cancelError: response.error});
  }
  return {projectId, get: (source: ZoteroAttachmentSource): Entry => entries.get(keyFor(source)) ?? empty,
    inspect, grant, importFile, cancel};
}
export type ZoteroAttachmentJobs = ReturnType<typeof useZoteroAttachmentJobs>;
