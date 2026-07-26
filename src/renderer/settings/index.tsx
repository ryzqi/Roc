import { useCallback, useState } from 'react';
import type React from 'react';
import type {
  AgentLangSmithConfigV1,
  AgentLangSmithSetApiKeyRequest,
  AgentLangSmithSettings,
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
import { ObservabilitySection } from './sections/observability-section';
import { TaskSettingsSection } from './sections/task-settings-section';

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
  state,
  updateLoadedState
}: {
  client?: RocClient;
  state: SettingsViewState;
  updateLoadedState: SettingsViewUpdate;
}): React.JSX.Element {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('providers');
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>(() => createInitialProviderDraft(state.providers));
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
    setProviderDraft(createProviderDraft(type));
    setProviderDraftError(null);
    setActiveSection('providers');
  }, []);

  const editProvider = useCallback((provider: ProviderConfig): void => {
    if (
      provider.type !== 'openai_compatible' &&
      provider.type !== 'anthropic_compatible' &&
      provider.type !== 'nvidia' &&
      provider.type !== 'openrouter' &&
      provider.type !== 'llama_cpp'
    ) {
      setProviderDraftError('当前设置页只编辑 OpenAI-compatible、Anthropic-compatible、NVIDIA、OpenRouter 和 llama.cpp provider。');
      return;
    }
    setProviderDraft(createProviderDraft(provider.type, provider));
    setProviderDraftError(null);
    setActiveSection('providers');
  }, []);

  const saveProviderDraft = useCallback(async (): Promise<void> => {
    let provider: ProviderConfig;
    const apiKey = providerDraft.apiKey.trim();
    try {
      provider = buildProviderConfigFromDraft(providerDraft);
      if (providerDraft.mode === 'create') {
        assertProviderCreateIdAvailable(state.providers, provider.id);
      }
    } catch (error) {
      setProviderDraftError(error instanceof Error ? error.message : 'Provider 草稿无效。');
      return;
    }
    let saved: SettingsSnapshot;
    try {
      saved = unwrap<SettingsSnapshot>(
        'settings save',
        await resolveClient().api.settings.save(upsertProviderInSettingsSaveRequest(buildBaseSaveRequest(), provider))
      );
    } catch (error) {
      setProviderDraftError(error instanceof Error ? error.message : 'Provider 保存失败。');
      return;
    }
    const savedProvider = saved.providers.find((entry) => entry.id === provider.id) ?? provider;
    const nextDraft: ProviderDraft = {
      ...createProviderDraft(providerDraft.type, savedProvider),
      apiKey
    };
    updateLoadedState(applySettingsSnapshot(saved));
    setProviderDraft(nextDraft);
    if (apiKey.length === 0) {
      setProviderDraftError(null);
      return;
    }
    try {
      const refreshed = await saveProviderSecret(savedProvider.id, apiKey);
      const refreshedProvider = refreshed.providers.find((entry) => entry.id === savedProvider.id) ?? savedProvider;
      setProviderDraft({
        ...createProviderDraft(providerDraft.type, refreshedProvider),
        apiKey: ''
      });
      setProviderDraftError(null);
    } catch (error) {
      setProviderDraft(nextDraft);
      setProviderDraftError(error instanceof Error ? error.message : 'API Key 保存失败。');
    }
  }, [client, providerDraft, buildBaseSaveRequest, saveProviderSecret, state.providers, updateLoadedState]);

  const deleteProvider = useCallback(
    async (providerId: string): Promise<void> => {
      const saved = unwrap<SettingsSnapshot>(
        'settings save',
        await resolveClient().api.settings.save(
          deleteProviderFromSettingsSaveRequest(buildBaseSaveRequest(), providerId)
        )
      );
      updateLoadedState(applySettingsSnapshot(saved));
      setProviderDraft(createInitialProviderDraft(saved.providers));
    },
    [buildBaseSaveRequest, client, updateLoadedState]
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
    async (providerId: string): Promise<void> => {
      const result = unwrap<ProviderTestResult>(
        'provider test',
        await resolveClient().api.settings.testProvider(providerId)
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

  const loadLangSmithSettings = useCallback(async (): Promise<AgentLangSmithSettings> => {
    return unwrap<AgentLangSmithSettings>(
      'LangSmith settings get',
      await resolveClient().api.agent.getLangSmithSettings()
    );
  }, [client]);

  const saveLangSmithSettings = useCallback(
    async (config: AgentLangSmithConfigV1): Promise<AgentLangSmithSettings> => {
      return unwrap<AgentLangSmithSettings>(
        'LangSmith settings save',
        await resolveClient().api.agent.saveLangSmithSettings(config)
      );
    },
    [client]
  );

  const setLangSmithApiKey = useCallback(
    async (request: AgentLangSmithSetApiKeyRequest): Promise<AgentLangSmithSettings> => {
      return unwrap<AgentLangSmithSettings>(
        'LangSmith API Key save',
        await resolveClient().api.agent.setLangSmithApiKey(request)
      );
    },
    [client]
  );

  const clearLangSmithApiKey = useCallback(async (): Promise<AgentLangSmithSettings> => {
    return unwrap<AgentLangSmithSettings>(
      'LangSmith API Key clear',
      await resolveClient().api.agent.clearLangSmithApiKey()
    );
  }, [client]);

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
                  onClick={() => setActiveSection(selectSettingsSection(activeSection, item.id))}
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
            {activeSection === 'observability' ? (
              <ObservabilitySection
                onClearApiKey={clearLangSmithApiKey}
                onLoad={loadLangSmithSettings}
                onSaveConfig={saveLangSmithSettings}
                onSetApiKey={setLangSmithApiKey}
              />
            ) : null}
            {activeSection === 'memory' ? (
              <MemorySection draft={draft.settings} onChange={draft.setSettings} />
            ) : null}
          </div>
        </div>
      </section>
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
