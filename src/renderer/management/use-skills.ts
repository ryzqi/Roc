import useSWR from 'swr';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  BuiltinSkillsStatus,
  SkillFileEntry,
  SkillFilePreviewResult,
  SkillSnapshot
} from '../../shared/types';
import type { AsyncStatus } from '../app/use-async-resource';
import { errorMessage } from '../app/loaded-state';
import { IpcResourceError } from '../app/ipc-resource';
import type { RocClient } from '../shared/roc-client';
import { notifySettingsChanged } from '../shared/settings-events';
import { sortEntries } from './skill-model';
import { SKILLS_LIST_RESOURCE_KEY, loadSkillsList } from './skills-resource';
import { useOptimisticFlags } from './use-optimistic-flags';
import {
  checkBuiltinSkills,
  deleteSkill,
  getBuiltinSkillsStatus,
  importSkill,
  listSkillFiles,
  readSkillFile,
  restoreBuiltinSkillSource,
  setBuiltinSkillsAutoUpdate,
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

/**
 * Built-in source state.
 *
 * Kept next to the list rather than inside `SkillSnapshot` because it is source-scoped: two
 * sources can be at different commits, one of them can be licensed for non-commercial use only,
 * and a check can fail for one while the other updates successfully.
 */
type BuiltinSkillsStore = {
  status: AsyncStatus;
  error: string | null;
  snapshot: BuiltinSkillsStatus | null;
  reload: () => void;
  check: {
    pending: boolean;
    error: string | null;
    lastChanged: boolean | null;
    run: (force?: boolean) => Promise<boolean>;
  };
  autoUpdate: {
    pending: boolean;
    error: string | null;
    run: (autoUpdate: boolean) => Promise<boolean>;
  };
  restore: {
    pending: boolean;
    error: string | null;
    sourceId: string | null;
    run: (sourceId: string) => Promise<boolean>;
  };
};

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
  builtin: BuiltinSkillsStore;
};

export function useSkills(client: RocClient): SkillsStore {
  const skillsResource = useSWR<SkillSnapshot[], IpcResourceError>(
    SKILLS_LIST_RESOURCE_KEY,
    () => loadSkillsList(client),
    { keepPreviousData: false, shouldRetryOnError: false }
  );
  const skills = skillsResource.data ?? [];
  let status: AsyncStatus;
  if (skillsResource.isValidating) {
    status = 'loading';
  } else if (skillsResource.error !== undefined) {
    status = 'error';
  } else if (skillsResource.data !== undefined) {
    status = 'ready';
  } else {
    status = 'idle';
  }
  const error = skillsResource.isValidating ? null : skillsResource.error?.message ?? null;

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

  // Keep `clearFlags` stable for the list-snapshot effect; list data changes clear flags without
  // tying the effect to the whole flags object.
  const { valueFor: flagValueFor, set: setFlag, clear: clearFlags } = useOptimisticFlags();
  const [togglePending, setTogglePending] = useState(false);
  const [importPending, setImportPending] = useState(false);
  const [removePending, setRemovePending] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [lastImported, setLastImported] = useState<SkillSnapshot | null>(null);

  const [builtinSnapshot, setBuiltinSnapshot] = useState<BuiltinSkillsStatus | null>(null);
  const [builtinStatus, setBuiltinStatus] = useState<AsyncStatus>('loading');
  const [builtinError, setBuiltinError] = useState<string | null>(null);
  const [builtinNonce, setBuiltinNonce] = useState(0);
  const [builtinCheckPending, setBuiltinCheckPending] = useState(false);
  const [builtinAutoUpdatePending, setBuiltinAutoUpdatePending] = useState(false);
  const [builtinRestorePending, setBuiltinRestorePending] = useState(false);
  const [builtinActionError, setBuiltinActionError] = useState<string | null>(null);
  const [builtinLastChanged, setBuiltinLastChanged] = useState<boolean | null>(null);
  const [builtinRestoreSourceId, setBuiltinRestoreSourceId] = useState<string | null>(null);

  const reload = useCallback(() => {
    void skillsResource.mutate().catch(() => undefined);
  }, [skillsResource.mutate]);

  useEffect(() => {
    if (skillsResource.data !== undefined) {
      // A fresh list is the authority again: drop any pending toggle intent.
      clearFlags();
    }
  }, [skillsResource.data, clearFlags]);

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

  const reloadBuiltin = useCallback(() => {
    setBuiltinNonce((current) => current + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setBuiltinStatus('loading');
    void (async () => {
      try {
        const result = await getBuiltinSkillsStatus(client);
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          setBuiltinStatus('error');
          setBuiltinError(result.error.message);
          return;
        }
        setBuiltinSnapshot(result.data);
        setBuiltinStatus('ready');
        setBuiltinError(null);
      } catch (caught) {
        if (!cancelled) {
          setBuiltinStatus('error');
          setBuiltinError(errorMessage(caught));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, builtinNonce]);

  /**
   * Push channel for the daily sync and the manual check. The list read is repeated because a new
   * upstream commit can add or remove skills, and the composer reads the same `settings.get`
   * snapshot — both consumers are stale after this event.
   */
  useEffect(() => {
    const unsubscribe = client.api.skills.onUpdated((status) => {
      setBuiltinSnapshot(status);
      setBuiltinStatus('ready');
      setBuiltinError(null);
      reload();
      notifySettingsChanged();
    });
    return unsubscribe;
  }, [client, reload]);

  const checkBuiltin = useCallback(
    async (force = false): Promise<boolean> => {
      setBuiltinCheckPending(true);
      setBuiltinActionError(null);
      setBuiltinLastChanged(null);
      try {
        const result = await checkBuiltinSkills(client, { force });
        if (!result.ok) {
          setBuiltinActionError(result.error.message);
          return false;
        }
        setBuiltinSnapshot({
          schemaVersion: result.data.schemaVersion,
          autoUpdate: result.data.autoUpdate,
          updating: result.data.updating,
          lastCheckedAt: result.data.lastCheckedAt,
          sources: result.data.sources
        });
        setBuiltinLastChanged(result.data.changed);
        if (result.data.errors.length > 0) {
          setBuiltinActionError(result.data.errors.join('；'));
        }
        reload();
        notifySettingsChanged();
        return result.data.errors.length === 0;
      } catch (caught) {
        setBuiltinActionError(errorMessage(caught));
        return false;
      } finally {
        setBuiltinCheckPending(false);
      }
    },
    [client, reload]
  );

  const setBuiltinAutoUpdate = useCallback(
    async (autoUpdate: boolean): Promise<boolean> => {
      setBuiltinAutoUpdatePending(true);
      setBuiltinActionError(null);
      try {
        const result = await setBuiltinSkillsAutoUpdate(client, { autoUpdate });
        if (!result.ok) {
          setBuiltinActionError(result.error.message);
          return false;
        }
        setBuiltinSnapshot(result.data);
        return true;
      } catch (caught) {
        setBuiltinActionError(errorMessage(caught));
        return false;
      } finally {
        setBuiltinAutoUpdatePending(false);
      }
    },
    [client]
  );

  const restoreBuiltin = useCallback(
    async (sourceId: string): Promise<boolean> => {
      setBuiltinRestorePending(true);
      setBuiltinRestoreSourceId(sourceId);
      setBuiltinActionError(null);
      try {
        const result = await restoreBuiltinSkillSource(client, { sourceId });
        if (!result.ok) {
          setBuiltinActionError(result.error.message);
          return false;
        }
        setBuiltinSnapshot(result.data);
        reload();
        notifySettingsChanged();
        return true;
      } catch (caught) {
        setBuiltinActionError(errorMessage(caught));
        return false;
      } finally {
        setBuiltinRestorePending(false);
        setBuiltinRestoreSourceId(null);
      }
    },
    [client, reload]
  );

  const builtin = useMemo<BuiltinSkillsStore>(
    () => ({
      status: builtinStatus,
      error: builtinError,
      snapshot: builtinSnapshot,
      reload: reloadBuiltin,
      check: { pending: builtinCheckPending, error: builtinActionError, lastChanged: builtinLastChanged, run: checkBuiltin },
      autoUpdate: { pending: builtinAutoUpdatePending, error: builtinActionError, run: setBuiltinAutoUpdate },
      restore: { pending: builtinRestorePending, error: builtinActionError, sourceId: builtinRestoreSourceId, run: restoreBuiltin }
    }),
    [
      builtinStatus,
      builtinError,
      builtinSnapshot,
      reloadBuiltin,
      builtinCheckPending,
      builtinLastChanged,
      checkBuiltin,
      builtinAutoUpdatePending,
      setBuiltinAutoUpdate,
      builtinRestorePending,
      builtinRestoreSourceId,
      restoreBuiltin
    ]
  );

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
      remove: { pending: removePending, error: mutationError, run: remove },
      builtin
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
      remove,
      builtin
    ]
  );
}
