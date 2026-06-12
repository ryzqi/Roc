import { useCallback, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import type {
  McpServerSnapshot,
  ProviderConfig,
  ProviderSecretStatus,
  ProviderTestResult,
  SettingsSnapshot,
  SkillSnapshot,
  PermissionsConfig,
  AppSettings
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
import { MemorySection } from './sections/memory-section';
import { BrowserSection } from './sections/browser-section';
import { CapabilitiesSection } from './sections/capabilities-section';

export type SettingsViewState = {
  settings: AppSettings;
  providers: ProviderConfig[];
  defaultModelId: string | null;
  providerSecretStatus: ProviderSecretStatus[];
  permissions: PermissionsConfig;
  mcpServers: McpServerSnapshot[];
  skills: SkillSnapshot[];
  hostIntegration: LoadedSettingsState['hostIntegration'];
  providerTestStatus: ProviderTestResult | null;
};

export type SettingsViewUpdate = (partial: Partial<LoadedState>) => void;

export function SettingsView({
  client,
  onNavigate,
  state,
  updateLoadedState
}: {
  client?: RocClient;
  onNavigate: (target: 'mcp' | 'skills') => void;
  state: SettingsViewState;
  updateLoadedState: SettingsViewUpdate;
}): React.JSX.Element {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('providers');
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>(() => createInitialProviderDraft(state.providers));
  const [providerDraftError, setProviderDraftError] = useState<string | null>(null);
  const [secretBusyProviderId, setSecretBusyProviderId] = useState<string | null>(null);
  const [exaTestLabel, setExaTestLabel] = useState<string>('未测试');
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

  const exaServer = useMemo(
    () => state.mcpServers.find((server) => server.id === 'exa-hosted') ?? null,
    [state.mcpServers]
  );

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
        if (apiKey.length === 0) {
          throw new Error('新建 Provider 必须填写 API Key。');
        }
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

  async function saveProviderSecret(providerId: string, plaintext: string): Promise<SettingsSnapshot> {
    setSecretBusyProviderId(providerId);
    try {
      unwrap('provider secret save', await resolveClient().api.settings.setProviderSecret({ providerId, plaintext }));
      return await refreshSettingsSnapshot();
    } finally {
      setSecretBusyProviderId(null);
    }
  }

  const setProviderSecret = useCallback(
    async (providerId: string, plaintext: string): Promise<void> => {
      await saveProviderSecret(providerId, plaintext);
    },
    [saveProviderSecret]
  );

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

  const testExa = useCallback(async (): Promise<void> => {
    if (exaServer === null) {
      setExaTestLabel('未配置');
      return;
    }
    try {
      const result = unwrap('mcp test exa', await resolveClient().api.mcp.testServer(exaServer.id));
      setExaTestLabel(result.status);
    } catch (error) {
      setExaTestLabel(error instanceof Error ? error.message : 'invalid');
    }
  }, [client, exaServer]);

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

  useEffect(() => {
    setExaTestLabel('未测试');
  }, [exaServer?.id]);

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
                onSetProviderSecret={setProviderSecret}
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
            {activeSection === 'auth-security' ? (
              <AuthSecuritySection draft={draft.permissions} onChange={draft.setPermissions} />
            ) : null}
            {activeSection === 'memory' ? (
              <MemorySection draft={draft.settings} onChange={draft.setSettings} />
            ) : null}
            {activeSection === 'browser' ? (
              <BrowserSection exaServer={exaServer} onTestExa={testExa} testStatusLabel={exaTestLabel} />
            ) : null}
            {activeSection === 'capabilities' ? (
              <CapabilitiesSection
                mcpServers={state.mcpServers}
                onNavigate={onNavigate}
                skills={state.skills}
              />
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
