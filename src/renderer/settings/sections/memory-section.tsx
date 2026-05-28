import type React from 'react';
import type { AppSettings } from '../../../shared/types';
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

  function parseRatio(raw: string): number | null {
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
  }

  return (
    <section className="single-panel settings-section-panel" data-testid="settings-panel-memory">
      <div className="section-head">
        <h2 className="section-title">记忆策略</h2>
      </div>
      <div className="settings-form">
        <p className="card-hint">
          这里只管理新记忆边界；具体文件在记忆中心编辑，写入时会执行容量和安全扫描。
        </p>
        <div className="form-grid">
          <label className="field checkbox-field">
            <span>冻结快照</span>
            <input
              checked={draft.memory.frozenSnapshotEnabled}
              data-testid="settings-memory-frozen-snapshot-enabled"
              onChange={(event) => patchMemory({ frozenSnapshotEnabled: event.currentTarget.checked })}
              type="checkbox"
            />
            <small className="field-hint">新会话启动时将 USER、AGENTS、MEMORY 汇总进系统上下文。</small>
          </label>
          <label className="field checkbox-field">
            <span>用户画像</span>
            <input
              checked={draft.memory.userProfileEnabled}
              data-testid="settings-memory-user-profile-enabled"
              onChange={(event) => patchMemory({ userProfileEnabled: event.currentTarget.checked })}
              type="checkbox"
            />
          </label>
          <label className="field checkbox-field">
            <span>规则文件</span>
            <input
              checked={draft.memory.agentsRulesEnabled}
              data-testid="settings-memory-agents-rules-enabled"
              onChange={(event) => patchMemory({ agentsRulesEnabled: event.currentTarget.checked })}
              type="checkbox"
            />
          </label>
          <FieldRow hint="会话回忆超过保留期会被自动清理；策展记忆不受影响。" label="会话回忆保留">
            <input
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
          <FieldRow hint="USER.md 最大字符数。" label="USER 容量">
            <input
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
            <input
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
            <input
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
          <label className="field checkbox-field">
            <span>自动压缩</span>
            <input
              checked={draft.memory.consolidatorEnabled}
              data-testid="settings-memory-consolidator-enabled"
              onChange={(event) => patchMemory({ consolidatorEnabled: event.currentTarget.checked })}
              type="checkbox"
            />
          </label>
          <FieldRow hint="记忆写入溢出后延迟合并的分钟数。" label="压缩延迟">
            <input
              data-testid="settings-memory-consolidator-debounce-minutes"
              onChange={(event) => {
                const value = parsePositiveInteger(event.currentTarget.value);
                if (value !== null) {
                  patchMemory({ consolidatorDebounceMinutes: value });
                }
              }}
              min={1}
              type="number"
              value={draft.memory.consolidatorDebounceMinutes}
            />
          </FieldRow>
          <FieldRow hint="压缩后目标容量占比，范围 0 到 1。" label="压缩目标">
            <input
              data-testid="settings-memory-consolidator-target-ratio"
              onChange={(event) => {
                const value = parseRatio(event.currentTarget.value);
                if (value !== null) {
                  patchMemory({ consolidatorTargetRatio: value });
                }
              }}
              max={1}
              min={0}
              step="0.01"
              type="number"
              value={draft.memory.consolidatorTargetRatio}
            />
          </FieldRow>
          <FieldRow hint="每天最多自动压缩次数。" label="压缩配额">
            <input
              data-testid="settings-memory-consolidator-daily-quota"
              onChange={(event) => {
                const value = parsePositiveInteger(event.currentTarget.value);
                if (value !== null) {
                  patchMemory({ consolidatorDailyQuota: value });
                }
              }}
              min={1}
              type="number"
              value={draft.memory.consolidatorDailyQuota}
            />
          </FieldRow>
          <label className="field checkbox-field">
            <span>预压缩刷新</span>
            <input
              checked={draft.memory.preCompactionFlushEnabled}
              data-testid="settings-memory-precompaction-flush-enabled"
              onChange={(event) => patchMemory({ preCompactionFlushEnabled: event.currentTarget.checked })}
              type="checkbox"
            />
          </label>
          <FieldRow hint="到达上下文窗口占比后触发静默刷新。" label="刷新阈值">
            <input
              data-testid="settings-memory-precompaction-token-threshold"
              onChange={(event) => {
                const value = parseRatio(event.currentTarget.value);
                if (value !== null) {
                  patchMemory({ preCompactionTokenThreshold: value });
                }
              }}
              max={1}
              min={0}
              step="0.01"
              type="number"
              value={draft.memory.preCompactionTokenThreshold}
            />
          </FieldRow>
          <FieldRow hint="估算上下文窗口 token 数。" label="上下文窗口">
            <input
              data-testid="settings-memory-precompaction-context-window-tokens"
              onChange={(event) => {
                const value = parsePositiveInteger(event.currentTarget.value);
                if (value !== null) {
                  patchMemory({ preCompactionContextWindowTokens: value });
                }
              }}
              min={1}
              type="number"
              value={draft.memory.preCompactionContextWindowTokens}
            />
          </FieldRow>
          <label className="field checkbox-field">
            <span>Prompt injection 扫描</span>
            <input
              checked={draft.memory.securityScan.promptInjection}
              data-testid="settings-memory-security-prompt-injection"
              onChange={(event) => patchSecurityScan('promptInjection', event.currentTarget.checked)}
              type="checkbox"
            />
          </label>
          <label className="field checkbox-field">
            <span>凭据扫描</span>
            <input
              checked={draft.memory.securityScan.credential}
              data-testid="settings-memory-security-credential"
              onChange={(event) => patchSecurityScan('credential', event.currentTarget.checked)}
              type="checkbox"
            />
          </label>
          <label className="field checkbox-field">
            <span>SSH 后门扫描</span>
            <input
              checked={draft.memory.securityScan.sshBackdoor}
              data-testid="settings-memory-security-ssh-backdoor"
              onChange={(event) => patchSecurityScan('sshBackdoor', event.currentTarget.checked)}
              type="checkbox"
            />
          </label>
          <label className="field checkbox-field">
            <span>不可见字符扫描</span>
            <input
              checked={draft.memory.securityScan.invisibleUnicode}
              data-testid="settings-memory-security-invisible-unicode"
              onChange={(event) => patchSecurityScan('invisibleUnicode', event.currentTarget.checked)}
              type="checkbox"
            />
          </label>
        </div>
      </div>
    </section>
  );
}
