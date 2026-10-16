import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SkillFileEntry, SkillFilePreviewResult, SkillSnapshot } from '../../shared/types';
import type { AsyncStatus } from '../app/use-async-resource';
import { errorMessage } from '../app/loaded-state';
import type { RocClient } from '../shared/roc-client';
import { notifySettingsChanged } from '../shared/settings-events';
import { sortEntries } from './skill-model';
import { useOptimisticFlags } from './use-optimistic-flags';
import {
  deleteSkill,
  importSkill,
  listSkillFiles,
  listSkills,
  readSkillFile,
  setSkillEnabled
} from './management-store';

/**
 * Skill data (P9/T9.2).
 *
 * ## One list, one selection, one directory cursor
 *
 * `skills.list` is the authority for the list; the two file capabilities are **per skill and per
 * directory** (`skills.files.list` takes `{id, relativePath}` and returns one level), so the hook
 * keeps a `dirPath` cursor instead of caching a whole tree. Selecting a skill resets the cursor
 * and drops any preview, because the previous skill's paths mean nothing in the new one.
 *
 * ## Writes go through the same list read
 *
 * Enable/import/delete all end with a `listSkills` re-read, so the composer's candidate list (P4
 * reads the same snapshot from `settings.get`) and this panel cannot disagree about which skills
 * exist: the drawer shows the backend's list, never an optimistically patched copy.
 */

export type SkillsStore = {
  status: AsyncStatus;
  error: string | null;
  skills: SkillSnapshot[];
  reload: () => void;
  enabledIds: string[];
  /** `checked` for the row toggle: the pending intent, else the snapshot. */
  skillEnabled: (skill: SkillSnapshot) => boolean;
  selectedId: string | null;
  select: (id: string | null) => void;
  selected: SkillSnapshot | null;
  dirPath: string;
  setDirPath: (path: string) => void;
  entries: SkillFileEntry[];
  treeStatus: AsyncStatus;
  treeError: string | null;
  treeTruncated: boolean;
  rootPath: string | null;
  previewPath: string | null;
  preview: SkillFilePreviewResult | null;
  previewStatus: AsyncStatus;
  previewError: string | null;
  openFile: (relativePath: string) => void;
  closePreview: () => void;
  toggleEnabled: { pending: boolean; error: string | null; run: (skill: SkillSnapshot, enabled: boolean) => Promise<boolean> };
  importFrom: { pending: boolean; error: string | null; lastImported: SkillSnapshot | null; run: (sourcePath: string) => Promise<boolean> };
  remove: { pending: boolean; error: string | null; run: (skillId: string) => Promise<boolean> };
};

export function useSkills(client: RocClient): SkillsStore {
  const [skills, setSkills] = useState<SkillSnapshot[]>([]);
  const [status, setStatus] = useState<AsyncStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dirPath, setDirPathState] = useState('');
  const [entries, setEntries] = useState<SkillFileEntry[]>([]);
  const [treeStatus, setTreeStatus] = useState<AsyncStatus>('idle');
  const [treeError, setTreeError] = useState<string | null>(null);
  const [treeTruncated, setTreeTruncated] = useState(false);
  const [rootPath, setRootPath] = useState<string | null>(null);

  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<SkillFilePreviewResult | null>(null);
  const [previewStatus, setPreviewStatus] = useState<AsyncStatus>('idle');
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Destructured so the load effect can depend on `clearFlags` (stable) instead of the whole object
  // (whose identity changes whenever a flag moves) — depending on the object re-ran the read.
  const { valueFor: flagValueFor, set: setFlag, clear: clearFlags } = useOptimisticFlags();
  const [togglePending, setTogglePending] = useState(false);
  const [importPending, setImportPending] = useState(false);
  const [removePending, setRemovePending] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [lastImported, setLastImported] = useState<SkillSnapshot | null>(null);

  const reload = useCallback(() => {
    setNonce((current) => current + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    void (async () => {
      try {
        const result = await listSkills(client);
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          setStatus('error');
          setError(result.error.message);
          return;
        }
        setSkills(result.data);
        // A fresh read is the authority again: drop any pending toggle intent.
        clearFlags();
        setStatus('ready');
        setError(null);
      } catch (caught) {
        if (!cancelled) {
          setStatus('error');
          setError(errorMessage(caught));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, nonce, clearFlags]);

  /** Keep a valid selection when the list changes underneath (a delete, or a failed import). */
  useEffect(() => {
    if (status !== 'ready') {
      return;
    }
    if (selectedId !== null && skills.some((skill) => skill.id === selectedId)) {
      return;
    }
    setSelectedId(skills[0]?.id ?? null);
  }, [skills, selectedId, status]);

  useEffect(() => {
    if (selectedId === null) {
      setEntries([]);
      setTreeStatus('idle');
      setTreeError(null);
      return;
    }
    let cancelled = false;
    setTreeStatus('loading');
    void (async () => {
      try {
        const result = await listSkillFiles(client, { id: selectedId, relativePath: dirPath });
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          setTreeStatus('error');
          setTreeError(result.error.message);
          setEntries([]);
          return;
        }
        setEntries(sortEntries(result.data.entries));
        setTreeTruncated(result.data.truncated);
        setRootPath(result.data.rootPath);
        setTreeStatus('ready');
        setTreeError(null);
      } catch (caught) {
        if (!cancelled) {
          setTreeStatus('error');
          setTreeError(errorMessage(caught));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, selectedId, dirPath]);

  useEffect(() => {
    if (selectedId === null || previewPath === null) {
      setPreview(null);
      setPreviewStatus('idle');
      setPreviewError(null);
      return;
    }
    let cancelled = false;
    setPreviewStatus('loading');
    void (async () => {
      try {
        const result = await readSkillFile(client, { id: selectedId, relativePath: previewPath });
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          setPreviewStatus('error');
          setPreviewError(result.error.message);
          setPreview(null);
          return;
        }
        setPreview(result.data);
        setPreviewStatus('ready');
        setPreviewError(null);
      } catch (caught) {
        if (!cancelled) {
          setPreviewStatus('error');
          setPreviewError(errorMessage(caught));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, selectedId, previewPath]);

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    setDirPathState('');
    setPreviewPath(null);
    setMutationError(null);
  }, []);

  const selected = useMemo(() => skills.find((skill) => skill.id === selectedId) ?? null, [skills, selectedId]);
  // One pass, and the same shape the MCP hook uses for its enabled server ids.
  const enabledIds = useMemo(() => {
    const ids: string[] = [];
    for (const skill of skills) {
      if (skill.enabled) {
        ids.push(skill.id);
      }
    }
    return ids;
  }, [skills]);

  const toggleEnabled = useCallback(
    async (skill: SkillSnapshot, enabled: boolean): Promise<boolean> => {
      setTogglePending(true);
      setMutationError(null);
      // Move the box now; the list read below makes the backend the authority again.
      setFlag(skill.id, enabled);
      try {
        const result = await setSkillEnabled(client, { id: skill.id, enabled });
        if (!result.ok) {
          setMutationError(result.error.message);
          // The checkbox moved optimistically; a refusal must put it back to the snapshot's value.
          clearFlags();
          return false;
        }
        reload();
        // The assistant's composer builds its `/skill` list from `settings.get().skills`, and only a
        // settings save used to bump the revision — a toggle here would otherwise be invisible
        // until the next save (the P9 gate caught exactly that).
        notifySettingsChanged();
        return true;
      } catch (caught) {
        setMutationError(errorMessage(caught));
        return false;
      } finally {
        setTogglePending(false);
      }
    },
    [client, setFlag, reload]
  );

  const importFrom = useCallback(
    async (sourcePath: string): Promise<boolean> => {
      setImportPending(true);
      setMutationError(null);
      try {
        const result = await importSkill(client, { sourcePath: sourcePath.trim() });
        if (!result.ok) {
          setMutationError(result.error.message);
          return false;
        }
        setLastImported(result.data);
        setSelectedId(result.data.id);
        setDirPathState('');
        setPreviewPath(null);
        reload();
        notifySettingsChanged();
        return true;
      } catch (caught) {
        setMutationError(errorMessage(caught));
        return false;
      } finally {
        setImportPending(false);
      }
    },
    [client, reload]
  );

  const remove = useCallback(
    async (skillId: string): Promise<boolean> => {
      setRemovePending(true);
      setMutationError(null);
      try {
        const result = await deleteSkill(client, skillId);
        if (!result.ok) {
          setMutationError(result.error.message);
          return false;
        }
        reload();
        notifySettingsChanged();
        return true;
      } catch (caught) {
        setMutationError(errorMessage(caught));
        return false;
      } finally {
        setRemovePending(false);
      }
    },
    [client, reload]
  );

  return useMemo(
    () => ({
      status,
      error,
      skills,
      reload,
      enabledIds,
      skillEnabled: (skill: SkillSnapshot) => flagValueFor(skill.id, skill.enabled),
      selectedId,
      select,
      selected,
      dirPath,
      setDirPath: setDirPathState,
      entries,
      treeStatus,
      treeError,
      treeTruncated,
      rootPath,
      previewPath,
      preview,
      previewStatus,
      previewError,
      openFile: setPreviewPath,
      closePreview: () => setPreviewPath(null),
      toggleEnabled: { pending: togglePending, error: mutationError, run: toggleEnabled },
      importFrom: { pending: importPending, error: mutationError, lastImported, run: importFrom },
      remove: { pending: removePending, error: mutationError, run: remove }
    }),
    [
      status,
      error,
      skills,
      reload,
      enabledIds,
      selectedId,
      select,
      selected,
      dirPath,
      entries,
      treeStatus,
      treeError,
      treeTruncated,
      rootPath,
      previewPath,
      preview,
      previewStatus,
      previewError,
      togglePending,
      importPending,
      removePending,
      mutationError,
      lastImported,
      toggleEnabled,
      importFrom,
      remove
    ]
  );
}
