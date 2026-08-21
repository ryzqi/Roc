import type React from 'react';
import {
  buildEnabledModelOptions,
  type EnabledModelOption
} from '../../settings-model';
import type { ProviderConfig } from '../../../shared/types';
import { InfoRow, StatusPill } from '../atoms';
import { Button } from '../../components/ui';

export function DefaultModelSection({
  defaultModelId,
  onClearDefaultModel,
  onSelectDefaultModel,
  providers
}: {
  defaultModelId: string | null;
  onClearDefaultModel: () => Promise<void>;
  onSelectDefaultModel: (modelId: string) => Promise<void>;
  providers: ProviderConfig[];
}): React.JSX.Element {
  const options: EnabledModelOption[] = buildEnabledModelOptions(providers);
  return (
    <section className="single-panel settings-section-panel" data-testid="default-model-settings">
      <div className="section-head">
        <h2 className="section-title">默认模型</h2>
        <StatusPill
          label="当前"
          tone={defaultModelId === null ? 'warn' : 'ok'}
          value={defaultModelId === null ? '缺失' : defaultModelId}
        />
      </div>
      {options.length === 0 ? (
        <InfoRow
          sub="请先在模型 Provider 标签下配置 provider 并启用至少一个模型。"
          tag="blocked"
          title="默认模型"
          tone="warn"
        />
      ) : (
        options.map((option) => (
          <div className="row action-row" key={`${option.providerId}:${option.modelId}`}>
            <div>
              <div className="row-title">{option.label}</div>
              <div className="row-sub">
                {option.providerId}:{option.modelId}
              </div>
            </div>
            <span className={defaultModelId === option.modelKey ? 'pill ok' : 'pill info'}>
              {defaultModelId === option.modelKey ? '默认' : '可选'}
            </span>
            <Button
              data-testid={`default-model-${option.providerId}-${option.modelId}`}
              onClick={() => void onSelectDefaultModel(option.modelKey)}
              size="compact"
            >
              设为默认
            </Button>
          </div>
        ))
      )}
      <div className="settings-actions">
        <Button data-testid="default-model-clear" onClick={() => void onClearDefaultModel()}>清除默认</Button>
      </div>
      <p className="card-hint">
        默认模型必须来自已启用 Provider 下的已启用模型；当前设置无法静默 fallback。
      </p>
    </section>
  );
}
