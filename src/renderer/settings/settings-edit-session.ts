import type { SettingsSnapshot } from '../../shared/types/settings';
import type { RocClient } from '../shared/roc-client';
import { errorMessage } from '../app/loaded-state';
import { cloneDraft, diffDraftPaths, draftFromSnapshot, type SettingsDraft } from './settings-rules';
import { saveHookConfig, saveIndexSettings, saveSettings } from './settings-store';

export type SettingsCommit = 'core' | 'hooks' | 'index';
export type SettingsSaveOutcome = {
  ok: boolean;
  committed: SettingsCommit[];
  error: string | null;
};
export type SettingsEditState = { base: SettingsDraft; draft: SettingsDraft };

/** Advance only committed fields; edits made while the request was pending survive. */
export function applySettingsCommit(
  current: SettingsEditState,
  submitted: SettingsDraft,
  committed: SettingsDraft,
  part: SettingsCommit
): SettingsEditState {
  const next = { base: cloneDraft(current.base), draft: cloneDraft(current.draft) };
  const keys = part === 'core'
    ? ['settings', 'providers', 'defaultModelId', 'permissions'] as const
    : part === 'hooks' ? ['hooks'] as const : ['index'] as const;
  for (const key of keys) {
    Object.assign(next.base, { [key]: structuredClone(committed[key]) });
    if (diffDraftPaths(submitted[key], current.draft[key]).length === 0) {
      Object.assign(next.draft, { [key]: structuredClone(committed[key]) });
    }
  }
  return next;
}

/** Independent writes are not a transaction. Publish each commit before attempting the next. */
export async function saveSettingsDraft(
  client: RocClient,
  state: SettingsEditState,
  onCommit: (part: SettingsCommit, base: SettingsDraft, snapshot: SettingsSnapshot | null) => void,
  isCurrent: () => boolean
): Promise<SettingsSaveOutcome> {
  const { base, draft } = { base: cloneDraft(state.base), draft: cloneDraft(state.draft) };
  const committed: SettingsCommit[] = [];
  let committedBase = cloneDraft(base);
  let part: SettingsCommit = 'core';
  const publish = (snapshot: SettingsSnapshot | null): void => {
    committed.push(part);
    onCommit(part, cloneDraft(committedBase), snapshot);
  };
  const changed = (key: keyof SettingsDraft): boolean => diffDraftPaths(base[key], draft[key]).length > 0;
  try {
    if (['settings', 'providers', 'defaultModelId', 'permissions'].some((key) => changed(key as keyof SettingsDraft))) {
      const core = await saveSettings(client, {
        settings: draft.settings, providers: draft.providers,
        defaultModelId: draft.defaultModelId, permissions: draft.permissions
      });
      if (!core.ok) throw new Error(core.error.message);
      const normalized = draftFromSnapshot(core.data, committedBase.index);
      committedBase = { ...normalized, hooks: committedBase.hooks };
      publish(core.data);
    }
    if (!isCurrent()) return { ok: false, committed, error: null };
    part = 'hooks';
    if (changed('hooks')) {
      const hooks = await saveHookConfig(client, draft.hooks);
      if (!hooks.ok) throw new Error(hooks.error.message);
      committedBase.hooks = hooks.data.config;
      publish(null);
    }
    if (!isCurrent()) return { ok: false, committed, error: null };
    part = 'index';
    if (changed('index')) {
      if (draft.index === null || base.index === null) throw new Error('当前没有绑定工作目录的项目。');
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
      if (!index.ok) throw new Error(index.error.message);
      committedBase.index = index.data.settings;
      publish(null);
    }
    return { ok: true, committed, error: null };
  } catch (caught) {
    const label = { core: '模型与偏好', hooks: 'Hooks', index: '索引配置' }[part];
    const prefix = committed.length === 0 ? '' : '部分设置已保存；';
    return { ok: false, committed, error: `${prefix}${label}未保存：${errorMessage(caught)}` };
  }
}
