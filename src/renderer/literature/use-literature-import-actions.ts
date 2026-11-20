import { useCallback, useMemo, useRef } from 'react';
import type { LiteratureImportResult, LiteratureSearchInput, LiteratureSearchResult } from '../../shared/schemas/literature-import';
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
  /** Native picker; resolves `null` on cancellation, throws a failure for the dialog to display. */
  pickFile: () => Promise<string | null>;
  /** `research.literature.search`, normalized so the dialog never sees `{ok:false}`. */
  searchLiterature: (
    query: string,
    sources: LiteratureSearchSource[],
    limit: number,
    filters?: Pick<LiteratureSearchInput, 'yearFrom' | 'yearTo'>
  ) => Promise<{ ok: true; result: LiteratureSearchResult } | { ok: false; message: string }>;
  addCandidates: (searchId: string, candidateIds: string[]) => Promise<{ ok: true; result: LiteratureImportResult } | { ok: false; message: string }>;
  addCandidate: (searchId: string, candidateId: string) => Promise<LiteratureImportOutcome>;
};

export function useLiteratureImportActions({ store }: { store: LiteratureStore }): LiteratureImportActions {
  const client = store.client;
  const { projectId, reload } = store;
  const requests = useRef(new Map<string, string>());

  const pickFile = useCallback(async (): Promise<string | null> => {
    // `files.selectFromDialog` is the *file* dialog; `workspace.selectFromDialog`
    // is the directory one. Using the workspace one here would let the user pick a
    // folder and then fail with `research_source_format_unsupported`.
    const result = await client.api.files.selectFromDialog();
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    // `{ filePaths: string[] }`; a cancelled dialog is `{ filePaths: [] }`.
    const first = result.data?.filePaths?.[0];
    return typeof first === 'string' && first.length > 0 ? first : null;
  }, [client]);

  const searchLiterature = useCallback(
    async (query: string, sources: LiteratureSearchSource[], limit: number, filters?: Pick<LiteratureSearchInput, 'yearFrom' | 'yearTo'>) => {
      const result = await client.api.research.searchLiterature({ query, sources, limit, maxPages: 1, projectId, ...filters });
      if (!result.ok) {
        return { ok: false as const, message: result.error.message };
      }
      return { ok: true as const, result: result.data };
    },
    [client, projectId]
  );

  const addCandidates = useCallback(async (searchId: string, candidateIds: string[]) => {
    const ids = [...new Set(candidateIds)];
    const key = JSON.stringify([projectId, searchId, ids]);
    let requestId = requests.current.get(key);
    if (requestId === undefined) { requestId = crypto.randomUUID(); requests.current.set(key, requestId); }
    const response = await client.api.research.addLiterature({ projectId, requestId,
      destination: projectId === null ? 'library_only' : 'current_project', ingestionPolicy: 'fulltext_auto',
      entries: ids.map(candidateId => ({ kind: 'candidate' as const, searchId, candidateId })) });
    if (!response.ok) return { ok: false as const, message: response.error.message };
    reload();
    const { counts } = response.data;
    if (counts.failed + counts.cancelled + counts.skippedArchived + counts.notProcessed > 0) requests.current.delete(key);
    return { ok: true as const, result: response.data };
  }, [client, projectId, reload]);

  const addCandidate = useCallback(async (searchId: string, candidateId: string): Promise<LiteratureImportOutcome> => {
    const response = await addCandidates(searchId, [candidateId]);
    if (!response.ok) return response;
    const { counts } = response.result;
    if (counts.failed + counts.cancelled + counts.skippedArchived + counts.notProcessed > 0) {
      return { ok: false, message: counts.skippedArchived > 0 ? '文献已归档，请先在文献库恢复后再加入。' : '元数据导入未完成，请查看导入结果。' };
    }
    return { ok: true, createdCount: counts.created + counts.linked, duplicateCount: counts.alreadyPresent };
  }, [addCandidates]);

  return useMemo(
    () => ({ pickFile, searchLiterature, addCandidate, addCandidates }),
    [pickFile, searchLiterature, addCandidate, addCandidates]
  );
}
