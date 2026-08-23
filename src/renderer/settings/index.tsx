import { useCallback, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import type {
  AppSettings,
  McpServerSnapshot,
  PermissionsConfig,
  ProviderConfig,
  ProviderSecretStatus,
  ProviderTestResult,
  RocHookConfigSnapshot,
  SettingsSnapshot,
  SettingsSaveHookConfigRequest,
  SettingsTrustHookRequest,
  SkillSnapshot
} from '../../shared/types';
import {
  applySettingsSnapshot,
  assertProviderCreateIdAvailable,
  buildProviderConfigFromDraft,
  buildSettingsStateUpdate,
  createProviderDraft,
  deleteProviderFromSettingsSaveRequest,
  setDefaultModelInSettingsSaveRequest,
  selectSettingsSection,
  SETTINGS_SECTIONS,
  upsertProviderInSettingsSaveRequest,
  type CreatableProviderType,
  type LoadedSettingsState,
  type ProviderDraft,
  type SettingsSectionId
} from '../settings-model';
import type { LoadedState } from '../loaded-state';
import { unwrap } from '../loaded-state';
import type { RocClient } from '../shared/roc-client';
import { createRocClient } from '../shared/roc-client';
import { useSettingsDraft } from './use-settings-draft';
import { ProvidersSection } from './sections/providers-section';
import { DefaultModelSection } from './sections/default-model-section';
import { AppBasicsSection } from './sections/app-basics-section';
import { AuthSecuritySection } from './sections/auth-security-section';
import { HooksSection } from './sections/hooks-section';
import { MemorySection } from './sections/memory-section';
import { TaskSettingsSection } from './sections/task-settings-section';
import { ConfirmDialog } from '../components/ui';

export type SettingsViewState = {
  settings: AppSettings;
  providers: ProviderConfig[];
  defaultModelId: string | null;
  providerSecretStatus: ProviderSecretStatus[];
  permissions: PermissionsConfig;
  mcpServers: McpServerSnapshot[];
  skills: SkillSnapshot[];
  hookSettings: RocHookConfigSnapshot;
  hostIntegration: LoadedSettingsState['hostIntegration'];
  providerTestStatus: ProviderTestResult | null;
};

export type SettingsViewUpdate = (partial: Partial<LoadedState>) => void;

export function SettingsView({
  client,
  onProviderDirtyChange,
  state,
  updateLoadedState
}: {
  client?: RocClient;
  onProviderDirtyChange?: (dirty: boolean) => void;
  state: SettingsViewState;
  updateLoadedState: SettingsViewUpdate;
}): React.JSX.Element {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('providers');
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>(() => createInitialProviderDraft(state.providers));
  const [providerDraftBaseline, setProviderDraftBaseline] = useState<ProviderDraft>(() => createInitialProviderDraft(state.providers));
  const [pendingProviderNavigation, setPendingProviderNavigation] = useState<{ run: () => void } | null>(null);
  const [providerDraftError, setProviderDraftError] = useState<string | null>(null);
  const [secretBusyProviderId, setSecretBusyProviderId] = useState<string | null>(null);
  const [savingAll, setSavingAll] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function resolveClient(): RocClient {
    return client ?? createRocClient();
  }

  const draft = useSettingsDraft({
    baseSettings: state.settings,
    basePermissions: state.permissions,
    baseDefaultModelId: state.defaultModelId,
    baseProviders: state.providers
  });
  const providerDraftDirty = useMemo(
    () => JSON.stringify(providerDraft) !== JSON.stringify(providerDraftBaseline),
    [providerDraft, providerDraftBaseline]
  );

  useEffect(() => {
    onProviderDirtyChange?.(providerDraftDirty);
    return () => onProviderDirtyChange?.(false);
  }, [onProviderDirtyChange, providerDraftDirty]);

  function navigateFromProvider(run: () => void): void {
    if (providerDraftDirty) {
      setPendingProviderNavigation({ run });
      return;
    }
    run();
  }

  const buildBaseSaveRequest = useCallback(
    () =>
      draft.buildSaveRequest({
        providers: state.providers
      }),
    [draft, state.providers]
  );

  const refreshSettingsSnapshot = useCallback(async (): Promise<SettingsSnapshot> => {
    const refreshed = unwrap<SettingsSnapshot>('settings get', await resolveClient().api.settings.get());
    updateLoadedState(applySettingsSnapshot(refreshed));
    return refreshed;
  }, [client, updateLoadedState]);

  const updateProviderDraft = useCallback((partial: Partial<ProviderDraft>): void => {
    setProviderDraft((current) => ({
      ...current,
      ...partial
    }));
    setProviderDraftError(null);
  }, []);

  const startNewProvider = useCallback((type: CreatableProviderType): void => {
    navigateFromProvider(() => {
      const nextDraft = createProviderDraft(type);
      setProviderDraft(nextDraft);
      setProviderDraftBaseline(nextDraft);
      setProviderDraftError(null);
      setActiveSection('providers');
    });
  }, [providerDraftDirty]);

  const editProvider = useCallback((provider: ProviderConfig): void => {
    if (providerDraft.mode === 'edit' && providerDraft.id === provider.id) return;
    if (
      provider.type !== 'openai_compatible' &&
      provider.type !== 'anthropic_compatible' &&
      provider.type !== 'nvidia' &&
      provider.type !== 'openrouter' &&
      provider.type !== 'llama_cpp'
    ) {
      setProviderDraftError('当前设置页只能编辑 OpenAI 兼容、Anthropic 兼容、NVIDIA、OpenRouter 和 llama.cpp 提供商。');
      return;
    }
    const editableType = provider.type;
    navigateFromProvider(() => {
      const nextDraft = createProviderDraft(editableType, provider);
      setProviderDraft(nextDraft);
      setProviderDraftBaseline(nextDraft);
      setProviderDraftError(null);
      setActiveSection('providers');
    });
  }, [providerDraft.id, providerDraft.mode, providerDraftDirty]);

  const saveProviderDraft = useCallback(async (): Promise<void> => {
    let provider: ProviderConfig;
    const apiKey = providerDraft.apiKey.trim();
    try {
      provider = buildProviderConfigFromDraft(providerDraft);
      if (providerDraft.mode === 'create') {
        assertProviderCreateIdAvailable(state.providers, provider.id);
      }
    } catch (error) {
      setProviderDraftError(error instanceof Error ? error.message : '提供商草稿无效。');
      return;
    }
    let saved: SettingsSnapshot;
    try {
      saved = unwrap<SettingsSnapshot>(
        'settings save',
        await resolveClient().api.settings.save(upsertProviderInSettingsSaveRequest(buildBaseSaveRequest(), provider))
      );
    } catch (error) {
      setProviderDraftError(error instanceof Error ? error.message : '提供商保存失败。');
      return;
    }
    const savedProvider = saved.providers.find((entry) => entry.id === provider.id) ?? provider;
    const nextDraft: ProviderDraft = {
      ...createProviderDraft(providerDraft.type, savedProvider),
      apiKey
    };
    if (state.defaultModelId === saved.defaultModelId) {
      updateLoadedState(applySettingsSnapshot(saved));
    } else {
      updateLoadedState(await buildSettingsStateUpdate(resolveClient(), saved));
    }
    setProviderDraft(nextDraft);
    if (apiKey.length === 0) {
      setProviderDraftBaseline(nextDraft);
      setProviderDraftError(null);
      return;
    }
    setProviderDraftBaseline(createProviderDraft(providerDraft.type, savedProvider));
    try {
      const refreshed = await saveProviderSecret(savedProvider.id, apiKey);
      const refreshedProvider = refreshed.providers.find((entry) => entry.id === savedProvider.id) ?? savedProvider;
      const refreshedDraft = {
        ...createProviderDraft(providerDraft.type, refreshedProvider),
        apiKey: ''
      };
      setProviderDraft(refreshedDraft);
      setProviderDraftBaseline(refreshedDraft);
      setProviderDraftError(null);
    } catch (error) {
      setProviderDraft(nextDraft);
      setProviderDraftError(error instanceof Error ? error.message : 'API Key 保存失败。');
    }
  }, [client, providerDraft, buildBaseSaveRequest, saveProviderSecret, state.defaultModelId, state.providers, updateLoadedState]);

  const deleteProvider = useCallback(
    async (providerId: string): Promise<void> => {
      const saved = unwrap<SettingsSnapshot>(
        'settings save',
        await resolveClient().api.settings.save(
          deleteProviderFromSettingsSaveRequest(buildBaseSaveRequest(), providerId)
        )
      );
      if (state.defaultModelId === saved.defaultModelId) {
        updateLoadedState(applySettingsSnapshot(saved));
      } else {
        updateLoadedState(await buildSettingsStateUpdate(resolveClient(), saved));
      }
      const nextDraft = createInitialProviderDraft(saved.providers);
      setProviderDraft(nextDraft);
      setProviderDraftBaseline(nextDraft);
    },
    [buildBaseSaveRequest, client, state.defaultModelId, updateLoadedState]
  );

  const setDefaultModel = useCallback(
    async (modelId: string | null): Promise<void> => {
      const settingsClient = resolveClient();
      const saved = unwrap<SettingsSnapshot>(
        'settings save',
        await settingsClient.api.settings.save(
          setDefaultModelInSettingsSaveRequest(buildBaseSaveRequest(), modelId)
        )
      );
      updateLoadedState(await buildSettingsStateUpdate(settingsClient, saved));
    },
    [buildBaseSaveRequest, client, updateLoadedState]
  );

  const testProvider = useCallback(
    async (providerId: string, modelId: string): Promise<void> => {
      const result = unwrap<ProviderTestResult>(
        'provider test',
        await resolveClient().api.settings.testProvider({ providerId, modelId })
      );
      updateLoadedState({ providerTestStatus: result });
    },
    [client, updateLoadedState]
  );

  const refreshHooks = useCallback(async (): Promise<void> => {
    const refreshed = unwrap<RocHookConfigSnapshot>('settings hooks get', await resolveClient().api.settings.getHooks());
    updateLoadedState({ hookSettings: refreshed });
  }, [client, updateLoadedState]);

  const saveHooks = useCallback(
    async (request: SettingsSaveHookConfigRequest): Promise<void> => {
      const refreshed = unwrap<RocHookConfigSnapshot>(
        'settings hooks save',
        await resolveClient().api.settings.saveHooks(request)
      );
      updateLoadedState({ hookSettings: refreshed });
    },
    [client, updateLoadedState]
  );

  const trustHook = useCallback(
    async (request: SettingsTrustHookRequest): Promise<void> => {
      const refreshed = unwrap<RocHookConfigSnapshot>(
        'settings hooks trust',
        await resolveClient().api.settings.trustHook(request)
      );
      updateLoadedState({ hookSettings: refreshed });
    },
    [client, updateLoadedState]
  );

  async function saveProviderSecret(providerId: string, plaintext: string): Promise<SettingsSnapshot> {
    setSecretBusyProviderId(providerId);
    try {
      unwrap('provider secret save', await resolveClient().api.settings.setProviderSecret({ providerId, plaintext }));
      return await refreshSettingsSnapshot();
    } finally {
      setSecretBusyProviderId(null);
    }
  }

  const clearProviderSecret = useCallback(
    async (providerId: string): Promise<void> => {
      setSecretBusyProviderId(providerId);
      try {
        unwrap('provider secret clear', await resolveClient().api.settings.clearProviderSecret(providerId));
        await refreshSettingsSnapshot();
        setProviderDraft((current) =>
          current.id === providerId
            ? {
                ...current,
                apiKey: ''
              }
            : current
        );
        setProviderDraftError(null);
      } catch (error) {
        setProviderDraftError(error instanceof Error ? error.message : 'API Key 清除失败。');
      } finally {
        setSecretBusyProviderId(null);
      }
    },
    [client, refreshSettingsSnapshot]
  );

  const saveAll = useCallback(async (): Promise<void> => {
    setSaveError(null);
    setSavingAll(true);
    try {
      const saved = unwrap<SettingsSnapshot>(
        'settings save all',
        await resolveClient().api.settings.save(buildBaseSaveRequest())
      );
      updateLoadedState(applySettingsSnapshot(saved));
      setSaveError(null);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '保存失败。');
    } finally {
      setSavingAll(false);
    }
  }, [buildBaseSaveRequest, client, updateLoadedState]);

  const dirtyCount = draft.impactRows.length;

  return (
    <>
      <div className="page-strip settings-page-strip" data-testid="settings-header">
        <span className={dirtyCount === 0 ? 'pill ok' : 'pill warn'} data-testid="settings-dirty-count">
          {dirtyCount === 0 ? '无未保存变更' : `未保存 ${dirtyCount} 项`}
        </span>
        <div className="settings-page-actions">
          <button
            className="secondary"
            data-testid="settings-reset-all"
            disabled={!draft.isDirty || savingAll}
            onClick={() => draft.resetAll()}
            type="button"
          >
            放弃修改
          </button>
          <button
            className="primary"
            data-testid="settings-save-all"
            disabled={!draft.isDirty || savingAll}
            onClick={() => void saveAll()}
            type="button"
          >
            保存设置
          </button>
        </div>
      </div>
      <section className="canvas-stage stage-grid settings-view-stage" data-testid="settings-view">
        <div className="split settings-layout">
          <nav className="settings-list settings-sidebar-card">
            {SETTINGS_SECTIONS.map((item) => {
              const dirty = draft.dirtyIds.includes(item.id);
              return (
                <button
                  className={activeSection === item.id ? 'settings-item active' : 'settings-item'}
                  data-testid={`settings-section-${item.id}`}
                  key={item.id}
                  onClick={() => {
                    const nextSection = selectSettingsSection(activeSection, item.id);
                    if (nextSection === activeSection) return;
                    if (activeSection === 'providers') {
                      navigateFromProvider(() => setActiveSection(nextSection));
                      return;
                    }
                    setActiveSection(nextSection);
                  }}
                  type="button"
                >
                  <span>{item.label}</span>
                  {dirty ? <span className="settings-dirty-marker" aria-label="未保存" /> : null}
                </button>
              );
            })}
          </nav>
          <div className="settings-panel-stack settings-panel-stack--compact">
            {saveError === null ? null : (
              <div className="settings-save-error" data-testid="settings-save-error">
                {saveError}
              </div>
            )}
            {activeSection === 'providers' ? (
              <ProvidersSection
                draft={providerDraft}
                draftError={providerDraftError}
                onClearProviderSecret={clearProviderSecret}
                onDeleteProvider={deleteProvider}
                onEditProvider={editProvider}
                onSaveProviderDraft={saveProviderDraft}
                onStartNewProvider={startNewProvider}
                onTestProvider={testProvider}
                onUpdateDraft={updateProviderDraft}
                providers={state.providers}
                providerSecretStatus={state.providerSecretStatus}
                providerTestStatus={state.providerTestStatus}
                secretBusyProviderId={secretBusyProviderId}
              />
            ) : null}
            {activeSection === 'default-model' ? (
              <DefaultModelSection
                defaultModelId={state.defaultModelId}
                onClearDefaultModel={() => setDefaultModel(null)}
                onSelectDefaultModel={setDefaultModel}
                providers={state.providers}
              />
            ) : null}
            {activeSection === 'app-basics' ? (
              <AppBasicsSection
                draft={draft.settings}
                hostIntegration={state.hostIntegration}
                onChange={draft.setSettings}
              />
            ) : null}
            {activeSection === 'tasks' ? (
              <TaskSettingsSection
                draft={draft.settings}
                onChange={draft.setSettings}
              />
            ) : null}
            {activeSection === 'auth-security' ? (
              <AuthSecuritySection draft={draft.permissions} onChange={draft.setPermissions} />
            ) : null}
            {activeSection === 'hooks' ? (
              <HooksSection
                snapshot={state.hookSettings}
                onRefresh={refreshHooks}
                onSave={saveHooks}
                onTrust={trustHook}
              />
            ) : null}
            {activeSection === 'memory' ? (
              <MemorySection draft={draft.settings} onChange={draft.setSettings} />
            ) : null}
          </div>
        </div>
      </section>
      <ConfirmDialog
        confirmLabel="放弃修改"
        description="当前提供商有未保存修改。继续后这些修改会丢失。"
        onCancel={() => setPendingProviderNavigation(null)}
        onConfirm={() => {
          const pending = pendingProviderNavigation;
          setPendingProviderNavigation(null);
          setProviderDraft(providerDraftBaseline);
          setProviderDraftError(null);
          pending?.run();
        }}
        open={pendingProviderNavigation !== null}
        title="放弃提供商修改？"
      />
    </>
  );
}

function createInitialProviderDraft(providers: ProviderConfig[]): ProviderDraft {
  const nvidia = providers.find((provider) => provider.id === 'nvidia');
  if (nvidia !== undefined) {
    return createProviderDraft('nvidia', nvidia);
  }
  const openRouter = providers.find((provider) => provider.id === 'openrouter');
  if (openRouter !== undefined) {
    return createProviderDraft('openrouter', openRouter);
  }
  const llamaCpp = providers.find((provider) => provider.id === 'llama_cpp');
  if (llamaCpp !== undefined) {
    return createProviderDraft('llama_cpp', llamaCpp);
  }
  return createProviderDraft('openai_compatible');
}
