import { useEffect } from 'react';
import { Download } from 'lucide-react';
import { useAsyncAction, useAsyncResource } from '../../app/use-async-resource';
import type { SettingsStore } from '../settings-scope';
import { downloadModels, getModelsStatus, getRtkStatus, getToolchainStatus } from '../settings-store';
import { KeyValueRow, FormNote, FormSection, formSecondaryButtonClass } from '../../shared/form-ui';

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

export function LiteratureSection({ store }: { store: SettingsStore }): React.JSX.Element {
  const models = useAsyncResource('settings:models', () => getModelsStatus(store.client), {
    label: '读取解析模型状态'
  });
  const download = useAsyncAction(() => downloadModels(store.client), { label: '下载解析模型' });

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

  return (
    <FormSection
      title="文献与解析"
      readOnly
      testId="settings-section-literature-body"
    >
      {models.error === null ? null : (
        <FormNote tone="warn" testId="settings-models-status-error">
          {models.error}
        </FormNote>
      )}

      <dl className="flex flex-col gap-0.5">
        <KeyValueRow label="就绪" value={status === null ? '读取中…' : status.ready ? '是' : '否'} testId="settings-models-ready" />
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
        <ul className="flex flex-col gap-0.5" data-testid="settings-models-list">
          {status.models.map((model) => (
            <li key={model.repoId} className="flex flex-wrap items-center gap-2 text-[var(--font-micro-size)]">
              <span className="font-mono text-muted">{model.directory}</span>
              <span className="text-subtle">{model.repoId}</span>
              <span className="text-subtle">{model.ready ? '已就绪' : '未就绪'}</span>
            </li>
          ))}
        </ul>
      )}


      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="settings-models-download"
          disabled={download.pending || downloading}
          onClick={() => {
            void download.run().then((result) => {
              if (result !== null) {
                reloadModels();
              }
            });
          }}
          className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
        >
          <Download size={11} aria-hidden="true" />
          {downloading ? '下载中…' : '下载/校验解析模型'}
        </button>
      </div>
      {download.error === null ? null : (
        <FormNote tone="warn" testId="settings-models-download-error">
          {download.error}
        </FormNote>
      )}

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
