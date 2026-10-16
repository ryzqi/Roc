import { useCallback, useMemo, useState } from 'react';
import type { ResearchLiterature } from '../../shared/types';
import type { LiteratureStore } from './use-literature-store';
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
  ) => Promise<{ ok: true; hits: ResearchLiterature[] } | { ok: false; message: string }>;
  /** Set when the native picker itself failed (permission, dialog error). */
  pickError: string | null;
};

export function useLiteratureImportActions({ store }: { store: LiteratureStore }): LiteratureImportActions {
  const client = store.client;
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
      const result = await client.api.research.searchLiterature({ query, sources, limit });
      if (!result.ok) {
        return { ok: false as const, message: result.error.message };
      }
      return { ok: true as const, hits: result.data };
    },
    [client]
  );

  return useMemo(
    () => ({ pickFile, searchLiterature, pickError }),
    [pickFile, pickError, searchLiterature]
  );
}
