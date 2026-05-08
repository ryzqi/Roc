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

  return (
    <section className="card" data-testid="settings-panel-memory">
      <div className="card-title">记忆策略</div>
      <div className="card-pad settings-form">
        <p className="card-hint">
          这里只管理记忆策略；具体记忆条目仍在记忆中心审阅、编辑或删除。
        </p>
        <div className="form-grid">
          <FieldRow hint="候选记忆是否需要人工审阅才能进入有效记忆。" label="候选记忆审阅">
            <select
              data-testid="settings-memory-candidate-review-mode"
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (value === 'manual' || value === 'auto_after_approval') {
                  patchMemory({ candidateReviewMode: value });
                }
              }}
              value={draft.memory.candidateReviewMode}
            >
              <option value="manual">人工审阅</option>
              <option value="auto_after_approval">已确认后自动准入</option>
            </select>
          </FieldRow>
          <label className="field checkbox-field">
            <span>暖记忆按需召回</span>
            <input
              checked={draft.memory.warmRecallEnabled}
              data-testid="settings-memory-warm-recall-enabled"
              onChange={(event) => patchMemory({ warmRecallEnabled: event.currentTarget.checked })}
              type="checkbox"
            />
          </label>
          <FieldRow hint="会话回忆超过保留期会被自动清理；策展记忆不受影响。" label="会话回忆保留">
            <select
              data-testid="settings-memory-session-retention-days"
              onChange={(event) => {
                const value = Number(event.currentTarget.value);
                if (value === 30 || value === 90 || value === 180) {
                  patchMemory({ sessionRetentionDays: value });
                }
              }}
              value={draft.memory.sessionRetentionDays}
            >
              <option value="30">30 天</option>
              <option value="90">90 天</option>
              <option value="180">180 天</option>
            </select>
          </FieldRow>
          <FieldRow
            hint="跨项目、跨任务召回是否需要显式扩大范围；扩大并标注会在结果中标记来源范围。"
            label="跨域召回策略"
          >
            <select
              data-testid="settings-memory-cross-scope-recall"
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (value === 'explicit_only' || value === 'expanded_with_label') {
                  patchMemory({ crossScopeRecall: value });
                }
              }}
              value={draft.memory.crossScopeRecall}
            >
              <option value="explicit_only">仅显式扩大范围</option>
              <option value="expanded_with_label">默认扩大并标注来源</option>
            </select>
          </FieldRow>
          <FieldRow
            hint="设为 0 / 关闭则冷记忆永不自动遗忘；用户保护项不受此设置影响。"
            label="冷记忆自动遗忘"
          >
            <select
              data-testid="settings-memory-cold-auto-forget-days"
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (value === 'never') {
                  patchMemory({ coldAutoForgetDays: null });
                  return;
                }
                const days = Number(value);
                if (days === 90 || days === 180 || days === 365) {
                  patchMemory({ coldAutoForgetDays: days });
                }
              }}
              value={draft.memory.coldAutoForgetDays === null ? 'never' : String(draft.memory.coldAutoForgetDays)}
            >
              <option value="90">90 天</option>
              <option value="180">180 天</option>
              <option value="365">365 天</option>
              <option value="never">不自动遗忘</option>
            </select>
          </FieldRow>
        </div>
      </div>
    </section>
  );
}
