import { useEffect, useMemo, useState } from 'react';
import { Download, Search } from 'lucide-react';
import type { RemoteModelEntry } from '../../shared/types';
import { useAsyncAction } from '../app/use-async-resource';
import { ModalShell } from '../shell/ModalShell';
import { FormNote, TextField, formButtonClass, formPrimaryButtonClass } from '../shared/form-ui';
import type { RocClient } from '../shared/roc-client';
import { listRemoteModels } from './settings-store';

/**
 * 「从端点拉取模型」浮层（P10）。
 *
 * 为什么是一个浮层而不是页面里的一个内联列表：拉取会写入一份**临时的、可能很长**的结果
 * （OpenAI 兼容服务常见 60+ 条，本地 Ollama 也是几十条），把它铺在设置区里会把下面的
 * 「测速」「嵌入配置」全部推走；而用户在这个时刻只想做一件事——挑几个模型。
 *
 * 三件事决定了这里的形状：
 *
 *  1. **端点是用户填的，不是我们认定的。** 请求发的是当前编辑的这一份地址（可改），
 *     因为用户往往是在「发现模型标识填错」之后才想起来拉取。
 *  2. **密钥有两种来源。** 手填的一次性明文（还没保存、或与已存的不是同一个），
 *     或者系统钥匙串里已存的那一份（`providerId`）。两者都没有也允许发请求：本机
 *     推理服务不需要凭据，把「没 key 就是错的」当前提会挡掉这批用户。
 *  3. **已添加的模型不重复添加。** 列表里已有标识会被标成「已添加」并禁用，避免用户
 *     连点两次后拿到两份同名模型（模型标识在 provider 内是有效的唯一键，重复会让
 *     默认模型解析和测速都出现歧义）。
 */

export type RemoteModelPickerProps = {
  open: boolean;
  client: RocClient;
  /** 端点预填：当前供应商 / 当前嵌入配置的那一份。 */
  endpoint: string;
  /** 用系统钥匙串里已存的 provider 凭据；没有就只认手填的 key。 */
  providerId?: string | null;
  /** 已存在的模型标识，列表里标为「已添加」并禁用。 */
  existingIds?: readonly string[];
  /** false = 单选（嵌入模型一次只能选一个）。 */
  multiple?: boolean;
  testId?: string;
  onClose: () => void;
  onConfirm: (entries: RemoteModelEntry[]) => void;
};

export function RemoteModelPicker({
  open,
  client,
  endpoint,
  providerId = null,
  existingIds = [],
  multiple = true,
  testId = 'settings-remote-models',
  onClose,
  onConfirm
}: RemoteModelPickerProps): React.JSX.Element {
  const [endpointText, setEndpointText] = useState(endpoint);
  const [apiKey, setApiKey] = useState('');
  const [entries, setEntries] = useState<RemoteModelEntry[] | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState('');

  // 每次打开都从当前端点和空选择开始：上一次的勾选不该跟着用户跑到另一个供应商身上。
  useEffect(() => {
    if (!open) {
      return;
    }
    setEndpointText(endpoint);
    setApiKey('');
    setEntries(null);
    setSelected(new Set());
    setFilter('');
  }, [open, endpoint]);

  const fetchModels = useAsyncAction(
    (input: { endpoint: string; apiKey: string | null; providerId: string | null }) => listRemoteModels(client, input),
    { label: '拉取模型列表' }
  );

  const existing = useMemo(() => new Set(existingIds), [existingIds]);
  const visible = useMemo(() => {
    const all = entries ?? [];
    const needle = filter.trim().toLowerCase();
    if (needle.length === 0) {
      return all;
    }
    return all.filter((entry) => entry.id.toLowerCase().includes(needle));
  }, [entries, filter]);

  const toggle = (id: string): void => {
    setSelected((current) => {
      if (!multiple) {
        return new Set(current.has(id) ? [] : [id]);
      }
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const confirm = (): void => {
    const picked = (entries ?? []).filter((entry) => selected.has(entry.id));
    if (picked.length === 0) {
      return;
    }
    onConfirm(picked);
  };

  const canFetch = fetchModels.pending === false && endpointText.trim().length > 0;
  const confirmLabel = multiple ? `添加所选（${selected.size}）` : '使用该模型';

  return (
    <ModalShell
      open={open}
      title="从端点拉取模型"
      onClose={onClose}
      widthClassName="w-[min(560px,92vw)]"
      testId={testId}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            data-testid={`${testId}-cancel`}
            className={formButtonClass}
          >
            取消
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={selected.size === 0}
            data-testid={`${testId}-confirm`}
            className={formPrimaryButtonClass}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1">
            <TextField
              label="接入地址"
              value={endpointText}
              onChange={setEndpointText}
              placeholder="https://api.openai.com/v1"
              testId={`${testId}-endpoint`}
            />
          </div>
          <button
            type="button"
            data-testid={`${testId}-fetch`}
            disabled={!canFetch}
            onClick={() => {
              setSelected(new Set());
              void fetchModels
                .run({
                  endpoint: endpointText.trim(),
                  apiKey: apiKey.trim().length === 0 ? null : apiKey.trim(),
                  providerId
                })
                .then((result) => {
                  if (result !== null) {
                    setEntries(result.models);
                  }
                });
            }}
            className={`${formButtonClass} inline-flex items-center gap-1`}
          >
            <Download size={11} aria-hidden="true" />
            {fetchModels.pending ? '拉取中…' : '拉取'}
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <TextField
            label="API Key（可留空）"
            type="password"
            value={apiKey}
            onChange={setApiKey}
            placeholder="留空则使用已保存的密钥"
            testId={`${testId}-key`}
          />
          <div className="flex flex-col gap-0.5">
            <span className="text-subtle text-[var(--font-micro-size)]">说明</span>
            <p className="flex h-[var(--control-height)] items-center text-subtle text-[var(--font-micro-size)] leading-tight">
              本机推理服务通常不需要密钥。
            </p>
          </div>
        </div>

        {fetchModels.error === null ? null : (
          <FormNote tone="warn" testId={`${testId}-error`}>
            {fetchModels.error}
          </FormNote>
        )}

        {entries === null ? (
          <p className="text-subtle text-[var(--font-micro-size)]" data-testid={`${testId}-hint`}>
            填好端点后点「拉取」，这里会列出该端点声明的模型。
          </p>
        ) : (
          <>
            <div className="flex items-end gap-2">
              <label className="flex h-[var(--control-height)] min-w-0 flex-1 items-center gap-1.5 rounded-control border border-line bg-bg px-2 focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent">
                <Search size={11} aria-hidden="true" className="shrink-0 text-subtle" />
                <input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="筛选模型标识"
                  aria-label="筛选模型标识"
                  data-testid={`${testId}-filter`}
                  className="h-full min-w-0 flex-1 bg-transparent text-ink text-[var(--font-meta-size)] outline-none placeholder:text-subtle"
                />
              </label>
              <span
                className="flex h-[var(--control-height)] shrink-0 items-center text-subtle text-[var(--font-micro-size)]"
                data-testid={`${testId}-count`}
              >
                {visible.length}/{entries.length} 个
              </span>
            </div>

            {entries.length === 0 ? (
              <p className="text-subtle text-[var(--font-micro-size)]" data-testid={`${testId}-empty`}>
                端点没有返回任何模型。确认地址包含版本前缀（如 /v1），或先在该服务里下载模型。
              </p>
            ) : (
              <div
                role={multiple ? 'group' : 'radiogroup'}
                aria-label="可用模型"
                className="flex max-h-[240px] flex-col gap-0.5 overflow-y-auto rounded-card border border-line-soft p-1"
                data-testid={`${testId}-list`}
              >
                {/* 行用 div 而不是 ul/li：单选时外层是 radiogroup，中间夹一层 listitem
                    会让读屏把“第 3 项，共 12 项”和“单选框”错位；复选框自身已由 label 命名。 */}
                {visible.map((entry) => {
                  const added = existing.has(entry.id);
                  const checked = selected.has(entry.id);
                  return (
                    <div key={entry.id}>
                      <label
                        className={`flex items-center gap-2 rounded-control px-1.5 py-1 ${
                          added
                            ? 'text-subtle'
                            : 'text-ink hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]'
                        }`}
                      >
                        <input
                          type={multiple ? 'checkbox' : 'radio'}
                          name={`${testId}-choice`}
                          checked={checked}
                          disabled={added}
                          onChange={() => toggle(entry.id)}
                          data-testid={`${testId}-option-${entry.id}`}
                          className="h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-[var(--font-meta-size)]">{entry.id}</span>
                        {added ? (
                          <span className="shrink-0 text-subtle text-[var(--font-micro-size)]">已添加</span>
                        ) : entry.ownedBy === null ? null : (
                          <span className="shrink-0 truncate text-subtle text-[var(--font-micro-size)]">{entry.ownedBy}</span>
                        )}
                      </label>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </ModalShell>
  );
}
