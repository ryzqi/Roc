import { useEffect, useState } from 'react';
import { Download, FolderInput, Square, Trash2 } from 'lucide-react';
import type { ResearchModelsStatus } from '../../../shared/types';
import { useAsyncAction, useAsyncResource } from '../../app/use-async-resource';
import type { SettingsStore } from '../settings-scope';
import {
  downloadModels, cancelModels, getModelsStatus, importModels, removeModels, selectModels
} from '../../shared/research-models-store';
import { getRtkStatus, getToolchainStatus } from '../settings-store';
import { KeyValueRow, FormNote, FormSection, SelectField, TextField, formSecondaryButtonClass } from '../../shared/form-ui';
import { formatBytes } from '../../shared/format';

/**
 * 文献与解析 · 编译与沙箱 — the two sections with **no writer** (T8.3).
 *
 * Both report state the backend owns and both are `README`-style sections for it: the
 * MinerU/academic-source fields the legacy settings had (service type, api url, token,
 * formula/table toggles, language, arXiv mirror, Semantic Scholar key, CrossRef email,
 * proxy, auto-citation, bibliography style) and the sandbox fields (LaTeX engine,
 * auto-compile, debounce, synctex, sandbox runtime/endpoint, execution timeout, plotting
 * backend) have **no field in the backend contract at all** — verified against
 * `src/shared/schemas` (findings F22). They are removed, not greyed out and not invented.
 *
 * What remains is real: `research.models.status/download` for the local parsing models and
 * `research.toolchain.status` for the Python/uv/tectonic toolchain, plus `rtk.status`.
 */

const POLL_INTERVAL_MS = 2_000;

const PACK_LABELS: Readonly<Record<ResearchModelsStatus['selectedPack'], { label: string; note: string }>> = {
  basic: { label: '轻量解析 Basic', note: '扫描件、OCR、表格、公式；不下载 VLM' },
  standard: { label: '标准解析 Standard', note: '复杂论文版面；推荐档（含 VLM）' },
  advanced: { label: '精细解析 Advanced', note: '更大计算投入；复用 Standard 权重' },
  flash: { label: '原生文档 Flash', note: 'HTML 与原生 PDF 文本；不加载推理模型' }
};

const STATE_LABELS: Readonly<Record<ResearchModelsStatus['packs'][number]['state'], string>> = {
  missing: '未下载',
  downloading: '下载中',
  verifying: '校验中',
  ready: '已就绪',
  incompatible: '文件不匹配',
  failed: '失败'
};

/**
 * 解析模型管理（提案 §5）。
 *
 * 四件事必须同时可见才能做决定：选中的包、每个包的真实字节量与已安装量、
 * 已选下载源，以及「缺模型时不自动下载」的边界——所以下载只在用户点击时发生，
 * 且下载目标就是当前选中的包。
 */
export function LiteratureSection({ store }: { store: SettingsStore }): React.JSX.Element {
  const models = useAsyncResource('settings:models', () => getModelsStatus(store.client), {
    label: '读取解析模型状态'
  });
  const [importPath, setImportPath] = useState('');
  const download = useAsyncAction(
    (input: { pack: ResearchModelsStatus['selectedPack']; source: ResearchModelsStatus['source'] }) =>
      downloadModels(store.client, input),
    { label: '下载解析模型' }
  );
  const select = useAsyncAction(
    (input: { pack: ResearchModelsStatus['selectedPack']; source?: ResearchModelsStatus['source'] }) =>
      selectModels(store.client, input),
    { label: '切换解析模型配置' }
  );
  const importAction = useAsyncAction((directory: string) => importModels(store.client, directory), {
    label: '导入解析模型'
  });
  const removeAction = useAsyncAction(
    (pack: ResearchModelsStatus['selectedPack']) => removeModels(store.client, pack),
    { label: '卸载解析模型' }
  );
  const cancelAction = useAsyncAction(() => cancelModels(store.client), { label: '取消模型下载' });

  const downloading = models.data?.downloading === true;
  const reloadModels = models.reload;
  useEffect(() => {
    if (!downloading) {
      return;
    }
    // There is no push channel for the download; polling only exists while it is running.
    const timer = window.setInterval(() => reloadModels(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [downloading, reloadModels]);

  const status = models.data;
  const refresh = (): void => {
    reloadModels();
  };
  const selected = status?.packs.find((pack) => pack.pack === status.selectedPack) ?? null;

  return (
    <FormSection
      title="文献与解析"
      testId="settings-section-literature-body"
    >
      {models.error === null ? null : (
        <FormNote tone="warn" testId="settings-models-status-error">
          {models.error}
        </FormNote>
      )}

      <dl className="flex flex-col gap-0.5">
        <KeyValueRow
          label="就绪"
          value={status === null ? '读取中…' : status.ready ? '是' : '否'}
          testId="settings-models-ready"
        />
        <KeyValueRow
          label="当前配置"
          value={status === null ? '读取中…' : `${PACK_LABELS[status.selectedPack].label} · ${STATE_LABELS[selected?.state ?? 'missing']}`}
          testId="settings-models-selected"
        />
        <KeyValueRow
          label="下载中"
          value={status === null ? '读取中…' : status.downloading ? '是' : '否'}
          testId="settings-models-downloading"
        />
        <KeyValueRow
          label="后端错误"
          value={status?.error ?? '无'}
          testId="settings-models-error"
        />
      </dl>

      {status === null ? null : (
        <>
          <SelectField
            label="解析配置"
            value={status.selectedPack}
            disabled={select.pending || downloading}
            options={status.packs.map((pack) => ({ value: pack.pack, label: `${PACK_LABELS[pack.pack].label} · ${STATE_LABELS[pack.state]}` }))}
            onChange={(next) => {
              void select.run({ pack: next }).then(refresh);
            }}
            testId="settings-models-pack"
          />
          <SelectField
            label="下载源"
            value={status.source}
            disabled={downloading}
            options={[
              { value: 'auto', label: '自动选择（官方入口决定）' },
              { value: 'huggingface', label: 'Hugging Face' },
              { value: 'modelscope', label: 'ModelScope' }
            ]}
            onChange={(next) => {
              void select.run({ pack: status.selectedPack, source: next }).then(refresh);
            }}
            testId="settings-models-source"
          />

          <ul className="flex flex-col gap-0.5" data-testid="settings-models-list">
            {status.packs.map((pack) => (
              <li key={pack.pack} className="flex flex-wrap items-center gap-2 text-[var(--font-micro-size)]">
                <span className="text-muted">{PACK_LABELS[pack.pack].label}</span>
                <span className="text-subtle">
                  {pack.installedBytes > 0 ? `${formatBytes(pack.installedBytes)} / ` : ''}{formatBytes(pack.bytes)}
                </span>
                <span className="text-subtle">{STATE_LABELS[pack.state]}</span>
                {pack.state === 'ready' || pack.error === null ? null : (
                  <span className="font-mono text-subtle">{pack.error}</span>
                )}
                <span className="text-subtle">{PACK_LABELS[pack.pack].note}</span>
              </li>
            ))}
          </ul>

          <dl className="flex flex-col gap-0.5">
            <KeyValueRow
              label="组件"
              value={status.models.map((model) => `${model.name} ${model.ready ? '✓' : '✗'}`).join('  ') || '无'}
              testId="settings-models-components"
            />
            {status.job === null ? null : (
              <KeyValueRow
                label="进度"
                value={`${status.job.phase === 'verifying' ? '校验' : '下载'} ${formatBytes(status.job.bytesDone)} / ${formatBytes(status.job.bytesTotal)}`}
                testId="settings-models-progress"
              />
            )}
          </dl>
        </>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="settings-models-download"
          disabled={download.pending || downloading || status === null}
          onClick={() => {
            if (status === null) return;
            void download.run({ pack: status.selectedPack, source: status.source }).then(refresh);
          }}
          className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
        >
          <Download size={11} aria-hidden="true" />
          {downloading ? '下载中…' : '下载/校验选中配置'}
        </button>
        <button
          type="button"
          data-testid="settings-models-cancel"
          disabled={cancelAction.pending || !downloading}
          onClick={() => {
            void cancelAction.run().then(refresh);
          }}
          className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
        >
          <Square size={11} aria-hidden="true" />
          取消下载
        </button>
        <button
          type="button"
          data-testid="settings-models-remove"
          disabled={removeAction.pending || downloading || status === null || selected?.installedBytes === 0}
          onClick={() => {
            if (status === null) return;
            void removeAction.run(status.selectedPack).then(refresh);
          }}
          className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
        >
          <Trash2 size={11} aria-hidden="true" />
          卸载选中配置
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <TextField
            label="从已有目录导入"
            value={importPath}
            disabled={downloading}
            placeholder="/path/to/mineru-home"
            onChange={setImportPath}
            testId="settings-models-import-path"
          />
        </div>
        <button
          type="button"
          data-testid="settings-models-import"
          disabled={importAction.pending || downloading || importPath.trim() === ''}
          onClick={() => {
            void importAction.run(importPath.trim()).then((result) => {
              if (result !== null) {
                setImportPath('');
                refresh();
              }
            });
          }}
          className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
        >
          <FolderInput size={11} aria-hidden="true" />
          校验并导入
        </button>
      </div>

      {download.error === null ? null : (
        <FormNote tone="warn" testId="settings-models-download-error">
          {download.error}
        </FormNote>
      )}
      {select.error === null ? null : (
        <FormNote tone="warn" testId="settings-models-select-error">{select.error}</FormNote>
      )}
      {importAction.error === null ? null : (
        <FormNote tone="warn" testId="settings-models-import-error">{importAction.error}</FormNote>
      )}
      {removeAction.error === null ? null : (
        <FormNote tone="warn" testId="settings-models-remove-error">{removeAction.error}</FormNote>
      )}
      {cancelAction.error === null ? null : (
        <FormNote tone="warn" testId="settings-models-cancel-error">{cancelAction.error}</FormNote>
      )}
      <FormNote tone="default" testId="settings-models-offline-note">
        模型就绪后解析全程离线；缺模型时会明确阻断，不会自动联网下载。
      </FormNote>
    </FormSection>
  );
}

export function SandboxSection({ store }: { store: SettingsStore }): React.JSX.Element {
  const toolchain = useAsyncResource('settings:toolchain', () => getToolchainStatus(store.client), {
    label: '读取工具链状态'
  });
  const rtk = useAsyncResource('settings:rtk', () => getRtkStatus(store.client), { label: '读取 rtk 状态' });

  const toolchainStatus = toolchain.data;
  const rtkStatus = rtk.data;

  return (
    <FormSection
      title="编译与沙箱"
      readOnly
      testId="settings-section-sandbox-body"
    >
      {toolchain.error === null ? null : (
        <FormNote tone="warn" testId="settings-toolchain-error">
          {toolchain.error}
        </FormNote>
      )}
      <dl className="flex flex-col gap-0.5">
        <KeyValueRow
          label="工具链"
          value={toolchainStatus === null ? '读取中…' : toolchainStatus.available ? '可用' : '不可用'}
          testId="settings-toolchain-available"
        />
        <KeyValueRow
          label="Python"
          value={toolchainStatus?.versions?.python ?? '—'}
          testId="settings-toolchain-python"
        />
        <KeyValueRow label="uv" value={toolchainStatus?.versions?.uv ?? '—'} testId="settings-toolchain-uv" />
        <KeyValueRow
          label="tectonic"
          value={toolchainStatus?.versions?.tectonic ?? '—'}
          testId="settings-toolchain-tectonic"
        />
        <KeyValueRow label="错误" value={toolchainStatus?.error ?? '无'} testId="settings-toolchain-detail-error" />
      </dl>
      {toolchainStatus !== null && !toolchainStatus.available && toolchainStatus.error !== null ? (
        <FormNote tone="warn" testId="settings-toolchain-unavailable">
          编译与实验在工具链就绪前都会失败：{toolchainStatus.error}
        </FormNote>
      ) : null}

      <div className="border-t border-line pt-2">
        {rtk.error === null ? null : (
          <FormNote tone="warn" testId="settings-rtk-error">
            {rtk.error}
          </FormNote>
        )}
        <dl className="flex flex-col gap-0.5">
          <KeyValueRow
            label="rtk"
            value={
              rtkStatus === null
                ? '读取中…'
                : rtkStatus.resourceState === 'ready'
                  ? `已启用为 agent 命令代理（${rtkStatus.binaryPath}）`
                  : `不可用（${rtkStatus.bypassReason ?? '缺少二进制'}）`
            }
            testId="settings-rtk-status"
          />
          <KeyValueRow label="配置文件" value={rtkStatus?.configPath ?? '—'} testId="settings-rtk-config" />
          <KeyValueRow label="tee 目录" value={rtkStatus?.teeDir ?? '—'} testId="settings-rtk-tee" />
        </dl>
      </div>

    </FormSection>
  );
}
