import { useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { useAsyncAction } from '../../app/use-async-resource';
import { RadixSettingsConfirmDialog } from '../radix-dialog-pilot';
import { writeTextFile } from '../../workspace/workspace-store';
import { applyImport, parseSettingsImport, serializeSettingsExport } from '../settings-rules';
import type { SettingsStore } from '../settings-scope';
import {
  FormNote,
  FormSection,
  formSecondaryButtonClass,
  formTextAreaClass
} from '../../shared/form-ui';

/**
 * 偏好与备份 (T8.3).
 *
 * Two decisions:
 *
 *  1. **The snapshot is built from an allow-list of draft keys** (`serializeSettingsExport`), so
 *     there is no code path that can copy a plaintext secret into it — `SettingsDraft` has no
 *     key field, and keys live in safeStorage behind `settings.setProviderSecret` /
 *     `research.embedding.save`. The security test in `tests/unit` seeds a fake key, exports, and
 *     asserts the string does not contain it.
 *  2. **Import is validation-first**: `parseSettingsImport` checks that the text is a document
 *     *this* surface produced (schemaVersion, the required objects, the two approval modes) and
 *     the imported document replaces the draft. Nothing is written until 「保存设置」 — an
 *     import is a draft operation, not a write, so a bad import is discarded by 「放弃修改」.
 *
 * 外观 lives in 应用基础 (it is the same `ui-state` preference, and two controls for one value
 * would be the drift MASTER §6.7 warns about). `fontSize` / `editorFontSize` have no backend
 * field and no consumer — removed (F22), not shown as dead controls.
 */

export function BackupSection({
  store,
  workspacePath,
  onResetUiPreferences
}: {
  store: SettingsStore;
  workspacePath: string | null;
  onResetUiPreferences: () => void;
}): React.JSX.Element {
  const [exportText, setExportText] = useState<string | null>(null);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [imported, setImported] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [written, setWritten] = useState(false);

  const writeSnapshot = useAsyncAction(
    (input: { relativePath: string; content: string; source: string }) => writeTextFile(store.client, input),
    { label: '写入设置快照' }
  );

  const draft = store.draft;
  if (draft === null) {
    return <FormNote testId="settings-backup-unavailable">设置尚未读取完成。</FormNote>;
  }

  const exportFileName = `roc-settings-export.json`;

  return (
    <FormSection
      title="偏好与备份"
      testId="settings-section-backup-body"
    >
      <section className="flex flex-col gap-3" aria-label="导出设置">
        <h4 className="font-medium">导出设置</h4>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="settings-export-generate"
            disabled={writeSnapshot.pending}
            onClick={() => {
              setExportText(serializeSettingsExport(draft, new Date().toISOString()));
              setWritten(false);
            }}
            className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
          >
            <Download size={14} aria-hidden="true" />
            生成快照
          </button>
          <button
            type="button"
            data-testid="settings-export-write"
            disabled={exportText === null || workspacePath === null || writeSnapshot.pending}
            onClick={() => {
              if (exportText === null) {
                return;
              }
              setWritten(false);
              void writeSnapshot.run({ relativePath: exportFileName, content: exportText, source: 'settings-export' })
                .then((result) => { if (result.ok) setWritten(true); });
            }}
            className={formSecondaryButtonClass}
          >
            {writeSnapshot.pending ? '写入中…' : '写入工作目录'}
          </button>
        </div>
        {written ? <p role="status" data-testid="settings-export-written" className="text-muted">已写入 {exportFileName}</p> : null}
        {writeSnapshot.error === null ? null : (
          <FormNote tone="warn" testId="settings-export-write-error">
            {writeSnapshot.error}
          </FormNote>
        )}
        <p className="text-muted text-[length:var(--font-meta-size)]" data-testid="settings-export-note">不含密钥</p>
        {exportText === null ? null : (
          <label className="flex flex-col gap-1.5">
            <span className="text-muted text-[length:var(--font-meta-size)]">{exportFileName}</span>
            <textarea value={exportText} readOnly rows={5} spellCheck={false}
              data-testid="settings-export-text" className={formTextAreaClass} />
          </label>
        )}
        <p className="text-muted text-[length:var(--font-meta-size)] break-all" data-testid="settings-export-destination">
          {workspacePath === null ? '未打开工作目录' : workspacePath}
        </p>
      </section>

      <section className="flex flex-col gap-3 border-t-[0.5px] border-line pt-4" aria-label="导入设置">
        <h4 className="font-medium">导入设置</h4>
        <label className="flex flex-col gap-1.5">
          <span className="sr-only">设置 JSON</span>
          <textarea
            value={importText}
            rows={5}
            spellCheck={false}
            placeholder='{"schemaVersion":1,…}'
            onChange={(event) => {
              setImportText(event.target.value);
              setImportError(null);
              setImported(false);
            }}
            data-testid="settings-import-text"
            className={formTextAreaClass}
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="settings-import-apply"
            disabled={importText.trim().length === 0}
            onClick={() => {
              const result = parseSettingsImport(importText);
              if (!result.ok) {
                setImportError(result.error);
                setImported(false);
                return;
              }
              store.update((next) => {
                const applied = applyImport(result.document, next);
                next.settings = applied.settings;
                next.providers = applied.providers;
                next.defaultModelId = applied.defaultModelId;
                next.permissions = applied.permissions;
                next.hooks = applied.hooks;
                next.index = applied.index;
              });
              setImportError(null);
              setImported(true);
            }}
            className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
          >
            <Upload size={14} aria-hidden="true" />
            导入到草稿
          </button>
          {imported ? (
            <span className="text-[length:var(--font-micro-size)] text-muted" data-testid="settings-import-ok">
              已导入，待保存
            </span>
          ) : null}
        </div>
        {importError === null ? null : (
          <FormNote tone="warn" testId="settings-import-error">
            {importError}
          </FormNote>
        )}
      </section>

      <div className="flex flex-col gap-1 border-t-[0.5px] border-line pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="settings-reset-ui"
            onClick={() => setResetOpen(true)}
            className={formSecondaryButtonClass}
          >
            重置本地界面偏好
          </button>
        </div>
      </div>

      <RadixSettingsConfirmDialog
        open={resetOpen}
        title="重置本地界面偏好？"
        message="将清除本机保存的界面偏好，回到默认值。"
        detail="外观覆盖会重置为「跟随系统」。不会删除项目、设置或密钥。"
        confirmLabel="重置"
        tone="destructive"
        testId="settings-reset-confirm"
        onCancel={() => setResetOpen(false)}
        onConfirm={() => {
          setResetOpen(false);
          onResetUiPreferences();
        }}
      />
    </FormSection>
  );
}
