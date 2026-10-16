import { useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { useAsyncAction } from '../../app/use-async-resource';
import { ConfirmDialog } from '../../shell/ConfirmDialog';
import { writeTextFile } from '../../workspace/workspace-store';
import { applyImport, parseSettingsImport, serializeSettingsExport } from '../settings-rules';
import type { SettingsStore } from '../settings-scope';
import {
  SettingsNote,
  SettingsSection,
  settingsSecondaryButtonClass,
  settingsTextAreaClass
} from '../settings-ui';

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

  const writeSnapshot = useAsyncAction(
    (input: { relativePath: string; content: string; source: string }) => writeTextFile(store.client, input),
    { label: '写入设置快照' }
  );

  const draft = store.draft;
  if (draft === null) {
    return <SettingsNote testId="settings-backup-unavailable">设置尚未读取完成。</SettingsNote>;
  }

  const exportFileName = `roc-settings-export.json`;

  return (
    <SettingsSection
      title="偏好与备份"
      hint="renderer 侧快照（无密钥）· 导入进草稿 · 本地界面偏好重置"
      testId="settings-section-backup-body"
    >
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="settings-export-generate"
            onClick={() => {
              setExportText(serializeSettingsExport(draft, new Date().toISOString()));
            }}
            className={`${settingsSecondaryButtonClass} inline-flex items-center gap-1`}
          >
            <Download size={11} aria-hidden="true" />
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
              void writeSnapshot.run({ relativePath: exportFileName, content: exportText, source: 'settings-export' });
            }}
            className={settingsSecondaryButtonClass}
          >
            写入工作目录（{exportFileName}）
          </button>
          <span className="text-subtle text-[var(--font-micro-size)]">
            {workspacePath === null ? '未绑定工作目录，只能查看快照文本' : `工作目录：${workspacePath}`}
          </span>
        </div>
        {writeSnapshot.error === null ? null : (
          <SettingsNote tone="warn" testId="settings-export-write-error">
            {writeSnapshot.error}
          </SettingsNote>
        )}
        {/* Not hidden while writing: the sentence describes the snapshot's contents, and hiding it
            exactly when the write happens reads like a state change. */}
        <p className="text-subtle text-[var(--font-micro-size)]" data-testid="settings-export-note">
          快照只含 settings / providers / defaultModelId / permissions / hooks；密钥正文不在其中（只保留
          credentialRef 与「已配置」状态）。
        </p>
        <textarea
          value={exportText ?? ''}
          readOnly
          rows={8}
          spellCheck={false}
          data-testid="settings-export-text"
          className={settingsTextAreaClass}
        />
      </div>

      <div className="flex flex-col gap-1 border-t border-line pt-2">
        <span className="text-subtle text-[var(--font-micro-size)]">从 JSON 导入（替换草稿，保存后才写入后端）</span>
        <textarea
          value={importText}
          rows={6}
          spellCheck={false}
          placeholder='{"schemaVersion":1,…}'
          onChange={(event) => {
            setImportText(event.target.value);
            setImportError(null);
            setImported(false);
          }}
          data-testid="settings-import-text"
          className={settingsTextAreaClass}
        />
        <div className="flex items-center gap-2">
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
            className={`${settingsSecondaryButtonClass} inline-flex items-center gap-1`}
          >
            <Upload size={11} aria-hidden="true" />
            导入到草稿
          </button>
          {imported ? (
            <span className="text-[var(--font-micro-size)] text-muted" data-testid="settings-import-ok">
              已导入草稿；顶部「保存设置」才会写入（可先「放弃修改」撤销）。
            </span>
          ) : null}
        </div>
        {importError === null ? null : (
          <SettingsNote tone="warn" testId="settings-import-error">
            {importError}
          </SettingsNote>
        )}
      </div>

      <div className="flex flex-col gap-1 border-t border-line pt-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="settings-reset-ui"
            onClick={() => setResetOpen(true)}
            className={settingsSecondaryButtonClass}
          >
            重置本地界面偏好
          </button>
          <span className="text-subtle text-[var(--font-micro-size)]">
            清除 `roc.ui.*`（面板宽度、折叠、左栏 tab、星标、文件树展开、外观覆盖）。产品数据与后端设置不受影响。
          </span>
        </div>
        <SettingsNote testId="settings-reset-note">
          后端没有「清除缓存 / 恢复默认设置」的 IPC，所以这里不做假动作：要恢复后端设置默认值目前只能手工改字段。
          面板宽度这类实时布局值在下次启动时回到默认。
        </SettingsNote>
      </div>

      <ConfirmDialog
        open={resetOpen}
        title="重置本地界面偏好？"
        message="将清除本机保存的界面偏好（roc.ui.*），回到默认值。"
        detail="外观覆盖会重置为「跟随系统」（它本身就是一条偏好，重置后的值就是默认值）。产品数据、项目与后端设置不受影响，也不会删除密钥。"
        confirmLabel="重置"
        tone="destructive"
        testId="settings-reset-confirm"
        onCancel={() => setResetOpen(false)}
        onConfirm={() => {
          setResetOpen(false);
          onResetUiPreferences();
        }}
      />
    </SettingsSection>
  );
}
