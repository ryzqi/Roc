import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SettingsSnapshot } from '../../shared/types/settings';
import type { ResearchIndexStatus } from '../../shared/types/research';
import type { AsyncResource } from '../app/use-async-resource';
import { useAsyncResource } from '../app/use-async-resource';
import type { RocClient } from '../shared/roc-client';
import { getIndexStatus, getSettingsSnapshot } from './settings-store';
import { applySettingsCommit, saveSettingsDraft, type SettingsSaveOutcome } from './settings-edit-session';
import { notifySettingsChanged, useSettingsRevision } from '../shared/settings-events';
import {
  cloneDraft,
  diffDraft,
  draftFromSnapshot,
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
 *  2. each successful independent write — its returned, normalized values advance only
 *     that part of the baseline. Failed and unattempted parts remain dirty.
 *
 * In particular `reload()` (used after `settings.setProviderSecret`, `clearProviderSecret` and
 * `settings.hooks.trust`) only refreshes the *snapshot* the read-only surfaces render from.
 * Rebuilding the draft there would delete every unsaved edit in the other eleven sections — a
 * data-loss bug, not a refresh. The first version of this hook did exactly that and the P8 gate
 * caught it (progress.md 本轮错误表).
 *
 * ## Independent writers, one surface
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
  save: { pending: boolean; error: string | null; outcome: SettingsSaveOutcome | null; run: () => Promise<boolean> };
  /** Set after a successful save; drives the "已保存" line. */
  savedAt: string | null;
  projectId: string | null;
  client: RocClient;
};

export function useSettingsStore(client: RocClient, projectId: string | null): SettingsStore {
  /**
   * 资源键带上修订号：这个中心不是唯一写者。
   *
   * 实力器的模型选择器走 `settings.setDefaultModel`（只改一个字段的窄通道），技能的启停、
   * MCP 服务的新增/删除也会改写快照里的 `skills` / `mcpServers`。写成功的一方广播修订号，
   * 这里重新读一次快照，否则**基准文档**停在旧值上，用户下一次保存任何一个不相关的字段
   * 就会把别人的写入改回去（整份文档写入，F22）。
   */
  const settingsRevision = useSettingsRevision();
  const snapshotResource = useAsyncResource(`settings:snapshot:${settingsRevision}`, () => getSettingsSnapshot(client), {
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
  const [saveOutcome, setSaveOutcome] = useState<SettingsSaveOutcome | null>(null);
  const savingRef = useRef(false);
  const saveScopeRef = useRef({ projectId, client, active: true });
  if (saveScopeRef.current.projectId !== projectId || saveScopeRef.current.client !== client) {
    saveScopeRef.current = { projectId, client, active: true };
  }
  useEffect(() => {
    const scope = saveScopeRef.current;
    scope.active = true;
    setPending(false);
    setSavedAt(null);
    setSaveError(null);
    setSaveOutcome(null);
    return () => { scope.active = false; };
  }, [client, projectId]);

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

  const indexPending = projectId !== null && indexResource.status !== 'error' && indexResource.data === null;

  useEffect(() => {
    const scope = projectId ?? 'none';
    if (scopeRef.current !== scope) {
      // A different project owns a different index configuration, so the draft goes with it.
      scopeRef.current = scope;
      baselineSnapshotRef.current = null;
      setState(null);
    }
    /**
     * 重读期间 `data` 会变回 null（修订号是资源键的一部分），这**不是**「没有文档」。
     *
     * 早期版本在这里无条件 `setState(null)`，后果是保存成功后一推送修订号，草稿就被清掉；
     * 而基准引用还在，等重读返回时走的是「基准已有」那条分支，永远不会再建草稿——整个面板
     * 就停在「正在读取设置…」（P8 闸门在 hooks 列表处超时抓到）。保留已有草稿才是对的行为：
     * 重读只刷新只读快照，删除草稿等于删掉十一个分区里的未保存修改。
     */
    if (loadedSnapshot === null) {
      return;
    }
    if (baselineSnapshotRef.current !== null) {
      /**
       * 基准已有，但快照变了：说明是**别人**写的（修订号变了才会重新读）。
       *
       * 只接上用户没动过的那个字段，不重建草稿——重建会删掉十一个分区里的未保存修改，
       * 而不接则会用旧基准把别人的写入改回去。两条都不能选，所以分路径判断：
       * 草稿里 `defaultModelId` 仍是基准值，就跟着新基准走；已经改过就以用户为准。
       *
       * 窄通道目前只能改 `defaultModelId`，其余字段（模型列表、权限、技能/MCP 列表）仍然
       * 只由这个中心写，所以不需要更通用的三方合并。
       */
      const baseline = baselineSnapshotRef.current;
      if (loadedSnapshot.defaultModelId !== baseline.defaultModelId) {
        setState((current) =>
          current === null || current.draft.defaultModelId !== baseline.defaultModelId
            ? current
            : {
                base: { ...current.base, defaultModelId: loadedSnapshot.defaultModelId },
                draft: { ...current.draft, defaultModelId: loadedSnapshot.defaultModelId }
              }
        );
      }
      baselineSnapshotRef.current = loadedSnapshot;
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

  const run = useCallback(async (): Promise<boolean> => {
    if (state === null || savingRef.current || validateDraft(state.draft).length > 0) return false;
    const scope = saveScopeRef.current;
    const isCurrent = (): boolean => saveScopeRef.current === scope && scope.active;
    savingRef.current = true;
    setPending(true);
    setSaveError(null);
    setSaveOutcome(null);
    try {
      const outcome = await saveSettingsDraft(client, state, (part, base, snapshot) => {
        // Other mounted readers must hear about successful writes even after this scope closed.
        if (isCurrent()) {
          if (snapshot !== null) baselineSnapshotRef.current = snapshot;
          setState((current) => current === null ? current : applySettingsCommit(current, state.draft, base, part));
        }
        notifySettingsChanged();
      }, isCurrent);
      if (!isCurrent()) return false;
      setSaveOutcome(outcome);
      setSaveError(outcome.error);
      if (outcome.ok) setSavedAt(new Date().toISOString());
      if (outcome.committed.length > 0) {
        reloadSnapshot();
        reloadIndex();
      }
      return outcome.ok;
    } finally {
      savingRef.current = false;
      if (isCurrent()) setPending(false);
    }
  }, [client, state, reloadIndex, reloadSnapshot]);

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
    save: { pending, error: saveError, outcome: saveOutcome, run },
    savedAt,
    projectId,
    client
  };
}
