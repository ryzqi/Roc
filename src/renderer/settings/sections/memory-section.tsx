import type React from 'react';
import type { AppSettings } from '../../../shared/types';
import { CheckboxInput, TextInput } from '../../components/ui';
import { FieldRow } from '../atoms';

export function MemorySection({
  draft,
  onChange
}: {
  draft: AppSettings;
  onChange: (next: AppSettings) => void;
}): React.JSX.Element {
  function patchMemory(patch: Partial<AppSettings['memory']>): void {
    onChange({
      ...draft,
      memory: {
        ...draft.memory,
        ...patch
      }
    });
  }

  function patchCharLimit(kind: keyof AppSettings['memory']['charLimits'], value: number): void {
    patchMemory({
      charLimits: {
        ...draft.memory.charLimits,
        [kind]: value
      }
    });
  }

  function patchSecurityScan(kind: keyof AppSettings['memory']['securityScan'], enabled: boolean): void {
    patchMemory({
      securityScan: {
        ...draft.memory.securityScan,
        [kind]: enabled
      }
    });
  }

  function parsePositiveInteger(raw: string): number | null {
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  return (
    <section className="single-panel settings-section-panel" data-testid="settings-panel-memory">
      <div className="section-head">
        <h2 className="section-title">记忆策略</h2>
      </div>
      <div className="settings-form">
        <p className="card-hint">
          这里只管理 DeepAgents native memory 的容量、安全扫描、自动记忆和会话回忆保留期；USER.md 仅接受高置信直接用户偏好自动写入，具体文件在记忆中心编辑。
        </p>
        <div className="settings-section-group">
          <h3 className="settings-group-title">会话回忆</h3>
          <FieldRow hint="会话回忆超过保留期会被自动清理；策展记忆不受影响。" label="会话回忆保留">
            <TextInput
              data-testid="settings-memory-session-retention-days"
              onChange={(event) => {
                const value = parsePositiveInteger(event.currentTarget.value);
                if (value !== null) {
                  patchMemory({ sessionRetentionDays: value });
                }
              }}
              min={1}
              type="number"
              value={draft.memory.sessionRetentionDays}
            />
          </FieldRow>
        </div>
        <div className="settings-section-group">
          <h3 className="settings-group-title">安全扫描</h3>
          <p className="card-hint">当前写入记忆前会检查 prompt injection、凭据、SSH 后门和不可见字符。</p>
          <details className="settings-advanced">
            <summary>高级保护</summary>
            <div className="form-grid">
              <label className="field checkbox-field ui-checkbox">
                <span>Prompt injection 扫描</span>
                <CheckboxInput
                  checked={draft.memory.securityScan.promptInjection}
                  data-testid="settings-memory-security-prompt-injection"
                  onChange={(event) => patchSecurityScan('promptInjection', event.currentTarget.checked)}
                  type="checkbox"
                />
              </label>
              <label className="field checkbox-field ui-checkbox">
                <span>凭据扫描</span>
                <CheckboxInput
                  checked={draft.memory.securityScan.credential}
                  data-testid="settings-memory-security-credential"
                  onChange={(event) => patchSecurityScan('credential', event.currentTarget.checked)}
                  type="checkbox"
                />
              </label>
              <label className="field checkbox-field ui-checkbox">
                <span>SSH 后门扫描</span>
                <CheckboxInput
                  checked={draft.memory.securityScan.sshBackdoor}
                  data-testid="settings-memory-security-ssh-backdoor"
                  onChange={(event) => patchSecurityScan('sshBackdoor', event.currentTarget.checked)}
                  type="checkbox"
                />
              </label>
              <label className="field checkbox-field ui-checkbox">
                <span>不可见字符扫描</span>
                <CheckboxInput
                  checked={draft.memory.securityScan.invisibleUnicode}
                  data-testid="settings-memory-security-invisible-unicode"
                  onChange={(event) => patchSecurityScan('invisibleUnicode', event.currentTarget.checked)}
                  type="checkbox"
                />
              </label>
            </div>
          </details>
        </div>
        <div className="settings-section-group">
          <details className="settings-advanced">
            <summary>高级容量</summary>
            <div className="form-grid">
              <FieldRow hint="USER.md 最大字符数。" label="USER 容量">
                <TextInput
                  data-testid="settings-memory-char-limit-user"
                  onChange={(event) => {
                    const value = parsePositiveInteger(event.currentTarget.value);
                    if (value !== null) {
                      patchCharLimit('user', value);
                    }
                  }}
                  min={1}
                  type="number"
                  value={draft.memory.charLimits.user}
                />
              </FieldRow>
              <FieldRow hint="AGENTS.md 最大字符数。" label="AGENTS 容量">
                <TextInput
                  data-testid="settings-memory-char-limit-agents"
                  onChange={(event) => {
                    const value = parsePositiveInteger(event.currentTarget.value);
                    if (value !== null) {
                      patchCharLimit('agents', value);
                    }
                  }}
                  min={1}
                  type="number"
                  value={draft.memory.charLimits.agents}
                />
              </FieldRow>
              <FieldRow hint="MEMORY.md 最大字符数。" label="MEMORY 容量">
                <TextInput
                  data-testid="settings-memory-char-limit-memory"
                  onChange={(event) => {
                    const value = parsePositiveInteger(event.currentTarget.value);
                    if (value !== null) {
                      patchCharLimit('memory', value);
                    }
                  }}
                  min={1}
                  type="number"
                  value={draft.memory.charLimits.memory}
                />
              </FieldRow>
            </div>
          </details>
        </div>
      </div>
    </section>
  );
}
