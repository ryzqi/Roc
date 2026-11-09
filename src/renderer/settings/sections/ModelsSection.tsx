import { useMemo, useState } from 'react';
import { ChevronRight, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { ProviderConfig, ProviderTestResult, RemoteModelEntry } from '../../../shared/types';
import { buildProviderModelKey, parseProviderModelKey } from '../../../shared/provider-model-key';
import { useAsyncAction } from '../../app/use-async-resource';
import { RadixSettingsConfirmDialog } from '../radix-dialog-pilot';
import {
  CREATABLE_PROVIDER_TYPES,
  PROVIDER_TYPE_LABELS,
  createModelDraft,
  createModelDraftFromRemote,
  createProviderDraft,
  credentialRefFor,
  testableModelOptions
} from '../settings-rules';
import type { SettingsStore } from '../settings-scope';
import { RemoteModelPicker } from '../RemoteModelPicker';
import { clearProviderSecret, setProviderSecret, testProvider } from '../settings-store';
import {
  CheckboxField,
  NumberField,
  SelectField,
  FormNote,
  FormSection,
  TextField,
  formButtonClass,
  formInputClass,
  formSecondaryButtonClass
} from '../../shared/form-ui';

export function ModelsSection({ store }: { store: SettingsStore }): React.JSX.Element {
  const providers = store.draft?.providers ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const provider = providers.find((entry) => entry.id === selectedId) ?? providers[0] ?? null;

  if (store.draft === null) {
    return <FormNote testId="settings-models-unavailable">设置尚未读取完成。</FormNote>;
  }

  return (
    <FormSection title="模型与服务" testId="settings-section-models-body">
      {provider === null ? <p className="text-muted" data-testid="settings-models-empty">尚未添加供应商</p> : null}
      <div className="form-action-row">
        {provider === null ? null : (
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-muted text-[length:var(--font-meta-size)]">供应商</span>
            <select value={provider.id} onChange={(event) => setSelectedId(event.target.value)}
              data-testid="settings-provider-select" className={formInputClass}>
              {providers.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name || entry.id}{entry.enabled ? '' : '（已停用）'}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="button" data-testid="settings-provider-add" className={formButtonClass}
          onClick={() => {
            const created = createProviderDraft(CREATABLE_PROVIDER_TYPES[0] ?? 'custom', providers.map((entry) => entry.id));
            store.update((next) => { next.providers.push(created); });
            setSelectedId(created.id);
          }}>
          <Plus size={14} aria-hidden="true" />新增供应商
        </button>
      </div>
      {/* Provider identity owns sensitive inputs and async feedback. Switching providers
          unmounts this editor; async writes still target an ID, never a mutable array index. */}
      {provider === null ? null : <ProviderEditor key={provider.id} provider={provider} store={store} />}
    </FormSection>
  );
}

function ProviderEditor({ provider, store }: { provider: ProviderConfig; store: SettingsStore }): React.JSX.Element {
  const [secretInput, setSecretInput] = useState('');
  const [clearSecretOpen, setClearSecretOpen] = useState(false);
  const [removeProviderOpen, setRemoveProviderOpen] = useState(false);
  const [removeModelIndex, setRemoveModelIndex] = useState<number | null>(null);
  const [selectedTestModel, setSelectedTestModel] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ modelId: string; config: string; result: ProviderTestResult } | null>(null);
  const [pullModelsOpen, setPullModelsOpen] = useState(false);
  const patchProvider = (mutator: (entry: ProviderConfig) => void): void => {
    store.update((next) => {
      const target = next.providers.find((entry) => entry.id === provider.id);
      if (target !== undefined) mutator(target);
    });
  };
  const patchModel = (index: number, mutator: (model: ProviderConfig['models'][number]) => void): void => {
    patchProvider((entry) => {
      const model = entry.models[index];
      if (model !== undefined) mutator(model);
    });
  };
  const testModelOptions = useMemo(() => testableModelOptions([provider], provider.id), [provider]);
  const testModelId = testModelOptions.find((model) => model.key === selectedTestModel)?.key ?? testModelOptions[0]?.key ?? null;
  const stored = store.snapshot?.providerSecretStatus.find((entry) => entry.providerId === provider.id)?.stored ?? false;
  const config = JSON.stringify(provider);
  const savedProvider = store.base?.providers.find((entry) => entry.id === provider.id);
  // Connectivity uses persisted backend settings, so never present a test of stale settings
  // as a verdict on the currently edited endpoint/model.
  const saved = config === JSON.stringify(savedProvider);
  const visibleTestResult = testResult?.modelId === testModelId && testResult.config === config ? testResult.result : null;
  const setSecret = useAsyncAction(
    (input: { providerId: string; plaintext: string }) => setProviderSecret(store.client, input), { label: '保存供应商密钥' }
  );
  const clearSecret = useAsyncAction((providerId: string) => clearProviderSecret(store.client, providerId), { label: '清除供应商密钥' });
  const test = useAsyncAction(
    (input: { providerId: string; modelId: string }) => testProvider(store.client, input), { label: '测试供应商连通' }
  );

  return (
    <>
      <div className="form-grid">
        <TextField label="名称" value={provider.name} onChange={(name) => patchProvider((entry) => void (entry.name = name))}
          testId="settings-provider-name" />
        <SelectField label="类型" value={provider.type}
          options={CREATABLE_PROVIDER_TYPES.map((type) => ({ value: type, label: PROVIDER_TYPE_LABELS[type] }))}
          onChange={(type) => patchProvider((entry) => void (entry.type = type))} testId="settings-provider-type" />
      </div>
      <TextField label="接入地址" value={provider.endpoint}
        onChange={(endpoint) => patchProvider((entry) => void (entry.endpoint = endpoint))} testId="settings-provider-endpoint" />
      <CheckboxField label="启用供应商" checked={provider.enabled}
        onChange={(enabled) => patchProvider((entry) => void (entry.enabled = enabled))} testId="settings-provider-enabled" />

      <div className="flex flex-col gap-2 border-t-[0.5px] border-line pt-4">
        <div className="form-action-row">
          <TextField label="API Key" type="password" value={secretInput} onChange={setSecretInput}
            placeholder={stored ? '输入新密钥以替换' : '输入密钥'} testId="settings-provider-secret-input" />
          <button type="button" data-testid="settings-provider-secret-save" className={formButtonClass}
            disabled={setSecret.pending || clearSecret.pending || secretInput.trim().length === 0}
            onClick={() => {
              void setSecret.run({ providerId: provider.id, plaintext: secretInput }).then((result) => {
                if (!result.ok) return;
                setSecretInput('');
                // safeStorage owns plaintext; only its reference enters the shared draft.
                patchProvider((entry) => void (entry.credentialRef = credentialRefFor(provider.id)));
                store.reload();
              });
            }}>
            {setSecret.pending ? '保存中…' : '保存密钥'}
          </button>
          <button type="button" data-testid="settings-provider-secret-clear" className={formButtonClass}
            disabled={clearSecret.pending || setSecret.pending || !stored} onClick={() => setClearSecretOpen(true)}>
            清除密钥
          </button>
        </div>
        <span className="text-muted text-[length:var(--font-meta-size)]" role="status"
          data-testid="settings-provider-secret-status" data-stored={String(stored)}>{stored ? '已配置' : '未配置'}</span>
        {setSecret.error === null ? null : <FormNote tone="warn" testId="settings-provider-secret-error">{setSecret.error}</FormNote>}
        {clearSecret.error === null ? null : <FormNote tone="warn" testId="settings-provider-secret-clear-error">{clearSecret.error}</FormNote>}
      </div>

      <section className="flex flex-col gap-3 border-t-[0.5px] border-line pt-4" aria-label="模型">
        <header className="flex flex-wrap items-center gap-2">
          <h4 className="mr-auto font-medium text-ink">模型</h4>
          <button type="button" data-testid="settings-model-pull" onClick={() => setPullModelsOpen(true)} className={formSecondaryButtonClass}>
            <RefreshCw size={14} aria-hidden="true" />拉取模型
          </button>
          <button type="button" data-testid="settings-model-add" className={formSecondaryButtonClass}
            onClick={() => patchProvider((entry) => void entry.models.push(createModelDraft()))}>
            <Plus size={14} aria-hidden="true" />手动添加
          </button>
        </header>
        {provider.models.length === 0 ? <p className="text-muted" data-testid="settings-models-list-empty">尚未添加模型</p> : null}
        <ul className="flex flex-col divide-y-[0.5px] divide-line">
          {provider.models.map((model, modelIndex) => (
            <li key={`${provider.id}:${modelIndex}`} className="flex flex-col gap-3 py-4 first:pt-0" data-testid={`settings-model-${modelIndex}`}>
              <div className="form-grid">
                <TextField label="模型标识" value={model.id}
                  onChange={(id) => patchModel(modelIndex, (target) => void (target.id = id))} testId={`settings-model-id-${modelIndex}`} />
                <TextField label="显示名称" value={model.displayName}
                  onChange={(displayName) => patchModel(modelIndex, (target) => void (target.displayName = displayName))} testId={`settings-model-name-${modelIndex}`} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <CheckboxField label="启用模型" checked={model.enabled}
                  onChange={(enabled) => patchModel(modelIndex, (target) => void (target.enabled = enabled))} testId={`settings-model-enabled-${modelIndex}`} />
                <button type="button" data-testid={`settings-model-remove-${modelIndex}`} onClick={() => setRemoveModelIndex(modelIndex)}
                  className={formSecondaryButtonClass} aria-label={`移除模型 ${model.displayName || model.id}`}>
                  <Trash2 size={14} aria-hidden="true" />移除模型
                </button>
              </div>
              <details className="group" data-testid={`settings-model-advanced-${modelIndex}`}>
                <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-control py-1 text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent">
                  <ChevronRight size={14} aria-hidden="true" className="group-open:rotate-90" />参数与能力
                </summary>
                <div className="flex flex-col gap-3 p-1 pt-3">
                  <div className="form-grid">
                    <NumberField label="温度" value={model.options?.temperature} allowEmpty step={0.1} min={0}
                      onChange={(temperature) => patchModel(modelIndex, (target) => {
                        target.options = { ...(target.options ?? {}) };
                        if (typeof temperature !== 'number') delete target.options.temperature;
                        else target.options.temperature = temperature;
                      })} testId={`settings-model-temperature-${modelIndex}`} />
                    <NumberField label="最大 token" value={model.options?.maxTokens} allowEmpty min={1}
                      onChange={(maxTokens) => patchModel(modelIndex, (target) => {
                        target.options = { ...(target.options ?? {}) };
                        if (typeof maxTokens !== 'number') delete target.options.maxTokens;
                        else target.options.maxTokens = maxTokens;
                      })} testId={`settings-model-maxtokens-${modelIndex}`} />
                  </div>
                  <div className="flex flex-wrap gap-x-5 gap-y-3">
                    <CheckboxField label="流式输出" checked={model.supportsStreaming}
                      onChange={(value) => patchModel(modelIndex, (target) => void (target.supportsStreaming = value))} testId={`settings-model-streaming-${modelIndex}`} />
                    <CheckboxField label="工具调用" checked={model.supportsToolCalls}
                      onChange={(value) => patchModel(modelIndex, (target) => void (target.supportsToolCalls = value))} testId={`settings-model-tools-${modelIndex}`} />
                    <CheckboxField label="图片输入" checked={model.supportsImages}
                      onChange={(value) => patchModel(modelIndex, (target) => void (target.supportsImages = value))} testId={`settings-model-images-${modelIndex}`} />
                    <CheckboxField label="思考" checked={model.options?.thinking === true}
                      onChange={(thinking) => patchModel(modelIndex, (target) => { target.options = { ...(target.options ?? {}), thinking }; })} testId={`settings-model-thinking-${modelIndex}`} />
                  </div>
                </div>
              </details>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2 border-t-[0.5px] border-line pt-4" aria-label="连接测试">
        <div className="form-action-row">
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-muted text-[length:var(--font-meta-size)]">测试模型</span>
            <select value={testModelId ?? ''} data-testid="settings-test-model" className={formInputClass}
              onChange={(event) => { setSelectedTestModel(event.target.value); setTestResult(null); test.reset(); }}>
              {testModelOptions.length === 0 ? <option value="">无可测试模型</option> : null}
              {testModelOptions.map((model) => <option key={model.key} value={model.key}>{model.label}</option>)}
            </select>
          </label>
          <button type="button" data-testid="settings-test-provider" className={formButtonClass}
            disabled={test.pending || testModelId === null || !saved} aria-describedby={!saved ? 'settings-test-save-required' : undefined}
            onClick={() => {
              if (testModelId === null || !saved) return;
              setTestResult(null);
              void test.run({ providerId: provider.id, modelId: testModelId }).then((outcome) => {
                if (outcome.ok) setTestResult({ modelId: testModelId, config, result: outcome.data });
              });
            }}>{test.pending ? '测试中…' : '测试连通'}</button>
        </div>
        {saved ? null : <p id="settings-test-save-required" className="text-muted text-[length:var(--font-meta-size)]">保存设置后可测试此供应商</p>}
        {test.error === null ? null : <FormNote tone="warn" testId="settings-test-error">{test.error}</FormNote>}
        {visibleTestResult === null ? null : (
          <FormNote tone={visibleTestResult.status === 'ready' ? 'default' : 'warn'} testId="settings-test-result">
            {visibleTestResult.status === 'ready'
              ? `连通：${visibleTestResult.latencyMs === null ? '未返回延迟' : `${visibleTestResult.latencyMs} ms`}`
              : `不连通：${visibleTestResult.error ?? '未知原因'}`}
          </FormNote>
        )}
      </section>
      <div className="border-t-[0.5px] border-line pt-4">
        <button type="button" data-testid="settings-provider-remove" onClick={() => setRemoveProviderOpen(true)}
          disabled={setSecret.pending || clearSecret.pending} className={formSecondaryButtonClass}>
          <Trash2 size={14} aria-hidden="true" />移除供应商
        </button>
      </div>

      <RemoteModelPicker open={pullModelsOpen} client={store.client} endpoint={provider.endpoint} providerId={provider.id}
        existingIds={provider.models.map((model) => model.id)} testId="settings-provider-models-pull" onClose={() => setPullModelsOpen(false)}
        onConfirm={(entries: RemoteModelEntry[]) => {
          patchProvider((entry) => {
            for (const picked of entries) {
              if (!entry.models.some((model) => model.id === picked.id)) entry.models.push(createModelDraftFromRemote(picked.id));
            }
          });
          setPullModelsOpen(false);
        }} />
      <RadixSettingsConfirmDialog open={clearSecretOpen} title="清除供应商密钥？"
        message={`将立即删除 ${provider.name || provider.id} 已保存的 API Key。`} detail="下次调用前需要重新录入密钥。"
        confirmLabel="清除密钥" tone="destructive" testId="settings-secret-clear-confirm" onCancel={() => setClearSecretOpen(false)}
        onConfirm={() => {
          setClearSecretOpen(false);
          void clearSecret.run(provider.id).then((result) => { if (result.ok) store.reload(); });
        }} />
      <RadixSettingsConfirmDialog open={removeProviderOpen} title="移除供应商？"
        message={`将移除 ${provider.name || provider.id} 及其模型。`} detail="保存设置后生效；已存密钥会保留。"
        confirmLabel="移除供应商" tone="destructive" testId="settings-provider-remove-confirm" onCancel={() => setRemoveProviderOpen(false)}
        onConfirm={() => {
          setRemoveProviderOpen(false);
          store.update((next) => {
            next.providers = next.providers.filter((entry) => entry.id !== provider.id);
            if (next.defaultModelId !== null && parseProviderModelKey(next.defaultModelId)?.providerId === provider.id) next.defaultModelId = null;
          });
        }} />
      <RadixSettingsConfirmDialog open={removeModelIndex !== null} title="移除模型？"
        message={`将移除 ${provider.models[removeModelIndex ?? -1]?.displayName || provider.models[removeModelIndex ?? -1]?.id || '此模型'}。`}
        detail="保存设置后生效；若为默认模型，将同时清除默认选择。" confirmLabel="移除模型" tone="destructive"
        testId="settings-model-remove-confirm" onCancel={() => setRemoveModelIndex(null)}
        onConfirm={() => {
          const index = removeModelIndex;
          setRemoveModelIndex(null);
          if (index === null) return;
          store.update((next) => {
            const target = next.providers.find((entry) => entry.id === provider.id);
            const model = target?.models[index];
            if (target === undefined || model === undefined) return;
            if (next.defaultModelId === buildProviderModelKey(provider.id, model.id)) next.defaultModelId = null;
            target.models.splice(index, 1);
          });
        }} />
    </>
  );
}
