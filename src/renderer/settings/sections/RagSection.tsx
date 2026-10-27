import { useEffect, useMemo, useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import type { ResearchEmbeddingConfig } from '../../../shared/types/research';
import type { RemoteModelEntry } from '../../../shared/types';
import { useAsyncAction, useAsyncResource } from '../../app/use-async-resource';
import { RemoteModelPicker } from '../RemoteModelPicker';
import {
  INDEX_KIND_LABELS,
  linesToPatterns,
  patternsToLines,
  type SettingsDraft
} from '../settings-rules';
import type { SettingsStore } from '../settings-scope';
import { listEmbeddingConfigs, saveEmbeddingConfig } from '../settings-store';
import {
  CheckboxField,
  Field,
  NumberField,
  FormNote,
  FormSection,
  TextField,
  formButtonClass,
  formInputClass,
  formTextAreaClass
} from '../../shared/form-ui';

/**
 * 向量与 RAG (T8.3).
 *
 * Two different capabilities with two different shapes, which is why they are shown
 * together but written separately:
 *
 *  - **Index options are per project** (`research.index.configure` requires `projectId`
 *    and an `expectedRevision`, which is `status.settings.revision` — not the top-level
 *    `status.revision`, the mistake P7's gate hit). When no project is open the section
 *    says so instead of pretending a global value exists.
 *  - **Embedding configs are global** and their write requires a **plaintext `apiKey`**
 *    (`min(1)`, B23) even when only the dimensions changed — the main process stores it via
 *    `context.secrets.set`, the same safeStorage path as `settings.setProviderSecret`. The
 *    key therefore lives in this component's state for one save and is cleared afterwards;
 *    it is never part of the settings draft, the export snapshot or `localStorage`.
 *
 * Everything the legacy `ModelSettings` had for RAG that the backend does **not** have
 * (chunk size, chunk overlap, topK, RRF k, vector/keyword/paper weights, reranker model,
 * similarity threshold, contextual prefix, parent expansion) is absent on purpose and
 * registered in findings F22.
 */

type EmbeddingForm = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  /**
   * `null` = 交给主进程探测（P10）。
   *
   * 从端点拉到的模型并不知道维度，所以拉取之后这个字段先变成 `null`；保存时服务端发一次
   * 真实嵌入量出准确值。用户也可以手填覆盖（自建部署的截断维度、或想固定维度时）。
   */
  dimensions: number | null;
  enabled: boolean;
};

function formFromConfig(config: ResearchEmbeddingConfig): EmbeddingForm {
  return {
    id: config.id,
    name: config.name,
    baseUrl: config.baseUrl,
    model: config.model,
    dimensions: config.dimensions,
    enabled: config.enabled
  };
}

function newEmbeddingForm(existing: readonly ResearchEmbeddingConfig[]): EmbeddingForm {
  let index = existing.length + 1;
  while (existing.some((config) => config.id === `embedding-${index}`)) {
    index += 1;
  }
  return {
    id: `embedding-${index}`,
    name: '',
    baseUrl: 'https://api.openai.com/v1',
    model: 'text-embedding-3-small',
    dimensions: null,
    enabled: true
  };
}

/**
 * One pattern per line.
 *
 * Committed on blur rather than on every keystroke: `patternsToLines(linesToPatterns(text))`
 * normalises away blank lines, so writing back on change would delete the newline the user
 * just typed.
 */
function PatternsArea({
  label,
  patterns,
  onCommit,
  testId
}: {
  label: string;
  patterns: readonly string[];
  onCommit: (next: string[]) => void;
  testId: string;
}): React.JSX.Element {
  const [text, setText] = useState(() => patternsToLines(patterns));
  useEffect(() => {
    setText(patternsToLines(patterns));
  }, [patterns]);
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-subtle text-[var(--font-micro-size)]">{label}</span>
      <textarea
        value={text}
        rows={4}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => onCommit(linesToPatterns(text))}
        data-testid={testId}
        className={formTextAreaClass}
      />
    </label>
  );
}

export function RagSection({ store }: { store: SettingsStore }): React.JSX.Element {
  const draft = store.draft;
  const client = store.client;
  const embeddings = useAsyncResource('settings:embeddings', () => listEmbeddingConfigs(client), {
    label: '读取嵌入配置'
  });
  const configs = useMemo(() => embeddings.data ?? [], [embeddings.data]);

  const [selectedConfigId, setSelectedConfigId] = useState<string | null>(null);
  const [form, setForm] = useState<EmbeddingForm | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [pullModelsOpen, setPullModelsOpen] = useState(false);

  const selectedConfig = configs.find((config) => config.id === selectedConfigId) ?? null;
  useEffect(() => {
    if (form === null && configs.length > 0) {
      const first = configs[0];
      if (first !== undefined) {
        setSelectedConfigId(first.id);
        setForm(formFromConfig(first));
      }
    }
  }, [configs, form]);

  const saveEmbedding = useAsyncAction(
    (input: {
      id: string;
      name: string;
      baseUrl: string;
      model: string;
      dimensions: number | null;
      apiKey: string;
      enabled: boolean;
    }) => saveEmbeddingConfig(client, input),
    { label: '保存嵌入配置' }
  );

  if (draft === null) {
    return <FormNote testId="settings-rag-unavailable">设置尚未读取完成。</FormNote>;
  }

  const index = draft.index;
  const indexStatus = store.indexStatus;
  const updateIndex = (mutator: (index: Extract<SettingsDraft['index'], object>) => void): void => {
    store.update((next) => {
      if (next.index !== null) {
        mutator(next.index);
      }
    });
  };

  return (
    <FormSection
      title="向量与 RAG"
      testId="settings-section-rag-body"
    >
      <section className="flex flex-col gap-2 rounded-card border border-line bg-bg-soft px-3 py-2">
        <header className="flex flex-wrap items-center gap-2">
          <h4 className="text-ink text-[var(--font-meta-size)]">索引（当前项目）</h4>
          {indexStatus === null ? null : (
            <span className="font-mono text-subtle text-[var(--font-micro-size)]" data-testid="settings-index-status">
              phase {indexStatus.phase} · revision {indexStatus.settings.revision} · ready {indexStatus.counts.ready}/
              {indexStatus.counts.total}
            </span>
          )}
        </header>

        {store.projectId === null ? null : store.indexError !== null ? (
          <FormNote tone="warn" testId="settings-index-error">
            {store.indexError}
          </FormNote>
        ) : index === null ? (
          <FormNote testId="settings-index-loading">索引配置读取中…</FormNote>
        ) : (
          <>
            <Field label="索引文件类型" testId="settings-index-kinds">
              <div className="flex flex-wrap gap-3">
                {(Object.keys(INDEX_KIND_LABELS) as Array<keyof typeof INDEX_KIND_LABELS>).map((kind) => (
                  <CheckboxField
                    key={kind}
                    label={INDEX_KIND_LABELS[kind]}
                    checked={index.kinds.includes(kind)}
                    onChange={(checked) =>
                      updateIndex((target) => {
                        const nextKinds = checked
                          ? [...target.kinds, kind]
                          : target.kinds.filter((entry) => entry !== kind);
                        target.kinds = nextKinds;
                      })
                    }
                    testId={`settings-index-kind-${kind}`}
                  />
                ))}
              </div>
            </Field>

            <div className="grid grid-cols-2 gap-2">
              <PatternsArea
                label="包含模式（每行一条）"
                patterns={index.include}
                onCommit={(next) => updateIndex((target) => void (target.include = next))}
                testId="settings-index-include"
              />
              <PatternsArea
                label="排除模式（每行一条）"
                patterns={index.exclude}
                onCommit={(next) => updateIndex((target) => void (target.exclude = next))}
                testId="settings-index-exclude"
              />
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <CheckboxField
                label="监听文件变化"
                checked={index.watch}
                onChange={(watch) => updateIndex((target) => void (target.watch = watch))}
                testId="settings-index-watch"
              />
              <CheckboxField
                label="暂停索引"
                checked={index.paused}
                onChange={(paused) => updateIndex((target) => void (target.paused = paused))}
                testId="settings-index-paused"
              />
              <label className="flex w-[260px] flex-col gap-0.5">
                <span className="text-subtle text-[var(--font-micro-size)]">嵌入配置</span>
                <select
                  value={index.embeddingConfigId ?? ''}
                  onChange={(event) => {
                    const next = event.target.value;
                    updateIndex((target) => void (target.embeddingConfigId = next.length === 0 ? null : next));
                  }}
                  data-testid="settings-index-embedding"
                  className={formInputClass}
                >
                  <option value="">（不指定）</option>
                  {configs.map((config) => (
                    <option key={config.id} value={config.id}>
                      {config.name || config.id}
                      {config.keyConfigured ? '' : '（缺少密钥）'}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </>
        )}
      </section>

      <section className="flex flex-col gap-2 rounded-card border border-line bg-bg-soft px-3 py-2">
        <header className="flex flex-wrap items-center gap-2">
          <h4 className="text-ink text-[var(--font-meta-size)]">嵌入配置（{configs.length}）</h4>
          <button
            type="button"
            data-testid="settings-embedding-add"
            onClick={() => {
              setSelectedConfigId(null);
              setForm(newEmbeddingForm(configs));
              setApiKey('');
            }}
            className={`${formButtonClass} inline-flex items-center gap-1`}
          >
            <Plus size={11} aria-hidden="true" />
            新增嵌入配置
          </button>
          <button
            type="button"
            data-testid="settings-embedding-pull"
            disabled={form === null}
            onClick={() => setPullModelsOpen(true)}
            className={`${formButtonClass} inline-flex items-center gap-1`}
          >
            <RefreshCw size={11} aria-hidden="true" />
            拉取模型
          </button>
          <button
            type="button"
            data-testid="settings-embedding-reload"
            onClick={() => embeddings.reload()}
            className={`${formButtonClass} inline-flex items-center gap-1`}
          >
            <RefreshCw size={11} aria-hidden="true" />
            重新读取
          </button>
        </header>

        {embeddings.error === null ? null : (
          <FormNote tone="warn" testId="settings-embedding-error">
            {embeddings.error}
          </FormNote>
        )}

        <ul className="flex flex-col gap-1" data-testid="settings-embedding-list">
          {configs.map((config) => (
            <li key={config.id} className="flex flex-wrap items-center gap-2 text-[var(--font-meta-size)]">
              <button
                type="button"
                data-testid={`settings-embedding-select-${config.id}`}
                onClick={() => {
                  setSelectedConfigId(config.id);
                  setForm(formFromConfig(config));
                  setApiKey('');
                }}
                className={
                  config.id === selectedConfigId
                    ? 'rounded-control bg-accent-soft px-2 py-0.5 text-left text-ink'
                    : 'rounded-control px-2 py-0.5 text-left text-muted hover:bg-[var(--overlay-hover)] hover:text-ink'
                }
              >
                {config.name || config.id}
              </button>
              <span className="font-mono text-subtle text-[var(--font-micro-size)]">{config.model}</span>
              <span className="text-subtle text-[var(--font-micro-size)]">
                {config.dimensions} 维 · {config.enabled ? '启用' : '停用'} ·{' '}
                {config.keyConfigured ? '密钥已配置' : '缺少密钥'}
              </span>
            </li>
          ))}
        </ul>
      

        {form === null ? null : (
          <div className="flex flex-col gap-2 border-t border-line pt-2" data-testid="settings-embedding-editor">
            <div className="grid grid-cols-2 gap-2">
              <TextField
                label="标识"
                value={form.id}
                disabled={selectedConfig !== null}
                onChange={(id) => setForm({ ...form, id })}
                testId="settings-embedding-id"
              />
              <TextField
                label="名称"
                value={form.name}
                onChange={(name) => setForm({ ...form, name })}
                testId="settings-embedding-name"
              />
              <TextField
                label="接入地址"
                value={form.baseUrl}
                onChange={(baseUrl) => setForm({ ...form, baseUrl })}
                testId="settings-embedding-baseurl"
              />
              <TextField
                label="模型"
                value={form.model}
                onChange={(model) => setForm({ ...form, model })}
                testId="settings-embedding-model"
              />
              <NumberField
                label="维度（留空则保存时自动探测）"
                value={form.dimensions}
                min={1}
                allowEmpty
                emptyValue={null}
                onChange={(dimensions) =>
                  setForm({ ...form, dimensions: typeof dimensions === 'number' ? dimensions : null })
                }
                testId="settings-embedding-dimensions"
              />
              <TextField
                label="API Key（每次保存都需要填写）"
                type="password"
                value={apiKey}
                onChange={setApiKey}
                testId="settings-embedding-apikey"
              />
            </div>
            <CheckboxField
              label="启用该嵌入配置"
              checked={form.enabled}
              onChange={(enabled) => setForm({ ...form, enabled })}
              testId="settings-embedding-enabled"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="settings-embedding-save"
                disabled={saveEmbedding.pending || apiKey.trim().length === 0 || form.name.trim().length === 0}
                onClick={() => {
                  void saveEmbedding
                    .run({
                      id: form.id.trim(),
                      name: form.name.trim(),
                      baseUrl: form.baseUrl.trim(),
                      model: form.model.trim(),
                      dimensions: form.dimensions,
                      apiKey,
                      enabled: form.enabled
                    })
                    .then((result) => {
                      if (!result.ok) {
                        return;
                      }
                      setApiKey('');
                      setSelectedConfigId(result.data.id);
                      setForm(formFromConfig(result.data));
                      embeddings.reload();
                    });
                }}
                className={formButtonClass}
              >
                保存嵌入配置
              </button>
              <span className="text-subtle text-[var(--font-micro-size)]">
                {selectedConfig === null ? '新增' : `编辑 ${selectedConfig.id}`}
                {form.dimensions === null ? ' · 保存时探测维度' : ''}
              </span>
            </div>
            {saveEmbedding.error === null ? null : (
              <FormNote tone="warn" testId="settings-embedding-save-error">
                {saveEmbedding.error}
              </FormNote>
            )}
          </div>
        )}
      </section>

      <RemoteModelPicker
        open={pullModelsOpen && form !== null}
        client={client}
        endpoint={form?.baseUrl ?? ''}
        multiple={false}
        testId="settings-embedding-pull-models"
        onClose={() => setPullModelsOpen(false)}
        onConfirm={(entries: RemoteModelEntry[]) => {
          const picked = entries[0];
          if (picked === undefined || form === null) {
            return;
          }
          // 拉到的只是一个模型标识，维度仍然未知 —— 置成 null（留空）让保存时探测。
          // 名称只在还空着的时候补，避免覆盖用户已经写好的中文名。
          setForm({
            ...form,
            model: picked.id,
            name: form.name.trim().length === 0 ? picked.id : form.name,
            dimensions: null
          });
          setPullModelsOpen(false);
        }}
      />

    </FormSection>
  );
}
