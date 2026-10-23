import { useEffect, useMemo, useState } from 'react';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import type { ProviderConfig, ProviderTestResult } from '../../../shared/types';
import { useAsyncAction } from '../../app/use-async-resource';
import { ConfirmDialog } from '../../shell/ConfirmDialog';
import {
  CREATABLE_PROVIDER_TYPES,
  PROVIDER_TYPE_LABELS,
  createModelDraft,
  createProviderDraft,
  credentialRefFor,
  isFixedProviderId,
  testableModelOptions
} from '../settings-rules';
import type { SettingsStore } from '../settings-scope';
import { clearProviderSecret, setProviderSecret, testProvider } from '../settings-store';
import {
  CheckboxField,
  Field,
  NumberField,
  SelectField,
  FormNote,
  FormSection,
  TextField,
  formInputClass,
  formSecondaryButtonClass
} from '../../shared/form-ui';

/**
 * 模型与服务 (T8.3).
 *
 * Three facts from the main process shape this section, and each one is why a naive
 * "just edit the JSON" form would be wrong:
 *
 *  1. **`normalizeProvidersConfig` always materialises nvidia / openrouter / llama.cpp**
 *     and rewrites their id, name, endpoint and `credentialRef` on every save. Their
 *     fields are therefore locked and marked 「内置」 instead of offering an edit the
 *     backend discards.
 *  2. **A stored secret is unusable until the provider references it**: the model factory
 *     reads `provider.credentialRef`, requires `secret:<providerId>` and matches it to
 *     the provider id. So 「保存密钥」 does two things — `settings.setProviderSecret`
 *     (safeStorage) *and* setting `credentialRef` on that provider in the draft, which is
 *     then written by the next 保存设置. The key itself never enters the draft: it lives in
 *     component state only and is cleared on success.
 *  3. **`settings.testProvider` requires a concrete model** (`providerId` + `modelId`,
 *     both `min(1)`), so the button is bound to a model selection rather than to the
 *     provider alone.
 */

export function ModelsSection({ store }: { store: SettingsStore }): React.JSX.Element {
  const draft = store.draft;
  const providers = useMemo(() => draft?.providers ?? [], [draft]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // The selected provider is derived with a fallback so a removed provider cannot leave the
  // form pointing at nothing; the effect keeps the select's value in sync with it.
  const provider = providers.find((entry: ProviderConfig) => entry.id === selectedId) ?? providers[0] ?? null;
  useEffect(() => {
    if (provider !== null && selectedId !== provider.id) {
      setSelectedId(provider.id);
    }
  }, [provider, selectedId]);

  const providerIndex = provider === null ? -1 : providers.findIndex((entry: ProviderConfig) => entry.id === provider.id);
  const patchProvider = (mutator: (entry: ProviderConfig) => void): void => {
    store.update((next) => {
      const target = next.providers[providerIndex];
      if (target !== undefined) {
        mutator(target);
      }
    });
  };

  const [secretInput, setSecretInput] = useState('');
  const [clearSecretOpen, setClearSecretOpen] = useState(false);
  const [removeProviderOpen, setRemoveProviderOpen] = useState(false);
  const [testModelId, setTestModelId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);

  // The same helper the unit test pins: only *enabled* models may be tested, because
  // `settings.testProvider` refuses a model that is missing or disabled.
  const testModelOptions = useMemo(
    () => testableModelOptions(providers, provider?.id ?? null),
    [providers, provider]
  );
  const firstTestModelId = testModelOptions[0]?.key ?? null;
  useEffect(() => {
    if (testModelId === null || !testModelOptions.some((model) => model.key === testModelId)) {
      setTestModelId(firstTestModelId);
    }
  }, [testModelOptions, testModelId, firstTestModelId]);

  const stored = useMemo(() => {
    if (provider === null) {
      return false;
    }
    return store.snapshot?.providerSecretStatus.find((entry) => entry.providerId === provider.id)?.stored ?? false;
  }, [provider, store.snapshot]);

  const setSecret = useAsyncAction(
    (input: { providerId: string; plaintext: string }) => setProviderSecret(store.client, input),
    { label: '保存 Provider 密钥' }
  );
  const clearSecret = useAsyncAction((providerId: string) => clearProviderSecret(store.client, providerId), {
    label: '清除 Provider 密钥'
  });
  const test = useAsyncAction(
    (input: { providerId: string; modelId: string }) => testProvider(store.client, input),
    { label: '测试 Provider 连通' }
  );

  if (draft === null || provider === null) {
    return <FormNote testId="settings-models-unavailable">设置尚未读取完成。</FormNote>;
  }

  const builtIn = isFixedProviderId(provider.id);
  const reload = store.reload;
  const patchModel = (modelIndex: number, mutator: (model: ProviderConfig['models'][number]) => void): void => {
    patchProvider((entry) => {
      const target = entry.models[modelIndex];
      if (target !== undefined) {
        mutator(target);
      }
    });
  };

  return (
    <FormSection
      title="模型与服务"
      testId="settings-section-models-body"
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex w-[240px] flex-col gap-0.5">
          <span className="text-subtle text-[var(--font-micro-size)]">供应商</span>
          <select
            value={provider.id}
            onChange={(event) => {
              setSelectedId(event.target.value);
              setTestResult(null);
            }}
            data-testid="settings-provider-select"
            className={formInputClass}
          >
            {providers.map((entry: ProviderConfig) => (
              <option key={entry.id} value={entry.id}>
                {entry.name || entry.id}
                {entry.enabled ? '' : '（已停用）'}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          data-testid="settings-provider-add"
          onClick={() => {
            const created = createProviderDraft(
              CREATABLE_PROVIDER_TYPES[0] ?? 'custom',
              providers.map((entry: ProviderConfig) => entry.id)
            );
            store.update((next) => {
              next.providers.push(created);
            });
            setSelectedId(created.id);
          }}
          className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
        >
          <Plus size={11} aria-hidden="true" />
          新增供应商
        </button>
        {builtIn ? (
          <span
            className="rounded-control border border-line px-1.5 text-subtle text-[var(--font-micro-size)]"
            data-testid="settings-provider-builtin"
          >
            内置
          </span>
        ) : (
          <button
            type="button"
            data-testid="settings-provider-remove"
            onClick={() => setRemoveProviderOpen(true)}
            className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
          >
            <Trash2 size={11} aria-hidden="true" />
            移除供应商
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <TextField
          label="名称"
          value={provider.name}
          disabled={builtIn}
          onChange={(name) => patchProvider((entry) => void (entry.name = name))}
          testId="settings-provider-name"
        />
        <SelectField
          label="类型"
          value={provider.type}
          disabled={builtIn}
          options={(builtIn ? [provider.type] : [...CREATABLE_PROVIDER_TYPES]).map((type) => ({
            value: type,
            label: PROVIDER_TYPE_LABELS[type]
          }))}
          onChange={(type) => patchProvider((entry) => void (entry.type = type))}
          testId="settings-provider-type"
        />
        <TextField
          label="接入地址"
          value={provider.endpoint}
          disabled={builtIn}
          onChange={(endpoint) => patchProvider((entry) => void (entry.endpoint = endpoint))}
          testId="settings-provider-endpoint"
        />
        <Field
          label="凭据引用"
          testId="settings-provider-credential"
        >
          <span
            className="font-mono text-muted text-[var(--font-meta-size)]"
            data-testid="settings-provider-credential-ref"
          >
            {provider.credentialRef ?? '未引用'}
          </span>
        </Field>
      </div>

      <CheckboxField
        label="启用该供应商"
        checked={provider.enabled}
        onChange={(enabled) => patchProvider((entry) => void (entry.enabled = enabled))}
        testId="settings-provider-enabled"
      />

      <section className="flex flex-col gap-2 rounded-card border border-line bg-bg-soft px-3 py-2">
        <header className="flex items-center gap-2">
          <KeyRound size={12} aria-hidden="true" className="text-muted" />
          <h4 className="text-ink text-[var(--font-meta-size)]">API Key</h4>
          <span
            className="rounded-control border border-line px-1.5 text-[var(--font-micro-size)]"
            data-testid="settings-provider-secret-status"
            data-stored={String(stored)}
          >
            {stored ? '已配置（系统钥匙串）' : '未配置'}
          </span>
        </header>
        <div className="flex flex-wrap items-end gap-2">
          <TextField
            label="新密钥"
            type="password"
            value={secretInput}
            onChange={setSecretInput}
            testId="settings-provider-secret-input"
          />
          <button
            type="button"
            data-testid="settings-provider-secret-save"
            disabled={setSecret.pending || secretInput.trim().length === 0}
            onClick={() => {
              void setSecret.run({ providerId: provider.id, plaintext: secretInput }).then((result) => {
                if (result === null) {
                  return;
                }
                setSecretInput('');
                // The key is stored, but the provider only becomes usable once it references
                // the stored secret — mark that in the draft; the next 保存设置 writes it.
                patchProvider((entry) => void (entry.credentialRef = credentialRefFor(provider.id)));
                reload();
              });
            }}
            className={formSecondaryButtonClass}
          >
            保存密钥
          </button>
          <button
            type="button"
            data-testid="settings-provider-secret-clear"
            disabled={clearSecret.pending || !stored}
            onClick={() => setClearSecretOpen(true)}
            className={formSecondaryButtonClass}
          >
            清除密钥
          </button>
        </div>
        {setSecret.error === null ? null : (
          <FormNote tone="warn" testId="settings-provider-secret-error">
            {setSecret.error}
          </FormNote>
        )}
        {clearSecret.error === null ? null : (
          <FormNote tone="warn" testId="settings-provider-secret-clear-error">
            {clearSecret.error}
          </FormNote>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <header className="flex flex-wrap items-center gap-2">
          <h4 className="text-ink text-[var(--font-meta-size)]">模型（{provider.models.length}）</h4>
          <button
            type="button"
            data-testid="settings-model-add"
            onClick={() => patchProvider((entry) => void entry.models.push(createModelDraft()))}
            className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
          >
            <Plus size={11} aria-hidden="true" />
            添加模型
          </button>
        </header>


        <ul className="flex flex-col gap-2">
          {provider.models.map((model, modelIndex) => (
            <li
              key={`${provider.id}:${modelIndex}`}
              className="flex flex-col gap-2 rounded-card border border-line bg-surface px-3 py-2"
              data-testid={`settings-model-${modelIndex}`}
            >
              <div className="grid grid-cols-2 gap-2">
                <TextField
                  label="模型标识"
                  value={model.id}
                  onChange={(id) => patchModel(modelIndex, (target) => void (target.id = id))}
                  testId={`settings-model-id-${modelIndex}`}
                />
                <TextField
                  label="显示名"
                  value={model.displayName}
                  onChange={(displayName) => patchModel(modelIndex, (target) => void (target.displayName = displayName))}
                  testId={`settings-model-name-${modelIndex}`}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <NumberField
                  label="温度"
                  value={model.options?.temperature}
                  allowEmpty
                  step={0.1}
                  min={0}
                  onChange={(temperature) =>
                    patchModel(modelIndex, (target) => {
                      target.options = { ...(target.options ?? {}) };
                      if (typeof temperature !== 'number') {
                        delete target.options.temperature;
                      } else {
                        target.options.temperature = temperature;
                      }
                    })
                  }
                  testId={`settings-model-temperature-${modelIndex}`}
                />
                <NumberField
                  label="最大 token"
                  value={model.options?.maxTokens}
                  allowEmpty
                  min={1}
                  onChange={(maxTokens) =>
                    patchModel(modelIndex, (target) => {
                      target.options = { ...(target.options ?? {}) };
                      if (typeof maxTokens !== 'number') {
                        delete target.options.maxTokens;
                      } else {
                        target.options.maxTokens = maxTokens;
                      }
                    })
                  }
                  testId={`settings-model-maxtokens-${modelIndex}`}
                />
              </div>
              <div className="flex flex-wrap gap-4">
                <CheckboxField
                  label="启用"
                  checked={model.enabled}
                  onChange={(enabled) => patchModel(modelIndex, (target) => void (target.enabled = enabled))}
                  testId={`settings-model-enabled-${modelIndex}`}
                />
                <CheckboxField
                  label="流式"
                  checked={model.supportsStreaming}
                  onChange={(supportsStreaming) =>
                    patchModel(modelIndex, (target) => void (target.supportsStreaming = supportsStreaming))
                  }
                  testId={`settings-model-streaming-${modelIndex}`}
                />
                <CheckboxField
                  label="工具调用"
                  checked={model.supportsToolCalls}
                  onChange={(supportsToolCalls) =>
                    patchModel(modelIndex, (target) => void (target.supportsToolCalls = supportsToolCalls))
                  }
                  testId={`settings-model-tools-${modelIndex}`}
                />
                <CheckboxField
                  label="图片输入"
                  checked={model.supportsImages}
                  onChange={(supportsImages) =>
                    patchModel(modelIndex, (target) => void (target.supportsImages = supportsImages))
                  }
                  testId={`settings-model-images-${modelIndex}`}
                />
                <CheckboxField
                  label="思考"
                  checked={model.options?.thinking === true}
                  onChange={(thinking) =>
                    patchModel(modelIndex, (target) => {
                      target.options = { ...(target.options ?? {}), thinking };
                    })
                  }
                  testId={`settings-model-thinking-${modelIndex}`}
                />
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid={`settings-model-remove-${modelIndex}`}
                  onClick={() =>
                    patchProvider((entry) => {
                      entry.models.splice(modelIndex, 1);
                    })
                  }
                  className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
                >
                  <Trash2 size={11} aria-hidden="true" />
                  移除模型
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2 rounded-card border border-line bg-bg-soft px-3 py-2">
        <h4 className="text-ink text-[var(--font-meta-size)]">测速</h4>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex w-[240px] flex-col gap-0.5">
            <span className="text-subtle text-[var(--font-micro-size)]">用于测试的模型</span>
            <select
              value={testModelId ?? ''}
              onChange={(event) => {
                setTestModelId(event.target.value);
                setTestResult(null);
              }}
              data-testid="settings-test-model"
              className={formInputClass}
            >
              {testModelOptions.map((model) => (
                <option key={model.key} value={model.key}>
                  {model.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            data-testid="settings-test-provider"
            disabled={test.pending || testModelId === null}
            onClick={() => {
              if (testModelId === null) {
                return;
              }
              setTestResult(null);
              void test.run({ providerId: provider.id, modelId: testModelId }).then((result) => {
                if (result !== null) {
                  setTestResult(result);
                }
              });
            }}
            className={formSecondaryButtonClass}
          >
            {test.pending ? '测试中…' : '测试连通'}
          </button>
        </div>
        {test.error === null ? null : (
          <FormNote tone="warn" testId="settings-test-error">
            {test.error}
          </FormNote>
        )}
        {testResult === null ? null : (
          <FormNote testId="settings-test-result">
            {testResult.status === 'ready'
              ? `连通：${testResult.latencyMs === null ? '未返回延迟' : `${testResult.latencyMs} ms`}（检查项 ${testResult.checked.length}）`
              : `不连通：${testResult.error ?? '未知原因'}`}
          </FormNote>
        )}
      </section>

      <ConfirmDialog
        open={clearSecretOpen}
        title="清除该供应商的密钥？"
        message={`将从系统钥匙串删除 ${provider.name || provider.id} 的 API Key。`}
        detail="凭据引用会保留；下次调用前需要重新录入密钥。"
        confirmLabel="清除密钥"
        tone="destructive"
        testId="settings-secret-clear-confirm"
        onCancel={() => setClearSecretOpen(false)}
        onConfirm={() => {
          setClearSecretOpen(false);
          void clearSecret.run(provider.id).then((result) => {
            if (result !== null) {
              reload();
            }
          });
        }}
      />

      <ConfirmDialog
        open={removeProviderOpen}
        title="移除该供应商？"
        message={`将从设置中删除 ${provider.name || provider.id} 及其模型。`}
        detail="保存后生效；已存的密钥不会被删除。"
        confirmLabel="移除"
        tone="destructive"
        testId="settings-provider-remove-confirm"
        onCancel={() => setRemoveProviderOpen(false)}
        onConfirm={() => {
          setRemoveProviderOpen(false);
          store.update((next) => {
            next.providers = next.providers.filter((entry) => entry.id !== provider.id);
          });
          setSelectedId(null);
        }}
      />
    </FormSection>
  );
}
