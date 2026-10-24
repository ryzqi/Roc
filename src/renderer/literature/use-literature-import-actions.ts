import { useCallback, useMemo, useRef, useState } from 'react';
import type { LiteratureSearchResult } from '../../shared/schemas/literature-import';
import type { LiteratureImportOutcome, LiteratureStore } from './use-literature-store';
import type { LiteratureSearchSource } from './library-store';

/**
 * The two import actions that need the IPC surface rather than the store.
 *
 * Splitting them out of the hub keeps the store free of raw `files.*` calls: the
 * store owns library/document writes, while picking a path in a **native dialog**
 * is a different concern (it can be cancelled, and a cancellation is not an
 * error — the P2 lesson about `selectFromDialog` returning `null` vs `{ok:false}`).
 */

export type LiteratureImportActions = {
  /** Native picker; resolves `null` when the user cancels. */
  pickFile: () => Promise<string | null>;
  /** `research.literature.search`, normalized so the dialog never sees `{ok:false}`. */
  searchLiterature: (
    query: string,
    sources: LiteratureSearchSource[],
    limit: number
  ) => Promise<{ ok: true; result: LiteratureSearchResult } | { ok: false; message: string }>;
  addCandidate: (searchId: string, candidateId: string) => Promise<LiteratureImportOutcome>;
  /** Set when the native picker itself failed (permission, dialog error). */
  pickError: string | null;
};

export function useLiteratureImportActions({ store }: { store: LiteratureStore }): LiteratureImportActions {
  const client = store.client;
  const { projectId, reload } = store;
  const requests = useRef(new Map<string, string>());
  const [pickError, setPickError] = useState<string | null>(null);

  const pickFile = useCallback(async (): Promise<string | null> => {
    setPickError(null);
    // `files.selectFromDialog` is the *file* dialog; `workspace.selectFromDialog`
    // is the directory one. Using the workspace one here would let the user pick a
    // folder and then fail with `research_source_format_unsupported`.
    const result = await client.api.files.selectFromDialog();
    if (!result.ok) {
      setPickError(result.error.message);
      return null;
    }
    // `{ filePaths: string[] }`; a cancelled dialog is `{ filePaths: [] }`.
    const first = result.data?.filePaths?.[0];
    return typeof first === 'string' && first.length > 0 ? first : null;
  }, [client]);

  const searchLiterature = useCallback(
    async (query: string, sources: LiteratureSearchSource[], limit: number) => {
      const result = await client.api.research.searchLiterature({ query, sources, limit, projectId });
      if (!result.ok) {
        return { ok: false as const, message: result.error.message };
      }
      return { ok: true as const, result: result.data };
    },
    [client, projectId]
  );

  const addCandidate = useCallback(async (searchId: string, candidateId: string): Promise<LiteratureImportOutcome> => {
    const key = `${projectId}:${searchId}:${candidateId}`;
    let requestId = requests.current.get(key);
    if (requestId === undefined) { requestId = crypto.randomUUID(); requests.current.set(key, requestId); }
    const response = await client.api.research.addLiterature({ projectId, requestId,
      destination: projectId === null ? 'library_only' : 'current_project', entries: [{ kind: 'candidate', searchId, candidateId }] });
    if (!response.ok) return { ok: false, message: response.error.message };
    reload();
    const { counts } = response.data;
    if (counts.failed + counts.cancelled + counts.skippedArchived > 0) {
      requests.current.delete(key);
      return { ok: false, message: counts.skippedArchived > 0 ? '文献已归档，请先在文献库恢复后再加入。' : '元数据导入未完成，请查看导入结果。' };
    }
    return { ok: true, createdCount: counts.created + counts.linked, duplicateCount: counts.alreadyPresent };
  }, [client, projectId, reload]);

  return useMemo(
    () => ({ pickFile, searchLiterature, addCandidate, pickError }),
    [pickFile, pickError, searchLiterature, addCandidate]
  );
}
