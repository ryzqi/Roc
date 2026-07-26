import { KeyRound, RefreshCw, Save, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type React from 'react';

import type {
  AgentLangSmithConfigV1,
  AgentLangSmithSetApiKeyRequest,
  AgentLangSmithSettings
} from '../../../shared/types';
import { FieldRow, StatusPill } from '../atoms';

type ObservabilitySectionProps = {
  onClearApiKey: () => Promise<AgentLangSmithSettings>;
  onLoad: () => Promise<AgentLangSmithSettings>;
  onSaveConfig: (config: AgentLangSmithConfigV1) => Promise<AgentLangSmithSettings>;
  onSetApiKey: (request: AgentLangSmithSetApiKeyRequest) => Promise<AgentLangSmithSettings>;
};

type Feedback = {
  kind: 'error' | 'success';
  message: string;
};

type BusyAction = 'clear-api-key' | 'save-api-key' | 'save-config';

export function ObservabilitySection({
  onClearApiKey,
  onLoad,
  onSaveConfig,
  onSetApiKey
}: ObservabilitySectionProps): React.JSX.Element {
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settings, setSettings] = useState<AgentLangSmithSettings | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void onLoad()
      .then((loaded) => {
        if (cancelled) {
          return;
        }
        setSettings(loaded);
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setSettings(null);
        setLoadError(formatError(error, 'LangSmith 设置加载失败。'));
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt, onLoad]);

  return (
    <section
      aria-label="可观测性"
      className="single-panel settings-section-panel"
      data-testid="settings-panel-observability"
    >
      <div className="section-head">
        <div>
          <h2 className="section-title">可观测性</h2>
          <p className="card-hint">LangSmith tracing 默认关闭，仅在明确启用后发送数据。</p>
        </div>
      </div>
      <div className="settings-observability-disclosure">
        <strong>数据边界</strong>
        <p>
          启用后，Roc 会将经脱敏的 trace 数据发送到 LangSmith。项目名称用于选择 LangSmith project；数据保留期限由 LangSmith workspace 的 retention policy 控制。
        </p>
      </div>
      {loading ? (
        <div
          aria-live="polite"
          className="settings-observability-loading"
          data-testid="settings-observability-loading"
          role="status"
        >
          正在读取可观测性设置…
        </div>
      ) : settings === null ? (
        <div className="settings-observability-load-error">
          <FeedbackMessage feedback={{ kind: 'error', message: requireLoadError(loadError) }} />
          <div className="settings-actions settings-observability-actions">
            <button
              data-testid="settings-observability-retry"
              onClick={() => setLoadAttempt((current) => current + 1)}
              type="button"
            >
              <RefreshCw aria-hidden="true" />
              重试
            </button>
          </div>
        </div>
      ) : (
        <ObservabilitySettingsForm
          initialSettings={settings}
          onClearApiKey={onClearApiKey}
          onSaveConfig={onSaveConfig}
          onSetApiKey={onSetApiKey}
        />
      )}
    </section>
  );
}

function ObservabilitySettingsForm({
  initialSettings,
  onClearApiKey,
  onSaveConfig,
  onSetApiKey
}: Omit<ObservabilitySectionProps, 'onLoad'> & {
  initialSettings: AgentLangSmithSettings;
}): React.JSX.Element {
  const [settings, setSettings] = useState(initialSettings);
  const [draft, setDraft] = useState(initialSettings.config);
  const [apiKey, setApiKey] = useState('');
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const normalizedProjectName = draft.projectName.trim();
  const projectNameInvalid = !(normalizedProjectName.length >= 1 && normalizedProjectName.length <= 128);
  const configChanged = [
    draft.enabled !== settings.config.enabled,
    normalizedProjectName !== settings.config.projectName
  ].some((changed) => changed);
  const formBusy = busyAction !== null;
  const enabledWithoutApiKey = draft.enabled && !settings.apiKeyStored;
  const tracingEnabledForClear = [settings.config.enabled, draft.enabled].some((enabled) => enabled);
  const enableDisabled = formBusy ? true : !settings.apiKeyStored && !draft.enabled;
  const saveConfigDisabled = formBusy
    ? true
    : !configChanged
      ? true
      : projectNameInvalid
        ? true
        : enabledWithoutApiKey;
  const saveApiKeyDisabled = formBusy ? true : apiKey.trim().length === 0;
  const clearApiKeyDisabled = formBusy ? true : !settings.apiKeyStored ? true : tracingEnabledForClear;

  async function saveConfig(): Promise<void> {
    setBusyAction('save-config');
    setFeedback(null);
    try {
      const saved = await onSaveConfig({
        schemaVersion: 1,
        enabled: draft.enabled,
        projectName: normalizedProjectName
      });
      setSettings(saved);
      setDraft(saved.config);
      setFeedback({ kind: 'success', message: '可观测性设置已保存。' });
    } catch (error) {
      setFeedback({ kind: 'error', message: formatError(error, '可观测性设置保存失败。') });
    } finally {
      setBusyAction(null);
    }
  }

  async function saveApiKey(): Promise<void> {
    setBusyAction('save-api-key');
    setFeedback(null);
    try {
      const saved = await onSetApiKey({ apiKey: apiKey.trim() });
      setSettings(saved);
      setApiKey('');
      setFeedback({ kind: 'success', message: 'API Key 已安全存储。' });
    } catch (error) {
      setFeedback({ kind: 'error', message: formatError(error, 'API Key 保存失败。') });
    } finally {
      setBusyAction(null);
    }
  }

  async function clearApiKey(): Promise<void> {
    setBusyAction('clear-api-key');
    setFeedback(null);
    try {
      const saved = await onClearApiKey();
      setSettings(saved);
      setFeedback({ kind: 'success', message: 'API Key 已清除。' });
    } catch (error) {
      setFeedback({ kind: 'error', message: formatError(error, 'API Key 清除失败。') });
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="settings-form settings-observability-form">
      <FeedbackMessage feedback={feedback} />
      <div className="settings-section-group settings-observability-group">
        <div className="settings-observability-group-header">
          <h3 className="settings-group-title">Tracing 配置</h3>
          <StatusPill
            label="配置"
            tone={configChanged ? 'warn' : 'ok'}
            value={configChanged ? '未保存' : '已同步'}
          />
        </div>
        <label className="field checkbox-field settings-toggle-row settings-observability-toggle">
          <span>启用 LangSmith tracing</span>
          <input
            checked={draft.enabled}
            data-testid="settings-observability-enabled"
            disabled={enableDisabled}
            onChange={(event) => {
              const enabled = event.currentTarget.checked;
              setDraft((current) => ({ ...current, enabled }));
            }}
            type="checkbox"
          />
          <small className="field-hint">
            {settings.apiKeyStored ? '关闭时不会向 LangSmith 发送新的 trace。' : '启用前必须先保存 API Key。'}
          </small>
        </label>
        <FieldRow hint="用于在 LangSmith workspace 中归集 Roc trace。" label="项目名称">
          <input
            aria-invalid={projectNameInvalid}
            data-testid="settings-observability-project-name"
            disabled={formBusy}
            maxLength={128}
            onChange={(event) => {
              const projectName = event.currentTarget.value;
              setDraft((current) => ({ ...current, projectName }));
            }}
            type="text"
            value={draft.projectName}
          />
          {projectNameInvalid ? <small className="field-error">项目名称不能为空。</small> : null}
        </FieldRow>
        <div className="settings-actions settings-observability-actions">
          <button
            className="primary"
            data-testid="settings-observability-save-config"
            disabled={saveConfigDisabled}
            onClick={() => void saveConfig()}
            type="button"
          >
            <Save aria-hidden="true" />
            {busyAction === 'save-config' ? '正在保存…' : '保存配置'}
          </button>
        </div>
      </div>
      <div className="settings-section-group settings-observability-group">
        <div className="settings-observability-group-header">
          <h3 className="settings-group-title">API Key</h3>
          <span data-testid="settings-observability-key-state">
            <StatusPill
              label="密钥"
              tone={settings.apiKeyStored ? 'ok' : 'warn'}
              value={settings.apiKeyStored ? '已安全存储' : '未设置'}
            />
          </span>
        </div>
        <FieldRow hint="仅在本机加密存储；读取设置时只返回是否已存储。" label="LangSmith API Key">
          <input
            autoComplete="off"
            data-testid="settings-observability-api-key"
            disabled={formBusy}
            onChange={(event) => setApiKey(event.currentTarget.value)}
            spellCheck={false}
            type="password"
            value={apiKey}
          />
        </FieldRow>
        <div className="settings-actions settings-observability-actions">
          <button
            className="primary"
            data-testid="settings-observability-save-api-key"
            disabled={saveApiKeyDisabled}
            onClick={() => void saveApiKey()}
            type="button"
          >
            <KeyRound aria-hidden="true" />
            {busyAction === 'save-api-key' ? '正在保存…' : '保存 API Key'}
          </button>
          <button
            className="secondary"
            data-testid="settings-observability-clear-api-key"
            disabled={clearApiKeyDisabled}
            onClick={() => void clearApiKey()}
            type="button"
          >
            <Trash2 aria-hidden="true" />
            {busyAction === 'clear-api-key' ? '正在清除…' : '清除 API Key'}
          </button>
        </div>
        {settings.config.enabled ? (
          <small className="field-hint">请先关闭 tracing 并保存配置，再清除 API Key。</small>
        ) : draft.enabled ? (
          <small className="field-hint">请先取消尚未保存的启用修改，再清除 API Key。</small>
        ) : null}
      </div>
    </div>
  );
}

function FeedbackMessage({ feedback }: { feedback: Feedback | null }): React.JSX.Element | null {
  if (feedback === null) {
    return null;
  }
  return (
    <p
      aria-live={feedback.kind === 'error' ? 'assertive' : 'polite'}
      className={`settings-observability-feedback ${feedback.kind}`}
      data-testid="settings-observability-feedback"
      role={feedback.kind === 'error' ? 'alert' : 'status'}
    >
      {feedback.message}
    </p>
  );
}

function requireLoadError(error: string | null): string {
  if (error === null) {
    throw new Error('settings_observability_load_error_missing');
  }
  return error;
}

function formatError(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message.length > 0) {
      return message;
    }
  }
  return fallback;
}
