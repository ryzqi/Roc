import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SettingsSaveRequest, SettingsSnapshot } from '../../shared/types/settings';
import type { ResearchIndexSettings, ResearchIndexStatus } from '../../shared/types/research';
import type { AsyncResource } from '../app/use-async-resource';
import { useAsyncResource } from '../app/use-async-resource';
import type { RocClient } from '../shared/roc-client';
import { getIndexStatus, getSettingsSnapshot, saveHookConfig, saveIndexSettings, saveSettings } from './settings-store';
import { notifySettingsChanged } from './settings-events';
import {
  cloneDraft,
  diffDraft,
  draftFromSnapshot,
  sectionForDraftPath,
  validateDraft,
  type DraftDiff,
  type DraftIssue,
  type SettingsDraft,
  type SettingsSectionId
} from './settings-rules';

/**
 * The settings draft (P8/T8.2–T8.4).
 *
 * ## Why the draft is one object, not a form library
 *
 * `settings.save` writes the whole document (F22), so the surface is a *document
 * editor*: load once, edit in memory, diff against the baseline, write once. That is
 * also what makes the dirty bar honest — `未保存 n 项` is `diffDraft(...).count`, and
 * the per-section warning dots come from the same call, so the count and the dots
 * cannot disagree.
 *
 * ## Why the baseline is kept next to the draft
 *
 * `base` is the last committed document; it is never mutated. Discard restores the draft
 * from it, and save sends the draft. If the draft aliased the baseline, an in-place edit of a
 * nested object would change the comparison target and the diff would silently collapse to
 * zero.
 *
 * ## The baseline moves on exactly two events, and a status refresh is not one
 *
 *  1. the first load for a project (and a project switch, which drops the draft together with
 *     the scope it belonged to);
 *  2. a completed save — the backend **normalises** the document (the three fixed providers are
 *     rewritten, a default model whose provider is disabled becomes null), so the returned
 *     snapshot becomes the baseline and the draft shows the normalised result.
 *
 * In particular `reload()` (used after `settings.setProviderSecret`, `clearProviderSecret` and
 * `settings.hooks.trust`) only refreshes the *snapshot* the read-only surfaces render from.
 * Rebuilding the draft there would delete every unsaved edit in the other eleven sections — a
 * data-loss bug, not a refresh. The first version of this hook did exactly that and the P8 gate
 * caught it (progress.md 本轮错误表).
 *
 * ## Two writers, one surface
 *
 * The draft carries `hooks` and `index` as well, because they are edited here, but
 * they are saved by their own capabilities after the core document. A partial failure
 * says which part was written and which was not, instead of reporting a generic
 * failure over a half-applied change.
 */

export type SettingsStore = {
  status: AsyncResource<SettingsSnapshot>['status'];
  error: string | null;
  reload: () => void;
  snapshot: SettingsSnapshot | null;
  /** The current project's index status (phase, counts, revision, settings). */
  indexStatus: ResearchIndexStatus | null;
  /** The index read's own error: the RAG section must be able to explain its own absence. */
  indexError: string | null;
  base: SettingsDraft | null;
  draft: SettingsDraft | null;
  diff: DraftDiff;
  issues: DraftIssue[];
  dirtySections: Set<SettingsSectionId>;
  /** Applies an in-place mutation to a fresh copy of the draft. */
  update: (mutator: (draft: SettingsDraft) => void) => void;
  discard: () => void;
  save: { pending: boolean; error: string | null; run: () => Promise<boolean> };
  /** Set after a successful save; drives the "已保存" line. */
  savedAt: string | null;
  projectId: string | null;
  client: RocClient;
};

export function useSettingsStore(client: RocClient, projectId: string | null): SettingsStore {
  const snapshotResource = useAsyncResource('settings:snapshot', () => getSettingsSnapshot(client), {
    label: '读取设置'
  });
  const indexResource = useAsyncResource(
    projectId === null ? null : `settings:index:${projectId}`,
    () => getIndexStatus(client, projectId ?? ''),
    { label: '读取索引配置' }
  );

  const loadedSnapshot = snapshotResource.data;
  const loadedIndex = indexResource.data?.settings ?? null;

  const [state, setState] = useState<{ base: SettingsDraft; draft: SettingsDraft } | null>(null);
  const [pending, setPending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  /**
   * The draft is initialised once per project, not on every load.
   *
   * `loadedSnapshot` is the document the *resource* currently holds; `baselineSnapshot` is the
   * document the draft was built from. Keeping two references is what separates "a status
   * refresh happened" (the draft must survive) from "a new scope appeared" (the draft must be
   * rebuilt) — one effect on `loadedSnapshot` cannot tell those apart.
   */
  const scopeRef = useRef<string | null>(null);
  const baselineSnapshotRef = useRef<SettingsSnapshot | null>(null);

  const indexPending = projectId !== null && indexResource.status === 'loading';

  useEffect(() => {
    const scope = projectId ?? 'none';
    if (scopeRef.current !== scope) {
      // A different project owns a different index configuration, so the draft goes with it.
      scopeRef.current = scope;
      baselineSnapshotRef.current = null;
    }
    if (loadedSnapshot === null) {
      setState(null);
      return;
    }
    if (baselineSnapshotRef.current !== null) {
      return;
    }
    /**
     * The index read settles before the draft is built.
     *
     * The settings snapshot and the per-project index status are two separate loads, and the
     * snapshot usually wins. Building the draft from the first one would freeze
     * `index: null` for the whole session — the RAG section would then sit at
     * 「索引配置读取中…」 forever even though the status had arrived (the P8 gate caught this
     * after the baseline was made to move only on save/scope change).
     */
    if (indexPending) {
      return;
    }
    const base = draftFromSnapshot(loadedSnapshot, loadedIndex);
    baselineSnapshotRef.current = loadedSnapshot;
    setState({ base, draft: cloneDraft(base) });
  }, [projectId, loadedSnapshot, loadedIndex, indexPending]);

  const update = useCallback((mutator: (draft: SettingsDraft) => void) => {
    setState((current) => {
      if (current === null) {
        return current;
      }
      const draft = cloneDraft(current.draft);
      mutator(draft);
      return { base: current.base, draft };
    });
    setSaveError(null);
  }, []);

  const discard = useCallback(() => {
    setState((current) => (current === null ? current : { base: current.base, draft: cloneDraft(current.base) }));
    setSaveError(null);
  }, []);

  const diff = useMemo(() => diffDraft(state?.base ?? null, state?.draft ?? null), [state]);
  const issues = useMemo(() => validateDraft(state?.draft ?? null), [state]);

  const reloadSnapshot = snapshotResource.reload;
  const reloadIndex = indexResource.reload;

  /**
   * Makes a freshly returned document the new baseline and draft.
   *
   * Used only after a save: the backend normalises what it stores, so showing the *returned*
   * document is the honest result and the diff bar must go to zero.
   */
  const commitBaseline = useCallback((snapshot: SettingsSnapshot, index: ResearchIndexSettings | null) => {
    baselineSnapshotRef.current = snapshot;
    const base = draftFromSnapshot(snapshot, index);
    setState({ base, draft: cloneDraft(base) });
  }, []);

  const run = useCallback(async (): Promise<boolean> => {
    const current = state;
    if (current === null) {
      return false;
    }
    const { base, draft } = current;
    setPending(true);
    setSaveError(null);
    try {
      const request: SettingsSaveRequest = {
        settings: draft.settings,
        providers: draft.providers,
        defaultModelId: draft.defaultModelId,
        permissions: draft.permissions
      };
      const core = await saveSettings(client, request);
      if (!core.ok) {
        setSaveError(core.error.message);
        return false;
      }

      // The committed hooks config is the one `settings.hooks.save` returns, not the one inside
      // `core.data`: the core snapshot is built while the hooks file is still the old one, so
      // using it would rewrite the draft back to the pre-save hooks (P8 review P1-2).
      let nextHooksConfig = core.data.hooks.config;
      const hooksChanged = diff.paths.some((path) => sectionForDraftPath(path) === 'hooks');
      if (hooksChanged) {
        const hooks = await saveHookConfig(client, draft.hooks);
        if (!hooks.ok) {
          setSaveError(`模型与偏好已保存；Hooks 未保存：${hooks.error.message}`);
          return false;
        }
        nextHooksConfig = hooks.data.config;
      }

      let nextIndexSettings: ResearchIndexSettings | null = base.index;
      const indexChanged = diff.paths.some((path) => sectionForDraftPath(path) === 'rag');
      if (indexChanged) {
        if (draft.index === null || base.index === null) {
          setSaveError('索引配置未保存：当前没有绑定工作目录的项目。');
          return false;
        }
        const index = await saveIndexSettings(client, {
          projectId: draft.index.projectId,
          expectedRevision: base.index.revision,
          kinds: draft.index.kinds,
          include: draft.index.include,
          exclude: draft.index.exclude,
          watch: draft.index.watch,
          paused: draft.index.paused,
          embeddingConfigId: draft.index.embeddingConfigId
        });
        if (!index.ok) {
          // Revision conflict is the expected failure here and the backend's message is
          // the only accurate description of it — pass it through with the context the
          // user needs to understand that the rest was written.
          setSaveError(`设置已保存；索引配置未保存：${index.error.message}`);
          return false;
        }
        // The returned status carries the new revision; the next index save must use it or the
        // optimistic-concurrency check would fail against our own write.
        nextIndexSettings = index.data.settings;
      }

      // A completed save is the second event that moves the baseline (see the hook's comment).
      commitBaseline({ ...core.data, hooks: { ...core.data.hooks, config: nextHooksConfig } }, nextIndexSettings);
      notifySettingsChanged();
      setSavedAt(new Date().toISOString());
      reloadSnapshot();
      reloadIndex();
      return true;
    } finally {
      setPending(false);
    }
  }, [client, state, diff.paths, commitBaseline, reloadIndex, reloadSnapshot]);

  return {
    status: snapshotResource.status,
    error: snapshotResource.error ?? indexResource.error,
    reload: reloadSnapshot,
    snapshot: loadedSnapshot,
    indexStatus: indexResource.data ?? null,
    indexError: indexResource.error,
    base: state?.base ?? null,
    draft: state?.draft ?? null,
    diff,
    issues,
    dirtySections: diff.sections,
    update,
    discard,
    save: { pending, error: saveError, run },
    savedAt,
    projectId,
    client
  };
}
