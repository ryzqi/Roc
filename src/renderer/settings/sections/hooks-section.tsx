import { useEffect, useState } from 'react';
import type React from 'react';
import type {
  RocHookConfigSnapshot,
  RocHookConfiguredHandlerSnapshot,
  SettingsSaveHookConfigRequest,
  SettingsTrustHookRequest
} from '../../../shared/types';
import { Button, TextArea } from '../../components/ui';

type HooksSectionProps = {
  snapshot: RocHookConfigSnapshot;
  onRefresh: () => Promise<void> | void;
  onSave: (request: SettingsSaveHookConfigRequest) => Promise<void> | void;
  onTrust: (request: SettingsTrustHookRequest) => Promise<void> | void;
};

export function HooksSection({
  snapshot,
  onRefresh,
  onSave,
  onTrust
}: HooksSectionProps): React.JSX.Element {
  const [jsonText, setJsonText] = useState(() => JSON.stringify(snapshot.config, null, 2));
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setJsonText(JSON.stringify(snapshot.config, null, 2));
    setLocalError(null);
  }, [snapshot.config]);

  async function refresh(): Promise<void> {
    try {
      setLocalError(null);
      await onRefresh();
    } catch (error) {
      setLocalError(formatError(error));
    }
  }

  async function save(): Promise<void> {
    let parsed: SettingsSaveHookConfigRequest['config'];
    try {
      parsed = JSON.parse(jsonText) as SettingsSaveHookConfigRequest['config'];
    } catch (error) {
      setLocalError(formatError(error));
      return;
    }
    try {
      setLocalError(null);
      await onSave({ config: parsed });
    } catch (error) {
      setLocalError(formatError(error));
    }
  }

  async function trust(handler: RocHookConfiguredHandlerSnapshot): Promise<void> {
    try {
      setLocalError(null);
      await onTrust({ handlerId: handler.id, hash: handler.hash });
    } catch (error) {
      setLocalError(formatError(error));
    }
  }

  return (
    <section
      aria-label="Hooks"
      className="single-panel settings-section settings-section-panel"
      data-testid="settings-panel-hooks"
    >
      <div className="section-head settings-section-header">
        <div>
          <h2 className="section-title">Hooks</h2>
          <p className="card-hint">{snapshot.configPath.length === 0 ? 'hooks.json' : snapshot.configPath}</p>
        </div>
        <div className="settings-actions">
          <Button onClick={() => void refresh()}>刷新</Button>
        </div>
      </div>
      <div className="settings-form">
        <div className="settings-section-group">
          <label className="field field--full">
            <span>Hooks JSON</span>
            <TextArea
              aria-label="Hooks JSON"
              data-testid="settings-hooks-json"
              onChange={(event) => setJsonText(event.currentTarget.value)}
              spellCheck={false}
              value={jsonText}
            />
          </label>
          <div className="settings-actions">
            <Button onClick={() => void save()} variant="primary">保存</Button>
          </div>
          {localError === null ? null : (
            <p className="field-error settings-error" data-testid="settings-hooks-local-error">
              {localError}
            </p>
          )}
          {snapshot.validationErrors.map((error) => (
            <p className="field-error settings-error" key={error}>
              {error}
            </p>
          ))}
        </div>
        <div className="settings-section-group">
          <h3 className="settings-group-title">处理器</h3>
          <div className="settings-table">
            {snapshot.handlers.length === 0 ? (
              <p className="card-hint">未配置 Hooks。</p>
            ) : (
              snapshot.handlers.map((handler) => (
                <div className="tool-row settings-table-row" key={handler.id}>
                  <div>
                    <strong>{handler.event}</strong>
                    <span className="tool-row-label">{formatMatcher(handler.matcher)}</span>
                    <code>{handler.command}</code>
                    {handler.validationError === null ? null : (
                      <small className="field-error">{handler.validationError}</small>
                    )}
                  </div>
                  <span>{handler.trustState}</span>
                  <span>{handler.lastRun === null ? '从未运行' : handler.lastRun.status}</span>
                  <Button onClick={() => void trust(handler)} size="compact">信任当前命令</Button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function formatMatcher(matcher: string | null): string {
  return matcher === null ? 'all' : matcher;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
