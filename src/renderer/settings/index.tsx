import { useCallback, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import type {
  IpcResult,
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
  buildProviderConfigFromDraft,
  createProviderDraft,
  deleteProviderFromSettingsSaveRequest,
  setDefaultModelInSettingsSaveRequest,
  selectSettingsSection,
  SETTINGS_SECTIONS,
  upsertProviderInSettingsSaveRequest,
  type EditableProviderType,
  type LoadedSettingsState,
  type ProviderDraft,
  type SettingsSectionId
} from '../settings-model';
import { useSettingsDraft } from './use-settings-draft';
import { ImpactPreviewModal } from './impact-preview-modal';
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
  providerTestStatus: ProviderTestResult | null;
};

export type SettingsViewUpdate = (partial: Partial<LoadedSettingsState>) => void;

function unwrap<T>(label: string, result: IpcResult<T>): T {
  if (result.ok) {
    return result.data;
  }
  throw new Error(`${label} failed: ${result.error.message}`);
}

export function SettingsView({
  onNavigate,
  state,
  updateLoadedState
}: {
  onNavigate: (target: 'mcp' | 'skills') => void;
  state: SettingsViewState;
  updateLoadedState: SettingsViewUpdate;
}): React.JSX.Element {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('providers');
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>(() =>
    createProviderDraft('openai_compatible')
  );
  const [providerDraftError, setProviderDraftError] = useState<string | null>(null);
  const [secretBusyProviderId, setSecretBusyProviderId] = useState<string | null>(null);
  const [exaTestLabel, setExaTestLabel] = useState<string>('未测试');
  const [showImpactModal, setShowImpactModal] = useState<boolean>(false);
  const [savingAll, setSavingAll] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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

  const updateProviderDraft = useCallback((partial: Partial<ProviderDraft>): void => {
    setProviderDraft((current) => ({
      ...current,
      ...partial
    }));
    setProviderDraftError(null);
  }, []);

  const startNewProvider = useCallback((type: EditableProviderType): void => {
    setProviderDraft(createProviderDraft(type));
    setProviderDraftError(null);
    setActiveSection('providers');
  }, []);

  const editProvider = useCallback((provider: ProviderConfig): void => {
    if (provider.type !== 'openai_compatible' && provider.type !== 'anthropic_compatible') {
      setProviderDraftError('当前设置页只编辑 OpenAI-compatible 和 Anthropic-compatible provider。');
      return;
    }
    setProviderDraft(createProviderDraft(provider.type, provider));
    setProviderDraftError(null);
    setActiveSection('providers');
  }, []);

  const saveProviderDraft = useCallback(async (): Promise<void> => {
    let provider: ProviderConfig;
    try {
      provider = buildProviderConfigFromDraft(providerDraft);
    } catch (error) {
      setProviderDraftError(error instanceof Error ? error.message : 'Provider 草稿无效。');
      return;
    }
    const saved = unwrap<SettingsSnapshot>(
      'settings save',
      await window.roc.settings.save(upsertProviderInSettingsSaveRequest(buildBaseSaveRequest(), provider))
    );
    updateLoadedState(applySettingsSnapshot(saved));
    setProviderDraft(createProviderDraft(providerDraft.type, provider));
    setProviderDraftError(null);
  }, [providerDraft, buildBaseSaveRequest, updateLoadedState]);

  const deleteProvider = useCallback(
    async (providerId: string): Promise<void> => {
      const saved = unwrap<SettingsSnapshot>(
        'settings save',
        await window.roc.settings.save(
          deleteProviderFromSettingsSaveRequest(buildBaseSaveRequest(), providerId)
        )
      );
      updateLoadedState(applySettingsSnapshot(saved));
    },
    [buildBaseSaveRequest, updateLoadedState]
  );

  const setDefaultModel = useCallback(
    async (modelId: string | null): Promise<void> => {
      const saved = unwrap<SettingsSnapshot>(
        'settings save',
        await window.roc.settings.save(
          setDefaultModelInSettingsSaveRequest(buildBaseSaveRequest(), modelId)
        )
      );
      updateLoadedState(applySettingsSnapshot(saved));
    },
    [buildBaseSaveRequest, updateLoadedState]
  );

  const testProvider = useCallback(
    async (providerId: string): Promise<void> => {
      const result = unwrap<ProviderTestResult>(
        'provider test',
        await window.roc.settings.testProvider(providerId)
      );
      updateLoadedState({ providerTestStatus: result });
    },
    [updateLoadedState]
  );

  const setProviderSecret = useCallback(
    async (providerId: string, plaintext: string): Promise<void> => {
      setSecretBusyProviderId(providerId);
      try {
        unwrap('provider secret save', await window.roc.settings.setProviderSecret({ providerId, plaintext }));
        const refreshed = unwrap<SettingsSnapshot>('settings get', await window.roc.settings.get());
        updateLoadedState(applySettingsSnapshot(refreshed));
      } finally {
        setSecretBusyProviderId(null);
      }
    },
    [updateLoadedState]
  );

  const clearProviderSecret = useCallback(
    async (providerId: string): Promise<void> => {
      setSecretBusyProviderId(providerId);
      try {
        unwrap('provider secret clear', await window.roc.settings.clearProviderSecret(providerId));
        const refreshed = unwrap<SettingsSnapshot>('settings get', await window.roc.settings.get());
        updateLoadedState(applySettingsSnapshot(refreshed));
      } finally {
        setSecretBusyProviderId(null);
      }
    },
    [updateLoadedState]
  );

  const testExa = useCallback(async (): Promise<void> => {
    if (exaServer === null) {
      setExaTestLabel('未配置');
      return;
    }
    try {
      const result = unwrap('mcp test exa', await window.roc.mcp.testServer(exaServer.id));
      setExaTestLabel(result.status);
    } catch (error) {
      setExaTestLabel(error instanceof Error ? error.message : 'invalid');
    }
  }, [exaServer]);

  const startSaveAll = useCallback((): void => {
    setSaveError(null);
    setShowImpactModal(true);
  }, []);

  const cancelSaveAll = useCallback((): void => {
    if (savingAll) {
      return;
    }
    setShowImpactModal(false);
  }, [savingAll]);

  const confirmSaveAll = useCallback(async (): Promise<void> => {
    setSavingAll(true);
    try {
      const saved = unwrap<SettingsSnapshot>(
        'settings save all',
        await window.roc.settings.save(buildBaseSaveRequest())
      );
      updateLoadedState(applySettingsSnapshot(saved));
      setShowImpactModal(false);
      setSaveError(null);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '保存失败。');
    } finally {
      setSavingAll(false);
    }
  }, [buildBaseSaveRequest, updateLoadedState]);

  useEffect(() => {
    setExaTestLabel('未测试');
  }, [exaServer?.id]);

  const dirtyCount = draft.impactRows.length;

  return (
    <>
      <div className="page-strip" data-testid="settings-header">
        <div className="page-copy">
          <div className="page-kicker">控制面</div>
          <h1 className="page-title">设置</h1>
        </div>
        <div className="page-actions">
          <span className={dirtyCount === 0 ? 'pill ok' : 'pill warn'} data-testid="settings-dirty-count">
            {dirtyCount === 0 ? '无未保存变更' : `未保存 ${dirtyCount} 项`}
          </span>
          <button
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
            onClick={startSaveAll}
            type="button"
          >
            保存设置
          </button>
        </div>
      </div>
      <section className="canvas-stage stage-grid" data-testid="settings-view">
        <div className="split">
          <nav className="settings-list">
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
          <div className="settings-panel-stack">
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
              <AppBasicsSection draft={draft.settings} onChange={draft.setSettings} />
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
      {showImpactModal ? (
        <ImpactPreviewModal
          busy={savingAll}
          onCancel={cancelSaveAll}
          onConfirm={confirmSaveAll}
          rows={draft.impactRows}
        />
      ) : null}
    </>
  );
}
